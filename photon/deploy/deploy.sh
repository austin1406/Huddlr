#!/usr/bin/env bash
# Pull the latest main and restart the photon service. Run on the VM: /opt/huddlr/photon/deploy/deploy.sh
set -euo pipefail
cd /opt/huddlr && git pull --ff-only
cd photon && npm ci --no-audit --no-fund && pm2 restart photon --update-env
echo "Deployed $(git rev-parse --short HEAD)"
