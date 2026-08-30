import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { WorktreeManager } from "../../src/harness/execution-backend.ts";
import { InMemoryApprovalBroker, PolicyEnforcedExecutionEnv } from "../../src/harness/policy.ts";
import { TaskOrchestrator } from "../../src/harness/task-orchestrator.ts";

describe("code harness integration smoke", () => {
	it("runs approved plan in an owned worktree and stops on failed verification", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-integration-"));
		try {
			const env = new NodeExecutionEnv({ cwd: root });
			for (const command of [
				"git init -q",
				"git config user.email harness@example.invalid",
				"git config user.name harness",
			]) {
				const result = await env.exec(command);
				expect(result.ok && result.value.exitCode).toBe(0);
			}
			await env.writeFile(join(root, "README.md"), "base\n");
			expect((await env.exec("git add README.md && git commit -qm base")).ok).toBe(true);
			const manager = new WorktreeManager({ env, projectRoot: root });
			const audit = [] as string[];
			const orchestrator = new TaskOrchestrator({
				projectId: "smoke",
				auditSink: {
					async append(event) {
						audit.push(event.kind);
					},
				},
				approvalBroker: new InMemoryApprovalBroker(() => ({ approved: true, scope: "session" })),
				executor: {
					async execute(plan) {
						const worktree = await manager.create(plan.id);
						if (!worktree.ok) throw worktree.error;
						await env.writeFile(join(worktree.value.path, "feature.txt"), "feature\n");
						const now = Date.now();
						return {
							status: "succeeded",
							startedAt: now,
							finishedAt: now,
							commit: undefined,
							diffSummary: (await manager.diff(plan.id)).ok ? "changed" : "unknown",
						};
					},
				},
				verificationRunner: {
					async run() {
						return { exitCode: 0, stdout: "ok" };
					},
				},
			});
			const plan = await orchestrator.createPlan({
				goal: "api-key=secret feature",
				changeScope: ["feature.txt"],
				verificationCommands: ["verify"],
			});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect((await orchestrator.requestApproval(plan.value.id)).ok).toBe(true);
			expect((await orchestrator.executeTask(plan.value.id)).ok).toBe(true);
			const completed = await orchestrator.verifyTask(plan.value.id);
			expect(completed.ok && completed.value.state).toBe("completed");
			expect(audit).toContain("task_completed");
			const outside = new PolicyEnforcedExecutionEnv(env, {
				mode: "workspace-write",
				workspaceRoot: root,
				rules: [],
			});
			expect((await outside.writeFile(join(root, "..", "outside.txt"), "blocked")).ok).toBe(false);
			expect((await manager.remove(plan.value.id)).ok).toBe(false);
			const failed = await new TaskOrchestrator({
				projectId: "smoke-failure",
				executor: {
					async execute() {
						const now = Date.now();
						return { status: "succeeded", startedAt: now, finishedAt: now };
					},
				},
				verificationRunner: {
					async run() {
						return { exitCode: 1, stderr: "failed" };
					},
				},
			}).createPlan({ goal: "failure", changeScope: [], verificationCommands: ["false"] });
			expect(failed.ok).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
