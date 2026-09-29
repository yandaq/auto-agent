# auto-agent

A Pi extension. The first prompt of a session is answered by a team of sub-agents designed for that prompt:

1. **Design** — a nested model call proposes a team (reusing or refining agents already in the library, always with a verifier).
2. **Define** — each new or refined agent is written to the project's own `.pi/sub-agents/<name>.md`, in parallel. A run manifest goes to `.pi/sub-agents/runs/`. Each project has its own library; if pi is started in your home directory (or above it), no team is designed, so nothing lands in the global `~/.pi`.
3. **Orchestrate** — your session becomes the orchestrator and runs the team with the `spawn_agents` tool. Each worker is a separate `pi` process.

Later prompts behave like normal Pi, and `spawn_agents` stays available. See [SPEC.md](SPEC.md) for the full design.

## Install

```sh
ln -s "$PWD/extensions/auto-agent" ~/.pi/agent/extensions/auto-agent
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PI_AUTOAGENT_CONCURRENCY` | unlimited | Max workers running at once per `spawn_agents` call |
| `PI_AUTOAGENT_MAX_DEPTH` | 2 | Worker nesting cap (2 = orchestrator → worker → helper) |
| `PI_AUTOAGENT_VIEW` | auto | Live view per worker: `herdr` (tab), `tmux` (window), `ghostty` (window) or `off`. Auto picks herdr inside herdr, tmux inside tmux, else Ghostty on a desktop, else off |
| `PI_AUTOAGENT_VIEW_CLOSE` | 30 | Seconds a view stays open after its agent finishes; `0` keeps it open |
| `PI_AUTOAGENT_PIN_MODELS` | off | `1` lets the designer pin each agent to a model and effort, chosen from your `enabledModels`. Off: every agent runs on your pi default model and thinking level |

### Live views

Each worker writes a readable transcript (streamed text, tool calls, final ✔/✖) to `.pi/sub-agents/runs/<run-id>/logs/`, and a view window tails it. Views close 30 seconds after the agent finishes (set `PI_AUTOAGENT_VIEW_CLOSE`); the log file is kept. Only the orchestrator's workers get views, not nested helpers.

## Tests

```sh
npm test          # unit tests, model mocked
npm run test:e2e  # real pi + model; AUTO_AGENT_E2E_MODEL overrides the model
```
