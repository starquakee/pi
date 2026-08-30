import { uuidv7 } from "@earendil-works/pi-ai";
import type { ApprovalBroker, ApprovalResponse, PolicyScope } from "./policy.ts";
import type { ExecutionEnv } from "./types.ts";
import { err, ok, type Result } from "./types.ts";
import { truncateTail } from "./utils/truncate.ts";

/** Durable lifecycle states for a Plan -> Execute -> Verify task. */
export type TaskState = "planned" | "awaiting_approval" | "executing" | "verifying" | "paused" | "failed" | "completed";

export interface CapabilityRequest {
	kind: "tool" | "filesystem" | "shell" | "network" | "credential";
	detail: string;
	required?: boolean;
}

export interface VerificationCommand {
	command: string;
	required?: boolean;
}

export interface TaskPlanInput {
	goal: string;
	changeScope: string[];
	capabilityRequests?: CapabilityRequest[];
	verificationCommands?: Array<string | VerificationCommand>;
}

export interface TaskPlan extends TaskPlanInput {
	id: string;
	createdAt: number;
	capabilityRequests: CapabilityRequest[];
	verificationCommands: VerificationCommand[];
}

export interface ExecutionEvidence {
	status: "succeeded" | "failed" | "paused";
	startedAt: number;
	finishedAt: number;
	/** Optional backend-provided commit or patch identifier. */
	commit?: string;
	patch?: string;
	/** Human-readable bounded summary of effects. */
	diffSummary?: string;
	output?: string;
}

export interface VerificationEvidence {
	command: string;
	required: boolean;
	exitCode?: number;
	durationMs: number;
	passed: boolean;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

export interface TaskErrorInfo {
	code:
		| "not_found"
		| "invalid_state"
		| "approval_required"
		| "execution_failed"
		| "verification_failed"
		| "aborted"
		| "audit_failed";
	message: string;
}

export class TaskError extends Error {
	readonly code: TaskErrorInfo["code"];

	constructor(code: TaskErrorInfo["code"], message: string) {
		super(message);
		this.name = "TaskError";
		this.code = code;
	}
}

export interface TaskSnapshot {
	id: string;
	projectId: string;
	state: TaskState;
	revision: number;
	createdAt: number;
	updatedAt: number;
	plan: TaskPlan;
	approved: boolean;
	approvalScope?: PolicyScope;
	execution?: ExecutionEvidence;
	verification: VerificationEvidence[];
	error?: TaskErrorInfo;
}

export type TaskResult<T> = Result<T, TaskError>;

export type AuditEventKind =
	| "task_created"
	| "approval_requested"
	| "approval_granted"
	| "approval_denied"
	| "execution_started"
	| "execution_finished"
	| "verification_started"
	| "verification_command"
	| "task_paused"
	| "task_failed"
	| "task_completed";

/** Structured, redacted metadata for one lifecycle transition. */
export interface AuditEvent {
	id: string;
	timestamp: number;
	projectId: string;
	taskId: string;
	kind: AuditEventKind;
	summary: string;
	data?: Record<string, unknown>;
}

export interface AuditSink {
	append(event: AuditEvent): Promise<void>;
}

/** In-memory sink for tests and embedders that provide their own persistence. */
export class MemoryAuditSink implements AuditSink {
	private readonly events: AuditEvent[] = [];

	async append(event: AuditEvent): Promise<void> {
		this.events.push(redactAuditEvent(event));
	}

	getEvents(): AuditEvent[] {
		return this.events.map((event) => ({ ...event, data: event.data === undefined ? undefined : { ...event.data } }));
	}
}

/** JSONL sink. The caller chooses a global per-project path outside the worktree. */
export class JsonlAuditSink implements AuditSink {
	private readonly env: ExecutionEnv;
	private readonly path: string;

	constructor(env: ExecutionEnv, path: string) {
		this.env = env;
		this.path = path;
	}

