#!/usr/bin/env bash
# ETC. Bot auf einem Linux-Laptop/PC installieren (läuft dann dauerhaft per systemd, startet nach Absturz/Neustart von selbst).
# Benutzung:  bash install.sh        (fragt Token und Dashboard-Passwort ab – sie landen nur in .env auf diesem Rechner)
set -euo pipefail

DIR="${ETC_BOT_DIR:-$HOME/etc-bot}"
BRANCH="${ETC_BOT_BRANCH:-claude/discord-bot}"
PORT="${ETC_BOT_PORT:-3100}"   # 3100, damit es nicht mit dem Dashboard des alten Bots kollidiert
REPO="https://github.com/Brastib/Games.git"
say() { printf '\n\033[1;31m▶ %s\033[0m\n' "$*"; }

say "1/6 Node.js prüfen"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node.js 22 wird installiert (braucht dein sudo-Passwort) …"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

say "2/6 Code holen nach $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only origin "$BRANCH"
else git clone --branch "$BRANCH" --depth 50 "$REPO" "$DIR"; fi
cd "$DIR"

say "3/6 Pakete installieren"
npm ci --omit=dev

say "4/6 Einstellungen (.env)"
if [ ! -f .env ]; then
  read -rsp "Bot-Token (wird nicht angezeigt): " TOKEN; echo
  read -rsp "Dashboard-Passwort (wird nicht angezeigt): " PW; echo
  umask 077
  cat > .env <<ENV
DISCORD_TOKEN=$TOKEN
DASHBOARD_PASSWORD=$PW
PORT=$PORT
TRUST_PROXY=1
TZ=Europe/Berlin
# Temperatur-Grenzen des Laptop-Wächters (°C)
TEMP_WARN=80
TEMP_CRIT=90
ENV
  echo ".env angelegt (nur für dich lesbar)."
else
  echo ".env gibt es schon – bleibt unverändert."
fi

say "5/6 Autostart (systemd)"
sudo tee /etc/systemd/system/etc-bot.service >/dev/null <<UNIT
[Unit]
Description=ETC. Bot (Discord)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=5
# Bei Hitze nicht noch zusätzlich Last erzeugen
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now etc-bot
sleep 4
sudo systemctl --no-pager --lines=8 status etc-bot || true

say "6/6 Dashboard von außen erreichbar machen (Cloudflare-Tunnel)"
if command -v cloudflared >/dev/null; then
  sudo tee /etc/systemd/system/etc-bot-tunnel.service >/dev/null <<UNIT
[Unit]
Description=ETC. Bot Dashboard-Tunnel
After=etc-bot.service

[Service]
User=$USER
ExecStart=$(command -v cloudflared) tunnel --no-autoupdate --url http://localhost:$PORT
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now etc-bot-tunnel
  echo "Warte auf die Dashboard-Adresse …"
  for _ in $(seq 1 20); do
    URL=$(journalctl -u etc-bot-tunnel --no-pager 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
    [ -n "$URL" ] && break; sleep 2
  done
  echo "Dashboard: ${URL:-noch nicht da – später mit: journalctl -u etc-bot-tunnel | grep trycloudflare}"
else
  echo "cloudflared ist nicht installiert – Dashboard nur im Heimnetz: http://$(hostname -I | awk '{print $1}'):$PORT"
fi

say "Fertig! Log ansehen: journalctl -u etc-bot -f   ·   Update: bash $DIR/deploy/update.sh"
