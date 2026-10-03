import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifestPath, projectRunsDir, recordSpawns, type SpawnRecord } from "../extensions/auto-agent/runs.ts";
import { workerTask } from "../extensions/auto-agent/worker.ts";

const spawn = (agent: string, input = 10, id = `${agent}-${input}`): SpawnRecord => ({
	id,
	agent,
	task: "t",
	status: "done",
	exitCode: 0,
	turns: 1,
	toolCalls: 2,
	usage: { input, output: 1 },
	startedAt: "a",
	finishedAt: "b",
});

describe("projectRunsDir", () => {
	it("lives outside the project, one stable folder per project", () => {
		const dir = projectRunsDir("/work/hello-world", {}, "/home/u");
		expect(dir.startsWith(join("/home/u", ".pi", "agent", "auto-agent", "runs", "hello-world-"))).toBe(true);
		expect(projectRunsDir("/work/hello-world", {}, "/home/u")).toBe(dir);
		expect(projectRunsDir("/other/hello-world", {}, "/home/u")).not.toBe(dir);
	});

	it("honours the override", () => {
		expect(projectRunsDir("/work/app", { PI_AUTOAGENT_RUNS_DIR: "/tmp/r" }).startsWith("/tmp/r/app-")).toBe(true);
	});
});

describe("recordSpawns", () => {
	it("appends spawns and tracks used and unused team members", () => {
		const path = manifestPath(mkdtempSync(join(tmpdir(), "aa-")));
		writeFileSync(path, JSON.stringify({ team: { members: [{ name: "a" }, { name: "b" }, { name: "c" }] }, usage: { input: 5, output: 5 } }));
		recordSpawns(path, [spawn("a"), spawn("b")]);
		recordSpawns(path, [spawn("a", 20)]);
		const m = JSON.parse(readFileSync(path, "utf8"));
		expect(m.spawns).toHaveLength(3);
		expect(m.agentsUsed).toEqual({ a: 2, b: 1 });
		expect(m.agentsUnused).toEqual(["c"]);
		expect(m.usage).toEqual({ input: 5, output: 5, workers: { input: 40, output: 3 } });
	});

	it("records a spawn as running, then replaces it with its result", () => {
		const path = manifestPath(mkdtempSync(join(tmpdir(), "aa-")));
		recordSpawns(path, [{ ...spawn("a", 0, "b1-1"), status: "running", finishedAt: undefined }]);
		expect(JSON.parse(readFileSync(path, "utf8")).spawns[0].status).toBe("running");
		recordSpawns(path, [spawn("a", 7, "b1-1")]);
		const m = JSON.parse(readFileSync(path, "utf8"));
		expect(m.spawns).toHaveLength(1);
		expect(m.spawns[0]).toMatchObject({ status: "done", finishedAt: "b" });
		expect(m.agentsUsed).toEqual({ a: 1 });
	});
});

it("tells workers to ignore the .pi folder", () => {
	expect(workerTask("do x", "orig")).toContain("Ignore the .pi folder");
});
