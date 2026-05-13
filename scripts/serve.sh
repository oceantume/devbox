#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/dev/.local/share/fnm:$PATH"
eval "$(fnm env)"
exec node /srv/devbox/scripts/session-server.ts
