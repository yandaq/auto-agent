# auto-agent

A Pi extension. It is off by default: type `/auto-agent` (you'll see "auto-agent activated") and the next prompt is answered by a team of sub-agents designed for that prompt. Type `/auto-agent` again to deactivate it, which drops the team and gives the session its normal tools back.

1. **Design** — a nested model call proposes a team (reusing or refining agents already in the library, always with a verifier). The verifier is read-only: it reports defects, and the orchestrator sends each fix to the agent that owns that work.
2. **Define** — each new or refined agent is written to the project's own `.pi/sub-agents/<name>.md`, in parallel. Definitions are generic roles; a definition that still names project paths, routes, ports, selectors or phrases quoted in the prompt is sent back once to be rewritten. Run records (manifest and worker logs) go outside the project, to `~/.pi/agent/auto-agent/runs/<project>-<hash>/<run-id>/`, so workers never read each other's transcripts; set `PI_AUTOAGENT_RUNS_DIR` to change the root. Each project has its own library; if pi is started in your home directory (or above it), no team is designed, so nothing lands in the global `~/.pi`.
3. **Orchestrate** — your session becomes the orchestrator and runs the team with the `spawn_agents` tool. It can only read and delegate (`read`, `grep`, `find`, `ls`, `spawn_agents`); all code, tests and fixes are done by sub-agents. Each worker is a separate `pi` process.

After that, later prompts behave like normal Pi, and `spawn_agents` stays available. See [SPEC.md](SPEC.md) for the full design.

## Install

```sh
ln -s "$PWD/extensions/auto-agent" ~/.pi/agent/extensions/auto-agent
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PI_AUTOAGENT_ENABLED` | off | `1` starts every session with auto-agent already on, as if you had typed `/auto-agent` |
| `PI_AUTOAGENT_CONCURRENCY` | unlimited | Max workers running at once per `spawn_agents` call |
| `PI_AUTOAGENT_MAX_DEPTH` | 2 | Worker nesting cap (2 = orchestrator → worker → helper) |
| `PI_AUTOAGENT_VIEW` | auto | Live view per worker: `herdr` (tab), `tmux` (window), `ghostty` (window; on macOS one shared window of tiled panes) or `off`. Auto picks herdr inside herdr, tmux inside tmux, else Ghostty on a desktop, else off |
| `PI_AUTOAGENT_VIEW_CLOSE` | 30 | Seconds a view stays open after its agent finishes; `0` keeps it open |
| `PI_AUTOAGENT_VIEW_PANES` | 32 | macOS Ghostty: panes tiled per tab (up to 8×4, font shrinking to fit) before a new tab opens; `1` gives one tab per agent |
| `PI_AUTOAGENT_PIN_MODELS` | off | `1` lets the designer pin each agent to a model and effort, chosen from your `enabledModels`. Off: every agent runs on your pi default model and thinking level |

### Live views

Each worker writes a readable transcript (streamed text, tool calls, final ✔/✖) to the run's `logs/` folder under `~/.pi/agent/auto-agent/runs/<project>-<hash>/<run-id>/`, and a view window tails it. The run's `manifest.json` also records every spawn (agent, task, status, turns, tokens, times, log path) and lists which team members were used and which were not. Views close 30 seconds after the agent finishes (set `PI_AUTOAGENT_VIEW_CLOSE`); the log file is kept. Only the orchestrator's workers get views, not nested helpers.

## Tests

```sh
npm test          # unit tests, model mocked
npm run test:e2e  # real pi + model; AUTO_AGENT_E2E_MODEL overrides the model
```
