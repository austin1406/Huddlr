#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 24.04 Vultr VM. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/austin1406/Huddlr/main/photon/deploy/setup-vm.sh | bash -s -- <domain>
# <domain> is optional. Without it, uses <ip-with-dashes>.sslip.io (works instantly, no DNS).
set -euo pipefail

IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN="${1:-${IP//./-}.sslip.io}"
REPO=https://github.com/austin1406/Huddlr.git
APP=/opt/huddlr

echo "==> Domain: $DOMAIN"
export DEBIAN_FRONTEND=noninteractive

echo "==> System update"
apt-get update -y && apt-get upgrade -y

echo "==> Firewall (SSH, HTTP, HTTPS only)"
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

echo "==> Node 22, git, pm2"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
npm install -g pm2

echo "==> Caddy (automatic HTTPS)"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy

echo "==> Clock sync (Photon rejects webhooks >5 min off)"
timedatectl set-ntp true || true

echo "==> Code"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO" "$APP"; fi

echo "==> Caddy routes"
sed "s/__DOMAIN__/$DOMAIN/" "$APP/photon/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> Photon service"
cd "$APP/photon"
[ -f .env ] || printf 'PHOTON_API_KEY=\nPHOTON_PROJECT_ID=\nPHOTON_WEBHOOK_SECRET=\nPHOTON_ECHO=1\n' > .env
npm ci --no-audit --no-fund
pm2 delete photon >/dev/null 2>&1 || true
pm2 start npm --name photon -- start
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null

echo
echo "Done. Test:   https://$DOMAIN/photon/health"
echo "Webhook URL:  https://$DOMAIN/photon/webhook"
echo "Next: fill in $APP/photon/.env, then run: pm2 restart photon --update-env"
