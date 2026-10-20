#!/usr/bin/env bash
# Auto-Update: holt neue Versionen von GitHub und startet den Bot neu.
# Läuft alle 5 Minuten per systemd-Timer (als root, Git/npm aber als Besitzer des Ordners).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OWNER="$(stat -c %U "$DIR")"
as_owner() { runuser -u "$OWNER" -- "$@"; }
cd "$DIR"
BRANCH="$(as_owner git rev-parse --abbrev-ref HEAD)"
as_owner git fetch -q origin "$BRANCH"
[ "$(as_owner git rev-parse HEAD)" = "$(as_owner git rev-parse "origin/$BRANCH")" ] && exit 0
echo "Neue Version: $(as_owner git log --oneline -1 "origin/$BRANCH")"
as_owner git pull -q --ff-only origin "$BRANCH"
as_owner npm ci --omit=dev --no-audit --no-fund
as_owner node node_modules/ffmpeg-static/install.js >/dev/null 2>&1 || true
systemctl restart etc-bot
echo "Bot neu gestartet."
