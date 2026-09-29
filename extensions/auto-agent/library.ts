/**
 * The sub-agent library: markdown files in `.pi/sub-agents`, one agent each.
 * Frontmatter carries the launch settings; the body is the system prompt.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	body: string;
}

export const LIBRARY_DIR = join(".pi", "sub-agents");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseAgent(markdown: string): AgentDef | null {
	const match = FRONTMATTER.exec(markdown);
	if (!match) return null;

	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	if (!fields.name || !fields.description) return null;

	const agent: AgentDef = { name: fields.name, description: fields.description, body: match[2] };
	if (fields.tools) {
		agent.tools = fields.tools
			.replace(/^\[|\]$/g, "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	if (fields.model) agent.model = fields.model;
	if (fields.thinking) agent.thinking = fields.thinking;
	return agent;
}

export function serializeAgent(agent: AgentDef): string {
	const lines = ["---", `name: ${agent.name}`, `description: ${oneLine(agent.description)}`];
	if (agent.tools?.length) lines.push(`tools: ${agent.tools.join(", ")}`);
	if (agent.model) lines.push(`model: ${agent.model}`);
	if (agent.thinking) lines.push(`thinking: ${agent.thinking}`);
	lines.push("---");
	return `${lines.join("\n")}\n${agent.body}`;
}

/**
 * The project's library dir, or undefined when `cwd` is the home directory or
 * above it: `<home>/.pi` is pi's global folder, and agents belong to a project.
 */
export function projectLibraryDir(cwd: string, home: string = homedir()): string | undefined {
	const rel = relative(resolve(cwd), resolve(home));
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return undefined;
	return join(cwd, LIBRARY_DIR);
}

export function loadLibrary(dir: string): AgentDef[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => parseAgent(readFileSync(join(dir, file), "utf8")))
		.filter((agent): agent is AgentDef => agent !== null);
}

export function writeAgent(dir: string, agent: AgentDef): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${agent.name}.md`);
	writeFileSync(path, serializeAgent(agent));
	return path;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
