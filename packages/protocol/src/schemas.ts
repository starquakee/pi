import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 1 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** Matches AgentHarnessPhase so adapters do not need a second phase vocabulary. */
export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("branch_summary"),
	Type.Literal("retry"),
]);
export type SessionPhase = Static<typeof SessionPhaseSchema>;

export const ModelRefSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
});
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});

export const ModelMetadataSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
	name: Type.String({ minLength: 1 }),
	api: IdSchema,
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: ModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
	authenticated: Type.Boolean(),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
});
export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	redacted: Type.Optional(Type.Boolean()),
});
export const ImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});
export const ToolCallContentSchema = StrictObject({
	type: Type.Literal("toolCall"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
});
export const UserContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export const AssistantContentSchema = Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallContentSchema]);
export const ToolContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export type TextContent = Static<typeof TextContentSchema>;
export type ThinkingContent = Static<typeof ThinkingContentSchema>;
export type ImageContent = Static<typeof ImageContentSchema>;
export type ToolCallContent = Static<typeof ToolCallContentSchema>;

export const UsageSchema = StrictObject({
	input: Type.Integer({ minimum: 0 }),
	output: Type.Integer({ minimum: 0 }),
	cacheRead: Type.Integer({ minimum: 0 }),
	cacheWrite: Type.Integer({ minimum: 0 }),
	reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
	totalTokens: Type.Integer({ minimum: 0 }),
	cost: StrictObject({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
});
export type Usage = Static<typeof UsageSchema>;

export const UserTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("user"),
	content: Type.Array(UserContentSchema),
	timestamp: TimestampSchema,
});
const AssistantTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("assistant"),
	content: Type.Array(AssistantContentSchema),
	model: ModelRefSchema,
	responseModel: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const StreamingAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("streaming"),
});
const CompleteAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("complete"),
	stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
});
const ErrorAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("error"),
	stopReason: Type.Literal("error"),
	errorMessage: Type.Optional(Type.String({ minLength: 1 })),
});
const AbortedAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("aborted"),
	stopReason: Type.Literal("aborted"),
	errorMessage: Type.Optional(Type.String()),
});
export const AssistantTranscriptItemSchema = Type.Union([
	StreamingAssistantTranscriptItemSchema,
	CompleteAssistantTranscriptItemSchema,
	ErrorAssistantTranscriptItemSchema,
	AbortedAssistantTranscriptItemSchema,
]);
const ToolTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("tool"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
	content: Type.Array(ToolContentSchema),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const RunningToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("running"),
	isError: Type.Literal(false),
});
const CompleteToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("complete"),
	isError: Type.Literal(false),
});
const ErrorToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("error"),
	isError: Type.Literal(true),
});
export const ToolTranscriptItemSchema = Type.Union([
	RunningToolTranscriptItemSchema,
	CompleteToolTranscriptItemSchema,
	ErrorToolTranscriptItemSchema,
]);
export const TranscriptItemSchema = Type.Union([
	UserTranscriptItemSchema,
	AssistantTranscriptItemSchema,
	ToolTranscriptItemSchema,
]);
export type UserTranscriptItem = Static<typeof UserTranscriptItemSchema>;
export type AssistantTranscriptItem = Static<typeof AssistantTranscriptItemSchema>;
export type ToolTranscriptItem = Static<typeof ToolTranscriptItemSchema>;
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

/** Normalized incremental activity. Snapshots remain authoritative. */
export const TranscriptProgressSchema = Type.Union([
	StrictObject({
		type: Type.Literal("item_started"),
		item: TranscriptItemSchema,
	}),
	StrictObject({
		type: Type.Literal("assistant_delta"),
		messageId: IdSchema,
		contentIndex: Type.Integer({ minimum: 0 }),
		kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("toolCall")]),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("item_updated"),
		item: Type.Union([AssistantTranscriptItemSchema, ToolTranscriptItemSchema]),
	}),
	StrictObject({
		type: Type.Literal("item_finished"),
		item: Type.Union([
			CompleteAssistantTranscriptItemSchema,
			ErrorAssistantTranscriptItemSchema,
			AbortedAssistantTranscriptItemSchema,
			CompleteToolTranscriptItemSchema,
			ErrorToolTranscriptItemSchema,
		]),
	}),
]);
export type TranscriptProgress = Static<typeof TranscriptProgressSchema>;

