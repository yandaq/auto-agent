/**
 * Run records: the manifest and worker logs of each run. They live outside the
 * project, so workers browsing the repo never find each other's transcripts.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const RUNS_ENV = "PI_AUTOAGENT_RUNS_DIR";

type Env = Record<string, string | undefined>;

/** `<root>/<project>-<hash>`: one folder per project, named so it is easy to find. */
export function projectRunsDir(cwd: string, env: Env = process.env, home: string = homedir()): string {
	const root = env[RUNS_ENV] || join(home, ".pi", "agent", "auto-agent", "runs");
	const abs = resolve(cwd);
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
	return join(root, `${basename(abs) || "root"}-${hash}`);
}

export function runDir(cwd: string, runId: string, env: Env = process.env): string {
	return join(projectRunsDir(cwd, env), runId);
}

export function manifestPath(dir: string): string {
	return join(dir, "manifest.json");
}

export interface SpawnRecord {
	/** Unique within the run; a later record with the same id replaces the earlier one. */
	id: string;
	agent: string;
	task: string;
	status: string;
	exitCode: number;
	turns: number;
	toolCalls: number;
	usage: { input: number; output: number };
	startedAt: string;
	finishedAt?: string;
	logPath?: string;
	error?: string;
}

/**
 * Add spawns to the run's manifest, or update ones already recorded (by id), and
 * refresh which team members have been used. Spawns are recorded as running when
 * they start, so a killed session still leaves a trace. Synchronous, so
 * concurrent writes can't interleave.
 */
export function recordSpawns(path: string, spawns: SpawnRecord[]): void {
	let manifest: Record<string, any> = {};
	if (existsSync(path)) {
		try {
			manifest = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			// A damaged manifest is replaced rather than blocking the run.
		}
	}
	const all: SpawnRecord[] = Array.isArray(manifest.spawns) ? manifest.spawns : [];
	for (const spawn of spawns) {
		const at = all.findIndex((s) => s.id === spawn.id);
		if (at === -1) all.push(spawn);
		else all[at] = spawn;
	}
	manifest.spawns = all;

	const used: Record<string, number> = {};
	for (const s of all) used[s.agent] = (used[s.agent] ?? 0) + 1;
	manifest.agentsUsed = used;
	const members: string[] = (manifest.team?.members ?? []).map((m: { name: string }) => m.name);
	manifest.agentsUnused = members.filter((name) => !used[name]);
	manifest.usage = {
		...(manifest.usage ?? {}),
		workers: all.reduce(
			(sum, s) => ({ input: sum.input + s.usage.input, output: sum.output + s.usage.output }),
			{ input: 0, output: 0 },
		),
	};

	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(manifest, null, 2));
}
