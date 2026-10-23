#!/usr/bin/env bash
# Richtet Wake-on-LAN und den Gmail-Ausloeser auf dem Linux-Laptop ein.
#   ./install.sh               alles (Befehl wake-pc, Konfiguration, systemd-Dienst)
#   ./install.sh --no-service  nur Befehl wake-pc und Konfiguration
# Als normaler Benutzer starten, nicht mit sudo. sudo wird nur fuer den Dienst abgefragt.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$HOME/.local/lib/wake-pc"
BIN="$HOME/.local/bin/wake-pc"
CONFIG="$HOME/.config/wake-pc/config.ini"
STATE="$HOME/.local/state/wake-pc/processed.json"
UNIT=/etc/systemd/system/wake-pc-gmail.service
WITH_SERVICE=1
[[ "${1:-}" == "--no-service" ]] && WITH_SERVICE=0

if [[ $EUID -eq 0 ]]; then
    echo "Bitte als normaler Benutzer starten (ohne sudo)." >&2
    exit 1
fi
if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
    echo "Python 3.9 oder neuer wird benoetigt." >&2
    exit 1
fi

# Setzt key = value im Abschnitt [section] und laesst Kommentare stehen.
# Der Wert kommt ueber die Umgebung, damit Passwoerter nicht in der Prozessliste stehen.
set_value() {
    VALUE="$3" python3 - "$CONFIG" "$1" "$2" <<'EOF'
import os, re, sys
path, section, key = sys.argv[1:]
value = os.environ["VALUE"]
lines = open(path, encoding="utf-8").read().splitlines()
current, done = None, False
for i, line in enumerate(lines):
    m = re.match(r"\s*\[(.+)\]\s*$", line)
    if m:
        current = m.group(1)
    elif current == section and re.match(rf"\s*{re.escape(key)}\s*=", line):
        lines[i] = f"{key} = {value}"
        done = True
        break
if not done:
    sys.exit(f"{key} nicht in [{section}] gefunden")
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
EOF
}

echo "== 1. Programme nach $LIB_DIR kopieren"
mkdir -p "$LIB_DIR" "$(dirname "$BIN")"
install -m 755 "$SRC_DIR/wol.py" "$SRC_DIR/gmail_trigger.py" "$LIB_DIR/"
cat > "$BIN" <<EOF
#!/bin/sh
exec python3 "$LIB_DIR/wol.py" "\$@"
EOF
chmod 755 "$BIN"
echo "   Befehl: $BIN  (PC sofort wecken)"

echo "== 2. Konfiguration $CONFIG"
mkdir -p "$(dirname "$CONFIG")"
ask=1
if [[ -f "$CONFIG" ]]; then
    read -r -p "   Konfiguration existiert schon. Werte neu eingeben? [j/N] " answer
    [[ "$answer" =~ ^[jJyY] ]] || ask=0
else
    install -m 600 "$SRC_DIR/config.example.ini" "$CONFIG"
fi
chmod 600 "$CONFIG"

if [[ $ask -eq 1 ]]; then
    while true; do
        read -r -p "   MAC-Adresse des PCs (z. B. 1C-69-7A-12-34-56): " mac
        if python3 "$LIB_DIR/wol.py" "$mac" --dry-run >/dev/null; then
            set_value wol mac "$mac"
            break
        fi
    done
    read -r -p "   Broadcast-Adresse [255.255.255.255]: " bcast
    [[ -n "$bcast" ]] && set_value wol broadcast "$bcast"
    if [[ $WITH_SERVICE -eq 1 ]]; then
        read -r -p "   Gmail-Adresse, die der Laptop abfragt: " gmail_user
        set_value gmail user "$gmail_user"
        read -r -s -p "   Gmail-App-Passwort (Eingabe unsichtbar): " app_pw
        echo
        set_value gmail app_password "$app_pw"
        read -r -p "   Geheimwort fuer den Betreff (leer = keins, empfohlen: eins setzen): " secret
        set_value gmail secret "$secret"
        read -r -p "   IP des PCs fuer Online-Pruefung per Ping (leer = keine): " pc_host
        set_value check pc_host "$pc_host"
    fi
fi

echo "== 3. Test ohne Senden"
python3 "$LIB_DIR/wol.py" --config "$CONFIG" --dry-run

if [[ $WITH_SERVICE -eq 0 ]]; then
    echo "Fertig. PC wecken mit: wake-pc"
    exit 0
fi

echo "== 4. Gmail-Anmeldung testen (einmal abfragen)"
if ! python3 "$LIB_DIR/gmail_trigger.py" --config "$CONFIG" --state "$STATE" --once; then
    echo "   Gmail-Test fehlgeschlagen. Adresse/App-Passwort pruefen und install.sh erneut starten." >&2
    exit 1
fi

echo "== 5. systemd-Dienst einrichten (sudo)"
tmp_unit="$(mktemp)"
sed -e "s|@USER@|$USER|g" -e "s|@LIBDIR@|$LIB_DIR|g" \
    -e "s|@CONFIG@|$CONFIG|g" -e "s|@STATE@|$STATE|g" \
    "$SRC_DIR/wake-pc-gmail.service.in" > "$tmp_unit"
sudo install -m 644 "$tmp_unit" "$UNIT"
rm -f "$tmp_unit"
sudo systemctl daemon-reload
sudo systemctl enable --now wake-pc-gmail.service
sudo systemctl --no-pager status wake-pc-gmail.service || true

cat <<EOF

Fertig.
  PC sofort wecken:     wake-pc
  Dienst-Log ansehen:   journalctl -u wake-pc-gmail -f
  Dienst stoppen:       sudo systemctl disable --now wake-pc-gmail
  Ruhezustand sperren:  $SRC_DIR/laptop-no-sleep.sh
EOF