	async append(event: AuditEvent): Promise<void> {
		const line = `${JSON.stringify(redactAuditEvent(event))}\n`;
		const result = await this.env.appendFile(this.path, line);
		if (!result.ok) throw new TaskError("audit_failed", result.error.message);
	}
}

export interface TaskExecutionContext {
	task: TaskSnapshot;
	signal: AbortSignal;
}

export interface TaskExecutor {
	execute(plan: TaskPlan, context: TaskExecutionContext): Promise<ExecutionEvidence>;
}

export interface VerificationRunner {
	run(
		command: string,
		context: TaskExecutionContext,
	): Promise<{
		exitCode: number;
		stdout?: string;
		stderr?: string;
	}>;
}

export interface TaskOrchestratorOptions {
	projectId: string;
	executionEnv?: ExecutionEnv;
	executor?: TaskExecutor;
	verificationRunner?: VerificationRunner;
	auditSink?: AuditSink;
	approvalBroker?: ApprovalBroker;
	maxOutputBytes?: number;
	maxOutputLines?: number;
}

/** Coordinates task state transitions and keeps the snapshot authoritative. */
export class TaskOrchestrator {
	private readonly projectId: string;
	private readonly executionEnv?: ExecutionEnv;
	private readonly executor?: TaskExecutor;
	private readonly verificationRunner?: VerificationRunner;
	private readonly auditSink: AuditSink;
	private readonly approvalBroker?: ApprovalBroker;
	private readonly maxOutputBytes: number;
	private readonly maxOutputLines: number;
	private readonly tasks = new Map<string, TaskSnapshot>();

	constructor(options: TaskOrchestratorOptions) {
		this.projectId = options.projectId;
		this.executionEnv = options.executionEnv;
		this.executor = options.executor;
		this.verificationRunner = options.verificationRunner;
		this.auditSink = options.auditSink ?? new MemoryAuditSink();
		this.approvalBroker = options.approvalBroker;
		this.maxOutputBytes = options.maxOutputBytes ?? 50 * 1024;
		this.maxOutputLines = options.maxOutputLines ?? 2000;
	}

	async createPlan(input: TaskPlanInput): Promise<TaskResult<TaskSnapshot>> {
		if (!input.goal.trim()) return err(new TaskError("invalid_state", "A task goal is required"));
		const now = Date.now();
		const plan: TaskPlan = {
			id: uuidv7(),
			goal: input.goal,
			changeScope: [...input.changeScope],
			capabilityRequests: [...(input.capabilityRequests ?? [])],
			verificationCommands: (input.verificationCommands ?? []).map((command) =>
				typeof command === "string"
					? { command, required: true }
					: { command: command.command, required: command.required ?? true },
			),
			createdAt: now,
		};
		const snapshot: TaskSnapshot = {
			id: plan.id,
			projectId: this.projectId,
			state: "planned",
			revision: 0,
			createdAt: now,
			updatedAt: now,
			plan,
			approved: false,
			verification: [],
		};
		this.tasks.set(snapshot.id, snapshot);
		await this.audit(snapshot, "task_created", "Task plan created", {
			goal: plan.goal,
			changeScope: plan.changeScope,
			capabilities: plan.capabilityRequests,
			verificationCommands: plan.verificationCommands.map((item) => item.command),
		});
		return ok(this.clone(snapshot));
	}

	getSnapshot(taskId: string): TaskSnapshot | undefined {
		const snapshot = this.tasks.get(taskId);
		return snapshot === undefined ? undefined : this.clone(snapshot);
	}

	listSnapshots(): TaskSnapshot[] {
		return [...this.tasks.values()].map((snapshot) => this.clone(snapshot));
	}

	async requestApproval(taskId: string): Promise<TaskResult<TaskSnapshot>> {
		const snapshot = this.requireTask(taskId);
		if (!snapshot.ok) return snapshot;
		if (snapshot.value.approved) return ok(this.clone(snapshot.value));
		this.update(snapshot.value, { state: "awaiting_approval" });
		await this.audit(snapshot.value, "approval_requested", "Task plan requires approval");
		if (!this.approvalBroker) {
			return err(await this.denyApproval(snapshot.value, "Approval broker is not configured"));
		}
		const response = await this.approvalBroker.requestApproval({
			toolName: "task-plan",
			toolArgs: { taskId: snapshot.value.id, goal: snapshot.value.plan.goal },
			reason: "Approve the planned task before execution",
			scope: "session",
		});
		if (!response.approved) return err(await this.denyApproval(snapshot.value, response.reason));
		return this.grantApproval(snapshot.value, response);
	}

	async approvePlan(taskId: string, scope: PolicyScope = "session"): Promise<TaskResult<TaskSnapshot>> {
		const snapshot = this.requireTask(taskId);
		if (!snapshot.ok) return snapshot;
		return this.grantApproval(snapshot.value, { approved: true, scope });
	}

