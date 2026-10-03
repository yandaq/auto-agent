/**
 * Stages 1 and 2: design a team for the prompt, then write each new or refined
 * agent's definition into the library. Model access is injected as `Complete`,
 * a single forced tool call, so the whole pipeline runs without Pi in tests.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { type AgentDef, loadLibrary, writeAgent } from "./library.ts";
import { manifestPath as manifestFile } from "./runs.ts";

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
/** Tools the verifier never gets: it reports defects, the owning agent fixes them. */
export const VERIFIER_DENIED_TOOLS = ["edit", "write"];
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
						name: { type: "string", description: "kebab-case generic role name (e.g. backend-api-dev), not tied to this project" },
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

const DEFINE_SYSTEM = `You write sub-agent definitions for a coding harness. Each sub-agent is a separate process that receives one task from an orchestrator and must return a concise, complete report of what it did or found. A definition is a reusable role, saved to a library and used again on other projects: it must still make sense on a different project with the same kind of work.
Include: the role's responsibility, what it owns and must not touch, how it works in general (read the task and the repo's existing conventions and contracts before changing anything, verify its own work), and the report format.
Exclude: project or product names, concrete file paths, routes, ports, schemas, class or id names, the chosen stack or versions, step lists for the current deliverable, and any "edit file X" instruction. The orchestrator supplies these in each task.
Grant only the tools the role needs and, only when models are offered, pick a cheaper model when the role is simple. Answer only by calling define_agent.`;

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
			purpose: "Check that the combined result fully and correctly answers the task, and report each defect with the agent that owns it.",
			mode: known.has(verifier) ? "reuse" : "new",
		});
	}
	// A library verifier that may change files must be rewritten as read-only.
	const v = members.find((m) => m.name === verifier) as Member;
	const existing = library.find((a) => a.name === verifier);
	if (v.mode === "reuse" && existing && !isReadOnly(existing)) v.mode = "refine";
	return { members, plan: String(input.plan ?? ""), verifier };
}

export interface PipelineOptions {
	prompt: string;
	/** The project's agent library. */
	dir: string;
	/** Where this run's manifest and logs go (see runs.ts). */
	runDir: string;
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
	const { prompt, dir, runDir, complete, models, runId } = options;
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
			const isVerifier = member.name === team.verifier;
			const request = definePrompt(prompt, member, team, existing, models, isVerifier);
			const res = await complete({ systemPrompt: DEFINE_SYSTEM, prompt: request, tool: DEFINE_TOOL });
			addUsage(res.usage);
			let agent = toAgent(member.name, res.args, models, isVerifier);

			// One rewrite when the definition still carries this project's details.
			const found = findSpecifics(`${agent.description}\n${agent.body}`, prompt);
			if (found.length) {
				progress(`${member.name}: removing project specifics (${found.join(", ")})…`);
				const retry = await complete({
					systemPrompt: DEFINE_SYSTEM,
					prompt: `${request}\n\nYour previous definition contained project-specific details: ${found.join(", ")}. Rewrite it as a generic role without them; the orchestrator gives these in each task.\n\nPrevious definition:\n${agent.body}`,
					tool: DEFINE_TOOL,
				});
				addUsage(retry.usage);
				agent = toAgent(member.name, retry.args, models, isVerifier);
			}
			writeAgent(dir, agent);
			written.set(member.name, agent);
		}),
	);

	const agents = team.members.map(
		(m) => written.get(m.name) ?? (library.find((a) => a.name === m.name) as AgentDef),
	);

	mkdirSync(runDir, { recursive: true });
	const manifestPath = manifestFile(runDir);
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
	isVerifier = false,
): string {
	const roster = team.members.map((m) => `- ${m.name}: ${m.purpose}`).join("\n");
	const parts = [
		`Define the agent "${member.name}". Its purpose: ${member.purpose}`,
		`Overall task (context for scoping the role only; do not copy project specifics into the definition):\n${prompt}`,
		`Full team:\n${roster}\nPlan: ${team.plan}`,
		`Available tools: ${WORKER_TOOLS.join(", ")}`,
		models.length
			? `Available models: ${models.join(", ")}`
			: "Models: inherit only. Do not set model or thinking; every agent runs on the user's default.",
	];
	if (isVerifier) {
		parts.push(
			"This agent is the team's verifier. It must never create, edit or delete files, and never fix anything itself. " +
				"It may run read-only checks, tests, builds and the app, then report each defect with evidence and the team member that owns the affected work, so the orchestrator can send the fix to that owner. It has no edit or write tool.",
		);
	}
	if (existing) {
		parts.push(
			`Existing definition to refine (keep what is generally useful, generalise or remove any project-specific content, and widen the role only where this task shows a gap):\n` +
				`description: ${existing.description}\ntools: ${existing.tools?.join(", ") ?? ""}\n\n${existing.body}`,
		);
	}
	return parts.join("\n\n");
}

