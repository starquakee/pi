/**
 * Policy and approval core for the Pi code harness.
 *
 * Evaluation order: deny -> ask -> allow -> mode default.
 * Compound shell commands are classified segment-by-segment; an unparseable
 * segment never auto-allows. Path checks use canonicalized paths and reject
 * symlink/junction escapes. Every decision is auditable via PolicyDecision.
 */

import { posix } from "node:path";

import type { ExecutionEnv, FileSystem, ShellExecOptions } from "./types.ts";
import { ExecutionError, FileError, type Result, err as resultErr } from "./types.ts";

// ---------------------------------------------------------------------------
// Core policy types
// ---------------------------------------------------------------------------

/**
 * Scope determines how long an approval granted interactively by the user
 * remains valid.
 *
 * - "once"       — valid for one tool call, then discarded.
 * - "session"    — valid for the lifetime of the current harness session.
 * - "persistent" — written to durable storage and valid across sessions.
 */
export type PolicyScope = "once" | "session" | "persistent";

/** Effects that a policy can protect. */
export type PolicyEffect = "read" | "write" | "execute" | "network" | "credential";

/**
 * Action that a policy rule may take.
 *
 * - "deny"  — block without prompting.
 * - "ask"   — prompt the user for an approval decision.
 * - "allow" — permit without prompting.
 */
export type PolicyAction = "deny" | "ask" | "allow";

/** A single policy rule that matches a category of tool calls or filesystem paths. */
export interface PolicyRule {
	/** Human-readable label for auditing. */
	label: string;
	/** Describes which tool calls or paths this rule applies to. */
	match: PolicyMatch;
	/** The action to take when the rule matches. */
	action: PolicyAction;
	/** Scope of this rule when it grants an approval. */
	scope?: PolicyScope;
}

/**
 * Matcher describing when a rule applies.
 *
 * Multiple fields are ANDed. A missing field matches everything.
 */
export interface PolicyMatch {
	/** Exact tool name to match (e.g. "bash", "edit"). */
	toolName?: string;
	/**
	 * Shell command glob/substring to match against the `command` argument.
	 * This is a simple substring check — no glob expansion — to avoid
	 * accidental over-matching.
	 */
	commandContains?: string;
	/**
	 * Absolute path prefix that must be a prefix of the canonical path
	 * addressed by the tool call. Checked after canonicalization and
	 * symlink/junction rejection.
	 */
	pathPrefix?: string;
	/** Hostname (or hostname suffix) to match for a network request. */
	networkHost?: string;
	/** Credential identifier to match for a credential request. */
	credentialName?: string;
	/** Effect to match. Missing effects are inferred from the request. */
	effect?: PolicyEffect;
}

/**
 * Mode-level default policy when no rule matches.
 *
 * - "read-only"       — deny all write/exec effects; allow read-only tools.
 * - "workspace-write" — allow workspace reads, writes, and execution; deny network/credentials.
 * - "full-access"     — allow all effects; still subject to deny rules.
 */
export type PolicyMode = "read-only" | "workspace-write" | "full-access";

/** Top-level harness policy. */
export interface HarnessPolicy {
	/** Mode-level default when no explicit rule matches. */
	mode: PolicyMode;
	/** Ordered list of rules evaluated before the mode default. */
	rules: PolicyRule[];
	/** Absolute path of the workspace root. Path escapes are measured against this. */
	workspaceRoot?: string;
	/** Network capability advertised by the backend. Disabled by default. */
	network?: "disabled" | "enabled";
}

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

/** Outcome of evaluating a policy for one tool call. */
export type PolicyDecision =
	| { verdict: "allow"; ruleLabel?: string; scope?: PolicyScope }
	| { verdict: "deny"; ruleLabel?: string; reason: string }
	| { verdict: "ask"; ruleLabel?: string; scope?: PolicyScope; reason: string };

