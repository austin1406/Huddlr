#!/usr/bin/env bash
# One-shot: shared Postgres + shared /opt/huddlr/.env + deploy finance, agents, voice.
# Safe to re-run. Run on the VM as root:
#   bash /opt/huddlr/photon/deploy/setup-services.sh
set -euo pipefail
APP=/opt/huddlr
ENV=$APP/.env
cd "$APP" && git pull --ff-only

echo "==> Postgres"
export DEBIAN_FRONTEND=noninteractive
command -v psql >/dev/null || apt-get install -y postgresql
systemctl enable --now postgresql >/dev/null

touch "$ENV" && chmod 600 "$ENV"
setenv() { # setenv KEY VALUE -> add only if KEY is missing
  grep -q "^$1=" "$ENV" || echo "$1=$2" >> "$ENV"
}

if ! grep -q '^DATABASE_URL=' "$ENV"; then
  DBPASS=$(openssl rand -hex 16)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'huddlr') THEN
    CREATE ROLE huddlr LOGIN PASSWORD '$DBPASS';
  ELSE
    ALTER ROLE huddlr WITH PASSWORD '$DBPASS';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='huddlr'" | grep -q 1 \
    || sudo -u postgres createdb -O huddlr huddlr
  echo "DATABASE_URL=postgres://huddlr:$DBPASS@localhost:5432/huddlr" >> "$ENV"
fi

echo "==> Shared settings in $ENV"
setenv FINANCE_PORT 4000
setenv AGENTS_PORT 5000
setenv VOICE_PORT 6000
setenv FINANCE_URL http://localhost:4000
setenv PUBLIC_BASE_URL "https://$(curl -fsS https://api.ipify.org | tr . -).sslip.io"
setenv HUDDLR_SECRET "$(openssl rand -hex 24)"
for k in GEMINI_API_KEY CHARACTER_MODEL ELEVENLABS_API_KEY ELEVENLABS_AGENT_ID ELEVENLABS_PHONE_NUMBER_ID ELEVENLABS_WEBHOOK_SECRET; do
  setenv "$k" ""
done

echo "==> Shared contracts"
(cd contracts && npm ci --no-audit --no-fund)

start() { # start NAME DIR
  echo "==> $1"
  (cd "$APP/$2" && npm ci --no-audit --no-fund)
  pm2 restart "$1" --update-env >/dev/null 2>&1 || (cd "$APP/$2" && pm2 start npm --name "$1" -- start)
}
start finance finance
start agents agents
start voice voice
pm2 save >/dev/null

sleep 4
echo
pm2 status
echo
for p in 4000/health 5000/agents/health 6000/voice/health; do
  printf "%-22s" "localhost:$p"; curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:$p" || echo down
done
echo
echo "Still to fill by hand in $ENV (nano $ENV), then: pm2 restart all --update-env"
grep -E '^[A-Z_]+=$' "$ENV" | cut -d= -f1 | sed 's/^/  - /' || true
echo "HUDDLR_SECRET was generated here if it was missing: share it with the team privately (cat $ENV)."
