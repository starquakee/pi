import type { Api, AssistantMessage, Context, Model, Models, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream.ts";
import { AgentHarness, type HarnessTool } from "../../src/harness/agent-harness.ts";
import {
	InMemorySessionStorage,
	type NewRecord,
	type OperationStartedRecord,
	Session,
} from "../../src/harness/session/index.ts";
import type { AgentTool } from "../../src/types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
	id: "fake-model",
	name: "Fake model",
	api: "openai-completions",
	provider: "fake",
	baseUrl: "http://fake.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_000,
	maxTokens: 1_000,
} as Model<Api>;

function fakeModels(responses: Array<"ok" | "error"> = ["ok"]): Models {
	let responseIndex = 0;
	return {
		streamSimple: () => {
			const stream = new AssistantMessageEventStream();
			const response = responses[Math.min(responseIndex++, responses.length - 1)] ?? "ok";
			const message = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: response === "error" ? ("error" as const) : ("stop" as const),
				...(response === "error" ? { errorMessage: "temporary failure" } : {}),
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (response === "error") stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	} as unknown as Models;
}

function toolModels(): Models {
	return {
		streamSimple: (_model: Model<Api>, context: Context) => {
			const stream = new AssistantMessageEventStream();
			const hasToolResult = context.messages.some((message) => message.role === "toolResult");
			const message = {
				role: "assistant" as const,
				content: hasToolResult
					? [{ type: "text" as const, text: "tool complete" }]
					: [{ type: "toolCall" as const, id: "call-1", name: "echo", arguments: { value: "from tool" } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: hasToolResult ? ("stop" as const) : ("toolUse" as const),
				timestamp: Date.now(),
			} as AssistantMessage;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			});
			return stream;
		},
	} as unknown as Models;
}

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

describe("AgentHarness single-lane runtime", () => {
	it("runs a prompt, persists messages, and emits run events", async () => {
		const session = createSession();
		const { harness } = await AgentHarness.create({ session, models: fakeModels(), model });
		const events: string[] = [];
		harness.events.on("run_start", () => {
			events.push("start");
		});
		harness.events.on("run_end", () => {
			events.push("end");
		});

		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.kind).toBe("completed");
		expect(events).toEqual(["start", "end"]);
		expect((await session.findEntriesOnBranch({ order: "oldestFirst" })).map((entry) => entry.type)).toEqual([
			"message",
			"message",
		]);
		expect(await harness.getLeafId()).toBeTruthy();
	});

	it("executes a fake tool and persists the tool result before continuing", async () => {
		const parameters = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof parameters> = {
			name: "echo",
			label: "echo",
			description: "Return a value",
			parameters,
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: params.value }],
				details: {},
			}),
		};
		const session = createSession("tool");
		const { harness } = await AgentHarness.create({
			session,
			models: toolModels(),
			model,
			tools: [tool as unknown as HarnessTool],
		});
		const result = await harness.prompt("use the tool");
		expect(result.ok).toBe(true);
		const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("supports next-run queueing and cancellation", async () => {
		const { harness } = await AgentHarness.create({ session: createSession(), models: fakeModels(), model });
		const queued = await harness.nextRun("queued");
		expect(queued.ok).toBe(true);
		if (queued.ok) {
			const cancelled = await harness.cancelQueued(queued.value.entryId);
			expect(cancelled.ok).toBe(true);
			if (cancelled.ok) expect(cancelled.value).toEqual({ outcome: "cancelled" });
		}
		const second = await harness.nextRun("queued");
		expect(second.ok).toBe(true);
		await harness.runToCompletion();
		const watch = await harness.watch();
		expect(watch.snapshot.operation).toBeNull();
	});

	it("restores an unfinished operation and resumes its prompt", async () => {
		const session = createSession("suspended");
		const prompt = { role: "user" as const, content: [{ type: "text" as const, text: "resume me" }], timestamp: 1 };
		const operation: NewRecord<OperationStartedRecord> = {
			type: "operation_started",
			id: "run-1",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [prompt], initialMessages: [] },
		};
		await session.appendRecord(operation);
		const { harness, suspended } = await AgentHarness.create({ session, models: fakeModels(), model });
		expect(suspended).toHaveLength(1);
		const result = await harness.resume();
		expect(result.ok).toBe(true);
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(1);
	});

	it("retries a failed assistant attempt and records each attempt", async () => {
		const session = createSession("retry");
		const { harness } = await AgentHarness.create({
			session,
			models: fakeModels(["error", "ok"]),
			model,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		const result = await harness.prompt("retry me");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.kind).toBe("completed");
		expect(await session.findRecords({ type: "step_attempt" })).toHaveLength(2);
	});

	it("keeps configuration and resources isolated", async () => {
		const { harness } = await AgentHarness.create({ session: createSession(), models: fakeModels(), model });
		const tool = { name: "tool", label: "Tool" } as HarnessTool;
		const tools = [tool];
		await harness.setTools(tools);
		tools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);
		const names = ["tool"];
		await harness.setActiveTools(names);
		names.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["tool"]);
	});

	it("reports a closed harness before starting new work", async () => {
		const { harness } = await AgentHarness.create({ session: createSession(), models: fakeModels(), model });
		await harness.close();
		const result = await harness.prompt("hello");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.name).toBe("Closed");
	});
});