/** Input to the pure policy evaluator. */
export interface PolicyRequest {
	toolName: string;
	toolArgs?: unknown;
	effect?: PolicyEffect;
	command?: string;
	path?: string;
	networkHost?: string;
	credentialName?: string;
}

/** Evaluate one request using the fixed deny → ask → allow → mode order. */
export function evaluatePolicy(policy: HarnessPolicy, request: PolicyRequest): PolicyDecision {
	const effect = request.effect ?? inferEffect(request.toolName);
	if (effect === "network" && policy.network !== "enabled") {
		return { verdict: "deny", reason: "Network is disabled by the execution backend" };
	}
	let ask: PolicyRule | undefined;
	let allow: PolicyRule | undefined;
	for (const rule of policy.rules) {
		if (!matchesRule(rule, request)) continue;
		if (rule.action === "deny") {
			return { verdict: "deny", ruleLabel: rule.label, reason: `Denied by rule: ${rule.label}` };
		}
		if (rule.action === "ask") ask ??= rule;
		else allow ??= rule;
	}
	if (ask) {
		return {
			verdict: "ask",
			ruleLabel: ask.label,
			scope: ask.scope ?? "once",
			reason: `Rule requires approval: ${ask.label}`,
		};
	}
	if (allow) return { verdict: "allow", ruleLabel: allow.label, scope: allow.scope };
	return modeDefault(policy, request);
}

/** Stable key used by brokers to persist an approval decision. */
export function policyApprovalKey(ruleLabel: string, request: PolicyRequest): string {
	return `${ruleLabel}::${request.toolName}::${JSON.stringify({
		command: request.command,
		path: request.path,
		networkHost: request.networkHost,
		credentialName: request.credentialName,
	})}`;
}

/** Auditable record emitted for every policy evaluation. */
export interface PolicyAuditEvent {
	/** Monotonic timestamp (ms since process start). */
	timestamp: number;
	/** Name of the tool being evaluated. */
	toolName: string;
	/** Raw argument object passed to the tool. */
	toolArgs: unknown;
	/** Resulting decision. */
	decision: PolicyDecision;
	/** Whether the call was part of a compound command. */
	compound?: boolean;
	/** Canonicalized path, if one was resolved during evaluation. */
	canonicalPath?: string;
}

// ---------------------------------------------------------------------------
// Approval broker
// ---------------------------------------------------------------------------

/** Request sent to the approval broker when the policy yields "ask". */
export interface ApprovalRequest {
	toolName: string;
	toolArgs: unknown;
	reason: string;
	scope: PolicyScope;
}

/** Response from the approval broker. */
export type ApprovalResponse = { approved: true; scope: PolicyScope } | { approved: false; reason: string };

/**
 * Abstraction over the human-approval channel.
 *
 * Implementations may show an interactive prompt, auto-approve in tests, or
 * write approvals to a durable store. The harness never auto-approves when
 * the policy yields "ask" — it always delegates to this broker.
 */
export interface ApprovalBroker {
	/** Request approval for a single tool call. */
	requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
	/** Look up a previously persisted approval, when durable approvals are supported. */
	hasApproval?(key: string): boolean | Promise<boolean>;
	/** Persist a granted approval, when durable approvals are supported. */
	rememberApproval?(key: string, scope: PolicyScope): void | Promise<void>;
}

