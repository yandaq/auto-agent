/**
 * Real pi, real model. Opt in with `npm run test:e2e`; set AUTO_AGENT_E2E_MODEL
 * to choose the model (defaults to a fast hosted one).
 */

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const enabled = process.env.AUTO_AGENT_E2E === "1";
const model = process.env.AUTO_AGENT_E2E_MODEL ?? "anthropic/claude-haiku-4-5";
const extension = resolve(import.meta.dirname, "../../extensions/auto-agent/index.ts");

it.runIf(enabled)(
	"designs a team, writes definitions and orchestrates it to finish the task",
	() => {
		const cwd = mkdtempSync(join(tmpdir(), "auto-agent-e2e-"));
		execFileSync("git", ["init", "-q"], { cwd });
		const run = spawnSync(
			"pi",
			[
				"--mode", "json", "-p", "--no-session", "--no-extensions", "-e", extension,
				"--model", model, "--thinking", "off",
				"Create a.txt containing 'alpha' and b.txt containing 'beta'.",
			],
			{ cwd, encoding: "utf8", timeout: 540_000 },
		);
		expect(run.status).toBe(0);

		const dir = join(cwd, ".pi", "sub-agents");
		expect(readdirSync(dir).filter((f) => f.endsWith(".md")).length).toBeGreaterThanOrEqual(2);
		expect(readdirSync(join(dir, "runs"))).toHaveLength(1);
		expect(run.stdout).toContain('"toolName":"spawn_agents"');
		expect(existsSync(join(cwd, "a.txt")) && existsSync(join(cwd, "b.txt"))).toBe(true);
	},
	600_000,
);