export const SessionMetadataSchema = StrictObject({
	id: IdSchema,
	createdAt: TimestampSchema,
	updatedAt: Type.Optional(TimestampSchema),
	parentSessionId: Type.Optional(IdSchema),
	sessionName: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});
export const SessionSnapshotSchema = StrictObject({
	id: IdSchema,
	name: Type.Optional(Type.String()),
	cwd: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	phase: SessionPhaseSchema,
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	attached: Type.Boolean(),
	locked: Type.Boolean(),
	revision: Type.Integer({ minimum: 0 }),
	transcript: Type.Array(TranscriptItemSchema),
	queuedSteer: Type.Array(UserTranscriptItemSchema),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
});
export type SessionMetadata = Static<typeof SessionMetadataSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

export const ServerSnapshotSchema = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	sessions: Type.Array(SessionMetadataSchema),
	models: Type.Array(ModelMetadataSchema),
});
export type ServerSnapshot = Static<typeof ServerSnapshotSchema>;

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("busy"),
	Type.Literal("session_locked"),
	Type.Literal("not_found"),
	Type.Literal("invalid_request"),
	Type.Literal("not_implemented"),
	Type.Literal("internal_error"),
]);
export const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

const PromptPayloadProperties = {
	sessionId: IdSchema,
	text: Type.String(),
} as const;

export const ListCommandSchema = StrictObject({ command: Type.Literal("list") });
export const CreateCommandSchema = StrictObject({
	command: Type.Literal("create"),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String()),
	model: Type.Optional(ModelRefSchema),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
export const AttachCommandSchema = StrictObject({ command: Type.Literal("attach"), sessionId: IdSchema });
export const DetachCommandSchema = StrictObject({ command: Type.Literal("detach"), sessionId: IdSchema });
export const PromptCommandSchema = StrictObject({ command: Type.Literal("prompt"), ...PromptPayloadProperties });
export const SteerCommandSchema = StrictObject({ command: Type.Literal("steer"), ...PromptPayloadProperties });
export const AbortCommandSchema = StrictObject({ command: Type.Literal("abort"), sessionId: IdSchema });
export const SetModelCommandSchema = StrictObject({
	command: Type.Literal("set_model"),
	sessionId: IdSchema,
	model: ModelRefSchema,
});
export const SetThinkingCommandSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	sessionId: IdSchema,
	thinkingLevel: ThinkingLevelSchema,
});
export const CommandSchema = Type.Union([
	ListCommandSchema,
	CreateCommandSchema,
	AttachCommandSchema,
	DetachCommandSchema,
	PromptCommandSchema,
	SteerCommandSchema,
	AbortCommandSchema,
	SetModelCommandSchema,
	SetThinkingCommandSchema,
]);
export type Command = Static<typeof CommandSchema>;
export type CommandName = Command["command"];

export const CreateResultSchema = StrictObject({
	command: Type.Literal("create"),
	session: SessionSnapshotSchema,
});
export const AttachResultSchema = StrictObject({
	command: Type.Literal("attach"),
	session: SessionSnapshotSchema,
});
export const PromptResultSchema = StrictObject({
	command: Type.Literal("prompt"),
	session: SessionSnapshotSchema,
});
export const SteerResultSchema = StrictObject({
	command: Type.Literal("steer"),
	session: SessionSnapshotSchema,
});
export const AbortResultSchema = StrictObject({
	command: Type.Literal("abort"),
	session: SessionSnapshotSchema,
});
export const SetModelResultSchema = StrictObject({
	command: Type.Literal("set_model"),
	session: SessionSnapshotSchema,
});
export const SetThinkingResultSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	session: SessionSnapshotSchema,
});

