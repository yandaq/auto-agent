import type { AgentDef } from "./library.ts";
import type { Team } from "./pipeline.ts";
import { SPAWN_TOOL } from "./worker.ts";

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
- Parallel sub-agents must never edit the same files. Partition files between them; sequence the work when edits would overlap.
- When a sub-agent fails, decide yourself whether to retry, reassign, or work around it; the harness never retries.
- Before reporting back, run the verifier "${team.verifier}" on the combined result and act on what it finds.
- You may still do small things directly when delegating would be slower.`;
}
