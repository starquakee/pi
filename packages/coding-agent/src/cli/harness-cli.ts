import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getAgentDir } from "../config.ts";

type HarnessCliState = "planned" | "awaiting_approval" | "executing" | "verifying" | "paused" | "failed" | "completed";

interface HarnessTaskFile {
	id: string;
	projectId: string;
	goal: string;
	changeScope: string[];
	capabilityRequests: string[];
	verificationCommands: string[];
	state: HarnessCliState;
	approved: boolean;
	revision: number;
	createdAt: number;
	updatedAt: number;
	verification: Array<{
		command: string;
		exitCode: number;
		durationMs: number;
		passed: boolean;
		stdout: string;
		stderr: string;
	}>;
	error?: string;
}

interface HarnessConfig {
	version: 1;
	mode?: "read-only" | "workspace-write" | "full-access";
	workspaceRoot?: string;
}

export interface HarnessCliOptions {
	cwd?: string;
	auditRoot?: string;
	writeOut?: (line: string) => void;
	writeErr?: (line: string) => void;
}

/** Handle `pi harness ...`; return false when the argv is not a harness command. */
export async function handleHarnessCommand(args: string[], options: HarnessCliOptions = {}): Promise<boolean> {
	if (args[0] !== "harness") return false;
	const cwd = options.cwd ?? process.cwd();
	const writeOut = options.writeOut ?? ((line: string) => console.log(line));
	const writeErr = options.writeErr ?? ((line: string) => console.error(line));
	const command = args[1];
	const json = args.includes("--json");
	try {
		const config = await readHarnessConfig(cwd);
		if (!command || command === "--help" || command === "help") {
			emit({ command: "help", commands: ["plan", "run", "verify", "status"] }, json, writeOut);
			return true;
		}
		if (command !== "plan" && command !== "run" && command !== "verify" && command !== "status") {
			throw new Error(`Unknown harness command: ${command}`);
		}
		const taskDir = join(cwd, ".pi", "harness", "tasks");
		await mkdir(taskDir, { recursive: true });
		if (command === "plan") {
			const goal = args
				.slice(2)
				.filter((arg) => !arg.startsWith("--"))
				.join(" ")
				.trim();
			if (!goal) throw new Error("harness plan requires a goal");
			const now = Date.now();
			const task: HarnessTaskFile = {
				id: randomUUID(),
				projectId: projectId(cwd),
				goal,
				changeScope: [cwd],
				capabilityRequests: [config.mode === "read-only" ? "read" : "workspace-write"],
				verificationCommands: ["npm run check"],
				state: "planned",
				approved: args.includes("--approve"),
				revision: 0,
				createdAt: now,
				updatedAt: now,
				verification: [],
			};
			await saveTask(taskDir, task);
			await appendAudit(cwd, task, "task_created", { mode: config.mode ?? "read-only" }, options.auditRoot);
			emit(task, json, writeOut);
			return true;
		}
		const taskId = args[2];
		if (!taskId) throw new Error(`harness ${command} requires a task id`);
		if (command === "status") {
			if (taskId === "all") {
				const tasks = await listTasks(taskDir);
				emit(tasks, json, writeOut);
			} else {
				emit(await loadTask(taskDir, taskId), json, writeOut);
			}
			return true;
		}
		const task = await loadTask(taskDir, taskId);
		if (command === "run") {
			if (args.includes("--approve")) task.approved = true;
			if (!task.approved) {
				task.state = "awaiting_approval";
				await saveTask(taskDir, task);
				await appendAudit(cwd, task, "approval_denied", { reason: "Plan approval is required" }, options.auditRoot);
				throw new Error("Plan approval is required before run (use --approve)");
			}
			task.state = "executing";
			task.revision++;
			await appendAudit(cwd, task, "execution_started", undefined, options.auditRoot);
			task.state = "verifying";
			task.updatedAt = Date.now();
			await saveTask(taskDir, task);
			await appendAudit(cwd, task, "execution_finished", undefined, options.auditRoot);
			emit(task, json, writeOut);
			return true;
		}
		if (!task.approved) throw new Error("Plan approval is required before verify");
		if (task.state !== "verifying" && task.state !== "paused")
			throw new Error(`Cannot verify task in ${task.state} state`);
		task.state = "verifying";
		task.verification = [];
		const env = new NodeExecutionEnv({ cwd });
		for (const commandText of task.verificationCommands) {
			const startedAt = Date.now();
			const result = await env.exec(commandText);
			const evidence = result.ok
				? {
						command: commandText,
						exitCode: result.value.exitCode,
						durationMs: Date.now() - startedAt,
						passed: result.value.exitCode === 0,
						stdout: bound(result.value.stdout),
						stderr: bound(result.value.stderr),
					}
				: {
						command: commandText,
						exitCode: 1,
						durationMs: Date.now() - startedAt,
						passed: false,
						stdout: "",
						stderr: bound(result.error.message),
					};
			task.verification.push(evidence);
			task.revision++;
			await appendAudit(cwd, task, "verification_command", evidence, options.auditRoot);
			if (!evidence.passed) {
				task.state = "failed";
				task.error = `Verification failed: ${commandText}`;
				task.updatedAt = Date.now();
				await saveTask(taskDir, task);
				await appendAudit(cwd, task, "task_failed", { command: commandText }, options.auditRoot);
				emit(task, json, writeOut);
				return true;
			}
		}
		task.state = "completed";
		task.updatedAt = Date.now();
		await saveTask(taskDir, task);
		await appendAudit(cwd, task, "task_completed", undefined, options.auditRoot);
		emit(task, json, writeOut);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) writeOut(JSON.stringify({ ok: false, error: message }));
		else writeErr(`Error: ${message}`);
		process.exitCode = 1;
		return true;
	}
}

