import { expect, it } from "vitest";
import { orchestratorPrompt } from "../extensions/auto-agent/orchestrator.ts";

it("lists the team, the plan, the verifier and the file-partition rule", () => {
	const text = orchestratorPrompt(
		{ members: [{ name: "builder", purpose: "build the API", mode: "new" }], plan: "builder first", verifier: "checker" },
		[{ name: "builder", description: "Builds things", body: "" }],
	);
	expect(text).toContain("- builder: Builds things — on this task: build the API");
	expect(text).toContain("builder first");
	expect(text).toContain('"checker"');
	expect(text).toContain("never edit the same files");
	expect(text).toContain("spawn_agents");
});
