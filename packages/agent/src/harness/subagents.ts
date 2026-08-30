import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../types.ts";
import type { WorktreeManager } from "./execution-backend.ts";
import type { HarnessPolicy, PolicyScope } from "./policy.ts";
import { err, ok, type Result } from "./types.ts";

export type SubagentRole = "planner" | "implementer" | "reviewer";

export interface SubagentSpec {
	id: string;
	role: SubagentRole;
	prompt: string;
	write?: boolean;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	policy?: HarnessPolicy;
}

export interface SubagentContext {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	policy: HarnessPolicy;
	depth: number;
	worktreePath?: string;
	parentTaskId?: string;
}

export interface SubagentResult {
	id: string;
	role: SubagentRole;
	status: "completed" | "failed" | "rejected";
	output?: string;
	patch?: string;
	commit?: string;
	verification?: string[];
	worktreePath?: string;
	error?: { code: string; message: string };
}

export interface SubagentRunner {
	run(spec: SubagentSpec, context: SubagentContext): Promise<SubagentResult>;
}

export interface SubagentMergeHandler {
	apply(result: SubagentResult): Promise<{ commit?: string; diffSummary?: string }>;
}

export interface SubagentOrchestratorOptions {
	parent: {
		model: Model<Api>;
		thinkingLevel: ThinkingLevel;
		policy: HarnessPolicy;
		depth?: number;
		parentTaskId?: string;
	};
	runner: SubagentRunner;
	worktreeManager?: WorktreeManager;
	mergeHandler?: SubagentMergeHandler;
	maxConcurrency?: number;
	maxDepth?: number;
}

export type SubagentErrorCode =
	| "concurrency_limit"
	| "recursion_limit"
	| "policy_escalation"
	| "worktree_required"
	| "not_found"
	| "merge_not_approved"
	| "merge_unavailable";

export class SubagentError extends Error {
	readonly code: SubagentErrorCode;

	constructor(code: SubagentErrorCode, message: string) {
		super(message);
		this.name = "SubagentError";
		this.code = code;
	}
}

export interface MergeApproval {
	approved: boolean;
	scope?: PolicyScope;
}

/** Bounded, role-aware child-agent coordinator. */
export class SubagentOrchestrator {
	private readonly parent: SubagentOrchestratorOptions["parent"];
	private readonly runner: SubagentRunner;
	private readonly worktreeManager?: WorktreeManager;
	private readonly mergeHandler?: SubagentMergeHandler;
	private readonly maxConcurrency: number;
	private readonly maxDepth: number;
	private readonly results = new Map<string, SubagentResult>();
	private readonly mergeApprovals = new Set<string>();
	private running = 0;

	constructor(options: SubagentOrchestratorOptions) {
		this.parent = options.parent;
		this.runner = options.runner;
		this.worktreeManager = options.worktreeManager;
		this.mergeHandler = options.mergeHandler;
		this.maxConcurrency = Math.min(4, Math.max(1, options.maxConcurrency ?? 4));
		this.maxDepth = Math.min(1, Math.max(0, options.maxDepth ?? 1));
	}

