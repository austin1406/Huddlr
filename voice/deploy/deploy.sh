#!/usr/bin/env bash
# Pull the latest main and (re)start the voice service. Run on the VM: /opt/huddlr/voice/deploy/deploy.sh
# Caddy routes /voice/* to localhost:6000 (photon/deploy/Caddyfile).
set -euo pipefail
cd /opt/huddlr && git pull --ff-only
(cd contracts && npm ci --no-audit --no-fund)
cd voice && npm ci --no-audit --no-fund
pm2 restart voice --update-env 2>/dev/null || pm2 start npm --name voice -- start
pm2 save
echo "Deployed $(git rev-parse --short HEAD)"