async function readHarnessConfig(cwd: string): Promise<HarnessConfig> {
	const path = join(cwd, ".pi", "harness.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return { version: 1, mode: "read-only" };
	}
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || parsed.version !== 1) throw new Error(".pi/harness.json must have integer version: 1");
	for (const key of Object.keys(parsed))
		if (key !== "version" && key !== "mode" && key !== "workspaceRoot")
			throw new Error(`Unknown .pi/harness.json key: ${key}`);
	if (
		parsed.mode !== undefined &&
		parsed.mode !== "read-only" &&
		parsed.mode !== "workspace-write" &&
		parsed.mode !== "full-access"
	)
		throw new Error("Invalid harness mode");
	if (parsed.workspaceRoot !== undefined && typeof parsed.workspaceRoot !== "string")
		throw new Error("workspaceRoot must be a string");
	return {
		version: 1,
		...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
		...(parsed.workspaceRoot === undefined ? {} : { workspaceRoot: parsed.workspaceRoot }),
	};
}

async function saveTask(taskDir: string, task: HarnessTaskFile): Promise<void> {
	task.updatedAt = Date.now();
	await writeFile(join(taskDir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
}

async function loadTask(taskDir: string, id: string): Promise<HarnessTaskFile> {
	const parsed: unknown = JSON.parse(await readFile(join(taskDir, `${id}.json`), "utf8"));
	if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.state !== "string")
		throw new Error("Invalid harness task record");
	return parsed as unknown as HarnessTaskFile;
}

async function listTasks(taskDir: string): Promise<HarnessTaskFile[]> {
	const names = (await readdir(taskDir)).filter((name) => name.endsWith(".json"));
	const tasks: HarnessTaskFile[] = [];
	for (const name of names) {
		try {
			tasks.push(await loadTask(taskDir, name.slice(0, -5)));
		} catch {
			// Ignore unrelated/corrupt files in status listing; individual status remains strict.
		}
	}
	return tasks;
}

async function appendAudit(
	cwd: string,
	task: HarnessTaskFile,
	kind: string,
	data?: unknown,
	auditRoot?: string,
): Promise<void> {
	const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const root = auditRoot ?? getAgentDir();
	const path = join(root, "harness", digest, "audit.jsonl");
	await mkdir(join(root, "harness", digest), { recursive: true });
	const event = {
		id: randomUUID(),
		timestamp: Date.now(),
		projectId: task.projectId,
		taskId: task.id,
		kind,
		data: redact(data),
	};
	await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

function bound(value: string): string {
	return value.length > 50_000 ? `${value.slice(0, 50_000)}…` : value;
}

function redact(value: unknown): unknown {
	if (typeof value === "string")
		return value.replace(
			/((?:token|secret|password|credential|api[-_]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi,
			"$1[REDACTED]",
		);
	if (Array.isArray(value)) return value.map((item) => redact(item));
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value))
			result[key] = /(token|secret|password|credential|api[-_]?key|authorization)/i.test(key)
				? "[REDACTED]"
				: redact(entry);
		return result;
	}
	return value;
}

function emit(value: unknown, json: boolean, writeOut: (line: string) => void): void {
	writeOut(json ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function projectId(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
