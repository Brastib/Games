#!/usr/bin/env bash
# Richtet microduck_rl in WSL2 (Ubuntu 24.04) ein:
# WSL2/GPU prüfen, Pakete + uv installieren, Repo klonen, Abhängigkeiten laden, GPU-Test.
# Kann gefahrlos mehrfach ausgeführt werden; erledigte Schritte werden übersprungen.
#
# Aufruf in Ubuntu:   bash setup-microduck.sh
# Anderer Zielordner: MICRODUCK_DIR=~/projekte/microduck_rl bash setup-microduck.sh
set -euo pipefail

REPO_URL="https://github.com/pollen-robotics/microduck_rl"
TARGET_DIR="${MICRODUCK_DIR:-$HOME/microduck_rl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

step "1/7 WSL-Version prüfen"
osrelease="$(cat /proc/sys/kernel/osrelease 2>/dev/null || true)"
case "$osrelease" in
  *microsoft-standard*) echo "WSL2 erkannt ($osrelease)." ;;
  *Microsoft*) fail "WSL1 erkannt. CUDA geht nur mit WSL2. In PowerShell: wsl --set-version Ubuntu-24.04 2" ;;
  *) warn "Kein WSL erkannt ($osrelease). Das Skript läuft trotzdem weiter (normales Linux)." ;;
esac

step "2/7 NVIDIA-GPU prüfen (nvidia-smi)"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  fail "nvidia-smi nicht gefunden. Windows-NVIDIA-Treiber aktualisieren, dann in PowerShell 'wsl --update' und 'wsl --shutdown', Ubuntu neu öffnen."
fi
if ! nvidia-smi; then
  fail "nvidia-smi meldet einen Fehler. Windows-NVIDIA-Treiber aktualisieren, dann 'wsl --shutdown' und erneut versuchen."
fi
# In WSL kommt der Treiber von Windows. Ein Linux-Treiber in Ubuntu überschreibt ihn und macht CUDA kaputt.
if dpkg -l 2>/dev/null | grep -qE '^ii +nvidia-driver-'; then
  warn "In Ubuntu ist ein Linux-NVIDIA-Treiber installiert. In WSL nicht nötig und oft schädlich."
fi

step "3/7 Systempakete installieren (git, curl, build-essential)"
missing=()
for pkg in git curl build-essential; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if ((${#missing[@]})); then
  echo "Fehlt: ${missing[*]} (sudo fragt nach deinem Ubuntu-Passwort)"
  sudo apt-get update
  sudo apt-get install -y "${missing[@]}"
else
  echo "Alles schon installiert."
fi

step "4/7 uv installieren"
export PATH="$HOME/.local/bin:$PATH"
if command -v uv >/dev/null 2>&1; then
  echo "uv ist schon da: $(uv --version)"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  command -v uv >/dev/null 2>&1 || fail "uv wurde installiert, ist aber nicht im PATH. Ubuntu-Fenster neu öffnen und Skript erneut starten."
  echo "uv installiert: $(uv --version)"
fi

step "5/7 microduck_rl klonen nach $TARGET_DIR"
case "$TARGET_DIR" in
  /mnt/*) fail "Zielordner liegt auf dem Windows-Laufwerk ($TARGET_DIR). Das ist in WSL sehr langsam. Bitte einen Ordner unter ~ nehmen." ;;
esac
if [[ -d "$TARGET_DIR/.git" ]]; then
  echo "Schon geklont, wird so verwendet (Stand: $(git -C "$TARGET_DIR" log -1 --format='%h %cd' --date=short))."
elif [[ -e "$TARGET_DIR" ]]; then
  fail "$TARGET_DIR existiert, ist aber kein Git-Repo. Bitte umbenennen oder MICRODUCK_DIR setzen."
else
  git clone "$REPO_URL" "$TARGET_DIR"
fi

step "6/7 Python-Abhängigkeiten laden (uv sync, mehrere GB, kann dauern)"
# Großer Timeout, weil die CUDA-Pakete groß sind und uvs Standard (30 s) abbrechen kann.
(cd "$TARGET_DIR" && UV_HTTP_TIMEOUT="${UV_HTTP_TIMEOUT:-600}" uv sync)

step "7/7 GPU-Test mit torch und Warp"
"$TARGET_DIR/.venv/bin/python" "$SCRIPT_DIR/check_gpu.py"

printf '\nFertig. Training starten mit:\n  bash %s/train-velocity.sh\n' "$SCRIPT_DIR"
