#!/usr/bin/env bash
set -euo pipefail

AGENT="${RALPH_AGENT:-codex}"
AGENT_COMMAND="${RALPH_AGENT_COMMAND:-}"
MAX_ITERATIONS=3
DRY_RUN=0
UNSAFE=0

usage() {
  cat <<'EOF'
Usage: scripts/ralph/ralph.sh [options] [max_iterations]

Options:
  --agent NAME          Built-in agent (codex, claude, amp, kimi) or custom label
  --tool NAME           Backward-compatible alias for --agent
  --agent-command PATH  Executable adapter for another CLI agent
  --unsafe              Forward agent bypass flags; use only in an external sandbox
  --dry-run             Validate files and the selected agent without launching
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent|--tool)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires a value" >&2; exit 2; }
      AGENT="$2"; shift 2;;
    --agent=*|--tool=*) AGENT="${1#*=}"; shift;;
    --agent-command)
      [[ $# -ge 2 ]] || { echo "Error: --agent-command requires a value" >&2; exit 2; }
      AGENT_COMMAND="$2"; shift 2;;
    --agent-command=*) AGENT_COMMAND="${1#*=}"; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --unsafe) UNSAFE=1; shift;;
    -h|--help) usage; exit 0;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then MAX_ITERATIONS="$1"; shift
      else echo "Error: unknown argument '$1'" >&2; usage >&2; exit 2; fi;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
PRD_FILE="$REPO_ROOT/prd.json"
PROGRESS_FILE="$REPO_ROOT/progress.txt"
ARCHIVE_DIR="$REPO_ROOT/archive"
PROMPT_FILE="$SCRIPT_DIR/AGENTS.md"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: required command '$1' was not found for agent '$AGENT'." >&2
    exit 1
  }
}

validate_agent() {
  if [[ -n "$AGENT_COMMAND" ]]; then require_command "$AGENT_COMMAND"; return; fi
  case "$AGENT" in
    codex|claude|amp|kimi) require_command "$AGENT";;
    *) echo "Error: unknown agent '$AGENT'." >&2; exit 1;;
  esac
}

read_branch_name() {
  [[ -f "$PRD_FILE" ]] || return 0
  node -e "const fs=require('fs'); try { const d=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(d.branchName || ''); } catch {}" "$PRD_FILE"
}

all_stories_pass() {
  node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const s=d.userStories || []; process.exit(s.length > 0 && s.every(x => x.passes === true) ? 0 : 1);" "$PRD_FILE"
}

run_agent() {
  local iteration="$1"
  export RALPH_AGENT="$AGENT" RALPH_REPO_ROOT="$REPO_ROOT" RALPH_PROMPT_FILE="$PROMPT_FILE"
  export RALPH_ITERATION="$iteration" RALPH_MAX_ITERATIONS="$MAX_ITERATIONS" RALPH_UNSAFE="$UNSAFE"
  if [[ -n "$AGENT_COMMAND" ]]; then "$AGENT_COMMAND" "$PROMPT_FILE"; return; fi
  case "$AGENT" in
    codex)
      if [[ "$UNSAFE" -eq 1 ]]; then codex exec --dangerously-bypass-approvals-and-sandbox - < "$PROMPT_FILE"
      else codex --sandbox workspace-write --ask-for-approval never exec - < "$PROMPT_FILE"; fi;;
    claude)
      if [[ "$UNSAFE" -eq 1 ]]; then claude --dangerously-skip-permissions --print < "$PROMPT_FILE"
      else claude --permission-mode acceptEdits --print < "$PROMPT_FILE"; fi;;
    amp) amp < "$PROMPT_FILE";;
    kimi) kimi -p "$(cat "$PROMPT_FILE")";;
  esac
}

cd "$REPO_ROOT"
CURRENT_BRANCH="$(read_branch_name)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Ralph dry run"
  echo "  repo root: $REPO_ROOT"
  echo "  branch: ${CURRENT_BRANCH:-<missing>}"
  echo "  agent: $AGENT"
  [[ -f "$PRD_FILE" ]] || { echo "Error: missing $PRD_FILE" >&2; exit 1; }
  [[ -n "$CURRENT_BRANCH" ]] || { echo "Error: prd.json branchName is missing" >&2; exit 1; }
  [[ -f "$PROGRESS_FILE" ]] || { echo "Error: missing $PROGRESS_FILE" >&2; exit 1; }
  [[ -d "$ARCHIVE_DIR" ]] || { echo "Error: missing $ARCHIVE_DIR" >&2; exit 1; }
  [[ -f "$PROMPT_FILE" ]] || { echo "Error: missing $PROMPT_FILE" >&2; exit 1; }
  require_command node
  validate_agent
  echo "Dry run OK"
  exit 0
fi

validate_agent
[[ "$(git branch --show-current)" == "$CURRENT_BRANCH" ]] || {
  echo "Error: current branch does not match prd.json branchName ($CURRENT_BRANCH)." >&2; exit 1;
}

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "Ralph iteration $i of $MAX_ITERATIONS ($AGENT)"
  LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/ralph-output.XXXXXX")"
  set +e
  run_agent "$i" 2>&1 | tee "$LOG_FILE"
  AGENT_STATUS=${PIPESTATUS[0]}
  set -e
  OUTPUT="$(<"$LOG_FILE")"
  rm -f "$LOG_FILE"
  [[ "$AGENT_STATUS" -eq 0 ]] || { echo "Error: agent failed on iteration $i." >&2; exit "$AGENT_STATUS"; }
  if printf '%s\n' "$OUTPUT" | grep -qE '^[[:space:]]*<promise>COMPLETE</promise>[[:space:]]*$' && all_stories_pass; then
    echo "Ralph completed all tasks."; exit 0
  fi
done

echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks." >&2
exit 1
