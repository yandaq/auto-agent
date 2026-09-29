import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWorkerArgs,
	concurrencyLimit,
	depthConfig,
	formatEvent,
	mapWithLimit,
	runWorker,
	SPAWN_TOOL,
	truncate,
	workerTask,
} from "../extensions/auto-agent/worker.ts";

const agent = { name: "builder", description: "d", tools: ["read", "bash"], body: "b" };

describe("depth and concurrency config", () => {
	it("reads depth and max depth from the environment", () => {
		expect(depthConfig({})).toEqual({ depth: 0, maxDepth: 2 });
		expect(depthConfig({ PI_AUTOAGENT_DEPTH: "1", PI_AUTOAGENT_MAX_DEPTH: "4" })).toEqual({ depth: 1, maxDepth: 4 });
	});

	it("is unlimited unless overridden", () => {
		expect(concurrencyLimit({})).toBe(Number.POSITIVE_INFINITY);
		expect(concurrencyLimit({ PI_AUTOAGENT_CONCURRENCY: "3" })).toBe(3);
		expect(concurrencyLimit({ PI_AUTOAGENT_CONCURRENCY: "junk" })).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("buildWorkerArgs", () => {
	it("lets a child below the depth cap spawn helpers", () => {
		const args = buildWorkerArgs(agent, "do it", "/tmp/p.md", { childDepth: 1, maxDepth: 2 });
		expect(args.slice(0, 4)).toEqual(["--mode", "json", "-p", "--no-session"]);
		expect(args).toContain(`read,bash,${SPAWN_TOOL}`);
		expect(args).not.toContain("--exclude-tools");
		expect(args.at(-1)).toBe("do it");
	});

	it("strips the spawn tool at the depth cap and inherits model and thinking", () => {
		const args = buildWorkerArgs({ ...agent, tools: undefined }, "t", "/p", {
			childDepth: 2,
			maxDepth: 2,
			inheritedModel: "a/b",
			inheritedThinking: "high",
		});
		expect(args).toEqual(expect.arrayContaining(["--model", "a/b", "--thinking", "high", "--exclude-tools", SPAWN_TOOL]));
	});

	it("prefers the agent's own model and thinking", () => {
		const args = buildWorkerArgs({ ...agent, model: "x/y", thinking: "low" }, "t", "/p", {
			childDepth: 1,
			maxDepth: 2,
			inheritedModel: "a/b",
			inheritedThinking: "high",
		});
		expect(args).toEqual(expect.arrayContaining(["--model", "x/y", "--thinking", "low"]));
		expect(args).not.toContain("a/b");
	});
});

describe("helpers", () => {
	it("labels the original prompt as background", () => {
		const text = workerTask("fix foo", "the whole job");
		expect(text).toMatch(/^Task: fix foo/);
		expect(text).toContain("Background");
		expect(text).toContain("the whole job");
	});

	it("truncates long output", () => {
		expect(truncate("abc", 10)).toBe("abc");
		expect(truncate("a".repeat(20), 10)).toMatch(/^a{10}\n\n\[Output truncated/);
	});

	it("runs everything at once when unlimited, and respects a limit", async () => {
		let live = 0;
		let peak = 0;
		const work = async (n: number) => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((r) => setTimeout(r, 5));
			live--;
			return n * 2;
		};
		expect(await mapWithLimit([1, 2, 3, 4], Number.POSITIVE_INFINITY, work)).toEqual([2, 4, 6, 8]);
		expect(peak).toBe(4);
		peak = 0;
		await mapWithLimit([1, 2, 3, 4], 2, work);
		expect(peak).toBe(2);
	});
});

describe("runWorker", () => {
	it("streams a child's JSON events into a result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		const fake = join(dir, "fake-pi.mjs");
		writeFileSync(
			fake,
			`const out = (e) => console.log(JSON.stringify(e));
			out({ type: "session", id: "x" });
			out({ type: "turn_start" });
			out({ type: "tool_execution_start", toolName: "bash" });
			out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "all done" }], usage: { input: 7, output: 3 } } });
			process.stdout.write("not json\\n");`,
		);
		const updates: string[] = [];
		const result = await runWorker({
			agent,
			task: "t",
			originalPrompt: "p",
			cwd: dir,
			env: {},
			command: { command: process.execPath, args: [fake] },
			onUpdate: (s) => updates.push(s.status),
		});
		expect(result).toMatchObject({ status: "done", exitCode: 0, output: "all done", turns: 1, toolCalls: 1 });
		expect(result.usage).toEqual({ input: 7, output: 3 });
		expect(updates).toContain("running");
	});

	it("reports a failing child with its stderr", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		const fake = join(dir, "fail.mjs");
		writeFileSync(fake, "console.error('boom'); process.exit(3);");
		const result = await runWorker({
			agent,
			task: "t",
			originalPrompt: "p",
			cwd: dir,
			env: {},
			command: { command: process.execPath, args: [fake] },
		});
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(3);
		expect(result.error).toBe("boom");
	});

	it("writes a readable transcript when given a log path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		const fake = join(dir, "fake-pi.mjs");
		writeFileSync(
			fake,
			`const out = (e) => console.log(JSON.stringify(e));
			out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
			out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "there" } });
			out({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
			out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] } });`,
		);
		const logPath = join(dir, "worker.log");
		await runWorker({
			agent,
			task: "list files",
			originalPrompt: "p",
			cwd: dir,
			env: {},
			logPath,
			command: { command: process.execPath, args: [fake] },
		});
		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("list files");
		expect(log).toContain("Hello there");
		expect(log).toContain('▸ bash {"command":"ls"}');
		expect(log.trimEnd().endsWith("✔ done")).toBe(true);
	});
});

describe("formatEvent", () => {
	it("shows text deltas and tool calls, and hides everything else", () => {
		expect(formatEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } })).toBe("hi");
		expect(formatEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } })).toBeUndefined();
		expect(formatEvent({ type: "tool_execution_start", toolName: "read", args: { path: "a" } })).toBe('\n▸ read {"path":"a"}\n');
		expect(formatEvent({ type: "turn_start" })).toBeUndefined();
	});

	it("shows the first line of a failed tool's error", () => {
		const failed = (text: string) => ({ type: "tool_execution_end", isError: true, result: { content: [{ type: "text", text }] } });
		expect(formatEvent(failed("\nENOENT: no such file, open 'package.json'\nstack…"))).toBe("  ✖ ENOENT: no such file, open 'package.json'\n");
		expect(formatEvent({ type: "tool_execution_end", isError: true, result: {} })).toBe("  ✖ tool error\n");
		expect(formatEvent(failed("fine").type && { type: "tool_execution_end", isError: false })).toBeUndefined();
	});
});
