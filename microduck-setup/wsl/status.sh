#!/usr/bin/env bash
# Kurzer Statusbericht zum laufenden Training (ca. 10 Zeilen zum Kopieren in den Chat).
#
#   bash status.sh
set -euo pipefail

TARGET_DIR="${MICRODUCK_DIR:-$HOME/microduck_rl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -x "$TARGET_DIR/.venv/bin/python" ]]; then
  echo "FEHLER: $TARGET_DIR/.venv fehlt. Zuerst setup-microduck.sh ausführen." >&2
  exit 1
fi
exec "$TARGET_DIR/.venv/bin/python" "$SCRIPT_DIR/status.py" "$TARGET_DIR"
