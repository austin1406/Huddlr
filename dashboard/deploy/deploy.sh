#!/usr/bin/env bash
# Pull the latest main and (re)start the dashboard. Run on the VM: bash /opt/huddlr/dashboard/deploy/deploy.sh
# Caddy sends every path no other service claims (including /) to localhost:3001.
set -euo pipefail
cd /opt/huddlr && git pull --ff-only
(cd contracts && npm ci --no-audit --no-fund)
cd dashboard && npm ci --no-audit --no-fund
grep -q '^DASHBOARD_PASSWORD=' /opt/huddlr/.env || echo "DASHBOARD_PASSWORD=$(openssl rand -hex 6)" >> /opt/huddlr/.env
pm2 restart dashboard --update-env 2>/dev/null || pm2 start npm --name dashboard -- start
pm2 save
echo "Deployed $(git rev-parse --short HEAD)"
echo "Dashboard login: user 'huddlr', password: $(grep '^DASHBOARD_PASSWORD=' /opt/huddlr/.env | cut -d= -f2)"
