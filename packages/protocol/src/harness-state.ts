import type {
	HarnessApprovalRequest,
	HarnessApprovalResponse,
	HarnessProgress,
	HarnessTaskSnapshot,
} from "./schemas.ts";

/** Authoritative client-side harness state. Progress never mutates the snapshot. */
export class HarnessRevisionTracker {
	private currentSnapshot?: HarnessTaskSnapshot;
	private currentRevision = -1;
	private resnapshotRequired = false;

	get snapshot(): HarnessTaskSnapshot | undefined {
		return this.currentSnapshot;
	}

	get revision(): number {
		return this.currentRevision;
	}

	get needsResnapshot(): boolean {
		return this.resnapshotRequired;
	}

	applySnapshot(snapshot: HarnessTaskSnapshot): boolean {
		if (snapshot.revision < this.currentRevision) return false;
		this.currentSnapshot = snapshot;
		this.currentRevision = snapshot.revision;
		this.resnapshotRequired = false;
		return true;
	}

	acceptProgress(progress: HarnessProgress): boolean {
		if (progress.revision <= this.currentRevision) return false;
		this.resnapshotRequired = true;
		return true;
	}

	reset(): void {
		this.currentSnapshot = undefined;
		this.currentRevision = -1;
		this.resnapshotRequired = false;
	}
}

export type ApprovalResponseStatus = "accepted" | "stale" | "duplicate" | "unknown";

/** Rejects stale, duplicate, and unknown approval responses at the protocol boundary. */
export class HarnessApprovalTracker {
	private readonly pending = new Map<string, HarnessApprovalRequest>();
	private readonly completed = new Set<string>();

	add(request: HarnessApprovalRequest): void {
		if (!this.completed.has(request.requestId)) this.pending.set(request.requestId, request);
	}

	accept(response: HarnessApprovalResponse): ApprovalResponseStatus {
		if (this.completed.has(response.requestId)) return "duplicate";
		const request = this.pending.get(response.requestId);
		if (!request) return "unknown";
		if (request.taskId !== response.taskId || request.revision !== response.revision) return "stale";
		this.pending.delete(response.requestId);
		this.completed.add(response.requestId);
		return "accepted";
	}

	clear(): void {
		this.pending.clear();
		this.completed.clear();
	}
}
