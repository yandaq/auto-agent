/**
 * auto-agent: the first prompt of a session is answered by a team of
 * sub-agents designed for it.
 *
 *   1. design a team for the prompt (nested model call)
 *   2. write each new or refined agent into .pi/sub-agents (nested calls, in parallel)
 *   3. turn this session into the orchestrator, with `spawn_agents` to run the team
 *
 * Workers are separate `pi` processes that load this extension too; there it
 * only provides `spawn_agents`, and only below the depth cap.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDef, LIBRARY_DIR, loadLibrary, projectLibraryDir } from "./library.ts";
import { openViewer, VIEW_ENV, viewerBackend } from "./viewer.ts";
import { blockedToolReason, ORCHESTRATOR_TOOLS, orchestratorPrompt } from "./orchestrator.ts";
import { type Complete, runPipeline, type Team } from "./pipeline.ts";
import {
	concurrencyLimit,
	depthConfig,
	mapWithLimit,
	runWorker,
	SPAWN_TOOL,
	truncate,
	type WorkerResult,
	type WorkerSnapshot,
} from "./worker.ts";

const ENTRY_TYPE = "auto-agent-team";
const PROMPT_ENV = "PI_AUTOAGENT_ORIGINAL_PROMPT";
const WIDGET_ID = "auto-agent";
const STATUS_ID = "auto-agent";

interface TeamState {
	team: Team;
	prompt: string;
	runId?: string;
}

export default function (pi: ExtensionAPI) {
	const { depth } = depthConfig();
	const isWorker = depth > 0;
	let state: TeamState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (isWorker) return;
		const saved = ctx.sessionManager
			.getEntries()
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === ENTRY_TYPE)
			.pop() as { data?: TeamState } | undefined;
		state = saved?.data;
		if (state) restrictToOrchestratorTools(pi);

		if (ctx.hasUI && multiAgentLoaded(ctx.cwd)) {
			ctx.ui.notify(
				"auto-agent: the multi-agent extension is also loaded. Both add sub-agent tools (spawn_agents vs dispatch); consider disabling one.",
				"warning",
			);
		}
	});

	pi.on("input", async (event, ctx) => {
		if (isWorker || state || event.source === "extension" || event.streamingBehavior === "steer") {
			return { action: "continue" };
		}
		const hasUserMessage = ctx.sessionManager
			.getEntries()
			.some((e: { type: string; message?: { role: string } }) => e.type === "message" && e.message?.role === "user");
		if (hasUserMessage || !ctx.model) return { action: "continue" };
		const dir = projectLibraryDir(ctx.cwd);
		if (!dir) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`auto-agent: pi is running in ${ctx.cwd}, not a project folder, so no team was designed. Start pi from inside the project.`,
					"warning",
				);
			}
			return { action: "continue" };
		}

		const progress = (message: string) => {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, `auto-agent: ${message}`);
		};
		const runId = timestamp();
		try {
			const result = await runPipeline({
				prompt: event.text,
				dir,
				complete: nestedComplete(ctx),
				models: modelChoices(ctx),
				runId,
				onProgress: progress,
			});
			state = { team: result.team, prompt: event.text, runId };
			pi.appendEntry(ENTRY_TYPE, state);
			restrictToOrchestratorTools(pi);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`auto-agent: team of ${result.agents.length} ready (${result.team.members.map((m) => m.name).join(", ")}). ` +
						`Design used ${result.usage.input} in / ${result.usage.output} out tokens.`,
					"info",
				);
			}
		} catch (err) {
			// Never fall through to a plain session: without a team it would have every tool,
			// including write and bash. Drop the prompt so the user can resend it to retry.
			if (ctx.hasUI) {
				ctx.ui.notify(
					`auto-agent: team design failed, so the prompt was not run: ${errorText(err)}. Send it again to retry.`,
					"error",
				);
			}
			return { action: "handled" };
		} finally {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (isWorker || !state || !event.systemPrompt) return;
		const dir = projectLibraryDir(ctx.cwd);
		if (!dir) return;
		const agents = resolveTeam(state.team, loadLibrary(dir));
		return { systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt(state.team, agents)}` };
	});

	// Backstop for the tool restriction: blocks calls that reach the orchestrator anyway
	// (another extension re-enabling tools, codemode scripts, a resumed session).
	pi.on("tool_call", async (event) => {
		if (isWorker || !state) return;
		const reason = blockedToolReason(event.toolName);
		if (reason) return { block: true, reason };
	});

	pi.registerTool({
		name: SPAWN_TOOL,
		label: "Spawn agents",
		description: spawnDescription(process.cwd()),
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.String({ description: "Agent name from the library" }),
					task: Type.String({ description: "Self-contained instruction for this agent" }),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const dir = projectLibraryDir(ctx.cwd);
			if (!dir) throw new Error(`No project library: pi is running in ${ctx.cwd}, not a project folder.`);
			const library = loadLibrary(dir);
			const unknown = params.tasks.filter((t) => !library.some((a) => a.name === t.agent)).map((t) => t.agent);
			if (unknown.length) {
				throw new Error(
					`Unknown agent(s): ${unknown.join(", ")}. Available: ${library.map((a) => a.name).join(", ") || "(none)"}`,
				);
			}

			const logDir = join(dir, "runs", state?.runId ?? "adhoc", "logs");
			const batch = timestamp();
			const backend = viewerBackend();
			const viewErrors: string[] = [];

			const originalPrompt = state?.prompt ?? process.env[PROMPT_ENV] ?? "";
			const snapshots: WorkerSnapshot[] = params.tasks.map((t) => ({
				agent: t.agent,
				task: t.task,
				status: "queued",
				turns: 0,
				toolCalls: 0,
				usage: { input: 0, output: 0 },
				activity: "",
			}));
			const render = throttle(() => {
				if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, widgetLines(snapshots));
				onUpdate?.({
					content: [{ type: "text", text: summaryLine(snapshots) }],
					details: { workers: snapshots },
				});
			}, 200);
			render();

			const results = await mapWithLimit(params.tasks, concurrencyLimit(), async (t, i) => {
				let logPath: string | undefined;
				try {
					mkdirSync(logDir, { recursive: true });
					logPath = join(logDir, `${batch}-${i + 1}-${t.agent}.log`);
					writeFileSync(logPath, "");
					await openViewer(backend, t.agent, logPath, ctx.cwd);
				} catch (err) {
					viewErrors.push(`${t.agent}: ${errorText(err)}`);
				}
				return runWorker({
					agent: library.find((a) => a.name === t.agent) as AgentDef,
					task: t.task,
					originalPrompt,
					cwd: ctx.cwd,
					env: { ...process.env, [PROMPT_ENV]: originalPrompt, [VIEW_ENV]: "off" },
					logPath,
					inheritedModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					inheritedThinking: ctx.thinkingLevel as string | undefined,
					signal,
					onUpdate: (s) => {
						snapshots[i] = s;
						render();
					},
				});
			});
			render.flush();
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
			if (viewErrors.length && ctx.hasUI) {
				ctx.ui.notify(`auto-agent: couldn't open ${backend} view(s): ${viewErrors[0]}`, "warning");
			}

			const usage = results.reduce(
				(sum, r) => ({ input: sum.input + r.usage.input, output: sum.output + r.usage.output }),
				{ input: 0, output: 0 },
			);
			return {
				content: [{ type: "text", text: results.map(reportFor).join("\n\n") }],
				details: { results, usage },
			};
		},
	});
}

/**
 * Workers start in the project with its library already written, so listing the
 * names here stops them guessing agents that don't exist.
 */
