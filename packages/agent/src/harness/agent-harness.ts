import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import { Agent } from "../agent.ts";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import type { CompactionSettings } from "./compaction/compaction.ts";
import { HarnessEventBus } from "./events.ts";
import { convertToLlm } from "./messages.ts";
import { type Result as ResultValue, TaggedError } from "./result.ts";
import { buildSessionContext } from "./session/context.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	JsonValue,
	ProvisionedEntry,
	Session,
	SessionTree,
} from "./session/index.ts";
import type { TelemetryContext } from "./telemetry.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./types.ts";

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export class HarnessNotImplemented extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented yet`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}

export interface OperationError {
	code: string;
	message: string;
}

export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed;
export type CompactionRejected = LaneBusy | NothingToCompact | Closed;
export type NavigationRejected = LaneBusy | UnknownTarget | Closed;
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed;
export type QueueRejected = NoActiveRun | InvalidMessage | Closed;
export type CancelQueuedRejected = UnknownQueueItem | Closed;
export type AbortRejected = NoActiveOperation | Closed;

export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
export type RecordUsageResult = ResultValue<void, Closed>;
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	customInstructions?: string;
	label?: string;
}

export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: LaneInfo["operation"];
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "append_record"; recordType: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "set_fact"; fact: "name" | "label" }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
	| { kind: "hook"; name: HookName }
	| { kind: "sleep"; delayMs: number };

export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

export interface Events {
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}

class UnavailableRegistry implements Hooks, Events {
	private readonly operation: string;
	private readonly isClosed: () => boolean;

	constructor(operation: string, isClosed: () => boolean) {
		this.operation = operation;
		this.isClosed = isClosed;
	}

	on(
		_name: HookName | string,
		_handler: (event: unknown) => unknown | Promise<unknown>,
		_options?: { id?: string },
	): () => void {
		throw this.isClosed() ? new HarnessClosed() : new HarnessNotImplemented(this.operation);
	}
}

export type HarnessTool = AgentTool & { replay?: "never" | "safe" };
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

export interface AgentHarnessOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	systemPrompt?: string | (() => string | Promise<string>);
	resources?: Resources;
	streamOptions?: StreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	context?: TelemetryContext;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api>>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

export class AgentHarness implements AgentLane {
	readonly name = "main";
	readonly session: SessionTree;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private model: Model<Api>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private tools: HarnessTool[];
	private resources: Resources;
	private streamOptions: StreamOptions;
	private retryPolicy: RetryPolicy;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private readonly agent: Agent;
	private readonly eventBus: HarnessEventBus;
	private nextRunQueue: Array<{ entryId: string; message: AgentMessage }> = [];
	private steeringQueue: Array<{ entryId: string; message: AgentMessage }> = [];
	private followUpQueue: Array<{ entryId: string; message: AgentMessage }> = [];
	private readonly persistedEntryIds = new Map<AgentMessage, string>();
	private activeRun?: Promise<RunResult>;
	private activeRunId?: string;
	private resumeOperationId?: string;
	private snapshot: LaneSnapshot;
	private suspendedOperations: SuspendedOperation[] = [];
	private closed = false;

	private constructor(options: AgentHarnessOptions, initialMessages: AgentMessage[], systemPrompt: string) {
		this.durableSession = options.session;
		this.session = options.session;
		this.hooks = new UnavailableRegistry("hooks.on", () => this.closed);
		this.eventBus = new HarnessEventBus();
		this.events = this.eventBus;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model: options.model,
				thinkingLevel: this.thinkingLevel,
				messages: initialMessages,
				tools: this.tools.filter((tool) => this.activeToolNames.includes(tool.name)),
			},
			convertToLlm: options.toProviderMessages ?? convertToLlm,
			streamFn: (model, context, streamOptions) =>
				options.models.streamSimple(model, context, {
					...this.streamOptions,
					...streamOptions,
				}),
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
		});
		this.agent.subscribe(async (event) => this.handleAgentEvent(event));
		this.snapshot = {
			lane: "main",
			transcript: [],
			leafId: null,
			operation: null,
			queues: { steer: [], followUp: [], nextRun: [] },
			pendingWrites: [],
			faulted: false,
		};
	}

	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		const entries = await options.session.findEntriesOnBranch({ order: "oldestFirst" });
		const context = buildSessionContext(entries);
		const systemPrompt =
			typeof options.systemPrompt === "function" ? await options.systemPrompt() : (options.systemPrompt ?? "");
		const harness = new AgentHarness(options, context.messages, systemPrompt);
		const starts = await options.session.findRecords({
			type: "operation_started",
			lane: "main",
			order: "oldestFirst",
		});
		const finished = new Set(
			(await options.session.findRecords({ type: "operation_finished", lane: "main", order: "oldestFirst" })).map(
				(record) => record.runId,
			),
		);
		harness.suspendedOperations = starts
			.filter((record) => !finished.has(record.id) && record.intent.kind === "run")
			.map((record) => {
				if (record.intent.kind !== "run") throw new Error("Expected a run operation");
				return {
					lane: "main",
					kind: "run" as const,
					id: record.id,
					startedAt: record.timestamp,
					reason: "crash" as const,
					prompt: record.intent.originalPrompt,
					missing: { tools: [], models: [] },
				};
			});
		harness.snapshot = {
			...harness.snapshot,
			transcript: entries,
			leafId: await options.session.getLeafId(),
		};
		return { harness, suspended: harness.suspendedOperations.map((operation) => ({ ...operation })) };
	}

	private unavailable<T>(operation: string): Promise<T> {
		return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
	}

	async getLeafId(): Promise<string | null> {
		return this.durableSession.getLeafId();
	}

	async prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	async prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		if (this.activeRun) {
			return {
				ok: false,
				error: new LaneBusy({
					lane: this.name,
					operationId: this.activeRunId ?? "unknown",
					operationKind: "run",
					message: "The main lane is already running",
				}),
			};
		}
		const messages = normalizeMessages(input, images);
		const queued = this.nextRunQueue.splice(0).map((item) => item.message);
		const runId = this.resumeOperationId ?? uuidv7();
		if (!this.resumeOperationId) {
			await this.durableSession.appendRecord({
				type: "operation_started",
				id: runId,
				lane: this.name,
				sourceLeafId: await this.durableSession.getLeafId(),
				intent: { kind: "run", originalPrompt: [...queued, ...messages], initialMessages: [] },
			});
		}
		const run = this.executeRun(runId, [...queued, ...messages]);
		this.activeRunId = runId;
		this.activeRun = run;
		void run.finally(() => {
			if (this.activeRun === run) {
				this.activeRun = undefined;
				this.activeRunId = undefined;
			}
		});
		return run;
	}
	async skill(_name: string, _additionalInstructions?: string): Promise<RunResult> {
		const skill = this.resources.skills?.find((candidate) => candidate.name === _name);
		if (!skill) return { ok: false, error: new UnknownSkill({ name: _name, message: `Unknown skill: ${_name}` }) };
		return this.prompt(`${skill.content}${_additionalInstructions ? `\n\n${_additionalInstructions}` : ""}`);
	}
	async promptFromTemplate(_name: string, _args?: string[]): Promise<RunResult> {
		const template = this.resources.promptTemplates?.find((candidate) => candidate.name === _name);
		if (!template)
			return { ok: false, error: new UnknownTemplate({ name: _name, message: `Unknown template: ${_name}` }) };
		let content = template.content;
		for (const [index, arg] of (_args ?? []).entries()) content = content.replaceAll(`$${index + 1}`, arg);
		return this.prompt(content);
	}
	async compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		return this.unavailable("compact");
	}
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		return this.unavailable("navigateTree");
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		if (this.activeRun) {
			return {
				ok: false,
				error: new LaneBusy({
					lane: this.name,
					operationId: this.activeRunId ?? "unknown",
					operationKind: "run",
					message: "The main lane is already running",
				}),
			};
		}
		const suspended = this.suspendedOperations.shift();
		if (!suspended?.prompt || suspended.prompt.length === 0) {
			return {
				ok: false,
				error: new NothingToResume({ lane: this.name, message: "No suspended run is available" }),
			};
		}
		this.resumeOperationId = suspended.id;
		try {
			const result = await this.prompt(suspended.prompt);
			if (!result.ok) {
				if (result.error instanceof LaneBusy) {
					return {
						ok: false,
						error: new LaneBusy({
							lane: this.name,
							operationId: this.activeRunId ?? "unknown",
							operationKind: "run",
							message: result.error.message,
						}),
					};
				}
				if (result.error instanceof Closed)
					return { ok: false, error: new Closed({ message: result.error.message }) };
				return { ok: false, error: new Closed({ message: result.error.message }) };
			}
			return { ok: true, value: { operation: "run" as const, ...result.value } };
		} finally {
			this.resumeOperationId = undefined;
		}
	}
	async abort(): Promise<AbortResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		if (!this.activeRun || !this.activeRunId) {
			return { ok: false, error: new NoActiveOperation({ lane: this.name, message: "No active operation" }) };
		}
		this.agent.abort();
		return { ok: true, value: { runId: this.activeRunId, steer: [], followUp: [] } };
	}
	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		if (!this.activeRun) return { ok: false, error: new NoActiveRun({ lane: this.name, message: "No active run" }) };
		const message = normalizeMessages(input, images)[0];
		if (!message)
			return {
				ok: false,
				error: new InvalidMessage({ lane: this.name, reason: "empty", message: "Message is empty" }),
			};
		const entryId = uuidv7();
		this.steeringQueue.push({ entryId, message });
		this.syncAgentQueues();
		this.refreshQueueSnapshot();
		return { ok: true, value: { entryId } };
	}
	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		if (!this.activeRun) return { ok: false, error: new NoActiveRun({ lane: this.name, message: "No active run" }) };
		const message = normalizeMessages(input, images)[0];
		if (!message)
			return {
				ok: false,
				error: new InvalidMessage({ lane: this.name, reason: "empty", message: "Message is empty" }),
			};
		const entryId = uuidv7();
		this.followUpQueue.push({ entryId, message });
		this.syncAgentQueues();
		this.refreshQueueSnapshot();
		return { ok: true, value: { entryId } };
	}
	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const message = normalizeMessages(input, images)[0];
		if (!message)
			return {
				ok: false,
				error: new InvalidMessage({ lane: this.name, reason: "empty", message: "Message is empty" }),
			};
		const entryId = uuidv7();
		this.nextRunQueue.push({ entryId, message });
		this.refreshQueueSnapshot();
		return { ok: true, value: { entryId } };
	}
	async cancelQueued(_entryId: string): Promise<CancelQueuedResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const queues = [this.steeringQueue, this.followUpQueue, this.nextRunQueue];
		for (const queue of queues) {
			const index = queue.findIndex((item) => item.entryId === _entryId);
			if (index !== -1) {
				queue.splice(index, 1);
				this.syncAgentQueues();
				this.refreshQueueSnapshot();
				return { ok: true, value: { outcome: "cancelled" } };
			}
		}
		return { ok: true, value: { outcome: "already_cleared" } };
	}
	async recordUsage(_usage: Usage, _options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.unavailable("recordUsage");
	}
	async waitForIdle(): Promise<void> {
		if (this.closed && !this.activeRun) return;
		await this.activeRun;
	}
	async runWhenIdle(_callback: () => void | Promise<void>): Promise<void> {
		await this.waitForIdle();
		await _callback();
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("peekAction");
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("executeAction");
	}
	async runToCompletion(): Promise<void> {
		await this.waitForIdle();
		if (this.nextRunQueue.length === 0) return;
		const messages = this.nextRunQueue.splice(0).map((item) => item.message);
		await this.prompt(messages);
	}
	async getModel(): Promise<Model<Api>> {
		return this.model;
	}
	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
		this.agent.state.model = model;
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
		this.agent.state.thinkingLevel = level;
	}
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	async setActiveTools(names: string[]): Promise<void> {
		this.activeToolNames = [...names];
		this.agent.state.tools = this.tools.filter((tool) => this.activeToolNames.includes(tool.name));
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		if (this.closed) return Promise.reject(new HarnessClosed());
		await this.refreshSnapshot();
		const handle = this.eventBus.watch(() => structuredClone(this.snapshot));
		return {
			snapshot: structuredClone(handle.snapshot),
			start: (listener) => handle.start(listener),
			unsubscribe: () => handle.unsubscribe(),
		};
	}

	async lane(_name: string): Promise<AgentLane | undefined> {
		return this.unavailable("lane");
	}
	async createLane(_name: string, _at: string | null): Promise<CreateLaneResult> {
		return this.unavailable("createLane");
	}
	async lanes(): Promise<LaneInfo[]> {
		return this.unavailable("lanes");
	}
	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}
	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
		this.agent.state.tools = this.tools.filter((tool) => this.activeToolNames.includes(tool.name));
	}
	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}
	async setResources(resources: Resources): Promise<void> {
		this.resources = {
			skills: resources.skills ? [...resources.skills] : undefined,
			promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		};
	}
	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}
	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.streamOptions = { ...options };
	}
	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}
	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.retryPolicy = { ...policy };
	}
	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = { ...settings };
	}
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
		this.agent.steeringMode = mode;
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
		this.agent.followUpMode = mode;
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		return this.unavailable("watchSession");
	}
	async close(): Promise<void> {
		this.closed = true;
		this.agent.abort();
		await this.activeRun;
	}

	private async executeRun(runId: string, messages: AgentMessage[]): Promise<RunResult> {
		this.snapshot = { ...this.snapshot, operation: { id: runId, kind: "run", status: "running" } };
		this.eventBus.emit({ type: "run_start", lane: this.name, runId });
		let outcome: RunOutcome["kind"] = "completed";
		let operationError: { code: string; message: string } | undefined;
		let attempt = 0;
		try {
			let finalMessage: AssistantMessage | undefined;
			while (true) {
				attempt++;
				await this.agent.prompt(messages);
				finalMessage = [...this.agent.state.messages]
					.reverse()
					.find((message): message is AssistantMessage => message.role === "assistant");
				if (!finalMessage) break;
				const resultEntryId = this.persistedEntryIds.get(finalMessage);
				if (resultEntryId) {
					await this.durableSession.appendRecord({
						type: "step_attempt",
						id: uuidv7(),
						lane: this.name,
						runId,
						step: "assistant",
						attempt,
						resultEntryId,
					});
				}
				if (
					finalMessage.stopReason !== "error" ||
					!this.retryPolicy.enabled ||
					attempt > Math.max(0, this.retryPolicy.maxRetries)
				) {
					break;
				}
				this.agent.state.messages = this.agent.state.messages.slice(0, -1);
				const delayMs = Math.min(this.retryPolicy.baseDelayMs * 2 ** (attempt - 1), 60_000);
				if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			}
			if (!finalMessage) {
				outcome = "failed";
				operationError = { code: "no_assistant", message: "Agent produced no assistant message" };
				return {
					ok: false,
					error: new InvalidMessage({
						lane: this.name,
						reason: "no_assistant",
						message: "Agent produced no assistant message",
					}),
				};
			}
			const finalEntryId = this.persistedEntryIds.get(finalMessage) ?? uuidv7();
			const leafId = (await this.durableSession.getLeafId()) ?? finalEntryId;
			const value =
				finalMessage.stopReason === "aborted"
					? { runId, kind: "aborted" as const, leafId, finalEntryId, finalMessage }
					: finalMessage.stopReason === "error"
						? {
								runId,
								kind: "failed" as const,
								leafId,
								error: { code: "agent_error", message: finalMessage.errorMessage ?? "Agent run failed" },
								finalEntryId,
								finalMessage,
							}
						: { runId, kind: "completed" as const, leafId, finalEntryId, finalMessage };
			outcome = value.kind;
			if (value.kind === "failed") operationError = value.error;
			return { ok: true, value };
		} catch (error) {
			outcome = "failed";
			operationError = {
				code: "agent_error",
				message: error instanceof Error ? error.message : String(error),
			};
			return {
				ok: false,
				error: new InvalidMessage({
					lane: this.name,
					reason: error instanceof Error ? error.message : String(error),
					message: "Agent run failed",
				}),
			};
		} finally {
			this.steeringQueue = [];
			this.followUpQueue = [];
			this.agent.clearAllQueues();
			await this.refreshSnapshot();
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: uuidv7(),
				lane: this.name,
				runId,
				outcome: outcome === "completed" ? "completed" : outcome === "aborted" ? "aborted" : "failed",
				...(operationError ? { error: operationError } : {}),
			});
			this.eventBus.emit({
				type: "run_end",
				lane: this.name,
				runId,
				outcome: outcome === "aborted" ? "aborted" : outcome === "failed" ? "failed" : "completed",
				leafId: this.snapshot.leafId ?? "",
			});
			this.snapshot = { ...this.snapshot, operation: null };
		}
	}

	private async handleAgentEvent(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") {
			const id = await this.durableSession.appendMessage(toPersistableMessage(event.message));
			this.persistedEntryIds.set(event.message, id);
		}
		if (event.type === "message_update") {
			this.snapshot = {
				...this.snapshot,
				operation: this.snapshot.operation ? { ...this.snapshot.operation } : null,
			};
		}
	}

	private refreshQueueSnapshot(): void {
		this.snapshot = {
			...this.snapshot,
			queues: {
				steer: this.steeringQueue.map((item) => ({ entryId: item.entryId, message: item.message })),
				followUp: this.followUpQueue.map((item) => ({ entryId: item.entryId, message: item.message })),
				nextRun: this.nextRunQueue.map((item) => ({ entryId: item.entryId, message: item.message })),
			},
		};
	}

	private syncAgentQueues(): void {
		this.agent.clearSteeringQueue();
		for (const item of this.steeringQueue) this.agent.steer(item.message);
		this.agent.clearFollowUpQueue();
		for (const item of this.followUpQueue) this.agent.followUp(item.message);
	}

	private async refreshSnapshot(): Promise<void> {
		this.snapshot = {
			...this.snapshot,
			transcript: await this.session.findEntriesOnBranch({ order: "oldestFirst" }),
			leafId: await this.session.getLeafId(),
		};
		this.refreshQueueSnapshot();
	}
}

function normalizeMessages(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
	if (Array.isArray(input)) return input;
	if (typeof input !== "string") return [input];
	return [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }];
}

function toPersistableMessage(message: AgentMessage): AgentMessage {
	if (message.role !== "toolResult") return message;
	return {
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content,
		isError: message.isError,
		timestamp: message.timestamp,
		...(message.details === undefined ? {} : { details: message.details }),
		...(message.usage === undefined ? {} : { usage: message.usage }),
		...(message.addedToolNames === undefined ? {} : { addedToolNames: message.addedToolNames }),
	};
}
