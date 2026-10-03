import { expect, it } from "vitest";
import { blockedToolReason, ORCHESTRATOR_TOOLS, orchestratorPrompt } from "../extensions/auto-agent/orchestrator.ts";

it("lists the team, the plan, the verifier and the file-partition rule", () => {
	const text = orchestratorPrompt(
		{ members: [{ name: "builder", purpose: "build the API", mode: "new" }], plan: "builder first", verifier: "checker" },
		[{ name: "builder", description: "Builds things", body: "" }],
	);
	expect(text).toContain("- builder: Builds things — on this task: build the API");
	expect(text).toContain("builder first");
	expect(text).toContain('"checker"');
	expect(text).toContain("never edit the same files");
	expect(text).toContain("Agent definitions are generic roles");
	expect(text).toContain("Pass results forward yourself");
	expect(text).toContain("Respect dependencies");
	expect(text).toContain("The verifier never changes files");
	expect(text).toContain("spawn_agents");
});

it("tells the orchestrator never to change files itself", () => {
	const text = orchestratorPrompt({ members: [], plan: "", verifier: "checker" }, []);
	expect(text).toContain("Never write code, tests or docs yourself");
	expect(text).not.toContain("do small things directly");
});

it("lets the orchestrator read and delegate", () => {
	expect(ORCHESTRATOR_TOOLS).toEqual(["read", "grep", "find", "ls", "spawn_agents"]);
	for (const tool of ORCHESTRATOR_TOOLS) expect(blockedToolReason(tool)).toBeUndefined();
});

it("blocks every tool that could change files or run commands, pointing at spawn_agents", () => {
	for (const tool of ["edit", "write", "bash", "powershell", "some_extension_tool"]) {
		const reason = blockedToolReason(tool);
		expect(reason).toContain(`"${tool}"`);
		expect(reason).toContain("spawn_agents");
	}
});
