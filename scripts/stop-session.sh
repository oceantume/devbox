#!/usr/bin/env bash
set -euo pipefail

REPOS_DIR="/srv/devbox/repos"
SESSIONS_DIR="/srv/devbox/sessions"

SESSION_NAME="${1:-}"
KEEP_WORKTREE=false

if [[ -z "$SESSION_NAME" ]]; then
  echo "Usage: stop-session.sh <session-name> [--keep-worktree]" >&2
  exit 1
fi

if [[ "${2:-}" == "--keep-worktree" ]]; then
  KEEP_WORKTREE=true
fi

SESSION_JSON="$SESSIONS_DIR/$SESSION_NAME.json"

if [[ ! -f "$SESSION_JSON" ]]; then
  echo "Error: no session named '$SESSION_NAME' found." >&2
  exit 1
fi

# Pure bash JSON field extraction — no jq dependency
read_json_field() {
  grep -o "\"$1\": *\"[^\"]*\"" "$2" | grep -o '"[^"]*"$' | tr -d '"'
}

REPO=$(read_json_field "repo" "$SESSION_JSON")
WORKTREE_PATH=$(read_json_field "worktreePath" "$SESSION_JSON")
TMUX_SESSION=$(read_json_field "tmuxSession" "$SESSION_JSON")
BRANCH=$(read_json_field "branch" "$SESSION_JSON")
REPO_DIR="$REPOS_DIR/$REPO"

echo "Stopping session '$SESSION_NAME'..."

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "  Killing tmux session $TMUX_SESSION..."
  tmux kill-session -t "$TMUX_SESSION"
else
  echo "  tmux session $TMUX_SESSION not found (already dead?)"
fi

if [[ "$KEEP_WORKTREE" == "false" ]]; then
  if [[ -d "$WORKTREE_PATH" ]]; then
    echo "  Removing worktree at $WORKTREE_PATH..."
    git -C "$REPO_DIR" worktree remove --force "$WORKTREE_PATH"
  fi
  if git -C "$REPO_DIR" rev-parse --verify "$BRANCH" &>/dev/null; then
    echo "  Deleting branch $BRANCH..."
    git -C "$REPO_DIR" branch -D "$BRANCH"
  fi
else
  echo "  --keep-worktree: leaving $WORKTREE_PATH in place."
fi

rm -f "$SESSION_JSON"
echo "Session '$SESSION_NAME' stopped."
