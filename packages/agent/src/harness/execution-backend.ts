import type { ExecutionEnv, ExecutionError, Result, ShellExecOptions } from "./types.ts";
import { err, ok } from "./types.ts";
import { truncateTail } from "./utils/truncate.ts";

export type NetworkCapability = "disabled" | "enabled" | "unrestricted";

/** Capabilities a backend must state before a task can rely on it. */
export interface ExecutionCapabilities {
	shell: boolean;
	network: NetworkCapability;
	filesystem: "worktree" | "workspace" | "unrestricted";
	sandboxed: boolean;
}

export interface ExecutionResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	truncated: boolean;
}

export interface ExecutionBackend {
	readonly capabilities: ExecutionCapabilities;
	execute(command: string, options?: ShellExecOptions): Promise<Result<ExecutionResult, ExecutionError>>;
	getEnvironment(): ExecutionEnv;
	cleanup(): Promise<void>;
}

/** Backend-neutral sandbox lifecycle. Docker/QEMU/Gondolin details stay outside the core. */
export interface SandboxAdapter {
	readonly capabilities: ExecutionCapabilities;
	start(options?: { cwd?: string; signal?: AbortSignal }): Promise<ExecutionBackend>;
	stop(): Promise<void>;
}

/** Adapter over an existing ExecutionEnv. Local execution is explicitly unrestricted for network. */
export class LocalExecutionBackend implements ExecutionBackend {
	readonly capabilities: ExecutionCapabilities;
	private readonly env: ExecutionEnv;
	private readonly maxOutputBytes: number;
	private readonly maxOutputLines: number;

	constructor(options: {
		env: ExecutionEnv;
		filesystem?: ExecutionCapabilities["filesystem"];
		maxOutputBytes?: number;
		maxOutputLines?: number;
	}) {
		this.env = options.env;
		this.capabilities = {
			shell: true,
			network: "unrestricted",
			filesystem: options.filesystem ?? "workspace",
			sandboxed: false,
		};
		this.maxOutputBytes = options.maxOutputBytes ?? 50 * 1024;
		this.maxOutputLines = options.maxOutputLines ?? 2000;
	}

	getEnvironment(): ExecutionEnv {
		return this.env;
	}

	async execute(command: string, options?: ShellExecOptions): Promise<Result<ExecutionResult, ExecutionError>> {
		const startedAt = Date.now();
		const result = await this.env.exec(command, options);
		if (!result.ok) return result;
		const stdout = truncateTail(result.value.stdout, {
			maxBytes: this.maxOutputBytes,
			maxLines: this.maxOutputLines,
		});
		const stderr = truncateTail(result.value.stderr, {
			maxBytes: this.maxOutputBytes,
			maxLines: this.maxOutputLines,
		});
		return ok({
			stdout: stdout.content,
			stderr: stderr.content,
			exitCode: result.value.exitCode,
			durationMs: Math.max(0, Date.now() - startedAt),
			truncated: stdout.truncated || stderr.truncated,
		});
	}

	async cleanup(): Promise<void> {
		await this.env.cleanup();
	}
}

export class WorktreeError extends Error {
	readonly code: "dirty_baseline" | "not_found" | "git_failed" | "dirty_worktree" | "invalid_path";

	constructor(code: WorktreeError["code"], message: string) {
		super(message);
		this.name = "WorktreeError";
		this.code = code;
	}
}

export interface WorktreeRecord {
	taskId: string;
	path: string;
	baselineCommit: string;
	createdAt: number;
	commit?: string;
	diffSummary?: string;
}

export interface WorktreeDiff {
	path: string;
	baselineCommit: string;
	status: string;
	diff: string;
	truncated: boolean;
}

/** Owns only worktrees it created and never removes a dirty child tree. */
export class WorktreeManager {
	private readonly env: ExecutionEnv;
	private readonly projectRoot: string;
	private readonly owned = new Map<string, WorktreeRecord>();

	constructor(options: { env: ExecutionEnv; projectRoot?: string }) {
		this.env = options.env;
		this.projectRoot = options.projectRoot ?? options.env.cwd;
	}