function toAgent(name: string, raw: unknown, models: string[], isVerifier = false): AgentDef {
	const args = (raw ?? {}) as Record<string, unknown>;
	const agent: AgentDef = {
		name,
		description: String(args.description ?? name),
		body: `${String(args.systemPrompt ?? "").trim()}\n`,
	};
	const tools = Array.isArray(args.tools) ? args.tools.filter((t) => WORKER_TOOLS.includes(String(t))) : [];
	if (tools.length) agent.tools = tools.map(String);
	if (isVerifier) agent.tools = verifierTools(agent.tools);
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

/** The verifier's tools without edit/write. No tools listed means every tool, so list the safe ones. */
export function verifierTools(tools: string[] | undefined): string[] {
	return (tools?.length ? tools : WORKER_TOOLS).filter((t) => !VERIFIER_DENIED_TOOLS.includes(t));
}

function isReadOnly(agent: AgentDef): boolean {
	return !!agent.tools?.length && !agent.tools.some((t) => VERIFIER_DENIED_TOOLS.includes(t));
}

const ALLOWED_NAMES = new Set(["package.json", "readme.md", "agents.md", "claude.md", "node.js", "next.js", "vue.js", "nuxt.js"]);

/**
 * Project details that slipped into a definition meant to be a reusable role:
 * file paths, routes, ports, CSS selectors and phrases quoted in the prompt.
 */
export function findSpecifics(text: string, prompt: string): string[] {
	const found = new Set<string>();
	const add = (match: string) => {
		const m = match.trim();
		if (m && !ALLOWED_NAMES.has(m.toLowerCase())) found.add(m);
	};
	for (const m of text.matchAll(/(?:\.{0,2}\/)?[\w.-]+\/[\w./-]*\.[a-z]{1,5}\b/gi)) add(m[0]);
	for (const m of text.matchAll(/\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|cs|css|scss|html|sql|db|sqlite|ya?ml|toml)\b/gi)) add(m[0]);
	for (const m of text.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S*/g)) add(m[0]);
	for (const m of text.matchAll(/`\/[a-z][\w/-]*`/gi)) add(m[0].replaceAll("`", ""));
	for (const m of text.matchAll(/\blocalhost:\d+|\bport\s+\d{2,5}\b/gi)) add(m[0]);
	for (const m of text.matchAll(/(?<![\w#&])#[a-z][\w-]*/gi)) add(m[0]);
	for (const m of text.matchAll(/`\.[a-z][\w-]*`/gi)) add(m[0].replaceAll("`", ""));
	const lower = text.toLowerCase();
	for (const m of prompt.matchAll(/"([^"]{3,})"|'([^']{3,})'|`([^`]{3,})`/g)) {
		const phrase = (m[1] ?? m[2] ?? m[3]).trim();
		if (phrase && lower.includes(phrase.toLowerCase())) found.add(`"${phrase}"`);
	}
	return [...found];
}