/** Deterministic broker useful for embedding and tests. */
export class InMemoryApprovalBroker implements ApprovalBroker {
	private readonly persisted = new Set<string>();
	private readonly decide: (request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>;

	constructor(decide: (request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>) {
		this.decide = decide;
	}

	async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
		return await this.decide(request);
	}

	hasApproval(key: string): boolean {
		return this.persisted.has(key);
	}

	rememberApproval(key: string, scope: PolicyScope): void {
		if (scope === "persistent") this.persisted.add(key);
	}
}

// ---------------------------------------------------------------------------
// PolicyEnforcedExecutionEnv
// ---------------------------------------------------------------------------

/** Context passed to tools wrapped by PolicyEnforcedExecutionEnv. */
export interface PolicyEnforcedContext {
	toolName: string;
}

/**
 * Wraps an ExecutionEnv to enforce a HarnessPolicy before every shell exec
 * and filesystem write. Read-only filesystem methods are not blocked; only
 * writes and exec calls consult the policy.
 *
 * Every decision — allow, deny, or ask — is recorded in the audit log.
 */
export class PolicyEnforcedExecutionEnv implements ExecutionEnv {
	private readonly inner: ExecutionEnv;
	private readonly policy: HarnessPolicy;
	private readonly broker?: ApprovalBroker;
	private readonly auditLog: PolicyAuditEvent[] = [];

	/** Session-scoped approvals granted during this instance's lifetime. */
	private readonly sessionApprovals = new Set<string>();

	constructor(inner: ExecutionEnv, policy: HarnessPolicy, broker?: ApprovalBroker) {
		this.inner = inner;
		this.policy = policy;
		this.broker = broker;
	}

	// --- Audit access -------------------------------------------------------

	/** Return a copy of the accumulated audit log. */
	getAuditLog(): PolicyAuditEvent[] {
		return [...this.auditLog];
	}

	// --- Shell (policy-enforced) --------------------------------------------

	get cwd(): string {
		return this.inner.cwd;
	}

	async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		const decision = await this.evaluateShellCommand(command);
		this.recordAudit("bash", { command }, decision);
		if (decision.verdict !== "allow") {
			return resultErr(new ExecutionError("unknown", `Policy denied: ${decision.reason}`));
		}
		return this.inner.exec(command, options);
	}

	async cleanup(): Promise<void> {
		return this.inner.cleanup();
	}

	// --- FileSystem (policy-enforced writes) --------------------------------

	async absolutePath(path: string, abortSignal?: AbortSignal): ReturnType<FileSystem["absolutePath"]> {
		return this.inner.absolutePath(path, abortSignal);
	}

	async joinPath(parts: string[], abortSignal?: AbortSignal): ReturnType<FileSystem["joinPath"]> {
		return this.inner.joinPath(parts, abortSignal);
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): ReturnType<FileSystem["readTextFile"]> {
		return this.inner.readTextFile(path, abortSignal);
	}

	async readTextLines(
		path: string,
		options?: Parameters<FileSystem["readTextLines"]>[1],
	): ReturnType<FileSystem["readTextLines"]> {
		return this.inner.readTextLines(path, options);
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): ReturnType<FileSystem["readBinaryFile"]> {
		return this.inner.readBinaryFile(path, abortSignal);
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): ReturnType<FileSystem["writeFile"]> {
		const decision = await this.evaluatePathWrite("write", path);
		this.recordAudit("write", { path }, decision);
		if (decision.verdict !== "allow") {
			return resultErr(toFileError("permission_denied", decision.reason, path));
		}
		return this.inner.writeFile(path, content, abortSignal);
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): ReturnType<FileSystem["appendFile"]> {
		const decision = await this.evaluatePathWrite("write", path);
		this.recordAudit("write", { path }, decision);
		if (decision.verdict !== "allow") {
			return resultErr(toFileError("permission_denied", decision.reason, path));
		}
		return this.inner.appendFile(path, content, abortSignal);
	}

	async renameFile(
		sourcePath: string,
		destinationPath: string,
		abortSignal?: AbortSignal,
	): ReturnType<FileSystem["renameFile"]> {
		const srcDecision = await this.evaluatePathWrite("rename", sourcePath);
		const dstDecision = await this.evaluatePathWrite("rename", destinationPath);
		const decision = mergeDecisions(srcDecision, dstDecision);
		this.recordAudit("rename", { sourcePath, destinationPath }, decision);
		if (decision.verdict !== "allow") {
			return resultErr(toFileError("permission_denied", decision.reason, sourcePath));
		}
		return this.inner.renameFile(sourcePath, destinationPath, abortSignal);
	}