export const ListResultSchema = StrictObject({
	command: Type.Literal("list"),
	sessions: Type.Array(SessionMetadataSchema),
});
export const DetachResultSchema = StrictObject({
	command: Type.Literal("detach"),
	sessionId: IdSchema,
});
export const CommandResultSchema = Type.Union([
	ListResultSchema,
	CreateResultSchema,
	AttachResultSchema,
	DetachResultSchema,
	PromptResultSchema,
	SteerResultSchema,
	AbortResultSchema,
	SetModelResultSchema,
	SetThinkingResultSchema,
]);
export type CommandResult = Static<typeof CommandResultSchema>;

export type ResultForCommand<TCommand extends Command> = TCommand["command"] extends "list"
	? Static<typeof ListResultSchema>
	: TCommand["command"] extends "detach"
		? Static<typeof DetachResultSchema>
		: Extract<CommandResult, { command: TCommand["command"] }>;

/** Must be the first frame sent by a client. Version is intentionally an integer, not a coercible string. */
export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	request: CommandSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

export const ServerEventSchema = Type.Union([
	StrictObject({ type: Type.Literal("server_snapshot"), snapshot: ServerSnapshotSchema }),
	StrictObject({ type: Type.Literal("session_snapshot"), snapshot: SessionSnapshotSchema }),
	StrictObject({
		type: Type.Literal("session_progress"),
		sessionId: IdSchema,
		progress: TranscriptProgressSchema,
	}),
	StrictObject({ type: Type.Literal("session_removed"), sessionId: IdSchema }),
]);
export type ServerEvent = Static<typeof ServerEventSchema>;

export const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	connectionId: IdSchema,
	snapshot: ServerSnapshotSchema,
});
export const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
export const ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: CommandResultSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
export const EventEnvelopeSchema = StrictObject({
	type: Type.Literal("event"),
	event: ServerEventSchema,
});
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	EventEnvelopeSchema,
]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// Harness namespace (protocol v1 framing, independent of legacy commands)
// ---------------------------------------------------------------------------

export const HARNESS_NAMESPACE = "harness" as const;
export const HARNESS_PROTOCOL_VERSION = 1 as const;

export const HarnessTaskStateSchema = Type.Union([
	Type.Literal("planned"),
	Type.Literal("awaiting_approval"),
	Type.Literal("executing"),
	Type.Literal("verifying"),
	Type.Literal("paused"),
	Type.Literal("failed"),
	Type.Literal("completed"),
]);
export type HarnessTaskState = Static<typeof HarnessTaskStateSchema>;

export const HarnessCapabilitySchema = StrictObject({
	namespace: Type.Literal(HARNESS_NAMESPACE),
	version: Type.Literal(HARNESS_PROTOCOL_VERSION),
	features: Type.Array(IdSchema),
	network: Type.Union([Type.Literal("disabled"), Type.Literal("enabled"), Type.Literal("unrestricted")]),
});
export type HarnessCapability = Static<typeof HarnessCapabilitySchema>;

export const HarnessCapabilityRequestSchema = StrictObject({
	kind: Type.Union([
		Type.Literal("tool"),
		Type.Literal("filesystem"),
		Type.Literal("shell"),
		Type.Literal("network"),
		Type.Literal("credential"),
	]),
	detail: Type.String(),
	required: Type.Optional(Type.Boolean()),
});
export type HarnessCapabilityRequest = Static<typeof HarnessCapabilityRequestSchema>;

export const HarnessVerificationSchema = StrictObject({
	command: Type.String(),
	required: Type.Boolean(),
	exitCode: Type.Optional(Type.Integer()),
	durationMs: Type.Integer({ minimum: 0 }),
	passed: Type.Boolean(),
	stdout: Type.String(),
	stderr: Type.String(),
	truncated: Type.Boolean(),
});
export type HarnessVerification = Static<typeof HarnessVerificationSchema>;

