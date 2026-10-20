#!/usr/bin/env bash
# ETC. Bot auf den neuesten Stand bringen und neu starten.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
git pull --ff-only
npm ci --omit=dev
sudo systemctl restart etc-bot
sleep 3
journalctl -u etc-bot --no-pager -n 15
