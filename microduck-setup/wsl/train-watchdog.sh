#!/usr/bin/env bash
# Startet das Lauf-Training und setzt es nach einem Absturz automatisch fort
# (z. B. wenn ein Spiel nebenbei den Grafikspeicher braucht).
# Macht beim neuesten Checkpoint weiter; ohne Checkpoint startet es neu.
# Strg+C beendet alles. Die Trainingsausgabe landet zusätzlich in
# ~/microduck_rl/logs/train-console.log (status.sh zeigt daraus die letzten Zeilen).
#
#   bash train-watchdog.sh
#   MAX_RESTARTS=10 bash train-watchdog.sh
set -uo pipefail

TARGET_DIR="${MICRODUCK_DIR:-$HOME/microduck_rl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_RESTARTS="${MAX_RESTARTS:-5}"
LOG_ROOT="$TARGET_DIR/logs/rsl_rl/velocity"
CONSOLE_LOG="$TARGET_DIR/logs/train-console.log"

trap 'echo; echo "Watchdog: mit Strg+C beendet."; exit 130' INT
mkdir -p "$(dirname "$CONSOLE_LOG")"

note() { printf '[%s] Watchdog: %s\n' "$(date '+%F %T')" "$*" | tee -a "$CONSOLE_LOG"; }

restarts=0
while true; do
  args=()
  # Neuester Checkpoint nach Änderungszeit, bei Gleichstand der mit der höheren Iteration.
  newest="$(find "$LOG_ROOT" -mindepth 2 -maxdepth 2 -name 'model_*.pt' -printf '%T@ %p\n' 2>/dev/null \
    | sort -k1,1n -k2,2V | tail -1 | cut -d' ' -f2-)"
  if [[ -n "$newest" ]]; then
    run_dir="$(basename "$(dirname "$newest")")"
    note "setze fort ab $run_dir/$(basename "$newest")"
    args=(--agent.resume True --agent.load-run "$run_dir" --agent.load-checkpoint "$(basename "$newest")")
  else
    note "kein Checkpoint gefunden, starte neues Training"
  fi

  bash "$SCRIPT_DIR/train-velocity.sh" "${args[@]}" 2>&1 | tee -a "$CONSOLE_LOG"
  code="${PIPESTATUS[0]}"

  if [[ "$code" == 0 ]]; then
    note "Training regulär beendet."
    exit 0
  fi
  if [[ "$code" == 130 ]]; then
    note "Training mit Strg+C gestoppt."
    exit 130
  fi
  if (( restarts >= MAX_RESTARTS )); then
    note "Training abgestürzt (Code $code), schon $restarts Neustarts. Gebe auf."
    exit "$code"
  fi
  restarts=$((restarts + 1))
  wait_s=$((60 * 2 ** (restarts - 1)))
  note "Training abgestürzt (Code $code). Neustart $restarts/$MAX_RESTARTS in $wait_s s."
  sleep "$wait_s"
done
