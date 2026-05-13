# Devbox

Remote development environment for phone-based development over Tailscale.

## Layout

- `scripts/` — session management scripts
- `repos/` — git repositories (gitignored, each is its own repo)
- `worktrees/` — ephemeral git worktrees, one per active dev session (gitignored)
- `sessions/` — runtime JSON state for active sessions (gitignored)
- `.claude/skills/` — Claude skills available in all dev sessions via `--add-dir /srv/devbox`

## Session lifecycle

Start a session (creates worktree, installs deps, starts dev server, launches Claude remote):
```
scripts/start-session.sh <name> [base-branch=main] [port=4321]
```

Stop a session (kills dev server, removes worktree and branch):
```
scripts/stop-session.sh <name> [--keep-worktree]
```

The HTTP session manager runs on port 8080 and is the normal way to start/stop sessions from a phone:
```
node scripts/session-server.ts
```

## Current projects

- `spectaculaire` — Astro festival schedule site (`repos/spectaculaire/`)
