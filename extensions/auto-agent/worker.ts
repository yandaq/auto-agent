/**
 * Running one sub-agent: a separate `pi` process in JSON mode whose event
 * stream is folded into a live status and, at exit, a result.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentDef } from "./library.ts";

export const SPAWN_TOOL = "spawn_agents";
export const OUTPUT_LIMIT = 50_000;
const KILL_GRACE_MS = 3000;

type Env = Record<string, string | undefined>;

export function depthConfig(env: Env = process.env): { depth: number; maxDepth: number } {
	return { depth: positiveInt(env.PI_AUTOAGENT_DEPTH) ?? 0, maxDepth: positiveInt(env.PI_AUTOAGENT_MAX_DEPTH) ?? 2 };
}

export function concurrencyLimit(env: Env = process.env): number {
	return positiveInt(env.PI_AUTOAGENT_CONCURRENCY) || Number.POSITIVE_INFINITY;
}

export interface LaunchContext {
	childDepth: number;
	maxDepth: number;
	inheritedModel?: string;
	inheritedThinking?: string;
}

export function buildWorkerArgs(agent: AgentDef, task: string, promptPath: string, launch: LaunchContext): string[] {
	const canSpawn = launch.childDepth < launch.maxDepth;
	const args = ["--mode", "json", "-p", "--no-session"];
	const model = agent.model ?? launch.inheritedModel;
	const thinking = agent.model ? agent.thinking : (agent.thinking ?? launch.inheritedThinking);
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools?.length) args.push("--tools", [...agent.tools, ...(canSpawn ? [SPAWN_TOOL] : [])].join(","));
	if (!canSpawn) args.push("--exclude-tools", SPAWN_TOOL);
	args.push("--append-system-prompt", promptPath);
	args.push(task);
	return args;
}

export function workerTask(task: string, originalPrompt: string): string {
	return `Task: ${task}\n\nEverything you need is in this task and the repository. Ignore the .pi folder: it holds the harness's agent definitions, not project code.\n\n---\nBackground — the user's original request, which the whole team is working on. Do only your task above; use this for context:\n\n${originalPrompt}`;
}

export function truncate(text: string, limit = OUTPUT_LIMIT): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[Output truncated: ${text.length - limit} characters omitted. Full output is in the tool details.]`;
}

export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	return results;
}

export type WorkerStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface WorkerSnapshot {
	agent: string;
	task: string;
	status: WorkerStatus;
	turns: number;
	toolCalls: number;
	usage: { input: number; output: number };
	activity: string;
}

export interface WorkerResult extends WorkerSnapshot {
	exitCode: number;
	output: string;
	error?: string;
}

export interface RunWorkerOptions {
	agent: AgentDef;
	task: string;
	originalPrompt: string;
	cwd: string;
	env?: Env;
	inheritedModel?: string;
	inheritedThinking?: string;
	signal?: AbortSignal;
	onUpdate?: (snapshot: WorkerSnapshot) => void;
	/** Human-readable transcript, for live views. */
	logPath?: string;
	/** Overrides the pi executable; used by tests. */
	command?: { command: string; args: string[] };
}

