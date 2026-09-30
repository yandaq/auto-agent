# auto-agent — spec

A Pi extension (`@earendil-works/pi-coding-agent`, v0.87+) that turns the first prompt of a session into a team of sub-agents designed for that prompt, then orchestrates them from the HITL session.

## Pipeline (first prompt only)

1. **Intercept** — the `input` event catches the session's first non-steer prompt. Later prompts are handled by Pi as normal.
2. **Design the team** — a nested model call (`ctx.modelRegistry.complete`) sees the prompt plus the existing library in `./.pi/sub-agents`. It returns the team through a `propose_team` tool call:
   - For each agent: `{ name, purpose, reuse: existingName | null }`.
   - A short parallel/sequence plan, used only as a hint.
   - The team always includes a verifier.
3. **Write the definitions** — one nested call per new or refined agent, all run in parallel. Each call writes `./.pi/sub-agents/<name>.md`:
   - Frontmatter: `name, description, tools, model?, thinking?`.
   - The body is the agent's system prompt.
   - The designer may choose cheaper models for simple roles; otherwise the agent inherits the session model.
   - A refined agent's file is overwritten in place.
4. **Manifest** — each run writes `./.pi/sub-agents/runs/<run-id>.json` recording the prompt, team, plan, and which agents were created, reused or refined.
5. **Orchestrate** — the HITL session gets an orchestrator system prompt (`before_agent_start`) and receives the original prompt. Its brief is to finish the task as fast as possible using the team, with no limit on fan-out. The orchestrator only reads and delegates: its active tools are cut to `read`, `grep`, `find`, `ls` and `spawn_agents`, and a `tool_call` hook blocks any other tool, so every code change, test run and post-verification fix goes to a sub-agent.

No human checkpoints. Progress appears as status notifications.

## `spawn_agents` tool

- Available in the HITL session for the rest of the session. Later prompts may reuse the team, but no new team is designed.
- Accepts `{ tasks: [{ agent, task }] }`, which run in parallel.
- Each worker runs `pi --mode json -p --no-session`, with `--model`, `--thinking`, `--tools` and `--append-system-prompt <agent body>` set from the agent's file.
- Each worker receives its task plus the original prompt, labelled as background.
- Concurrency is unlimited by default and can be overridden with `PI_AUTOAGENT_CONCURRENCY`.
- **Depth:** `PI_AUTOAGENT_DEPTH` is passed to children. Workers may spawn one further level. The maximum is configurable with `PI_AUTOAGENT_MAX_DEPTH` (default 2).
- **Results:** the orchestrator gets each worker's final output, capped in size. The full output stays in the tool result `details`.
- **Failures:** the exit code and error are reported, and the orchestrator decides what to do. There are no automatic retries.
- **Shared files:** the orchestrator prompt tells it to split work so that parallel workers never edit the same files.
- **TUI widget:** a live table of agent, status, turns and tokens.
- **Nested model calls** include their `usage` in the tool result.

## Coexistence

- The tool is named `spawn_agents`, which doesn't clash with `multi-agent`'s `dispatch`.
- A warning is shown at startup if `multi-agent` is also loaded.

## Layout

- The extension lives in this repo and is symlinked into `~/.pi/agent/extensions/auto-agent`.
- It is a standalone implementation. Pi's example sub-agent extension serves only as a reference for the spawn and JSON-stream pattern.

## Tests

- vitest unit tests for the pipeline, with the model mocked.
- One end-to-end smoke test that runs real `pi` on a trivial prompt.
