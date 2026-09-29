/**
 * Stages 1 and 2: design a team for the prompt, then write each new or refined
 * agent's definition into the library. Model access is injected as `Complete`,
 * a single forced tool call, so the whole pipeline runs without Pi in tests.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentDef, loadLibrary, writeAgent } from "./library.ts";

export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Usage {
	input: number;
	output: number;
}

export type Complete = (req: {
	systemPrompt: string;
	prompt: string;
	tool: ToolSpec;
}) => Promise<{ args: unknown; usage?: Partial<Usage> }>;

export type MemberMode = "new" | "reuse" | "refine";

export interface Member {
	name: string;
	purpose: string;
	mode: MemberMode;
}

export interface Team {
	members: Member[];
	plan: string;
	verifier: string;
}

export const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const TEAM_TOOL: ToolSpec = {
	name: "propose_team",
	description: "Propose the team of sub-agents that should handle the task.",
	parameters: {
		type: "object",
		properties: {
			members: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string", description: "kebab-case agent name" },
						purpose: { type: "string", description: "What this agent does on this task" },
						mode: {
							type: "string",
							enum: ["new", "reuse", "refine"],
							description: "new: write a fresh agent. reuse: use a library agent unchanged. refine: rewrite a library agent for this task.",
						},
					},
					required: ["name", "purpose", "mode"],
				},
			},
			plan: { type: "string", description: "Which agents run in parallel and which in sequence" },
			verifier: { type: "string", description: "Name of the member that verifies the final result" },
		},
		required: ["members", "plan", "verifier"],
	},
};

export const DEFINE_TOOL: ToolSpec = {
	name: "define_agent",
	description: "Write the definition of one sub-agent.",
	parameters: {
		type: "object",
		properties: {
			description: { type: "string", description: "One line: what the agent is for" },
			tools: { type: "array", items: { type: "string", enum: WORKER_TOOLS } },
			model: { type: "string", description: "Optional provider/model id; omit to inherit the orchestrator's" },
			thinking: { type: "string", enum: THINKING_LEVELS },
			systemPrompt: { type: "string", description: "The agent's full system prompt, in markdown" },
		},
		required: ["description", "tools", "systemPrompt"],
	},
};

const DESIGN_SYSTEM = `You design teams of sub-agents for a coding harness. An orchestrator will use your team to complete the user's task as fast as possible. Compute is unlimited: favour many narrow specialists that can run in parallel over a few generalists. Always include exactly one verifier that checks the final result. Prefer reusing or refining agents from the existing library over creating near-duplicates. Answer only by calling propose_team.`;

const DEFINE_SYSTEM = `You write sub-agent definitions for a coding harness. Each sub-agent is a separate process that receives one task from an orchestrator and must return a concise, complete report of what it did or found. Write a focused system prompt for the role, grant only the tools it needs, and, only when models are offered, pick a cheaper model when the role is simple. Answer only by calling define_agent.`;

export function normalizeTeam(raw: unknown, library: AgentDef[]): Team {
	const input = (raw ?? {}) as { members?: unknown[]; plan?: unknown; verifier?: unknown };
	const known = new Set(library.map((a) => a.name));
	const members: Member[] = [];
	const seen = new Set<string>();

	for (const entry of input.members ?? []) {
		const m = (entry ?? {}) as Record<string, unknown>;
		const name = slug(String(m.name ?? ""));
		if (!name || seen.has(name)) continue;
		seen.add(name);
		let mode: MemberMode = m.mode === "reuse" || m.mode === "refine" ? m.mode : "new";
		if (mode !== "new" && !known.has(name)) mode = "new";
		members.push({ name, purpose: String(m.purpose ?? ""), mode });
	}
	if (members.length === 0) throw new Error("The designer proposed no team.");

	let verifier = slug(String(input.verifier ?? ""));
	if (!seen.has(verifier) && seen.has("verifier")) verifier = "verifier";
	if (!seen.has(verifier)) {
		verifier = "verifier";
		members.push({
			name: verifier,
			purpose: "Check that the combined result fully and correctly answers the task.",
			mode: known.has(verifier) ? "reuse" : "new",
		});
	}
	return { members, plan: String(input.plan ?? ""), verifier };
}

export interface PipelineOptions {
	prompt: string;
	dir: string;
	complete: Complete;
	models: string[];
	runId: string;
	onProgress?: (message: string) => void;
}

export interface PipelineResult {
	team: Team;
	agents: AgentDef[];
	manifestPath: string;
	usage: Usage;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
	const { prompt, dir, complete, models, runId } = options;
	const progress = options.onProgress ?? (() => {});
	const usage: Usage = { input: 0, output: 0 };
	const addUsage = (u?: Partial<Usage>) => {
		usage.input += u?.input ?? 0;
		usage.output += u?.output ?? 0;
	};

	const library = loadLibrary(dir);
	progress("Designing the team…");
	const design = await complete({ systemPrompt: DESIGN_SYSTEM, prompt: designPrompt(prompt, library), tool: TEAM_TOOL });
	addUsage(design.usage);
	const team = normalizeTeam(design.args, library);

	const toWrite = team.members.filter((m) => m.mode !== "reuse");
	progress(`Team: ${team.members.map((m) => m.name).join(", ")}. Writing ${toWrite.length} definition(s)…`);

	const written = new Map<string, AgentDef>();
	await Promise.all(
		toWrite.map(async (member) => {
			const existing = library.find((a) => a.name === member.name);
			const res = await complete({
				systemPrompt: DEFINE_SYSTEM,
				prompt: definePrompt(prompt, member, team, existing, models),
				tool: DEFINE_TOOL,
			});
			addUsage(res.usage);
			const agent = toAgent(member.name, res.args, models);
			writeAgent(dir, agent);
			written.set(member.name, agent);
		}),
	);

	const agents = team.members.map(
		(m) => written.get(m.name) ?? (library.find((a) => a.name === m.name) as AgentDef),
	);

	const runsDir = join(dir, "runs");
	mkdirSync(runsDir, { recursive: true });
	const manifestPath = join(runsDir, `${runId}.json`);
	writeFileSync(
		manifestPath,
		JSON.stringify({ runId, createdAt: new Date().toISOString(), prompt, team, usage }, null, 2),
	);
	progress("Team ready.");
	return { team, agents, manifestPath, usage };
}

function designPrompt(prompt: string, library: AgentDef[]): string {
	const existing = library.length
		? library.map((a) => `- ${a.name}: ${a.description}`).join("\n")
		: "(empty)";
	return `Task:\n${prompt}\n\nExisting agent library:\n${existing}`;
}

function definePrompt(
	prompt: string,
	member: Member,
	team: Team,
	existing: AgentDef | undefined,
	models: string[],
): string {
	const roster = team.members.map((m) => `- ${m.name}: ${m.purpose}`).join("\n");
	const parts = [
		`Define the agent "${member.name}". Its purpose: ${member.purpose}`,
		`Overall task (for context):\n${prompt}`,
		`Full team:\n${roster}\nPlan: ${team.plan}`,
		`Available tools: ${WORKER_TOOLS.join(", ")}`,
		models.length
			? `Available models: ${models.join(", ")}`
			: "Models: inherit only. Do not set model or thinking; every agent runs on the user's default.",
	];
	if (existing) {
		parts.push(
			`Existing definition to refine (keep what is generally useful, adapt it to this task):\n` +
				`description: ${existing.description}\ntools: ${existing.tools?.join(", ") ?? ""}\n\n${existing.body}`,
		);
	}
	return parts.join("\n\n");
}

function toAgent(name: string, raw: unknown, models: string[]): AgentDef {
	const args = (raw ?? {}) as Record<string, unknown>;
	const agent: AgentDef = {
		name,
		description: String(args.description ?? name),
		body: `${String(args.systemPrompt ?? "").trim()}\n`,
	};
	const tools = Array.isArray(args.tools) ? args.tools.filter((t) => WORKER_TOOLS.includes(String(t))) : [];
	if (tools.length) agent.tools = tools.map(String);
	if (typeof args.model === "string" && models.includes(args.model)) agent.model = args.model;
	// No model choices means the user's default model and effort apply to every agent.
	if (models.length && typeof args.thinking === "string" && THINKING_LEVELS.includes(args.thinking)) agent.thinking = args.thinking;
	return agent;
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
