#!/usr/bin/env bash
# Startet das Lauf-Training (Mjlab-Velocity-Flat-MicroDuck) in microduck_rl.
# Standard: Logs lokal (tensorboard), also ohne wandb-Konto. Weitere Argumente gehen an 'uv run train'.
#
#   bash train-velocity.sh                    # 4096 Umgebungen
#   NUM_ENVS=2048 bash train-velocity.sh      # weniger GPU-Speicher
#   LOGGER=wandb bash train-velocity.sh       # mit wandb-Konto (vorher einmal: uv run wandb login)
set -euo pipefail

TARGET_DIR="${MICRODUCK_DIR:-$HOME/microduck_rl}"
NUM_ENVS="${NUM_ENVS:-4096}"
LOGGER="${LOGGER:-tensorboard}"
export PATH="$HOME/.local/bin:$PATH"

if [[ ! -d "$TARGET_DIR/.venv" ]]; then
  echo "FEHLER: $TARGET_DIR/.venv fehlt. Zuerst setup-microduck.sh ausführen." >&2
  exit 1
fi
cd "$TARGET_DIR"

cat <<EOF
Checkpoints landen alle 250 Iterationen in:
  $TARGET_DIR/logs/rsl_rl/velocity/<Datum_Zeit>_velocity/model_<Iteration>.pt
Das Training hört erst nach 50.000 Iterationen von selbst auf.
Stoppen mit Strg+C, dann den neuesten Checkpoint nehmen.

EOF
exec uv run train Mjlab-Velocity-Flat-MicroDuck \
  --env.scene.num-envs "$NUM_ENVS" --agent.logger "$LOGGER" "$@"
