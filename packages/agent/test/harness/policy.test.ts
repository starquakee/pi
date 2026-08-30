import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	detectPathEscape,
	evaluatePolicy,
	InMemoryApprovalBroker,
	PolicyEnforcedExecutionEnv,
	parseShellSegments,
} from "../../src/harness/policy.ts";

describe("harness policy", () => {
	it("applies deny before ask and allow regardless of rule order", () => {
		const decision = evaluatePolicy(
			{
				mode: "full-access",
				rules: [
					{ label: "ask shell", action: "ask", match: { toolName: "bash" } },
					{ label: "deny rm", action: "deny", match: { commandContains: "rm" } },
				],
			},
			{ toolName: "bash", command: "rm -rf build" },
		);
		expect(decision).toMatchObject({ verdict: "deny", ruleLabel: "deny rm" });
		expect(
			evaluatePolicy(
				{
					mode: "read-only",
					rules: [{ label: "safe command", action: "allow", match: { commandContains: "pwd" } }],
				},
				{ toolName: "bash", command: "pwd" },
			).verdict,
		).toBe("allow");
	});

	it("parses safe segments and rejects ambiguous shell syntax", () => {
		expect(parseShellSegments("echo 'a;b' && printf ok | cat")).toEqual(["echo 'a;b'", "printf ok", "cat"]);
		expect(parseShellSegments("echo 'unterminated")).toBeNull();
		expect(parseShellSegments("cat input > output")).toBeNull();
		expect(parseShellSegments("echo $(uname)")).toBeNull();
	});

	it("rejects lexical path escapes", () => {
		expect(detectPathEscape("../outside", "/workspace/project")).toContain("traversal");
		expect(detectPathEscape("/workspace/other/file", "/workspace/project")).toContain("escapes");
		expect(detectPathEscape("src/file.ts", "/workspace/project")).toBeNull();
	});

	it("enforces writes and caches session approvals", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-policy-"));
		try {
			const inner = new NodeExecutionEnv({ cwd: root });
			let approvals = 0;
			const broker = new InMemoryApprovalBroker(() => {
				approvals++;
				return { approved: true, scope: "session" };
			});
			const env = new PolicyEnforcedExecutionEnv(
				inner,
				{
					mode: "read-only",
					workspaceRoot: root,
					rules: [{ label: "allow writes after approval", action: "ask", match: { effect: "write" } }],
				},
				broker,
			);
			expect((await env.writeFile(join(root, "a.txt"), "one")).ok).toBe(true);
			expect((await env.appendFile(join(root, "a.txt"), "two")).ok).toBe(true);
			expect(approvals).toBe(1);
			expect((await env.writeFile(join(root, "../outside.txt"), "blocked")).ok).toBe(false);
			expect(env.getAuditLog()).toHaveLength(3);
			await env.cleanup();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps network disabled unless explicitly enabled in full-access", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-policy-network-"));
		try {
			const inner = new NodeExecutionEnv({ cwd: root });
			const disabled = new PolicyEnforcedExecutionEnv(inner, { mode: "full-access", rules: [] });
			expect((await disabled.authorizeNetwork("example.com")).verdict).toBe("deny");
			const enabled = new PolicyEnforcedExecutionEnv(inner, { mode: "full-access", network: "enabled", rules: [] });
			expect((await enabled.authorizeNetwork("example.com")).verdict).toBe("allow");
			await inner.cleanup();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
