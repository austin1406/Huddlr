#!/usr/bin/env bash
# Pull the latest main and (re)start the agents service. Run on the VM: /opt/huddlr/agents/deploy/deploy.sh
# Needs DATABASE_URL, HUDDLR_SECRET, DEMO_USER_PHONE and GEMINI_API_KEY in /opt/huddlr/.env.
# The service creates its own tables on start. Caddy routes /agents/* to port 5000.
set -euo pipefail
cd /opt/huddlr && git pull --ff-only
grep -q '^DATABASE_URL=.\+' .env || { echo "DATABASE_URL is empty in /opt/huddlr/.env"; exit 1; }
(cd contracts && npm ci --no-audit --no-fund)
cd agents && npm ci --no-audit --no-fund
pm2 restart agents --update-env 2>/dev/null || pm2 start npm --name agents -- start
pm2 save
sleep 3
curl -fsS localhost:${AGENTS_PORT:-5000}/agents/health && echo
echo "Deployed $(git rev-parse --short HEAD)"
