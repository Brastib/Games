#!/usr/bin/env bash
# Verhindert, dass der Laptop in Bereitschaft/Ruhezustand geht.
#   ./laptop-no-sleep.sh           sperren
#   ./laptop-no-sleep.sh --status  anzeigen
#   ./laptop-no-sleep.sh --undo    rueckgaengig machen
# Als normaler Benutzer starten; sudo wird abgefragt.
set -euo pipefail

TARGETS=(sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target)
DROPIN=/etc/systemd/logind.conf.d/wake-pc-no-sleep.conf
GNOME_SCHEMA=org.gnome.settings-daemon.plugins.power

has_gnome() {
    command -v gsettings >/dev/null && gsettings list-schemas 2>/dev/null | grep -qx "$GNOME_SCHEMA"
}

case "${1:-}" in
    --status)
        for t in "${TARGETS[@]}"; do
            printf '%-32s %s\n' "$t" "$(systemctl is-enabled "$t" 2>/dev/null || true)"
        done
        [[ -f "$DROPIN" ]] && echo "logind: $DROPIN vorhanden" || echo "logind: keine Aenderung"
        if has_gnome; then
            echo "GNOME am Netzteil: $(gsettings get $GNOME_SCHEMA sleep-inactive-ac-type)"
            echo "GNOME im Akku:     $(gsettings get $GNOME_SCHEMA sleep-inactive-battery-type)"
        fi
        ;;
    --undo)
        sudo systemctl unmask "${TARGETS[@]}"
        sudo rm -f "$DROPIN"
        if has_gnome; then
            gsettings reset $GNOME_SCHEMA sleep-inactive-ac-type
            gsettings reset $GNOME_SCHEMA sleep-inactive-battery-type
        fi
        echo "Rueckgaengig gemacht. Die Deckel-Einstellung gilt nach einem Neustart wieder normal."
        ;;
    "")
        # 1. Alle Schlaf-Ziele sperren: wirkt sofort, egal wer den Schlaf ausloest.
        sudo systemctl mask "${TARGETS[@]}"
        # 2. Deckel zuklappen und Leerlauf sollen nichts tun.
        sudo mkdir -p "$(dirname "$DROPIN")"
        sudo tee "$DROPIN" >/dev/null <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF
        # 3. GNOME: automatische Bereitschaft aus.
        if has_gnome; then
            gsettings set $GNOME_SCHEMA sleep-inactive-ac-type 'nothing'
            gsettings set $GNOME_SCHEMA sleep-inactive-battery-type 'nothing'
            echo "GNOME-Energieeinstellungen angepasst."
        fi
        echo "Schlaf gesperrt. Die Deckel-Regel greift nach dem naechsten Neustart;"
        echo "die Sperre der Schlaf-Ziele wirkt schon jetzt."
        ;;
    *)
        echo "Unbekannte Option: $1" >&2
        exit 2
        ;;
esac
