"""Kurzer Statusbericht zum laufenden MicroDuck-Training.

Liest die tensorboard-Logs des neuesten Laufs und gibt etwa 10 Zeilen aus,
die man in den Chat kopieren kann. Wird von status.sh mit dem Python aus
microduck_rl/.venv gestartet: python status.py <microduck_rl-Ordner>
"""

import subprocess
import sys
import time
from pathlib import Path

from tensorboard.backend.event_processing.event_accumulator import EventAccumulator

# Älter als das gilt das Training als gestoppt (tensorboard schreibt alle 10 s).
STALE_SECONDS = 120


def ago(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 120:
        return f"{seconds} s"
    if seconds < 7200:
        return f"{seconds // 60} min"
    return f"{seconds // 3600} h {seconds % 3600 // 60} min"


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else float("nan")


def trend(values: list[float], window: int = 50) -> str:
    """Vergleicht den Schnitt der letzten `window` Werte mit den `window` davor."""
    if len(values) < 2 * window:
        return ""
    new, old = mean(values[-window:]), mean(values[-2 * window : -window])
    return f"  (Schnitt letzte {window}: {new:.3f}, davor: {old:.3f})"


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "microduck_rl"
    log_root = target / "logs" / "rsl_rl" / "velocity"
    runs = sorted((d for d in log_root.glob("*") if d.is_dir()), key=lambda d: d.stat().st_mtime)
    if not runs:
        sys.exit(f"Keine Trainingsläufe gefunden in {log_root}")
    run = runs[-1]

    events = sorted(run.glob("events.out.tfevents.*"), key=lambda f: f.stat().st_mtime)
    if not events:
        sys.exit(f"Noch keine Log-Datei in {run}")
    age = time.time() - events[-1].stat().st_mtime

    acc = EventAccumulator(str(run), size_guidance={"scalars": 0})
    acc.Reload()
    tags = set(acc.Tags()["scalars"])

    def series(tag: str) -> list[float]:
        return [e.value for e in acc.Scalars(tag)] if tag in tags else []

    reward = series("Train/mean_reward")
    length = series("Train/mean_episode_length")
    fell = series("Episode_Termination/fell_over")
    timeout = series("Episode_Termination/time_out")
    vel_err = series("Metrics/twist/error_vel_xy")
    std = series("Policy/mean_std")
    head_range = series("Curriculum/head_pose_range")
    iteration = acc.Scalars("Train/mean_reward")[-1].step if reward else None

    state = "läuft" if age < STALE_SECONDS else "STEHT – abgestürzt oder gestoppt?"
    print(f"Lauf:            {run.name}")
    print(f"Iteration:       {iteration}  (letzte Aktualisierung vor {ago(age)}: {state})")
    if reward:
        print(f"Mean reward:     {reward[-1]:.1f}{trend(reward)}")
    if length:
        print(f"Episodenlänge:   {length[-1]:.0f} von max. 1000{trend(length)}")
    if fell and timeout:
        share = mean(fell[-50:]) / max(mean(fell[-50:]) + mean(timeout[-50:]), 1e-9)
        print(f"Stürze:          {share:.0%} der Versuchs-Enden (letzte 50 Iterationen)")
    if vel_err:
        print(f"Tempo-Fehler xy: {vel_err[-1]:.3f}{trend(vel_err)}")
    if std:
        print(f"Action std:      {std[-1]:.3f}")
    if head_range:
        print(f"Curriculum:      head_pose_range {head_range[-1]:.3f}")

    checkpoints = sorted(
        log_root.glob("*/model_*.pt"),
        key=lambda f: (f.stat().st_mtime, int(f.stem.split("_")[1]) if f.stem.split("_")[1].isdigit() else 0),
    )
    if checkpoints:
        newest = checkpoints[-1]
        print(f"Checkpoint:      {newest.name} (vor {ago(time.time() - newest.stat().st_mtime)})")

    try:
        gpu = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        print(f"GPU:             {gpu}")
    except (OSError, subprocess.TimeoutExpired):
        print("GPU:             nvidia-smi nicht verfügbar")

    console_log = target / "logs" / "train-console.log"
    if age >= STALE_SECONDS and console_log.exists():
        print("\nLetzte Zeilen der Trainingsausgabe:")
        print("\n".join(console_log.read_text(errors="replace").splitlines()[-15:]))


if __name__ == "__main__":
    main()