	async fileInfo(path: string, abortSignal?: AbortSignal): ReturnType<FileSystem["fileInfo"]> {
		return this.inner.fileInfo(path, abortSignal);
	}

	async listDir(path: string, abortSignal?: AbortSignal): ReturnType<FileSystem["listDir"]> {
		return this.inner.listDir(path, abortSignal);
	}

	async canonicalPath(path: string, abortSignal?: AbortSignal): ReturnType<FileSystem["canonicalPath"]> {
		return this.inner.canonicalPath(path, abortSignal);
	}

	async exists(path: string, abortSignal?: AbortSignal): ReturnType<FileSystem["exists"]> {
		return this.inner.exists(path, abortSignal);
	}

	async createDir(
		path: string,
		options?: Parameters<FileSystem["createDir"]>[1],
	): ReturnType<FileSystem["createDir"]> {
		const decision = await this.evaluatePathWrite("mkdir", path);
		this.recordAudit("mkdir", { path }, decision);
		if (decision.verdict !== "allow") {
			return resultErr(toFileError("permission_denied", decision.reason, path));
		}
		return this.inner.createDir(path, options);
	}

	async remove(path: string, options?: Parameters<FileSystem["remove"]>[1]): ReturnType<FileSystem["remove"]> {
		const decision = await this.evaluatePathWrite("remove", path);
		this.recordAudit("remove", { path }, decision);
		if (decision.verdict !== "allow") {
			return resultErr(toFileError("permission_denied", decision.reason, path));
		}
		return this.inner.remove(path, options);
	}

	async createTempDir(prefix?: string, abortSignal?: AbortSignal): ReturnType<FileSystem["createTempDir"]> {
		return this.inner.createTempDir(prefix, abortSignal);
	}

	async createTempFile(
		options?: Parameters<FileSystem["createTempFile"]>[0],
	): ReturnType<FileSystem["createTempFile"]> {
		return this.inner.createTempFile(options);
	}

	/** Authorize a network request without performing it. */
	async authorizeNetwork(host: string): Promise<PolicyDecision> {
		const decision = await this.resolveAsk(
			evaluatePolicy(this.policy, {
				toolName: "network",
				effect: "network",
				networkHost: host,
				toolArgs: { host },
			}),
			{ toolName: "network", effect: "network", networkHost: host, toolArgs: { host } },
		);
		this.recordAudit("network", { host }, decision);
		return decision;
	}

	/** Authorize access to a named credential without exposing its value. */
	async authorizeCredential(name: string): Promise<PolicyDecision> {
		const request = {
			toolName: "credential",
			effect: "credential" as const,
			credentialName: name,
			toolArgs: { name },
		};
		const decision = await this.resolveAsk(evaluatePolicy(this.policy, request), request);
		this.recordAudit("credential", { name }, decision);
		return decision;
	}

	// ---------------------------------------------------------------------------
	// Policy evaluation helpers
	// ---------------------------------------------------------------------------

	private async evaluateShellCommand(command: string): Promise<PolicyDecision> {
		const segments = parseShellSegments(command);
		if (segments === null) {
			// Unparseable compound command — never auto-allow.
			const decision: PolicyDecision = {
				verdict: "deny",
				reason: "Unparseable compound command; auto-allow is not permitted.",
			};
			return decision;
		}

		// Evaluate each segment; the strictest verdict wins.
		let strictest: PolicyDecision | undefined;
		for (const segment of segments) {
			const decision = await this.resolveDecision({ toolName: "bash", effect: "execute", command: segment });
			strictest = strictest === undefined ? decision : mergeDecisions(strictest, decision);
			if (strictest.verdict === "deny") return strictest;
		}

		if (strictest === undefined) {
			return modeDefault(this.policy, { toolName: "bash", effect: "execute", command });
		}
		if (strictest.verdict === "ask") {
			return this.resolveAsk(strictest, { toolName: "bash", effect: "execute", command, toolArgs: { command } });
		}
		return strictest;
	}