function spawnDescription(cwd: string): string {
	const base =
		`Run sub-agents from the library in ${LIBRARY_DIR}, all tasks in parallel. Each task names an agent and gives it a ` +
		"self-contained instruction. Returns each agent's final report.";
	const dir = projectLibraryDir(cwd);
	const library = dir ? loadLibrary(dir) : [];
	if (!library.length) return base;
	return `${base} Only these agents exist:\n${library.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`;
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Installed and not switched off with a "-…multi-agent…" entry in settings. */
function multiAgentLoaded(cwd: string): boolean {
	const installed = [join(homedir(), ".pi/agent/extensions/multi-agent"), join(cwd, ".pi/extensions/multi-agent")];
	if (!installed.some((p) => existsSync(p))) return false;
	for (const file of [join(homedir(), ".pi/agent/settings.json"), join(cwd, ".pi/settings.json")]) {
		try {
			const entries: unknown = JSON.parse(readFileSync(file, "utf8")).extensions;
			if (Array.isArray(entries) && entries.some((e) => typeof e === "string" && e.startsWith("-") && e.includes("multi-agent"))) {
				return false;
			}
		} catch {
			// Missing or unreadable settings don't disable anything.
		}
	}
	return true;
}

function nestedComplete(ctx: any): Complete {
	return async ({ systemPrompt, prompt, tool }) => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await ctx.modelRegistry.complete(
				ctx.model,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
					tools: [tool],
				},
				{ signal: ctx.signal },
			);
			const call = (response.content ?? []).find((c: any) => c.type === "toolCall" && c.name === tool.name);
			if (call) return { args: call.arguments, usage: response.usage };
			if (response.stopReason === "aborted") throw new Error("aborted");
		}
		throw new Error(`the model did not call ${tool.name}`);
	};
}

