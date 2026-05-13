#!/usr/bin/env bash
set -euo pipefail

REPOS_DIR="/srv/devbox/repos"
WORKTREES_DIR="/srv/devbox/worktrees"
SESSIONS_DIR="/srv/devbox/sessions"

SESSION_NAME="${1:-}"
REPO="${2:-}"
BASE_BRANCH="${3:-main}"
REQUESTED_PORT="${4:-4321}"

if [[ -z "$SESSION_NAME" || -z "$REPO" ]]; then
  echo "Usage: start-session.sh <session-name> <repo> [base-branch] [port]" >&2
  exit 1
fi

if ! [[ "$SESSION_NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "Error: session name must be lowercase alphanumeric/hyphens only" >&2
  exit 1
fi

if ! [[ "$REPO" =~ ^[a-z0-9_-]+$ ]]; then
  echo "Error: repo name must be lowercase alphanumeric/hyphens/underscores only" >&2
  exit 1
fi

REPO_DIR="$REPOS_DIR/$REPO"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Error: no git repo found at $REPO_DIR" >&2
  exit 1
fi

SESSION_JSON="$SESSIONS_DIR/$SESSION_NAME.json"

if [[ -f "$SESSION_JSON" ]]; then
  echo "Error: session '$SESSION_NAME' already exists. Run stop-session.sh first." >&2
  exit 1
fi

find_free_port() {
  local port="$1"
  while ss -tlnH "sport = :$port" 2>/dev/null | grep -q .; do
    echo "Port $port in use, trying $((port + 1))..." >&2
    port=$((port + 1))
  done
  echo "$port"
}

PORT=$(find_free_port "$REQUESTED_PORT")

WORKTREE_PATH="$WORKTREES_DIR/$REPO/$SESSION_NAME"
BRANCH_NAME="session/$SESSION_NAME"

if [[ -d "$WORKTREE_PATH" ]]; then
  echo "Error: worktree directory already exists at $WORKTREE_PATH" >&2
  exit 1
fi

mkdir -p "$WORKTREES_DIR/$REPO"

echo "Creating worktree '$BRANCH_NAME' from $BASE_BRANCH..."
git -C "$REPO_DIR" worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"

echo "Running npm install..."
npm install --prefix "$WORKTREE_PATH"

TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "127.0.0.1")
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Write session JSON before tmux so stop-session.sh can always clean up
cat > "$SESSION_JSON" <<EOF
{
  "name": "$SESSION_NAME",
  "repo": "$REPO",
  "branch": "$BRANCH_NAME",
  "baseBranch": "$BASE_BRANCH",
  "port": $PORT,
  "worktreePath": "$WORKTREE_PATH",
  "tailscaleIp": "$TAILSCALE_IP",
  "startedAt": "$STARTED_AT",
  "tmuxSession": "dev-$SESSION_NAME"
}
EOF

echo "Starting tmux session dev-$SESSION_NAME..."
tmux new-session -d -s "dev-$SESSION_NAME" -x 220 -c "$WORKTREE_PATH"
tmux rename-window -t "dev-$SESSION_NAME:0" "server"
tmux send-keys -t "dev-$SESSION_NAME:server" "npm run dev -- --port $PORT --host" Enter

tmux new-window -t "dev-$SESSION_NAME" -n "claude" -c "$WORKTREE_PATH"
tmux send-keys -t "dev-$SESSION_NAME:claude" "claude --remote-control \"$SESSION_NAME\" --name \"$REPO/$SESSION_NAME\" --add-dir /srv/devbox" Enter

echo ""
echo "Session '$SESSION_NAME' started."
echo "  Repo:        $REPO"
echo "  Dev server:  http://$TAILSCALE_IP:$PORT"
echo "  Branch:      $BRANCH_NAME"
echo "  tmux:        tmux attach -t dev-$SESSION_NAME"
echo ""
echo "Claude will appear in the claude.ai web UI once it initialises."
