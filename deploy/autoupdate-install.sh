#!/usr/bin/env bash
# Richtet das Auto-Update ein (einmalig ausführen): alle 5 Minuten nach neuen Versionen schauen.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_DIR="$(dirname "$(command -v node)")"
sudo tee /etc/systemd/system/etc-bot-update.service >/dev/null <<UNIT
[Unit]
Description=ETC. Bot Auto-Update
After=network-online.target

[Service]
Type=oneshot
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $DIR/deploy/autoupdate.sh
UNIT
sudo tee /etc/systemd/system/etc-bot-update.timer >/dev/null <<UNIT
[Unit]
Description=ETC. Bot Auto-Update alle 5 Minuten

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now etc-bot-update.timer
echo "✅ Auto-Update aktiv. Verlauf ansehen: journalctl -u etc-bot-update -n 20"
