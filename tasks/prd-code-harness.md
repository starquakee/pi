# PRD: Pi Code Harness

## Introduction

Pi already exposes an extensible agent loop, durable session primitives, tool hooks, skills, and a transport-neutral protocol. Its current harness API is still a scaffold in `packages/agent/src/harness`, and the default coding-agent tools run with the host process permissions. This project turns the existing harness surface into a local-first code harness with explicit planning, policy-controlled execution, verification, and durable audit state.

## References

- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/session/`
- `packages/agent/src/harness/runtime/` (selectively audit `origin/dev`; do not merge Chord work)
- `packages/protocol/src/schemas.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/main.ts`
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/hooks-guide
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://github.com/starquakee/claude-code

## Decisions

- Create `ralph/code-harness` from `main`; keep `main` untouched.
- Complete and extend the existing `@earendil-works/pi-agent-core` harness API. Do not add a duplicate `packages/harness` package.
- Treat `origin/dev` as an internal reference only. Port only tested, pre-Chord harness slices; do not merge the branch wholesale.
- Preserve existing `pi` CLI behavior, legacy session JSONL, and protocol v1. Harness state and audit data are separate.
- Use `read-only`, `workspace-write`, and explicit `full-access` policy modes. Plan uses read-only; Execute uses workspace-write in a task worktree.
- Resolve policy rules in `deny -> ask -> allow -> mode` order. Unparseable compound commands are never auto-allowed.
- Default network is disabled. A backend must declare enforceable capabilities; the core must not claim isolation it cannot enforce.
- Canonicalize filesystem paths and reject symlink/junction escapes.
- Require explicit plan approval before writes, subagents, or merges.
- Child agents inherit the parent policy ceiling, use independent worktrees for writes, and are limited to four concurrent workers and depth one.
- Completion requires every declared required verification command to pass.
- Store detailed harness metadata globally per canonical project; keep output bounded and redact credentials.
- Use clean-room implementations inspired by public behavior and docs only. Never copy extracted Claude Code source, prompts, constants, or assets.

## Goals

- Make the existing durable `AgentHarness` single-lane operations usable and recoverable.
- Add deterministic policy, approval, execution, worktree, task, audit, and subagent abstractions.
- Expose a versioned `.pi/harness.json` configuration surface with project trust gating.
- Extend `pi-protocol` with a harness namespace using the existing CBOR framing and snapshot-authoritative event model.
- Add `pi harness plan|run|verify|status` without changing existing invocation semantics.
- Validate the complete local flow on Windows with fake model/approval backends and a real temporary Git repository.

## Non-Goals

- No wholesale merge of `origin/dev` or its Chord migration.
- No proprietary Claude Code code or assets.
- No self-built OS sandbox, remote runner, MCP implementation, or plugin marketplace in this release.
- No automatic merge into `main` or automatic Pull Request creation.
- No migration of existing Pi session files.

## User Stories

### US-001: Branch and Ralph bootstrap

**Description:** As a maintainer, I want a repository-local Ralph run contract so that each implementation iteration has durable scope and memory.

**Acceptance Criteria:**

- [x] Branch is `ralph/code-harness` and starts from `main`.
- [x] `tasks/prd-code-harness.md`, root `prd.json`, `scripts/ralph/AGENTS.md`, `scripts/ralph/ralph.sh`, `progress.txt`, and `archive/` exist.
- [x] `prd.json.branchName` is `ralph/code-harness` and all stories were initialized with `passes: false`.
- [x] `bash scripts/ralph/ralph.sh --dry-run` succeeds with the selected agent.

### US-002: Single-lane durable runtime

**Description:** As an SDK caller, I want one harness lane to prompt, execute tools, queue messages, abort, wait, and watch so that Pi can drive a task without the scaffold errors.

**Acceptance Criteria:**

- [x] Supported single-lane `AgentHarness` operations no longer return `HarnessNotImplemented`.
- [x] Prompt, tool-result ordering, steering, follow-up, abort, idle waiting, and watch snapshots are deterministic.
- [x] Memory-session tests use a fake model and fake tool and cover success, tool failure, abort, and queue behavior.
- [x] Focused harness tests pass (`7 tests`).

### US-003: Recovery, retry, and persistence

**Description:** As a long-running task, I want operation boundaries and retries to survive interruption so that a process restart does not duplicate effects or lose state.

**Acceptance Criteria:**

- [x] Operation and step-attempt records are persisted; suspended operations are discovered and resumed.
- [x] Retry counts and backoff are bounded and observable; repeated failure stops the operation with evidence.
- [x] Existing JSONL/memory storage tests cover corrupt, torn, duplicate, and missing-result guards.
- [x] Existing Pi session format and resume behavior remain unchanged.

### US-004: Policy and approval core

**Description:** As a user, I want predictable permission decisions so that tool, file, shell, network, and credential effects cannot silently exceed the task policy.

**Acceptance Criteria:**

- [x] Public types include `HarnessPolicy`, `PolicyRule`, `PolicyDecision`, `ApprovalBroker`, and `PolicyEnforcedExecutionEnv`.
- [x] `deny`, `ask`, `allow`, and mode decisions follow the documented precedence and support once/session/persistent scope.
- [x] Compound commands are classified segment-by-segment; unsafe parsing never auto-allows.
- [x] Path checks reject canonical and symlink/junction escapes and every denial is auditable.

### US-005: Task lifecycle and audit

**Description:** As a developer, I want a durable Plan -> Execute -> Verify task so that completion is backed by reviewable evidence.

**Acceptance Criteria:**

- [ ] Task snapshots support `planned`, `awaiting_approval`, `executing`, `verifying`, `paused`, `failed`, and `completed`.
- [ ] Execute rejects plans that have not been explicitly approved.
- [ ] Verify records required commands, exit codes, duration, bounded output, and diff summary; any required failure prevents `completed`.
- [ ] Global per-project JSONL metadata is used and secrets are redacted.

### US-006: Execution backends and Git worktrees

**Description:** As a task coordinator, I want backend-neutral execution and safe worktree ownership so that local, Gondolin, and container adapters can share one contract.

**Acceptance Criteria:**

- [ ] Local execution wraps the existing `ExecutionEnv`/`BashOperations` contracts.
- [ ] `SandboxAdapter` declares capabilities and lifecycle without embedding Docker/QEMU logic in the core.
- [ ] `WorktreeManager` records baseline, path, commits, and diff; refuses dirty baselines and only cleans harness-owned paths.
- [ ] Child write results are patches/commits plus evidence; no automatic merge occurs.

### US-007: Bounded subagent orchestration

**Description:** As a coordinator, I want role-based child agents so that complex work can be parallelized without unbounded permissions or resource use.

**Acceptance Criteria:**

- [ ] Planner, implementer, and reviewer roles are supported with inherited defaults and explicit model/thinking overrides.
- [ ] Concurrency defaults to four and recursion depth to one, with hard upper bounds.
- [ ] Child policy cannot exceed the parent policy and child worktree state is observable.
- [ ] Results require coordinator approval before patch/commit application.

### US-008: Harness protocol namespace

**Description:** As an SDK or future IDE client, I want a stable harness protocol so that task state and approvals can be driven outside the TUI.

**Acceptance Criteria:**

- [ ] Existing CBOR framing is reused and the legacy protocol v1 remains unchanged.
- [ ] Harness capability/version, task snapshots, revisions, progress events, approval requests/responses, and audit summaries are schema-validated.
- [ ] Snapshots are authoritative; incremental events are bounded UI hints and reconnect can resnapshot.
- [ ] `packages/client` and `packages/server` contract tests cover stale, duplicate, denied, and disconnected approvals.

### US-009: Harness CLI

**Description:** As a local developer, I want explicit harness commands so that planning, execution, and verification are easy to inspect and script.

**Acceptance Criteria:**

- [ ] `pi harness plan`, `pi harness run`, `pi harness verify`, and `pi harness status` are documented and functional.
- [ ] Human-readable output and structured JSON events are both supported.
- [ ] `.pi/harness.json` is strict `version: 1` and project trust diagnostics are surfaced.
- [ ] Existing `pi` commands and flags retain their current behavior.

### US-010: End-to-end validation and residue guard

**Description:** As a maintainer, I want a real local smoke and forbidden-behavior checks so that the harness is safe to extend.

**Acceptance Criteria:**

- [ ] Temporary Git repository smoke covers plan approval, pause/resume, worktree, verify, audit redaction, and failure stop.
- [ ] Dirty worktree, path escape, compound command, unavailable network capability, denied approval, duplicate recovery, and merge conflict cases are covered.
- [ ] A residue guard proves supported operations do not regress to `HarnessNotImplemented`.
- [ ] `npm run check` and `./test.sh` pass after the final story.

## Functional Requirements

- FR-1: The harness must expose policy and task state through TypeScript APIs and protocol DTOs.
- FR-2: Policy enforcement must occur before external tool effects and remain observable through audit events.
- FR-3: All task mutations must be durable or explicitly reported as not durable.
- FR-4: The CLI must refuse execution when the repository baseline is dirty unless a future, explicitly scoped override is added.
- FR-5: The harness must never report an unenforced sandbox or a passing verification without evidence.

## Validation

- Hydrate dependencies with `npm install --ignore-scripts`.
- Run `bash scripts/ralph/ralph.sh --dry-run` before launching iterations.
- Run focused harness tests with `npm --workspace=@earendil-works/pi-agent-core run test:harness`.
- Run `npm run check` after code changes and `./test.sh` for non-e2e regression coverage.
- Run a real Windows smoke against a temporary Git repository with fake model and execution/approval adapters.
- First execution batch is US-001 through US-003 only.

## Risks

- The pre-Chord implementation on `origin/dev` is large and may contain unrelated migrations; use file-level audits and small ports only.
- Host-local execution cannot enforce network isolation by itself; capability negotiation must block unsafe claims.
- Worktree cleanup can destroy uncommitted child work; preserve dirty paths and stop for review.
- Dependency installation is currently absent in the checkout; validation cannot run until dependencies are hydrated.
- Ralph must stop on repeated story failure, dirty worktrees, missing evidence, or scope expansion.
