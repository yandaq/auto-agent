/**
 * Live views of sub-agents: each worker's transcript log is tailed in its own
 * Ghostty window, tmux window or herdr tab. Views are best-effort — a failure
 * to open one never affects the run.
 */

import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

export type ViewerBackend = "herdr" | "tmux" | "ghostty" | "off";
export const VIEW_ENV = "PI_AUTOAGENT_VIEW";

type Env = Record<string, string | undefined>;
const BACKENDS: ViewerBackend[] = ["herdr", "tmux", "ghostty", "off"];

/** `PI_AUTOAGENT_VIEW` wins; otherwise herdr, then tmux, then Ghostty on a desktop. */
export function viewerBackend(env: Env = process.env, platform: NodeJS.Platform = process.platform): ViewerBackend {
	const forced = env[VIEW_ENV]?.trim().toLowerCase();
	if (forced && (BACKENDS as string[]).includes(forced)) return forced as ViewerBackend;
	if (env.HERDR_ENV === "1") return "herdr";
	if (env.TMUX) return "tmux";
	// macOS always has a desktop; elsewhere Ghostty needs an X11/Wayland display.
	if (env.TERM_PROGRAM === "ghostty" && (platform === "darwin" || env.DISPLAY || env.WAYLAND_DISPLAY)) return "ghostty";
	return "off";
}

export const VIEW_CLOSE_ENV = "PI_AUTOAGENT_VIEW_CLOSE";
const DEFAULT_CLOSE_SECONDS = 30;
/** Last lines the worker writes to its log (see runWorker). */
const END_MARKER = "^(✔ done|✖ failed|■ aborted)";

/** Seconds a view stays open after its agent finishes; 0 keeps it open. */
export function closeDelay(env: Env = process.env): number {
	const n = Number.parseInt(env[VIEW_CLOSE_ENV] ?? "", 10);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CLOSE_SECONDS;
}

export function viewerCommand(
	backend: Exclude<ViewerBackend, "off" | "herdr">,
	title: string,
	logPath: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	const script = viewerScriptPath(logPath);
	if (backend === "tmux") {
		return { command: "tmux", args: ["new-window", "-d", "-n", title, shellJoin(["sh", script])] };
	}
	// Ghostty drops some arguments after -e (e.g. `-n +1`), so it gets one script path.
	// On macOS the ghostty CLI cannot open windows; a new app instance must be launched via `open`.
	if (platform === "darwin") {
		return { command: "open", args: ["-na", "Ghostty.app", "--args", `--title=${title}`, "-e", script] };
	}
	return { command: "ghostty", args: [`--title=${title}`, "-e", script] };
}

export function viewerScriptPath(logPath: string): string {
	return `${logPath}.sh`;
}

/** Follow the log from its start; once the agent is done, exit after `closeAfter` seconds (0: never). */
export function viewerScript(logPath: string, closeAfter: number): string {
	const log = shellJoin([logPath]);
	if (closeAfter <= 0) return `#!/bin/sh\nexec tail -n +1 -F ${log}\n`;
	return [
		"#!/bin/sh",
		`tail -n +1 -F ${log} &`,
		"tail_pid=$!",
		`until grep -qE '${END_MARKER}' ${log} 2>/dev/null; do sleep 1; done`,
		`sleep 1; printf '\\nClosing in ${closeAfter}s…\\n'`,
		`sleep ${closeAfter}`,
		'kill "$tail_pid" 2>/dev/null',
		"",
	].join("\n");
}

export function herdrTabArgs(title: string, cwd: string): string[] {
	return ["tab", "create", "--no-focus", "--label", title, "--cwd", cwd];
}

/** `tab create` returns `.result.root_pane`, either an id or an object holding one. */
export function herdrPaneId(output: string): string | undefined {
	try {
		const pane = JSON.parse(output)?.result?.root_pane;
		if (typeof pane === "string") return pane;
		const id = pane?.pane_id ?? pane?.id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

export async function openViewer(backend: ViewerBackend, title: string, logPath: string, cwd: string): Promise<void> {
	if (backend === "off") return;
	writeFileSync(viewerScriptPath(logPath), viewerScript(logPath, closeDelay()), { mode: 0o755 });
	if (backend === "herdr") {
		const created = await run("herdr", herdrTabArgs(title, cwd), cwd);
		const pane = herdrPaneId(created);
		if (!pane) throw new Error("herdr tab create returned no pane id");
		await run("herdr", ["pane", "run", pane, `${shellJoin(["sh", viewerScriptPath(logPath)])}; exit`], cwd);
		return;
	}
	const { command, args } = viewerCommand(backend, title, logPath);
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
		proc.once("error", reject);
		proc.once("spawn", () => {
			proc.unref();
			resolve();
		});
	});
}

function run(command: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}

function shellJoin(args: string[]): string {
	return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