/**
 * Models the designer may pin agents to. Off by default, so every agent runs
 * on the user's default model and effort; with PI_AUTOAGENT_PIN_MODELS=1 it may
 * choose among the user's enabledModels (or all available ones if none are set).
 */
function modelChoices(ctx: any): string[] {
	if (process.env.PI_AUTOAGENT_PIN_MODELS !== "1") return [];
	const available = availableModels(ctx);
	const enabled = enabledModels(ctx.cwd);
	return enabled.length ? available.filter((m) => enabled.includes(m)) : available;
}

/** `enabledModels` from project settings, falling back to global settings. */
function enabledModels(cwd: string): string[] {
	for (const file of [join(cwd, ".pi/settings.json"), join(homedir(), ".pi/agent/settings.json")]) {
		try {
			const list: unknown = JSON.parse(readFileSync(file, "utf8")).enabledModels;
			if (Array.isArray(list)) return list.filter((m): m is string => typeof m === "string");
		} catch {
			// Missing or unreadable settings.
		}
	}
	return [];
}

function availableModels(ctx: any): string[] {
	try {
		return (ctx.modelRegistry.getAvailable?.() ?? []).map((m: any) => `${m.provider}/${m.id}`);
	} catch {
		return [];
	}
}

function resolveTeam(team: Team, library: AgentDef[]): AgentDef[] {
	return team.members
		.map((m) => library.find((a) => a.name === m.name))
		.filter((a): a is AgentDef => a !== undefined);
}

function reportFor(r: WorkerResult): string {
	const head = `### ${r.agent} — ${r.status} (exit ${r.exitCode}, ${r.turns} turns, ${r.toolCalls} tool calls)`;
	const error = r.error ? `\nError: ${r.error}` : "";
	return `${head}${error}\n\n${truncate(r.output || "(no output)")}`;
}

function summaryLine(snapshots: WorkerSnapshot[]): string {
	const done = snapshots.filter((s) => s.status !== "queued" && s.status !== "running").length;
	return `${done}/${snapshots.length} sub-agents finished`;
}

function widgetLines(snapshots: WorkerSnapshot[]): string[] {
	const icon: Record<string, string> = { queued: "·", running: "▶", done: "✓", failed: "✗", aborted: "■" };
	return [
		`auto-agent — ${summaryLine(snapshots)}`,
		...snapshots.map(
			(s) =>
				`${icon[s.status]} ${s.agent.padEnd(20)} ${s.status.padEnd(8)} ${String(s.turns).padStart(3)} turns ` +
				`${formatTokens(s.usage.input + s.usage.output).padStart(6)} tok  ${s.activity}`,
		),
	];
}

function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function throttle(fn: () => void, ms: number): (() => void) & { flush: () => void } {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		timer = undefined;
		last = Date.now();
		fn();
	};
	const wrapped = () => {
		if (timer) return;
		const wait = ms - (Date.now() - last);
		if (wait <= 0) run();
		else timer = setTimeout(run, wait);
	};
	wrapped.flush = () => {
		if (timer) clearTimeout(timer);
		run();
	};
	return wrapped;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Leave the orchestrator only the tools it may use (see ORCHESTRATOR_TOOLS). */
function restrictToOrchestratorTools(pi: ExtensionAPI): void {
	pi.setActiveTools(ORCHESTRATOR_TOOLS);
}
