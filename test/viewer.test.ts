import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { herdrPaneId, closeDelay, herdrTabArgs, viewerBackend, viewerCommand, viewerScript } from "../extensions/auto-agent/viewer.ts";

describe("viewerBackend", () => {
	it("prefers herdr, then tmux, then Ghostty on a desktop", () => {
		expect(viewerBackend({ HERDR_ENV: "1", TMUX: "/tmp/t" })).toBe("herdr");
		expect(viewerBackend({ TMUX: "/tmp/t", TERM_PROGRAM: "ghostty", DISPLAY: ":0" })).toBe("tmux");
		expect(viewerBackend({ TERM_PROGRAM: "ghostty", WAYLAND_DISPLAY: "wayland-1" })).toBe("ghostty");
		expect(viewerBackend({ TERM_PROGRAM: "ghostty" })).toBe("off");
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
	});

	it("creates an unfocused herdr tab and reads its pane id", () => {
		expect(herdrTabArgs("verifier", "/p")).toEqual(["tab", "create", "--no-focus", "--label", "verifier", "--cwd", "/p"]);
		expect(herdrPaneId('{"result":{"root_pane":"p-1"}}')).toBe("p-1");
		expect(herdrPaneId('{"result":{"root_pane":{"pane_id":"p-2"}}}')).toBe("p-2");
		expect(herdrPaneId("nope")).toBeUndefined();
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
