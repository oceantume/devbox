---
description: Check the current dev session status, show the Tailscale dev server URL, and offer to restart a dead dev server.
---

# Dev Session Status

## What to do

1. Determine the session name from the current working directory. The worktree path is `/srv/devbox/worktrees/<name>/`, so the session name is the last path component of `cwd`.

2. Read `/srv/devbox/sessions/<name>.json`. If it doesn't exist, say "No active session found for this worktree." and stop.

3. Report session info:
   - **Dev server:** `http://<tailscaleIp>:<port>` (make it a clickable link)
   - **Branch:** `<branch>`
   - **Started:** `<startedAt>` (convert to local time)
   - **tmux session:** `<tmuxSession>`

4. Check if the dev server is alive:
   - Run: `ss -tlnH "sport = :<port>"` — if no output, the port isn't listening.
   - If down: say the dev server appears to be stopped, and ask if the user wants to restart it.

5. To restart the dev server:
   - Run: `tmux send-keys -t <tmuxSession>:server "npm run dev -- --port <port>" Enter`
   - Wait a moment, then recheck with `ss`.
