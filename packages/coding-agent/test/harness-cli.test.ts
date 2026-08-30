import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleHarnessCommand } from "../src/cli/harness-cli.ts";

describe("harness CLI", () => {
	it("creates a plan, requires approval, and reports status as JSON", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cli-"));
		try {
			const output: string[] = [];
			await handleHarnessCommand(["harness", "plan", "add a test", "--json"], {
				cwd,
				auditRoot: cwd,
				writeOut: (line) => output.push(line),
				writeErr: () => {},
			});
			const planned = JSON.parse(output[0] ?? "") as { id: string; approved: boolean; state: string };
			expect(planned.approved).toBe(false);
			expect(planned.state).toBe("planned");
			output.length = 0;
			process.exitCode = 0;
			await handleHarnessCommand(["harness", "run", planned.id, "--json"], {
				cwd,
				auditRoot: cwd,
				writeOut: (line) => output.push(line),
				writeErr: () => {},
			});
			expect(JSON.parse(output[0] ?? "").ok).toBe(false);
			const task = JSON.parse(
				await readFile(join(cwd, ".pi", "harness", "tasks", `${planned.id}.json`), "utf8"),
			) as { state: string };
			expect(task.state).toBe("awaiting_approval");
		} finally {
			process.exitCode = 0;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects unknown config keys before starting a task", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cli-config-"));
		try {
			await mkdir(join(cwd, ".pi"), { recursive: true });
			await writeFile(join(cwd, ".pi", "harness.json"), '{"version":1,"unexpected":true}', "utf8");
			const output: string[] = [];
			await handleHarnessCommand(["harness", "status", "all", "--json"], {
				cwd,
				auditRoot: cwd,
				writeOut: (line) => output.push(line),
				writeErr: () => {},
			});
			expect(output).toHaveLength(1);
		} finally {
			process.exitCode = 0;
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
