"""Prüft, ob die microduck_rl-Umgebung die GPU nutzen kann.

Wird von setup-microduck.sh mit dem Python aus microduck_rl/.venv gestartet.
Beendet sich mit Code 1 und einer Meldung, sobald ein Schritt fehlschlägt.
"""

import sys


def fail(msg: str) -> None:
    print(f"FEHLER: {msg}", file=sys.stderr)
    sys.exit(1)


import torch  # noqa: E402

print(f"torch {torch.__version__}, gebaut für CUDA {torch.version.cuda}")
if not torch.cuda.is_available():
    fail("torch sieht keine CUDA-GPU. nvidia-smi prüfen, Windows-Treiber aktualisieren, 'wsl --shutdown'.")
print(f"torch-GPU: {torch.cuda.get_device_name(0)}")
x = torch.ones(1024, device="cuda")
if float(x.sum()) != 1024.0:
    fail("Rechentest mit torch auf der GPU liefert ein falsches Ergebnis.")

import warp as wp  # noqa: E402

wp.init()
if wp.get_cuda_device_count() == 0:
    fail("Warp findet keine CUDA-GPU. Training läuft über MuJoCo Warp und braucht sie.")


@wp.kernel
def add_one(a: wp.array(dtype=float)):
    i = wp.tid()
    a[i] = a[i] + 1.0


# Kompiliert einen kleinen Kernel: prüft, dass Warp unter WSL wirklich GPU-Code bauen und ausführen kann.
arr = wp.zeros(1024, dtype=float, device="cuda:0")
wp.launch(add_one, dim=1024, inputs=[arr], device="cuda:0")
if float(arr.numpy().sum()) != 1024.0:
    fail("Warp-Kernel auf der GPU liefert ein falsches Ergebnis.")
print(f"Warp {wp.config.version}: Kernel-Test auf {wp.get_device('cuda:0').name} ok")

try:
    import mujoco_warp  # noqa: F401
    import mjlab_microduck  # noqa: F401
except Exception as e:  # noqa: BLE001
    fail(f"Import von mujoco_warp/mjlab_microduck fehlgeschlagen: {e!r}")

print("GPU-Test bestanden.")