export async function runWorker(options: RunWorkerOptions): Promise<WorkerResult> {
	const { agent, task, cwd, signal } = options;
	const env = options.env ?? process.env;
	const { depth, maxDepth } = depthConfig(env);

	const tmp = mkdtempSync(join(tmpdir(), "auto-agent-"));
	const promptPath = join(tmp, `${agent.name}.md`);
	writeFileSync(promptPath, agent.body);

	const piArgs = buildWorkerArgs(agent, workerTask(task, options.originalPrompt), promptPath, {
		childDepth: depth + 1,
		maxDepth,
		inheritedModel: options.inheritedModel,
		inheritedThinking: options.inheritedThinking,
	});
	const invocation = options.command
		? { command: options.command.command, args: [...options.command.args, ...piArgs] }
		: piInvocation(piArgs);

	const state: WorkerSnapshot = {
		agent: agent.name,
		task,
		status: "running",
		turns: 0,
		toolCalls: 0,
		usage: { input: 0, output: 0 },
		activity: "starting",
	};
	const log = (text: string) => {
		if (!options.logPath) return;
		try {
			appendFileSync(options.logPath, text);
		} catch {
			// A missing view must never break the run.
		}
	};
	log(`━━ ${agent.name} ━━\n${task}\n\n`);

	const emit = () => options.onUpdate?.({ ...state, usage: { ...state.usage } });
	emit();

	let lastText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let stderr = "";
	let aborted = false;

	const handle = (event: Record<string, any>) => {
		const shown = formatEvent(event);
		if (shown) log(shown);
		switch (event.type) {
			case "turn_start":
				state.turns++;
				state.activity = "thinking";
				break;
			case "tool_execution_start":
				state.toolCalls++;
				state.activity = event.toolName ?? "tool";
				break;
			case "message_end": {
				const message = event.message;
				if (message?.role !== "assistant") return;
				state.usage.input += message.usage?.input ?? 0;
				state.usage.output += message.usage?.output ?? 0;
				const text = (message.content ?? [])
					.filter((c: any) => c.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n")
					.trim();
				if (text) lastText = text;
				if (message.stopReason) stopReason = message.stopReason;
				if (message.errorMessage) errorMessage = message.errorMessage;
				break;
			}
			default:
				return;
		}
		emit();
	};

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			env: { ...env, PI_AUTOAGENT_DEPTH: String(depth + 1), PI_AUTOAGENT_MAX_DEPTH: String(maxDepth) },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		const line = (text: string) => {
			if (!text.trim()) return;
			try {
				handle(JSON.parse(text));
			} catch {
				// Headers and non-JSON lines are not ours to interpret.
			}
		};
		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const l of lines) line(l);
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
			log(data.toString().replace(/^(?=.)/gm, "stderr│ "));
		});

		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			aborted = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
		};
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });

		const finish = (code: number) => {
			signal?.removeEventListener("abort", kill);
			if (killTimer) clearTimeout(killTimer);
			resolve(code);
		};
		proc.on("close", (code) => {
			line(buffer);
			finish(code ?? 1);
		});
		proc.on("error", (err) => {
			stderr += `\n${err.message}`;
			finish(1);
		});
	});

	rmSync(tmp, { recursive: true, force: true });

	const failed = exitCode !== 0 || stopReason === "error";
	state.status = aborted || stopReason === "aborted" ? "aborted" : failed ? "failed" : "done";
	state.activity = "";
	emit();
	log(
		state.status === "done"
			? "\n\n✔ done\n"
			: state.status === "aborted"
				? "\n\n■ aborted\n"
				: `\n\n✖ failed: ${errorMessage ?? (stderr.trim().split("\n").at(-1) || `exit ${exitCode}`)}\n`,
	);

	const lastStderr = stderr.trim().split("\n").at(-1) || undefined;
	return {
		...state,
		exitCode,
		output: lastText,
		error: state.status === "done" ? undefined : (errorMessage ?? lastStderr),
	};
}

/** One pi JSON event as transcript text, or undefined when it shows nothing. */
export function formatEvent(event: Record<string, any>): string | undefined {
	switch (event.type) {
		case "message_update": {
			const e = event.assistantMessageEvent;
			return e?.type === "text_delta" && typeof e.delta === "string" ? e.delta : undefined;
		}
		case "message_end":
			return event.message?.role === "assistant" ? "\n" : undefined;
		case "tool_execution_start":
			return `\n▸ ${event.toolName ?? "tool"} ${oneLine(JSON.stringify(event.args ?? {}), 160)}\n`;
		case "tool_execution_end":
			return event.isError ? `  ✖ ${toolError(event.result)}\n` : undefined;
		default:
			return undefined;
	}
}

/** First non-empty line of a failed tool's result text. */
function toolError(result: any): string {
	const text = (Array.isArray(result?.content) ? result.content : [])
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
	const first = text.split("\n").find((l: string) => l.trim()) ?? "";
	return first ? oneLine(first.trim(), 160) : "tool error";
}

function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ");
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Re-invoke the running pi the same way it was launched. */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exec = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function positiveInt(value: string | undefined): number | undefined {
	const n = Number.parseInt(value ?? "", 10);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}