	private async evaluatePathWrite(toolName: string, path: string): Promise<PolicyDecision> {
		// Check for path escapes before consulting rules.
		const escapeReason = detectPathEscape(path, this.policy.workspaceRoot ?? this.inner.cwd);
		if (escapeReason) {
			const decision: PolicyDecision = {
				verdict: "deny",
				reason: `Path escape rejected: ${escapeReason}`,
			};
			return decision;
		}
		const physical = await this.resolvePhysicalPath(path);
		if (physical.reason) {
			return { verdict: "deny", reason: physical.reason };
		}

		const decision = await this.resolveDecision({
			toolName,
			effect: "write",
			path: physical.path ?? path,
			toolArgs: { path },
		});
		if (decision.verdict === "ask") {
			return this.resolveAsk(decision, {
				toolName,
				effect: "write",
				path: physical.path ?? path,
				toolArgs: { path },
			});
		}
		return decision;
	}

	private async resolvePhysicalPath(path: string): Promise<{ path?: string; reason?: string }> {
		const absolute = await this.inner.absolutePath(path);
		if (!absolute.ok) return { reason: `Unable to resolve path: ${absolute.error.message}` };
		const root = this.policy.workspaceRoot ?? this.inner.cwd;
		const canonicalRoot = await this.inner.canonicalPath(root);
		let candidate = absolute.value;
		let canonicalCandidate: string | undefined;
		for (;;) {
			const resolved = await this.inner.canonicalPath(candidate);
			if (resolved.ok) {
				canonicalCandidate = resolved.value;
				break;
			}
			const parent = parentPath(candidate);
			if (parent === candidate) break;
			candidate = parent;
		}
		if (canonicalRoot.ok && canonicalCandidate && !isWithin(canonicalCandidate, canonicalRoot.value)) {
			return { reason: `Path resolves outside workspace root: ${path}` };
		}
		return { path: absolute.value };
	}

	private async resolveDecision(request: PolicyRequest): Promise<PolicyDecision> {
		const decision = evaluatePolicy(this.policy, request);
		if (decision.verdict !== "ask" || !decision.ruleLabel) return decision;
		const cacheKey = ruleSessionKey(decision.ruleLabel, request);
		if (this.sessionApprovals.has(cacheKey)) {
			return { verdict: "allow", ruleLabel: decision.ruleLabel, scope: "session" };
		}
		if (this.broker?.hasApproval && (await this.broker.hasApproval(cacheKey))) {
			return { verdict: "allow", ruleLabel: decision.ruleLabel, scope: "persistent" };
		}
		return decision;
	}

	private async resolveAsk(decision: PolicyDecision, request: PolicyRequest): Promise<PolicyDecision> {
		if (decision.verdict !== "ask") return decision;
		if (!this.broker) {
			return { verdict: "deny", ruleLabel: decision.ruleLabel, reason: "Approval broker is not configured" };
		}
		const response = await this.broker.requestApproval({
			toolName: request.toolName,
			toolArgs: request.toolArgs ?? request,
			reason: decision.reason,
			scope: decision.scope ?? "once",
		});
		if (!response.approved) {
			return { verdict: "deny", ruleLabel: decision.ruleLabel, reason: response.reason };
		}
		if (response.scope === "session" && decision.ruleLabel) {
			this.sessionApprovals.add(ruleSessionKey(decision.ruleLabel, request));
		}
		if (response.scope === "persistent" && decision.ruleLabel && this.broker.rememberApproval) {
			await this.broker.rememberApproval(ruleSessionKey(decision.ruleLabel, request), response.scope);
		}
		return { verdict: "allow", ruleLabel: decision.ruleLabel, scope: response.scope };
	}