export const HarnessTaskSnapshotSchema = StrictObject({
	namespace: Type.Literal(HARNESS_NAMESPACE),
	version: Type.Literal(HARNESS_PROTOCOL_VERSION),
	taskId: IdSchema,
	projectId: IdSchema,
	state: HarnessTaskStateSchema,
	revision: Type.Integer({ minimum: 0 }),
	goal: Type.String(),
	changeScope: Type.Array(Type.String()),
	capabilities: Type.Array(HarnessCapabilityRequestSchema),
	verificationCommands: Type.Array(Type.String()),
	approved: Type.Boolean(),
	updatedAt: TimestampSchema,
	verification: Type.Array(HarnessVerificationSchema),
	error: Type.Optional(StrictObject({ code: IdSchema, message: Type.String() })),
});
export type HarnessTaskSnapshot = Static<typeof HarnessTaskSnapshotSchema>;

export const HarnessApprovalRequestSchema = StrictObject({
	namespace: Type.Literal(HARNESS_NAMESPACE),
	version: Type.Literal(HARNESS_PROTOCOL_VERSION),
	requestId: IdSchema,
	taskId: IdSchema,
	revision: Type.Integer({ minimum: 0 }),
	reason: Type.String(),
	scope: Type.Union([Type.Literal("once"), Type.Literal("session"), Type.Literal("persistent")]),
	target: JsonValueSchema,
});
export type HarnessApprovalRequest = Static<typeof HarnessApprovalRequestSchema>;

export const HarnessApprovalResponseSchema = Type.Union([
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		requestId: IdSchema,
		taskId: IdSchema,
		revision: Type.Integer({ minimum: 0 }),
		approved: Type.Literal(true),
		scope: Type.Union([Type.Literal("once"), Type.Literal("session"), Type.Literal("persistent")]),
	}),
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		requestId: IdSchema,
		taskId: IdSchema,
		revision: Type.Integer({ minimum: 0 }),
		approved: Type.Literal(false),
		reason: Type.String(),
	}),
]);
export type HarnessApprovalResponse = Static<typeof HarnessApprovalResponseSchema>;

export const HarnessProgressSchema = StrictObject({
	namespace: Type.Literal(HARNESS_NAMESPACE),
	version: Type.Literal(HARNESS_PROTOCOL_VERSION),
	taskId: IdSchema,
	revision: Type.Integer({ minimum: 0 }),
	event: IdSchema,
	data: Type.Optional(JsonValueSchema),
});
export type HarnessProgress = Static<typeof HarnessProgressSchema>;

export const HarnessAuditSummarySchema = StrictObject({
	namespace: Type.Literal(HARNESS_NAMESPACE),
	version: Type.Literal(HARNESS_PROTOCOL_VERSION),
	taskId: IdSchema,
	revision: Type.Integer({ minimum: 0 }),
	eventCount: Type.Integer({ minimum: 0 }),
	redacted: Type.Boolean(),
	lastEventAt: Type.Optional(TimestampSchema),
});
export type HarnessAuditSummary = Static<typeof HarnessAuditSummarySchema>;

export const HarnessClientMessageSchema = Type.Union([
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("capability"),
		capability: HarnessCapabilitySchema,
	}),
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("snapshot"),
		taskId: IdSchema,
	}),
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("approval_response"),
		response: HarnessApprovalResponseSchema,
	}),
]);
export type HarnessClientMessage = Static<typeof HarnessClientMessageSchema>;

export const HarnessServerMessageSchema = Type.Union([
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("capability"),
		capability: HarnessCapabilitySchema,
	}),
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("snapshot"),
		snapshot: HarnessTaskSnapshotSchema,
	}),
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("approval_request"),
		request: HarnessApprovalRequestSchema,
	}),
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("progress"),
		progress: HarnessProgressSchema,
	}),
	StrictObject({
		namespace: Type.Literal(HARNESS_NAMESPACE),
		version: Type.Literal(HARNESS_PROTOCOL_VERSION),
		type: Type.Literal("audit_summary"),
		summary: HarnessAuditSummarySchema,
	}),
]);
export type HarnessServerMessage = Static<typeof HarnessServerMessageSchema>;
