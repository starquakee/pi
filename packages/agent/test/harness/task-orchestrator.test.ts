import { describe, expect, it } from "vitest";
import { MemoryAuditSink, TaskOrchestrator } from "../../src/harness/task-orchestrator.ts";

describe("TaskOrchestrator", () => {
	it("requires explicit approval before execution and completes after verification", async () => {
		const audit = new MemoryAuditSink();
		const orchestrator = new TaskOrchestrator({
			projectId: "project-a",
			auditSink: audit,
			executor: {
				async execute() {
					const now = Date.now();
					return { status: "succeeded", startedAt: now, finishedAt: now + 1, diffSummary: "1 file changed" };
				},
			},
			verificationRunner: {
				async run() {
					return { exitCode: 0, stdout: "ok" };
				},
			},
		});
		const planned = await orchestrator.createPlan({
			goal: "add a feature",
			changeScope: ["packages/agent"],
			capabilityRequests: [{ kind: "filesystem", detail: "workspace write", required: true }],
			verificationCommands: ["npm run check"],
		});
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const rejected = await orchestrator.executeTask(planned.value.id);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("approval_required");
		const approved = await orchestrator.approvePlan(planned.value.id, "session");
		expect(approved.ok && approved.value.approved).toBe(true);
		const executing = await orchestrator.executeTask(planned.value.id);
		expect(executing.ok && executing.value.state).toBe("verifying");
		const completed = await orchestrator.verifyTask(planned.value.id);
		expect(completed.ok && completed.value.state).toBe("completed");
		expect(audit.getEvents().map((event) => event.kind)).toEqual([
			"task_created",
			"approval_denied",
			"approval_granted",
			"execution_started",
			"execution_finished",
			"verification_started",
			"verification_command",
			"task_completed",
		]);
	});

	it("does not complete when a required verification command fails", async () => {
		const orchestrator = new TaskOrchestrator({
			projectId: "project-b",
			executor: {
				async execute() {
					const now = Date.now();
					return { status: "succeeded", startedAt: now, finishedAt: now };
				},
			},
			verificationRunner: {
				async run() {
					return { exitCode: 1, stderr: "token=hidden" };
				},
			},
		});
		const plan = await orchestrator.createPlan({
			goal: "fail verification",
			changeScope: [],
			verificationCommands: ["false"],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		await orchestrator.approvePlan(plan.value.id);
		await orchestrator.executeTask(plan.value.id);
		const result = await orchestrator.verifyTask(plan.value.id);
		expect(result.ok).toBe(false);
		const snapshot = orchestrator.getSnapshot(plan.value.id);
		expect(snapshot?.state).toBe("failed");
	});

	it("redacts sensitive fields in audit data", async () => {
		const audit = new MemoryAuditSink();
		const orchestrator = new TaskOrchestrator({ projectId: "project-c", auditSink: audit });
		await orchestrator.createPlan({
			goal: "secret",
			changeScope: [],
			capabilityRequests: [{ kind: "credential", detail: "api-key=secret" }],
		});
		const serialized = JSON.stringify(audit.getEvents());
		expect(serialized).not.toContain("api-key=secret");
	});
});
