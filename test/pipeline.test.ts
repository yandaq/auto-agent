import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadLibrary, writeAgent } from "../extensions/auto-agent/library.ts";
import { type Complete, findSpecifics, normalizeTeam, runPipeline, verifierTools } from "../extensions/auto-agent/pipeline.ts";

const def = (description: string) => ({
	args: { description, tools: ["read", "bash"], systemPrompt: `Prompt for ${description}` },
	usage: { input: 10, output: 5 },
});

describe("normalizeTeam", () => {
	it("slugs names, drops duplicates, and demotes reuse of unknown agents to new", () => {
		const team = normalizeTeam(
			{
				members: [
					{ name: "Code Writer", purpose: "writes", mode: "new" },
					{ name: "code-writer", purpose: "dup", mode: "new" },
					{ name: "ghost", purpose: "x", mode: "reuse" },
					{ name: "checker", purpose: "verifies", mode: "new" },
				],
				plan: "p",
				verifier: "checker",
			},
			[],
		);
		expect(team.members).toEqual([
			{ name: "code-writer", purpose: "writes", mode: "new" },
			{ name: "ghost", purpose: "x", mode: "new" },
			{ name: "checker", purpose: "verifies", mode: "new" },
		]);
		expect(team.verifier).toBe("checker");
	});

	it("adds a verifier when the designer left one out", () => {
		const team = normalizeTeam({ members: [{ name: "a", purpose: "x", mode: "new" }], plan: "" }, []);
		expect(team.verifier).toBe("verifier");
		expect(team.members.map((m) => m.name)).toEqual(["a", "verifier"]);
	});

	it("rejects an empty team", () => {
		expect(() => normalizeTeam({ members: [] }, [])).toThrow(/no team/i);
	});
});

describe("runPipeline", () => {
	it("designs, writes new and refined agents, keeps reused ones, and records a manifest", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		writeAgent(dir, { name: "reviewer", description: "old reviewer", body: "old" });
		writeAgent(dir, { name: "scout", description: "scout", body: "keep me" });

		const complete = vi.fn<Complete>(async (req) => {
			if (req.tool.name === "propose_team") {
				expect(req.prompt).toContain("reviewer: old reviewer");
				return {
					args: {
						members: [
							{ name: "builder", purpose: "build it", mode: "new" },
							{ name: "scout", purpose: "look", mode: "reuse" },
							{ name: "reviewer", purpose: "verify", mode: "refine" },
						],
						plan: "scout, then builder, then reviewer",
						verifier: "reviewer",
					},
					usage: { input: 100, output: 50 },
				};
			}
			return def(req.prompt.includes("Existing definition") ? "refined reviewer" : "new builder");
		});

		const progress: string[] = [];
		const result = await runPipeline({
			prompt: "Build a thing",
			dir,
			runDir: join(dir, "run"),
			complete,
			models: ["anthropic/claude-haiku-4-5"],
			runId: "run-1",
			onProgress: (m) => progress.push(m),
		});

		expect(complete).toHaveBeenCalledTimes(3);
		const byName = Object.fromEntries(loadLibrary(dir).map((a) => [a.name, a]));
		expect(byName.builder.description).toBe("new builder");
		expect(byName.reviewer.description).toBe("refined reviewer");
		expect(byName.scout.body).toBe("keep me");
		expect(result.agents.map((a) => a.name)).toEqual(["builder", "scout", "reviewer"]);
		expect(result.usage).toEqual({ input: 120, output: 60 });

		const manifestPath = join(dir, "run", "manifest.json");
		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		expect(manifest.prompt).toBe("Build a thing");
		expect(manifest.team.members.map((m: { mode: string }) => m.mode)).toEqual(["new", "reuse", "refine"]);
		expect(progress.length).toBeGreaterThan(0);
	});

	it("drops unknown tools and models from generated definitions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		const complete: Complete = async (req) =>
			req.tool.name === "propose_team"
				? { args: { members: [{ name: "v", purpose: "x", mode: "new" }], verifier: "v" } }
				: {
						args: {
							description: "d",
							tools: ["read", "teleport"],
							model: "made/up",
							thinking: "extreme",
							systemPrompt: "s",
						},
					};
		const { agents } = await runPipeline({ prompt: "p", dir, runDir: join(dir, "run"), complete, models: ["a/b"], runId: "r" });
		expect(agents[0]).toEqual({ name: "v", description: "d", tools: ["read"], body: "s\n" });
	});

	it("pins no model or thinking when no models are offered", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		let definePromptText = "";
		const complete: Complete = async (req) => {
			if (req.tool.name === "propose_team") {
				return { args: { members: [{ name: "v", purpose: "x", mode: "new" }], verifier: "v" } };
			}
			definePromptText = req.prompt;
			return { args: { description: "d", model: "a/b", thinking: "high", systemPrompt: "s" } };
		};
		const { agents } = await runPipeline({ prompt: "p", dir, runDir: join(dir, "run"), complete, models: [], runId: "r" });
		expect(agents[0].model).toBeUndefined();
		expect(agents[0].thinking).toBeUndefined();
		expect(definePromptText).toContain("inherit only");
	});

	it("asks for generic roles and generalises refined agents", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		writeAgent(dir, { name: "v", description: "old", body: "old body\n" });
		let systemText = "";
		let promptText = "";
		const complete: Complete = async (req) => {
			if (req.tool.name === "propose_team") {
				return { args: { members: [{ name: "v", purpose: "x", mode: "refine" }], verifier: "v" } };
			}
			systemText = req.systemPrompt;
			promptText = req.prompt;
			return { args: { description: "d", systemPrompt: "s" } };
		};
		await runPipeline({ prompt: "p", dir, runDir: join(dir, "run"), complete, models: [], runId: "r" });
		expect(systemText).toContain("reusable role");
		expect(systemText).toContain("concrete file paths");
		expect(promptText).toContain("do not copy project specifics");
		expect(promptText).toContain("generalise or remove any project-specific content");
	});
});

