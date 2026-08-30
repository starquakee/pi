import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SubagentOrchestrator } from "../../src/harness/subagents.ts";

const model = { id: "parent" } as Model<Api>;

describe("SubagentOrchestrator", () => {
	it("inherits defaults, bounds batches, and requires merge approval", async () => {
		let active = 0;
		let peak = 0;
		const orchestrator = new SubagentOrchestrator({
			parent: { model, thinkingLevel: "off", policy: { mode: "workspace-write", rules: [] } },
			maxConcurrency: 2,
			runner: {
				async run(spec, context) {
					expect(spec.model).toBe(model);
					expect(context.depth).toBe(1);
					active++;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 2));
					active--;
					return { id: spec.id, role: spec.role, status: "completed", output: "ok" };
				},
			},
			mergeHandler: {
				async apply() {
					return { commit: "abc" };
				},
			},
		});
		const results = await orchestrator.runAll([
			{ id: "a", role: "planner", prompt: "plan" },
			{ id: "b", role: "reviewer", prompt: "review" },
			{ id: "c", role: "implementer", prompt: "implement" },
		]);
		expect(results.every((result) => result.ok)).toBe(true);
		expect(peak).toBe(2);
		const mergeRejected = await orchestrator.merge("a");
		expect(mergeRejected.ok).toBe(false);
		if (mergeRejected.ok) return;
		expect(mergeRejected.error.code).toBe("merge_not_approved");
		orchestrator.approveMerge("a");
		const merged = await orchestrator.merge("a");
		expect(merged.ok).toBe(true);
		if (!merged.ok) return;
		expect(merged.value.commit).toBe("abc");
	});

	it("rejects policy escalation, recursive children, and writes without worktrees", async () => {
		const orchestrator = new SubagentOrchestrator({
			parent: { model, thinkingLevel: "off", policy: { mode: "workspace-write", rules: [] } },
			runner: {
				async run(spec) {
					return { id: spec.id, role: spec.role, status: "completed" };
				},
			},
		});
		const escalation = await orchestrator.run({
			id: "full",
			role: "planner",
			prompt: "",
			policy: { mode: "full-access", rules: [] },
		});
		expect(escalation.ok).toBe(false);
		if (!escalation.ok) expect(escalation.error.code).toBe("policy_escalation");
		const write = await orchestrator.run({ id: "write", role: "implementer", prompt: "", write: true });
		expect(write.ok).toBe(false);
		if (!write.ok) expect(write.error.code).toBe("worktree_required");
	});
});
