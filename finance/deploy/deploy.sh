#!/usr/bin/env bash
# Pull the latest main and (re)start the finance service. Run on the VM: /opt/huddlr/finance/deploy/deploy.sh
set -euo pipefail
cd /opt/huddlr && git pull --ff-only
(cd contracts && npm ci --no-audit --no-fund)
cd finance && npm ci --no-audit --no-fund
pm2 restart finance --update-env 2>/dev/null || pm2 start npm --name finance -- start
pm2 save
echo "Deployed $(git rev-parse --short HEAD)"
