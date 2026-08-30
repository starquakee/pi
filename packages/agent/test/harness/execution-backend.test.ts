import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { LocalExecutionBackend, WorktreeManager } from "../../src/harness/execution-backend.ts";

describe("execution backends", () => {
	it("bounds local command output and advertises unrestricted network", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-backend-"));
		try {
			const env = new NodeExecutionEnv({ cwd: root });
			const backend = new LocalExecutionBackend({ env, maxOutputLines: 1 });
			const result = await backend.execute("printf 'one\\ntwo\\n'");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.truncated).toBe(true);
			expect(backend.capabilities.network).toBe("unrestricted");
			await backend.cleanup();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("WorktreeManager", () => {
	it("creates, inspects, and preserves dirty owned worktrees", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-worktree-"));
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
			const commit = await env.exec("git add README.md && git commit -qm initial");
			expect(commit.ok && commit.value.exitCode).toBe(0);
			const manager = new WorktreeManager({ env, projectRoot: root });
			const created = await manager.create("task-1");
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			await env.writeFile(join(created.value.path, "README.md"), "changed\n");
			const diff = await manager.diff("task-1");
			expect(diff.ok && diff.value.status).toContain("README.md");
			const removed = await manager.remove("task-1");
			expect(removed.ok).toBe(false);
			if (removed.ok) return;
			expect(removed.error.code).toBe("dirty_worktree");
			await env.exec("git -C .pi/harness/worktrees/task-1 checkout -- README.md");
			expect((await manager.remove("task-1")).ok).toBe(true);
			await env.writeFile(join(root, "dirty.txt"), "dirty\n");
			const dirty = await manager.create("task-2");
			expect(dirty.ok).toBe(false);
			if (dirty.ok) return;
			expect(dirty.error.code).toBe("dirty_baseline");
			await env.cleanup();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
