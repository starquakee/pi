import { describe, expect, it } from "vitest";
import {
	encodeHarnessClientMessage,
	encodeHarnessServerMessage,
	HarnessApprovalTracker,
	HarnessClientMessageDecoder,
	HarnessRevisionTracker,
	HarnessServerMessageDecoder,
	parseHarnessClientMessage,
	parseHarnessServerMessage,
} from "../src/index.ts";

const snapshot = {
	namespace: "harness" as const,
	version: 1 as const,
	taskId: "task-1",
	projectId: "project-1",
	state: "verifying" as const,
	revision: 3,
	goal: "verify",
	changeScope: ["packages/agent"],
	capabilities: [],
	verificationCommands: ["npm run check"],
	approved: true,
	updatedAt: 1,
	verification: [],
};

describe("harness protocol namespace", () => {
	it("round-trips snapshots over existing framed CBOR", () => {
		const frame = encodeHarnessServerMessage({ namespace: "harness", version: 1, type: "snapshot", snapshot });
		const decoder = new HarnessServerMessageDecoder();
		const first = decoder.push(frame.subarray(0, 3));
		expect(first).toEqual([]);
		expect(decoder.push(frame.subarray(3))).toEqual([
			{ namespace: "harness", version: 1, type: "snapshot", snapshot },
		]);
		decoder.end();
	});

	it("validates approval responses and rejects malformed messages", () => {
		const response = {
			namespace: "harness" as const,
			version: 1 as const,
			type: "approval_response" as const,
			response: {
				namespace: "harness" as const,
				version: 1 as const,
				requestId: "request-1",
				taskId: "task-1",
				revision: 3,
				approved: false as const,
				reason: "declined",
			},
		};
		expect(parseHarnessClientMessage(response)).toEqual(response);
		expect(() =>
			parseHarnessClientMessage({ ...response, response: { ...response.response, revision: -1 } }),
		).toThrow();
		const frame = encodeHarnessClientMessage(response);
		const decoder = new HarnessClientMessageDecoder();
		expect(decoder.push(frame)).toEqual([response]);
		decoder.end();
	});

	it("does not accept a legacy message in the harness decoder", () => {
		expect(() => parseHarnessServerMessage({ type: "session_removed", sessionId: "s" })).toThrow();
	});

	it("treats snapshots as authoritative and rejects stale or duplicate approvals", () => {
		const revisions = new HarnessRevisionTracker();
		expect(revisions.applySnapshot(snapshot)).toBe(true);
		expect(
			revisions.acceptProgress({ namespace: "harness", version: 1, taskId: "task-1", revision: 4, event: "step" }),
		).toBe(true);
		expect(revisions.needsResnapshot).toBe(true);
		expect(revisions.applySnapshot({ ...snapshot, revision: 2 })).toBe(false);
		expect(revisions.applySnapshot({ ...snapshot, revision: 4 })).toBe(true);
		const approvals = new HarnessApprovalTracker();
		const request = {
			namespace: "harness" as const,
			version: 1 as const,
			requestId: "request-1",
			taskId: "task-1",
			revision: 4,
			reason: "write",
			scope: "session" as const,
			target: null,
		};
		approvals.add(request);
		const response = {
			namespace: "harness" as const,
			version: 1 as const,
			requestId: "request-1",
			taskId: "task-1",
			revision: 4,
			approved: true as const,
			scope: "session" as const,
		};
		expect(approvals.accept(response)).toBe("accepted");
		expect(approvals.accept(response)).toBe("duplicate");
	});
});
