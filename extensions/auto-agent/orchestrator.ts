import type { AgentDef } from "./library.ts";
import type { Team } from "./pipeline.ts";
import { SPAWN_TOOL } from "./worker.ts";

/** The only tools the orchestrator may use: it reads, plans and delegates, never changes files. */
export const ORCHESTRATOR_TOOLS = ["read", "grep", "find", "ls", SPAWN_TOOL];

/** Why the orchestrator may not call `toolName`, or undefined when it may. */
export function blockedToolReason(toolName: string): string | undefined {
	if (ORCHESTRATOR_TOOLS.includes(toolName)) return undefined;
	return `auto-agent: the orchestrator cannot use "${toolName}". It only reads and delegates; give this work, including writing code, writing or running tests and fixing verifier findings, to a sub-agent with ${SPAWN_TOOL}.`;
}

/** Appended to the HITL session's system prompt once a team exists. */
export function orchestratorPrompt(team: Team, agents: AgentDef[]): string {
	const roster = agents
		.map((a) => {
			const purpose = team.members.find((m) => m.name === a.name)?.purpose;
			return `- ${a.name}: ${a.description}${purpose ? ` — on this task: ${purpose}` : ""}`;
		})
		.join("\n");

	return `## Orchestrator mode (auto-agent)

You are the orchestrator of a team of sub-agents. Complete the user's request as quickly as possible by delegating to the team with the \`${SPAWN_TOOL}\` tool. Compute is unlimited: there is no cap on how many sub-agents run at once, so split the work into as many independent tasks as it allows and launch independent tasks together in a single call.

Team:
${roster}

Suggested plan (a hint, not a script): ${team.plan || "(none)"}

Rules:
- Give each sub-agent a self-contained task: it sees only your task text plus the user's original request as background.
- Agent definitions are generic roles. Each task you send must carry the project specifics: goal, files to own, interfaces and contracts to match, and acceptance checks.
- Pass results forward yourself. When a task builds on earlier work, copy the facts it needs from those agents' reports into the task: contracts, signatures, file paths, commands, decisions. Sub-agents cannot see each other's reports or logs.
- Respect dependencies. Never start an agent whose inputs another agent is still producing. Start dependent work in parallel only when the contract it codes against is fixed in your task text; otherwise wait for the producer's report.
- Parallel sub-agents must never edit the same files. Partition files between them; sequence the work when edits would overlap.
- Never write code, tests or docs yourself, and never run commands. Your only tools are ${ORCHESTRATOR_TOOLS.join(", ")}. All changes, test runs and fixes go to a sub-agent.
- When a sub-agent fails, decide yourself whether to retry, reassign, or work around it; the harness never retries.
- Before reporting back, run the verifier "${team.verifier}" on the combined result. The verifier never changes files: send each defect it reports to the agent that owns the affected work, with the verifier's evidence, then run the verifier again. Repeat until it passes or you hit a blocker you must report.`;
}