	private recordAudit(toolName: string, toolArgs: unknown, decision: PolicyDecision): void {
		this.auditLog.push({
			timestamp: Date.now(),
			toolName,
			toolArgs: sanitizeAuditValue(toolArgs),
			decision,
		});
	}
}

// ---------------------------------------------------------------------------
// Shell segment parser
// ---------------------------------------------------------------------------

/**
 * Parse a shell command into individual segments split by compound operators:
 * `;`, `&&`, `||`, `|`, and newlines.
 *
 * Returns null when the command contains subshell constructs (`$(`, `` ` ``),
 * process substitutions (`<(`, `>(`), heredocs (`<<`), or other constructs
 * that cannot be safely classified segment-by-segment.
 *
 * The intent is conservative: any ambiguity returns null, which causes the
 * caller to deny the command rather than auto-allow it.
 */
export function parseShellSegments(command: string): string[] | null {
	// Reject constructs that defeat segment-level classification.
	if (/\$\(/.test(command) || /`/.test(command) || /[<>]\(/.test(command) || /<</.test(command)) {
		return null;
	}

	// Split on ;  &&  ||  |  and newlines.
	// We walk the string manually to respect single- and double-quoted spans.
	const segments: string[] = [];
	let current = "";
	let i = 0;
	let quote: "'" | '"' | undefined;
	let sawOperator = false;
	const pushSegment = (): boolean => {
		const segment = current.trim();
		if (segment.length === 0) return false;
		segments.push(segment);
		current = "";
		sawOperator = true;
		return true;
	};
	while (i < command.length) {
		const ch = command[i];

		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			current += ch + command[i + 1];
			i += 2;
			continue;
		}

		if (quote !== undefined) {
			current += ch;
			if (ch === quote) quote = undefined;
			i++;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			i++;
			continue;
		}

		// Compound operators: && and ||
		if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
			if (!pushSegment()) return null;
			i += 2;
			continue;
		}

		// Pipe (single |)
		if (ch === "|") {
			if (!pushSegment()) return null;
			i++;
			continue;
		}

		// Semicolons and newlines
		if (ch === ";" || ch === "\n") {
			if (!pushSegment()) return null;
			i++;
			continue;
		}
		if (ch === "&" || ch === "<" || ch === ">") return null;

		current += ch;
		i++;
	}
	if (quote !== undefined) return null;
	const last = current.trim();
	if (last.length > 0) segments.push(last);
	else if (sawOperator) return null;

	return segments.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Path escape detection
// ---------------------------------------------------------------------------

/**
 * Returns a non-null description when `path` escapes `workspaceRoot`.
 *
 * Checks:
 * 1. Symlink/junction indicators (Windows junction prefix `\\?\`).
 * 2. `..` traversal after normalization.
 * 3. Absolute path that lies outside `workspaceRoot`.
 */
export function detectPathEscape(path: string, workspaceRoot: string): string | null {
	// Reject Windows junction/volume GUID paths.
	if (/^\\\\\?\\/.test(path) || /^\\\\\.\\./.test(path)) {
		return `Windows junction or volume GUID path rejected: ${path}`;
	}

	// Normalize with both posix and win32 path modules to catch mixed separators.
	const normalized = normalizePath(path);
	const root = normalizePath(workspaceRoot);
	if (hasParentSegment(path)) return `Path traversal rejected: ${path}`;

	// Resolved absolute path must be inside the workspace root.
	if (!posixIsAbsolute(normalized)) {
		// Relative path — check for traversal after normalization.
		return null; // relative paths within workspace are allowed
	}

	if (!isWithin(normalized, root)) {
		return `Path escapes workspace root (${workspaceRoot}): ${path}`;
	}
	return null;
}

function normalizePath(p: string): string {
	// Normalize Windows backslashes to forward slashes, then posix-normalize.
	return posix.normalize(p.replace(/\\/g, "/"));
}

function posixIsAbsolute(p: string): boolean {
	return p.startsWith("/") || /^[A-Za-z]:/.test(p);
}

function hasParentSegment(path: string): boolean {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.some((segment) => segment === "..");
}

function isWithin(path: string, root: string): boolean {
	const normalizedPath = normalizePath(path).replace(/\/$/, "");
	const normalizedRoot = normalizePath(root).replace(/\/$/, "");
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function parentPath(path: string): string {
	const normalized = normalizePath(path).replace(/\/$/, "");
	const index = normalized.lastIndexOf("/");
	if (index <= 0) return normalized;
	return normalized.slice(0, index);
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function matchesRule(rule: PolicyRule, request: PolicyRequest): boolean {
	const { match } = rule;
	if (match.toolName !== undefined && match.toolName !== request.toolName) return false;
	const effect = request.effect ?? inferEffect(request.toolName);
	if (match.effect !== undefined && match.effect !== effect) return false;
	if (match.commandContains !== undefined) {
		const cmd = request.command ?? "";
		if (!cmd.includes(match.commandContains)) return false;
	}
	if (match.pathPrefix !== undefined) {
		const p = request.path === undefined ? "" : normalizePath(request.path);
		const prefix = normalizePath(match.pathPrefix);
		if (!p.startsWith(`${prefix}/`) && p !== prefix) return false;
	}
	if (match.networkHost !== undefined && request.networkHost !== match.networkHost) return false;
	if (match.credentialName !== undefined && request.credentialName !== match.credentialName) return false;
	return true;
}

function inferEffect(toolName: string): PolicyEffect {
	if (toolName === "bash" || toolName === "shell") return "execute";
	if (toolName === "network" || toolName === "fetch" || toolName === "http") return "network";
	if (toolName === "credential" || toolName === "secret") return "credential";
	if (toolName === "read" || toolName === "list" || toolName === "search") return "read";
	return "write";
}

function modeDefault(policy: HarnessPolicy, request: PolicyRequest): PolicyDecision {
	const mode = policy.mode;
	const effect = request.effect ?? inferEffect(request.toolName);
	if (effect === "network") {
		return mode === "full-access" && policy.network === "enabled"
			? { verdict: "allow" }
			: { verdict: "deny", reason: `Mode ${mode} denies network access` };
	}
	if (effect === "credential") {
		return mode === "full-access"
			? { verdict: "allow" }
			: { verdict: "deny", reason: `Mode ${mode} denies credential access` };
	}
	if (mode === "read-only" && (effect === "write" || effect === "execute")) {
		return { verdict: "deny", reason: `Mode read-only denies ${effect}` };
	}
	return { verdict: "allow" };
}

// ---------------------------------------------------------------------------
// Decision merging
// ---------------------------------------------------------------------------

/**
 * Merge two decisions, returning the stricter one.
 *
 * Precedence (strictest first): deny > ask > allow.
 */
function mergeDecisions(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
	if (a.verdict === "deny" || b.verdict === "deny") {
		return a.verdict === "deny" ? a : b;
	}
	if (a.verdict === "ask" || b.verdict === "ask") {
		return a.verdict === "ask" ? a : b;
	}
	return a; // both allow
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFileError(code: FileError["code"], message: string, path?: string): FileError {
	return new FileError(code, message, path);
}

const ruleSessionKey = policyApprovalKey;

function sanitizeAuditValue(value: unknown, key?: string): unknown {
	if (key !== undefined && /(token|secret|password|credential|api[-_]?key|authorization)/i.test(key)) {
		return "[REDACTED]";
	}
	if (typeof value === "string") {
		const redacted = value.replace(
			/((?:token|secret|password|credential|api[-_]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi,
			"$1[REDACTED]",
		);
		return redacted.length > 4096 ? `${redacted.slice(0, 4096)}…` : redacted;
	}
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeAuditValue(item));
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) {
			result[entryKey] = sanitizeAuditValue(entryValue, entryKey);
		}
		return result;
	}
	return value;
}
