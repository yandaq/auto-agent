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
): { command: string; args: string[] } {
	const script = viewerScriptPath(logPath);
	if (backend === "tmux") {
		return { command: "tmux", args: ["new-window", "-d", "-n", title, shellJoin(["sh", script])] };
	}
	// Ghostty drops some arguments after -e (e.g. `-n +1`), so it gets one script path.
	return { command: "ghostty", args: [`--title=${title}`, "-e", script] };
}

export function viewerScriptPath(logPath: string): string {
	return `${logPath}.sh`;
}

/** Follow the log from its start; once the agent is done, exit after `closeAfter` seconds (0: never). */
export function viewerScript(logPath: string, closeAfter: number, title?: string): string {
	const log = shellJoin([logPath]);
	// OSC 0 names the tab where the terminal cannot be given a title up front (Ghostty AppleScript tabs).
	const head = title ? `#!/bin/sh\nprintf '\\033]0;%s\\007' ${shellJoin([title])}\n` : "#!/bin/sh\n";
	if (closeAfter <= 0) return `${head}exec tail -n +1 -F ${log}\n`;
	return [
		head.trimEnd(),
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
	const macGhostty = backend === "ghostty" && process.platform === "darwin";
	writeFileSync(viewerScriptPath(logPath), viewerScript(logPath, closeDelay(), macGhostty ? title : undefined), {
		mode: 0o755,
	});
	if (macGhostty) return openGhosttyView(viewerScriptPath(logPath), cwd);
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

/**
 * macOS: the ghostty CLI cannot open windows, and `-e` only applies to an instance's first
 * surface. AppleScript terminals given a `command` always stop at "Process exited", so the
 * script is instead typed into the terminal's shell with `exec`; the pane closes when it exits.
 *
 * All views share one window per pi process (a new one is opened if the user closed it). Each tab
 * tiles up to `panesPerTab()` views. We keep a model of each tab's split tree: a new view splits the
 * largest pane along its longer side (2 → 2×2 → 4×2 → 4×4 → 8×4), and when a pane closes its
 * sibling takes its space, as Ghostty does. Font size shrinks with each pane's share of the tab.
 */

export type SplitDir = "right" | "down";
export type PaneTree = { leaf: string } | { dir: SplitDir; a: PaneTree; b: PaneTree };
export type Pane = { id: string; w: number; h: number };

/** Assumed window aspect (width / height); only used to decide which way to split. */
const ASPECT = 1.6;

export function paneRects(tree: PaneTree, w = ASPECT, h = 1): Pane[] {
	if ("leaf" in tree) return [{ id: tree.leaf, w, h }];
	return tree.dir === "right"
		? [...paneRects(tree.a, w / 2, h), ...paneRects(tree.b, w / 2, h)]
		: [...paneRects(tree.a, w, h / 2), ...paneRects(tree.b, w, h / 2)];
}

/** Drops closed panes; a split with one side gone collapses into the other side. */
export function prunePanes(tree: PaneTree, alive: Set<string>): PaneTree | undefined {
	if ("leaf" in tree) return alive.has(tree.leaf) ? tree : undefined;
	const a = prunePanes(tree.a, alive);
	const b = prunePanes(tree.b, alive);
	return a && b ? { dir: tree.dir, a, b } : (a ?? b);
}

/** The pane to split next: the largest (first on ties), along its longer side. */
export function nextSplit(tree: PaneTree): { id: string; dir: SplitDir } {
	const panes = paneRects(tree);
	const big = panes.reduce((best, p) => (p.w * p.h > best.w * best.h + 1e-9 ? p : best));
	return { id: big.id, dir: big.w >= big.h ? "right" : "down" };
}

export function splitPane(tree: PaneTree, id: string, dir: SplitDir, newId: string): PaneTree {
	if ("leaf" in tree) return tree.leaf === id ? { dir, a: tree, b: { leaf: newId } } : tree;
	return { dir: tree.dir, a: splitPane(tree.a, id, dir, newId), b: splitPane(tree.b, id, dir, newId) };
}

const MIN_FONT = 8;

/** Scales the base font by the pane's share of the tab (¼ power keeps small panes readable). */
export function paneFontSize(base: number, share: number): number {
	return Math.max(MIN_FONT, Math.min(base, Math.round(base * share ** 0.25)));
}

export const VIEW_PANES_ENV = "PI_AUTOAGENT_VIEW_PANES";
const DEFAULT_PANES = 32;

/** Panes tiled per Ghostty tab on macOS before a new tab is opened; 1 gives one tab per agent. */
export function panesPerTab(env: Env = process.env): number {
	const n = Number.parseInt(env[VIEW_PANES_ENV] ?? "", 10);
	return Number.isFinite(n) && n >= 1 ? n : DEFAULT_PANES;
}

/** Lists the window's tabs as "tabId<TAB>termId,termId…" lines, or nothing if the window is gone. */
const GHOSTTY_LIST = `on run argv
	set wid to item 1 of argv
	set sep to character id 9 -- inside the tell block, "tab" means Ghostty's tab class
	tell application "Ghostty"
		if wid is "" or not (exists window id wid) then return ""
		set out to ""
		repeat with t in tabs of window id wid
			set ids to ""
			repeat with x in terminals of t
				set ids to ids & (id of x) & ","
			end repeat
			set out to out & (id of t) & sep & ids & linefeed
		end repeat
		return out
	end tell
end run`;

/** mode window|tab|split; returns "windowId<TAB>tabId<TAB>newTerminalId". */
const GHOSTTY_OPEN = `on run argv
	set {mode, input, cwd, wid, target, dir} to argv
	set sep to character id 9
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial input of cfg to input
		set initial working directory of cfg to cwd
		if mode is "window" then
			set w to new window with configuration cfg
			set t to selected tab of w
			return (id of w) & sep & (id of t) & sep & (id of focused terminal of t)
		else if mode is "tab" then
			set t to new tab in window id wid with configuration cfg
			return wid & sep & (id of t) & sep & (id of focused terminal of t)
		else if dir is "right" then
			set nt to split (terminal id target) direction right with configuration cfg
		else
			set nt to split (terminal id target) direction down with configuration cfg
		end if
		return wid & sep & "" & sep & (id of nt)
	end tell
end run`;

/** Arguments are "terminalId=size" pairs. */
const GHOSTTY_FONTS = `on run argv
	tell application "Ghostty"
		repeat with pair in argv
			set AppleScript's text item delimiters to "="
			set {tid, fsize} to text items of pair
			if exists terminal id tid then perform action ("set_font_size:" & fsize) on terminal id tid
		end repeat
	end tell
end run`;

let ghosttyWindow = "";
const ghosttyTabs = new Map<string, PaneTree>();
let ghosttyQueue: Promise<unknown> = Promise.resolve();
let baseFont: Promise<number> | undefined;

/** The user's configured font size, so scaling starts from what they chose. */
function configuredFont(cwd: string): Promise<number> {
	baseFont ??= run("ghostty", ["+show-config"], cwd)
		.then((out) => Number.parseFloat(/^font-size\s*=\s*([\d.]+)/m.exec(out)?.[1] ?? ""))
		.then((n) => (Number.isFinite(n) && n > 0 ? n : 13), () => 13);
	return baseFont;
}

/** Serialised so that parallel spawns tile into one window instead of racing. */
function openGhosttyView(script: string, cwd: string): Promise<void> {
	const next = ghosttyQueue.then(async () => {
		// Leading space keeps the line out of shell history where HIST_IGNORE_SPACE is set.
		const input = ` exec ${shellJoin(["/bin/sh", script])}\n`;
		const osa = (source: string, args: string[]) => run("osascript", ["-e", source, ...args], cwd);

		// Bring the model in line with what is still open.
		const live = new Map(
			(await osa(GHOSTTY_LIST, [ghosttyWindow]))
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [tabId, ids = ""] = line.split("\t");
					return [tabId, new Set(ids.split(",").filter(Boolean))] as const;
				}),
		);
		if (live.size === 0) ghosttyTabs.clear();
		for (const [tabId, tree] of ghosttyTabs) {
			const pruned = live.has(tabId) ? prunePanes(tree, live.get(tabId)!) : undefined;
			if (pruned) ghosttyTabs.set(tabId, pruned);
			else ghosttyTabs.delete(tabId);
		}

		const max = panesPerTab();
		const roomy = [...ghosttyTabs].find(([, tree]) => paneRects(tree).length < max);
		let tabId: string;
		if (roomy) {
			const [id, tree] = roomy;
			const { id: target, dir } = nextSplit(tree);
			const [, , newId] = (await osa(GHOSTTY_OPEN, ["split", input, cwd, ghosttyWindow, target, dir])).trim().split("\t");
			ghosttyTabs.set(id, splitPane(tree, target, dir, newId));
			tabId = id;
		} else {
			const mode = ghosttyTabs.size === 0 && live.size === 0 ? "window" : "tab";
			const [wid, newTab, newId] = (await osa(GHOSTTY_OPEN, [mode, input, cwd, ghosttyWindow, "", ""])).trim().split("\t");
			ghosttyWindow = wid;
			ghosttyTabs.set(newTab, { leaf: newId });
			tabId = newTab;
		}

		const base = await configuredFont(cwd);
		const panes = paneRects(ghosttyTabs.get(tabId)!);
		await osa(
			GHOSTTY_FONTS,
			panes.map((p) => `${p.id}=${paneFontSize(base, (p.w * p.h) / ASPECT)}`),
		);
	});
	ghosttyQueue = next.catch(() => {});
	return next;
}

function run(command: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}

function shellJoin(args: string[]): string {
	return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
