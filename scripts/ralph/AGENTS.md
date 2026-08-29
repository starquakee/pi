# Ralph Agent Instructions

You are an autonomous coding agent working in the Pi monorepo on `ralph/code-harness`.

## Task contract

1. Read `tasks/prd-code-harness.md`, root `prd.json`, `progress.txt`, and the root `AGENTS.md`.
2. Read only the architecture/source files referenced by the selected story.
3. Confirm the current branch is `ralph/code-harness` and the worktree is clean before starting. Never stash, reset, or overwrite unrelated changes.
4. Pick the highest-priority story with `passes: false` and implement exactly that story.
5. Do not merge `origin/dev` wholesale, import Chord, or copy Claude Code extracted source.
6. Run the story's focused validation. After code changes, run `npm run check`; if dependencies are absent, record the blocker instead of claiming success.
7. Update the markdown PRD if decisions or acceptance evidence changed, set only the completed story's `passes` field in `prd.json`, and append an honest entry to `progress.txt`.
8. Stage only files changed for this story, commit with `feat(agent): US-XXX <short description>`, and push `ralph/code-harness` to `origin` after validation passes.

## Required validation

- `npm --workspace=@earendil-works/pi-agent-core run test:harness` for agent harness stories.
- Focused Vitest files for touched tests.
- `npm run check` after code changes.
- `./test.sh` for the final aggregate non-e2e regression story.
- Real local smoke named in the PRD for execution, protocol, CLI, or Git stories.

Do not run `npm run build` or the full `npm test` suite unless the user explicitly requests it. Do not use `--unsafe` unless an external disposable sandbox is active.

## Scope and safety

- Plan is read-only. Execute is workspace-write in a harness-owned worktree. Full access must be explicitly requested.
- Deny rules outrank ask and allow. Unparseable shell commands never auto-allow.
- Default network is disabled; do not report advisory host behavior as enforced isolation.
- Canonicalize paths and reject symlink/junction escapes.
- Preserve dirty harness-created worktrees for review rather than deleting them.
- Do not mark a story passing without command output or an explicit recorded blocker.

## Completion token

After the selected story is validated and recorded, finish normally unless every story in `prd.json` has `passes: true`. Only then output `<promise>COMPLETE</promise>` on its own line.