	async executeTask(
		taskId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<TaskResult<TaskSnapshot>> {
		const snapshot = this.requireTask(taskId);
		if (!snapshot.ok) return snapshot;
		if (!snapshot.value.approved) {
			await this.audit(snapshot.value, "approval_denied", "Execution rejected because the plan is not approved");
			return err(new TaskError("approval_required", "Plan approval is required before execution"));
		}
		if (snapshot.value.state === "completed") return ok(this.clone(snapshot.value));
		if (!this.executor)
			return err(await this.fail(snapshot.value, "execution_failed", "No execution backend is configured"));
		this.update(snapshot.value, { state: "executing", error: undefined });
		await this.audit(snapshot.value, "execution_started", "Task execution started");
		try {
			if (signal.aborted) throw new TaskError("aborted", "Task execution was aborted");
			const execution = await this.executor.execute(snapshot.value.plan, {
				task: this.clone(snapshot.value),
				signal,
			});
			this.update(snapshot.value, {
				state: execution.status === "paused" ? "paused" : "verifying",
				execution,
				error: undefined,
			});
			await this.audit(snapshot.value, "execution_finished", "Task execution finished", execution);
			return ok(this.clone(snapshot.value));
		} catch (error) {
			const taskError =
				error instanceof TaskError
					? error
					: new TaskError("execution_failed", error instanceof Error ? error.message : String(error));
			return err(await this.fail(snapshot.value, taskError.code, taskError.message));
		}
	}

	async verifyTask(
		taskId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<TaskResult<TaskSnapshot>> {
		const snapshot = this.requireTask(taskId);
		if (!snapshot.ok) return snapshot;
		if (!snapshot.value.approved)
			return err(new TaskError("approval_required", "Plan approval is required before verification"));
		if (snapshot.value.state !== "verifying" && snapshot.value.state !== "paused") {
			if (snapshot.value.state === "completed") return ok(this.clone(snapshot.value));
			return err(new TaskError("invalid_state", `Cannot verify a task in ${snapshot.value.state} state`));
		}
		this.update(snapshot.value, { state: "verifying", verification: [], error: undefined });
		await this.audit(snapshot.value, "verification_started", "Task verification started");
		for (const requirement of snapshot.value.plan.verificationCommands) {
			if (signal.aborted) {
				this.update(snapshot.value, { state: "paused" });
				await this.audit(snapshot.value, "task_paused", "Task verification paused");
				return err(new TaskError("aborted", "Task verification was aborted"));
			}
			const startedAt = Date.now();
			let result: { exitCode: number; stdout?: string; stderr?: string };
			try {
				if (this.verificationRunner)
					result = await this.verificationRunner.run(requirement.command, {
						task: this.clone(snapshot.value),
						signal,
					});
				else if (this.executionEnv) {
					const execution = await this.executionEnv.exec(requirement.command, { abortSignal: signal });
					if (!execution.ok) throw new TaskError("verification_failed", execution.error.message);
					result = execution.value;
				} else throw new TaskError("verification_failed", "No verification backend is configured");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result = { exitCode: 1, stderr: message };
			}
			const stdout = truncateTail(result.stdout ?? "", {
				maxBytes: this.maxOutputBytes,
				maxLines: this.maxOutputLines,
			});
			const stderr = truncateTail(result.stderr ?? "", {
				maxBytes: this.maxOutputBytes,
				maxLines: this.maxOutputLines,
			});
			const evidence: VerificationEvidence = {
				command: requirement.command,
				required: requirement.required ?? true,
				exitCode: result.exitCode,
				durationMs: Math.max(0, Date.now() - startedAt),
				passed: result.exitCode === 0,
				stdout: stdout.content,
				stderr: stderr.content,
				truncated: stdout.truncated || stderr.truncated,
			};
			snapshot.value.verification.push(evidence);
			snapshot.value.revision++;
			snapshot.value.updatedAt = Date.now();
			await this.audit(
				snapshot.value,
				"verification_command",
				evidence.passed ? "Verification command passed" : "Verification command failed",
				evidence,
			);
			if (evidence.required && !evidence.passed) {
				return err(
					await this.fail(snapshot.value, "verification_failed", `Verification failed: ${requirement.command}`),
				);
			}
		}
		this.update(snapshot.value, { state: "completed", error: undefined });
		await this.audit(snapshot.value, "task_completed", "All required verification commands passed");
		return ok(this.clone(snapshot.value));
	}

	async pauseTask(taskId: string): Promise<TaskResult<TaskSnapshot>> {
		const snapshot = this.requireTask(taskId);
		if (!snapshot.ok) return snapshot;
		if (snapshot.value.state !== "executing" && snapshot.value.state !== "verifying")
			return err(new TaskError("invalid_state", "Only active tasks can be paused"));
		this.update(snapshot.value, { state: "paused" });
		await this.audit(snapshot.value, "task_paused", "Task paused by caller");
		return ok(this.clone(snapshot.value));
	}

	async resumeTask(taskId: string, signal?: AbortSignal): Promise<TaskResult<TaskSnapshot>> {
		const snapshot = this.requireTask(taskId);
		if (!snapshot.ok) return snapshot;
		if (snapshot.value.state !== "paused")
			return err(new TaskError("invalid_state", "Only paused tasks can be resumed"));
		if (snapshot.value.execution?.status === "succeeded") return this.verifyTask(taskId, signal);
		return this.executeTask(taskId, signal);
	}

	private requireTask(taskId: string): TaskResult<TaskSnapshot> {
		const snapshot = this.tasks.get(taskId);
		return snapshot === undefined ? err(new TaskError("not_found", `Unknown task: ${taskId}`)) : ok(snapshot);
	}

	private async grantApproval(
		snapshot: TaskSnapshot,
		response: Extract<ApprovalResponse, { approved: true }>,
	): Promise<TaskResult<TaskSnapshot>> {
		this.update(snapshot, { state: "planned", approved: true, approvalScope: response.scope, error: undefined });
		if (response.scope === "persistent" && this.approvalBroker?.rememberApproval) {
			await this.approvalBroker.rememberApproval(`task:${this.projectId}:${snapshot.id}`, response.scope);
		}
		await this.audit(snapshot, "approval_granted", "Task plan approved", { scope: response.scope });
		return ok(this.clone(snapshot));
	}

	private async denyApproval(snapshot: TaskSnapshot, reason: string): Promise<TaskError> {
		this.update(snapshot, { state: "awaiting_approval", error: { code: "approval_required", message: reason } });
		await this.audit(snapshot, "approval_denied", reason);
		return new TaskError("approval_required", reason);
	}

	private async fail(snapshot: TaskSnapshot, code: TaskErrorInfo["code"], message: string): Promise<TaskError> {
		this.update(snapshot, { state: "failed", error: { code, message } });
		await this.audit(snapshot, "task_failed", message, { code });
		return new TaskError(code, message);
	}

	private update(snapshot: TaskSnapshot, patch: Partial<TaskSnapshot>): void {
		Object.assign(snapshot, patch);
		snapshot.revision++;
		snapshot.updatedAt = Date.now();
	}

	private async audit(snapshot: TaskSnapshot, kind: AuditEventKind, summary: string, data?: unknown): Promise<void> {
		const event: AuditEvent = {
			id: uuidv7(),
			timestamp: Date.now(),
			projectId: this.projectId,
			taskId: snapshot.id,
			kind,
			summary,
			...(data !== undefined && isRecord(data) ? { data } : {}),
		};
		await this.auditSink.append(event);
	}

	private clone(snapshot: TaskSnapshot): TaskSnapshot {
		return {
			...snapshot,
			plan: {
				...snapshot.plan,
				changeScope: [...snapshot.plan.changeScope],
				capabilityRequests: snapshot.plan.capabilityRequests.map((item) => ({ ...item })),
				verificationCommands: snapshot.plan.verificationCommands.map((item) => ({ ...item })),
			},
			verification: snapshot.verification.map((item) => ({ ...item })),
			execution: snapshot.execution === undefined ? undefined : { ...snapshot.execution },
			error: snapshot.error === undefined ? undefined : { ...snapshot.error },
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactAuditEvent(event: AuditEvent): AuditEvent {
	return {
		...event,
		data: event.data === undefined ? undefined : (redactValue(event.data) as Record<string, unknown>),
	};
}

function redactValue(value: unknown, key?: string): unknown {
	if (key !== undefined && /(token|secret|password|credential|api[-_]?key|authorization)/i.test(key))
		return "[REDACTED]";
	if (typeof value === "string") {
		const redacted = value.replace(
			/((?:token|secret|password|credential|api[-_]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi,
			"$1[REDACTED]",
		);
		return redacted.length > 4096 ? `${redacted.slice(0, 4096)}…` : redacted;
	}
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item));
	if (isRecord(value)) {
		const output: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) output[entryKey] = redactValue(entryValue, entryKey);
		return output;
	}
	return value;
}