	async create(taskId: string, path?: string): Promise<Result<WorktreeRecord, WorktreeError>> {
		if (this.owned.has(taskId)) return ok({ ...this.owned.get(taskId)! });
		const status = await this.git("status --porcelain", this.projectRoot);
		if (!status.ok) return status;
		if (status.value.stdout.trim()) return err(new WorktreeError("dirty_baseline", "Git baseline is dirty"));
		const baseline = await this.git("rev-parse HEAD", this.projectRoot);
		if (!baseline.ok) return baseline;
		const requestedPath = path ?? `${this.projectRoot.replace(/[\\/]$/, "")}/.pi/harness/worktrees/${taskId}`;
		const absolute = await this.env.absolutePath(requestedPath);
		if (!absolute.ok) return err(new WorktreeError("invalid_path", absolute.error.message));
		const worktreePath = absolute.value;
		if (!isChildPath(worktreePath, this.projectRoot)) {
			return err(new WorktreeError("invalid_path", "Worktree path must stay inside the project root"));
		}
		const canonicalRoot = await this.env.canonicalPath(this.projectRoot);
		const canonicalParent = await findCanonicalParent(this.env, worktreePath);
		if (canonicalRoot.ok && canonicalParent && !isWithinPath(canonicalParent, canonicalRoot.value)) {
			return err(new WorktreeError("invalid_path", "Worktree parent resolves outside the project root"));
		}
		const added = await this.git(
			`worktree add --detach ${shellArg(worktreePath)} ${shellArg(baseline.value.stdout.trim())}`,
			this.projectRoot,
		);
		if (!added.ok) return added;
		const record: WorktreeRecord = {
			taskId,
			path: worktreePath,
			baselineCommit: baseline.value.stdout.trim(),
			createdAt: Date.now(),
		};
		this.owned.set(taskId, record);
		return ok({ ...record });
	}

	get(taskId: string): WorktreeRecord | undefined {
		const record = this.owned.get(taskId);
		return record === undefined ? undefined : { ...record };
	}

	async diff(
		taskId: string,
		options?: { maxOutputBytes?: number; maxOutputLines?: number },
	): Promise<Result<WorktreeDiff, WorktreeError>> {
		const record = this.owned.get(taskId);
		if (!record) return err(new WorktreeError("not_found", `Unknown worktree task: ${taskId}`));
		const status = await this.git("status --porcelain", record.path);
		if (!status.ok) return status;
		const diff = await this.git("diff HEAD --no-ext-diff", record.path);
		if (!diff.ok) return diff;
		const bounded = truncateTail(diff.value.stdout, {
			maxBytes: options?.maxOutputBytes ?? 100 * 1024,
			maxLines: options?.maxOutputLines ?? 4000,
		});
		return ok({
			path: record.path,
			baselineCommit: record.baselineCommit,
			status: status.value.stdout,
			diff: bounded.content,
			truncated: bounded.truncated,
		});
	}

	async commit(taskId: string, message: string): Promise<Result<WorktreeRecord, WorktreeError>> {
		const record = this.owned.get(taskId);
		if (!record) return err(new WorktreeError("not_found", `Unknown worktree task: ${taskId}`));
		const add = await this.git("add -A", record.path);
		if (!add.ok) return add;
		const beforeCommit = await this.diff(taskId);
		if (!beforeCommit.ok) return beforeCommit;
		const commit = await this.git(`commit -m ${shellArg(message)}`, record.path);
		if (!commit.ok) return commit;
		const head = await this.git("rev-parse HEAD", record.path);
		if (!head.ok) return head;
		record.commit = head.value.stdout.trim();
		record.diffSummary = summarizeStatus(beforeCommit.value.status);
		return ok({ ...record });
	}

	async remove(taskId: string): Promise<Result<void, WorktreeError>> {
		const record = this.owned.get(taskId);
		if (!record) return err(new WorktreeError("not_found", `Unknown worktree task: ${taskId}`));
		const status = await this.git("status --porcelain", record.path);
		if (!status.ok) return status;
		if (status.value.stdout.trim())
			return err(new WorktreeError("dirty_worktree", "Worktree has uncommitted changes; preserving it for review"));
		const removed = await this.git(`worktree remove ${shellArg(record.path)}`, this.projectRoot);
		if (!removed.ok) return removed;
		this.owned.delete(taskId);
		return ok(undefined);
	}

	private async git(
		command: string,
		cwd: string,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, WorktreeError>> {
		const result = await this.env.exec(`git ${command}`, { cwd });
		if (!result.ok) return err(new WorktreeError("git_failed", result.error.message));
		if (result.value.exitCode !== 0) {
			return err(new WorktreeError("git_failed", result.value.stderr.trim() || `git command failed: ${command}`));
		}
		return ok(result.value);
	}
}

function shellArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function isChildPath(path: string, root: string): boolean {
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	return isWithinPath(normalizedPath, normalizedRoot) && normalizedPath !== normalizedRoot;
}

function isWithinPath(path: string, root: string): boolean {
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

async function findCanonicalParent(env: ExecutionEnv, path: string): Promise<string | undefined> {
	let candidate = path;
	for (;;) {
		const result = await env.canonicalPath(candidate);
		if (result.ok) return result.value;
		const parent = candidate.slice(0, candidate.replace(/\\/g, "/").lastIndexOf("/"));
		if (!parent || parent === candidate) return undefined;
		candidate = parent;
	}
}

function summarizeStatus(status: string): string {
	const lines = status.trim().split(/\r?\n/).filter(Boolean);
	return lines.length === 0 ? "clean" : `${lines.length} changed path${lines.length === 1 ? "" : "s"}`;
}