describe("findSpecifics", () => {
	it("flags paths, routes, ports, selectors and phrases quoted in the prompt", () => {
		const text =
			"Edit `src/db.js` and server.js. Serve GET /api/message on localhost:3000 and port 8080. " +
			"Style #message and `.hero`. Show hello world.";
		const found = findSpecifics(text, 'Display "hello world" from sqlite');
		expect(found).toEqual(
			expect.arrayContaining(["src/db.js", "server.js", "GET /api/message", "localhost:3000", "port 8080", "#message", ".hero", '"hello world"']),
		);
	});

	it("leaves a generic role alone", () => {
		const text =
			"## Responsibilities\nRead the task, package.json and README.md, follow Node.js conventions, and report:\n- Summary\n- Files changed";
		expect(findSpecifics(text, "build an app")).toEqual([]);
	});
});

describe("verifier", () => {
	it("never gets edit or write, even when no tools are listed", () => {
		expect(verifierTools(["read", "bash", "edit", "write"])).toEqual(["read", "bash"]);
		expect(verifierTools(undefined)).toEqual(["read", "bash", "grep", "find", "ls"]);
	});

	it("rewrites a library verifier that can change files", () => {
		const library = [{ name: "checker", description: "c", tools: ["read", "edit"], body: "" }];
		const team = normalizeTeam({ members: [{ name: "checker", purpose: "check", mode: "reuse" }], verifier: "checker" }, library);
		expect(team.members[0].mode).toBe("refine");
	});

	it("keeps a read-only library verifier as is", () => {
		const library = [{ name: "checker", description: "c", tools: ["read", "bash"], body: "" }];
		const team = normalizeTeam({ members: [{ name: "checker", purpose: "check", mode: "reuse" }], verifier: "checker" }, library);
		expect(team.members[0].mode).toBe("reuse");
	});

	it("is defined read-only and told to route fixes to owners", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		let promptText = "";
		const complete: Complete = async (req) => {
			if (req.tool.name === "propose_team") {
				return { args: { members: [{ name: "v", purpose: "x", mode: "new" }], verifier: "v" } };
			}
			promptText = req.prompt;
			return { args: { description: "d", tools: ["read", "bash", "edit", "write"], systemPrompt: "s" } };
		};
		const { agents } = await runPipeline({ prompt: "p", dir, runDir: join(dir, "run"), complete, models: [], runId: "r" });
		expect(agents[0].tools).toEqual(["read", "bash"]);
		expect(promptText).toContain("never create, edit or delete files");
		expect(promptText).toContain("owns the affected work");
	});
});

describe("generic definitions", () => {
	it("asks once for a rewrite when a definition carries project specifics", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		const bodies = ["Write src/db.js for GET /api/message.", "Own the data layer and report the contract."];
		const prompts: string[] = [];
		const complete: Complete = async (req) => {
			if (req.tool.name === "propose_team") {
				return { args: { members: [{ name: "dev", purpose: "x", mode: "new" }, { name: "v", purpose: "y", mode: "new" }], verifier: "v" } };
			}
			if (!req.prompt.includes('"dev"')) return { args: { description: "v", tools: ["read"], systemPrompt: "Check and report." } };
			prompts.push(req.prompt);
			return { args: { description: "d", tools: ["read"], systemPrompt: bodies[prompts.length - 1] } };
		};
		const { agents } = await runPipeline({ prompt: "p", dir, runDir: join(dir, "run"), complete, models: [], runId: "r" });
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("src/db.js");
		expect(prompts[1]).toContain("generic role");
		expect(agents[0].body).toBe("Own the data layer and report the contract.\n");
	});
});

