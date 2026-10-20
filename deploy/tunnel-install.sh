#!/usr/bin/env bash
# Dashboard von überall erreichbar machen (Handy, Main-PC): Cloudflare-Schnelltunnel als Dienst.
# Außerdem: Laptop darf nicht einschlafen (Bildschirm aus ist okay), sonst ist der Bot offline.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="$(grep -oP '^PORT=\K\d+' "$DIR/.env" 2>/dev/null || echo 3100)"
say() { printf '\n\033[1;31m▶ %s\033[0m\n' "$*"; }

say "1/3 cloudflared installieren"
if ! command -v cloudflared >/dev/null; then
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"
  sudo dpkg -i /tmp/cloudflared.deb
fi
cloudflared --version

say "2/3 Tunnel als Dienst (startet mit dem Laptop)"
sudo tee /etc/systemd/system/etc-bot-tunnel.service >/dev/null <<UNIT
[Unit]
Description=ETC. Bot Dashboard-Tunnel
After=network-online.target etc-bot.service
Wants=network-online.target

[Service]
User=$(stat -c %U "$DIR")
# --metrics: darüber fragt der Bot die aktuelle Adresse ab und schickt sie dir per DM
ExecStart=$(command -v cloudflared) tunnel --no-autoupdate --metrics 127.0.0.1:20241 --url http://localhost:$PORT
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now etc-bot-tunnel
sudo systemctl restart etc-bot-tunnel

say "3/3 Laptop wach halten"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' | sudo tee /etc/systemd/logind.conf.d/etc-bot.conf >/dev/null
echo "Standby/Ruhezustand ist aus, Zuklappen schläft nicht mehr ein (Bildschirm geht trotzdem aus)."
echo "Rückgängig: sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target && sudo rm /etc/systemd/logind.conf.d/etc-bot.conf"

echo; echo "Warte auf die Dashboard-Adresse …"
URL=""
for _ in $(seq 1 30); do
  URL=$(curl -s --max-time 2 http://127.0.0.1:20241/quicktunnel | grep -oP '"hostname":"\K[^"]+' || true)
  [ -n "$URL" ] && break; sleep 2
done
if [ -n "$URL" ]; then echo "🌐 Dashboard: https://$URL  (kommt auch per Discord-DM; bei Neustart neue Adresse)"
else echo "Noch keine Adresse – in 1–2 Minuten kommt sie per Discord-DM, oder: journalctl -u etc-bot-tunnel | grep trycloudflare"; fi