	async run(spec: SubagentSpec): Promise<Result<SubagentResult, SubagentError>> {
		if (this.parent.depth !== undefined && this.parent.depth >= this.maxDepth) {
			return err(new SubagentError("recursion_limit", "Subagent recursion depth limit reached"));
		}
		if (this.running >= this.maxConcurrency) {
			return err(new SubagentError("concurrency_limit", "Subagent concurrency limit reached"));
		}
		if (this.results.has(spec.id)) return ok({ ...this.results.get(spec.id)! });
		const policy = constrainPolicy(this.parent.policy, spec.policy);
		if (!policy.ok) return policy;
		let worktreePath: string | undefined;
		if (spec.write) {
			if (!this.worktreeManager)
				return err(new SubagentError("worktree_required", "Write-capable subagents require a WorktreeManager"));
			const worktree = await this.worktreeManager.create(spec.id);
			if (!worktree.ok) return err(new SubagentError("worktree_required", worktree.error.message));
			worktreePath = worktree.value.path;
		}
		const effectiveModel = spec.model ?? this.parent.model;
		const effectiveThinkingLevel = spec.thinkingLevel ?? this.parent.thinkingLevel;
		const effectiveSpec: SubagentSpec = {
			...spec,
			model: effectiveModel,
			thinkingLevel: effectiveThinkingLevel,
			policy: policy.value,
		};
		const context: SubagentContext = {
			model: effectiveModel,
			thinkingLevel: effectiveThinkingLevel,
			policy: policy.value,
			depth: (this.parent.depth ?? 0) + 1,
			worktreePath,
			parentTaskId: this.parent.parentTaskId,
		};
		this.running++;
		try {
			const result = await this.runner.run(effectiveSpec, context);
			const bounded: SubagentResult = {
				...result,
				id: spec.id,
				role: spec.role,
				worktreePath: result.worktreePath ?? worktreePath,
			};
			this.results.set(spec.id, bounded);
			return ok({ ...bounded });
		} catch (error) {
			const failed: SubagentResult = {
				id: spec.id,
				role: spec.role,
				status: "failed",
				worktreePath,
				error: { code: "runner_failed", message: error instanceof Error ? error.message : String(error) },
			};
			this.results.set(spec.id, failed);
			return ok({ ...failed });
		} finally {
			this.running--;
		}
	}

	async runAll(specs: SubagentSpec[]): Promise<Array<Result<SubagentResult, SubagentError>>> {
		const results: Array<Result<SubagentResult, SubagentError>> = [];
		for (let index = 0; index < specs.length; index += this.maxConcurrency) {
			const batch = specs.slice(index, index + this.maxConcurrency);
			const batchResults = await Promise.all(batch.map((spec) => this.run(spec)));
			results.push(...batchResults);
		}
		return results;
	}

	getResult(id: string): SubagentResult | undefined {
		const result = this.results.get(id);
		return result === undefined
			? undefined
			: { ...result, verification: result.verification === undefined ? undefined : [...result.verification] };
	}

	approveMerge(id: string): Result<MergeApproval, SubagentError> {
		if (!this.results.has(id)) return err(new SubagentError("not_found", `Unknown subagent: ${id}`));
		this.mergeApprovals.add(id);
		return ok({ approved: true, scope: "session" });
	}

	async merge(id: string): Promise<Result<{ commit?: string; diffSummary?: string }, SubagentError>> {
		const result = this.results.get(id);
		if (!result) return err(new SubagentError("not_found", `Unknown subagent: ${id}`));
		if (!this.mergeApprovals.has(id))
			return err(new SubagentError("merge_not_approved", "Coordinator approval is required before merge"));
		if (!this.mergeHandler) return err(new SubagentError("merge_unavailable", "No merge handler is configured"));
		return ok(await this.mergeHandler.apply({ ...result }));
	}
}

function constrainPolicy(
	parent: HarnessPolicy,
	child: HarnessPolicy | undefined,
): Result<HarnessPolicy, SubagentError> {
	if (!child) return ok({ ...parent, rules: [...parent.rules] });
	if (policyRank(child.mode) > policyRank(parent.mode)) {
		return err(new SubagentError("policy_escalation", "Child policy mode exceeds parent policy"));
	}
	if (parent.workspaceRoot && child.workspaceRoot && !isWithin(child.workspaceRoot, parent.workspaceRoot)) {
		return err(new SubagentError("policy_escalation", "Child policy workspace exceeds parent workspace"));
	}
	return ok({
		mode: child.mode,
		rules: [...parent.rules, ...child.rules, ...modeRestrictionRules(child.mode)],
		workspaceRoot: child.workspaceRoot ?? parent.workspaceRoot,
		network: parent.network === "enabled" ? child.network : parent.network,
	});
}

function modeRestrictionRules(mode: HarnessPolicy["mode"]): HarnessPolicy["rules"] {
	const effects =
		mode === "read-only"
			? (["write", "execute", "network", "credential"] as const)
			: (["network", "credential"] as const);
	return effects.map((effect) => ({
		label: `child mode ${mode} denies ${effect}`,
		action: "deny" as const,
		match: { effect },
	}));
}

function policyRank(mode: HarnessPolicy["mode"]): number {
	return mode === "read-only" ? 0 : mode === "workspace-write" ? 1 : 2;
}

function isWithin(path: string, root: string): boolean {
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
