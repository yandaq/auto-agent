import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { herdrPaneId, closeDelay, panesPerTab, nextSplit, paneFontSize, paneRects, prunePanes, splitPane, type PaneTree, herdrTabArgs, viewerBackend, viewerCommand, viewerScript } from "../extensions/auto-agent/viewer.ts";

describe("viewerBackend", () => {
	it("prefers herdr, then tmux, then Ghostty on a desktop", () => {
		expect(viewerBackend({ HERDR_ENV: "1", TMUX: "/tmp/t" })).toBe("herdr");
		expect(viewerBackend({ TMUX: "/tmp/t", TERM_PROGRAM: "ghostty", DISPLAY: ":0" })).toBe("tmux");
		expect(viewerBackend({ TERM_PROGRAM: "ghostty", WAYLAND_DISPLAY: "wayland-1" })).toBe("ghostty");
		expect(viewerBackend({ TERM_PROGRAM: "ghostty" }, "linux")).toBe("off");
		expect(viewerBackend({ TERM_PROGRAM: "ghostty" }, "darwin")).toBe("ghostty");
		expect(viewerBackend({})).toBe("off");
	});

	it("honours PI_AUTOAGENT_VIEW and ignores junk values", () => {
		expect(viewerBackend({ PI_AUTOAGENT_VIEW: "off", TMUX: "/tmp/t" })).toBe("off");
		expect(viewerBackend({ PI_AUTOAGENT_VIEW: "Ghostty" })).toBe("ghostty");
		expect(viewerBackend({ PI_AUTOAGENT_VIEW: "junk", TMUX: "/tmp/t" })).toBe("tmux");
	});
});

describe("viewer commands", () => {
	it("tails the log in a tmux window or a Ghostty window", () => {
		expect(viewerCommand("tmux", "spec-writer", "/p/a b.log")).toEqual({
			command: "tmux",
			args: ["new-window", "-d", "-n", "spec-writer", "sh '/p/a b.log.sh'"],
		});
		expect(viewerCommand("ghostty", "spec-writer", "/p/a.log")).toEqual({
			command: "ghostty",
			args: ["--title=spec-writer", "-e", "/p/a.log.sh"],
		});
		expect(viewerScript("/p/a b.log", 0)).toBe("#!/bin/sh\nexec tail -n +1 -F '/p/a b.log'\n");
		expect(viewerScript("/p/a.log", 0, "spec writer")).toBe(
			"#!/bin/sh\nprintf '\\033]0;%s\\007' 'spec writer'\nexec tail -n +1 -F /p/a.log\n",
		);
	});

	it("creates an unfocused herdr tab and reads its pane id", () => {
		expect(herdrTabArgs("verifier", "/p")).toEqual(["tab", "create", "--no-focus", "--label", "verifier", "--cwd", "/p"]);
		expect(herdrPaneId('{"result":{"root_pane":"p-1"}}')).toBe("p-1");
		expect(herdrPaneId('{"result":{"root_pane":{"pane_id":"p-2"}}}')).toBe("p-2");
		expect(herdrPaneId("nope")).toBeUndefined();
	});
});

describe("tiling", () => {
	it("defaults to 32 panes per tab, 1 means one tab per agent", () => {
		expect(panesPerTab({})).toBe(32);
		expect(panesPerTab({ PI_AUTOAGENT_VIEW_PANES: "1" })).toBe(1);
		expect(panesPerTab({ PI_AUTOAGENT_VIEW_PANES: "0" })).toBe(32);
		expect(panesPerTab({ PI_AUTOAGENT_VIEW_PANES: "junk" })).toBe(32);
	});

	const grow = (n: number): PaneTree => {
		let tree: PaneTree = { leaf: "p1" };
		for (let i = 2; i <= n; i++) {
			const { id, dir } = nextSplit(tree);
			tree = splitPane(tree, id, dir, `p${i}`);
		}
		return tree;
	};
	const grid = (tree: PaneTree) => {
		const panes = paneRects(tree);
		return [new Set(panes.map((p) => p.w.toFixed(3))).size, new Set(panes.map((p) => p.h.toFixed(3))).size];
	};

	it("grows an even grid: 2 → 2×2 → 4×2 → 4×4 → 8×4", () => {
		expect(grid(grow(2))).toEqual([1, 1]);
		expect(paneRects(grow(2)).map((p) => p.h)).toEqual([1, 1]);
		for (const n of [4, 8, 16, 32]) {
			const panes = paneRects(grow(n));
			expect(panes).toHaveLength(n);
			expect(grid(grow(n))).toEqual([1, 1]); // all panes the same size
		}
		const [p] = paneRects(grow(32));
		expect([1.6 / p.w, 1 / p.h]).toEqual([8, 4]);
	});

	it("gives a closed pane's space to its sibling, which is split next", () => {
		const tree = grow(4); // p1 | p2 over p3 | p4
		const pruned = prunePanes(tree, new Set(["p1", "p2", "p4"]))!;
		expect(paneRects(pruned).map((p) => p.id)).toEqual(["p1", "p2", "p4"]);
		expect(nextSplit(pruned).id).toBe("p1");
		expect(prunePanes(tree, new Set())).toBeUndefined();
	});

	it("shrinks the font with the pane's share, down to 8pt", () => {
		expect(paneFontSize(19, 1)).toBe(19);
		expect(paneFontSize(19, 1 / 4)).toBe(13);
		expect(paneFontSize(19, 1 / 32)).toBe(8);
		expect(paneFontSize(12, 1 / 32)).toBe(8);
	});
});

describe("auto-close", () => {
	it("defaults to 30 seconds, 0 keeps the view open", () => {
		expect(closeDelay({})).toBe(30);
		expect(closeDelay({ PI_AUTOAGENT_VIEW_CLOSE: "0" })).toBe(0);
		expect(closeDelay({ PI_AUTOAGENT_VIEW_CLOSE: "5" })).toBe(5);
		expect(closeDelay({ PI_AUTOAGENT_VIEW_CLOSE: "junk" })).toBe(30);
	});

	it("exits once the log ends and the delay has passed", () => {
		const dir = mkdtempSync(join(tmpdir(), "aa-view-"));
		const log = join(dir, "a.log");
		writeFileSync(log, "working\n\n✔ done\n");
		const script = join(dir, "a.sh");
		writeFileSync(script, viewerScript(log, 1));
		const res = spawnSync("sh", [script], { encoding: "utf8", timeout: 10_000 });
		expect(res.error).toBeUndefined();
		expect(res.stdout).toContain("working");
		expect(res.stdout).toContain("Closing in 1s");
	});
});
