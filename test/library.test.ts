import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLibrary, parseAgent, projectLibraryDir, serializeAgent, writeAgent } from "../extensions/auto-agent/library.ts";

describe("agent files", () => {
	it("round-trips through markdown", () => {
		const agent = {
			name: "scout",
			description: "Fast recon",
			tools: ["read", "grep"],
			model: "anthropic/claude-haiku-4-5",
			thinking: "low",
			body: "You are a scout.\n",
		};
		expect(parseAgent(serializeAgent(agent))).toEqual(agent);
	});

	it("accepts a comma-separated tools string and omits absent fields", () => {
		const md = "---\nname: a\ndescription: b\ntools: read, bash\n---\nBody";
		expect(parseAgent(md)).toEqual({ name: "a", description: "b", tools: ["read", "bash"], body: "Body" });
	});

	it("rejects files without name or description", () => {
		expect(parseAgent("---\nname: a\n---\nx")).toBeNull();
		expect(parseAgent("no frontmatter")).toBeNull();
	});

	it("loads a directory, skipping invalid files and the runs folder", () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-"));
		writeAgent(dir, { name: "one", description: "d", body: "b" });
		writeFileSync(join(dir, "bad.md"), "nope");
		expect(loadLibrary(dir).map((a) => a.name)).toEqual(["one"]);
		expect(loadLibrary(join(dir, "missing"))).toEqual([]);
	});
});

describe("projectLibraryDir", () => {
	it("resolves inside a project under home", () => {
		expect(projectLibraryDir("/home/u/proj", "/home/u")).toBe(join("/home/u/proj", ".pi", "sub-agents"));
	});
	it("refuses home itself and anything above it", () => {
		expect(projectLibraryDir("/home/u", "/home/u")).toBeUndefined();
		expect(projectLibraryDir("/home/u/", "/home/u")).toBeUndefined();
		expect(projectLibraryDir("/", "/home/u")).toBeUndefined();
	});
	it("allows projects outside home", () => {
		expect(projectLibraryDir("/srv/proj", "/home/u")).toBe(join("/srv/proj", ".pi", "sub-agents"));
	});
});
