# MicroDuck-Training auf Windows (WSL2 + Ubuntu)

Trainiert die Lauf-Policy von [pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl)
auf deinem PC (RTX 4070 Ti Super, 16 GB). Das Projekt braucht Linux und eine NVIDIA-GPU mit CUDA.
Auf Windows läuft es deshalb in WSL2 mit Ubuntu.

## Stand (23.10.2026)

| Was | Status |
|---|---|
| Befehle mit dem microduck_rl-README abgeglichen | erledigt |
| `setup-microduck.sh` auf Linux x86_64 (Cloud-Container, ohne GPU, ohne WSL) | läuft durch bis Schritt 7, dort Abbruch „keine GPU“ wie erwartet. `uv sync`: 142 Pakete, ca. 15 Min., `.venv` 7,8 GB |
| CPU-Tests von microduck_rl im Container | 263 bestanden, 1 übersprungen |
| `check_gpu.py`: Warp-Kernel + Importe, im Container auf CPU umgestellt | ok (auf GPU nicht getestet) |
| Befehlsoptionen `--agent.logger`, `--env.scene.num-envs`, `--checkpoint-file` | per `--help` geprüft |
| PC (FliegeBOX, Windows 11 Build 26200): WSL 3.0.3 + Ubuntu 24.04 | installiert, nach WSL-Reparatur (siehe Fehlertabelle) |
| PC: `setup-microduck.sh` komplett | ok: Treiber 617.42, `uv sync` 3,5 Min., GPU-Test auf RTX 4070 Ti SUPER bestanden |
| PC: Training mit 4096 Umgebungen | läuft: ca. 3,3 s pro Iteration allein, ca. 8,5 s mit WARDOGS nebenbei, kein Speicherproblem. Erster Lauf `2026-10-23_17-36-43_velocity` bei Iteration 1133 (1:43 h) gestoppt, letzter Checkpoint `model_1000.pt` |
| PC: `status.sh`, `train-watchdog.sh`, Viewer mit trainierter Ente | noch nicht getestet |

Nächster Schritt: `model_1000.pt` im Viewer anschauen, dann mit `train-watchdog.sh` weitertrainieren.

## Was du brauchst

- Windows 11 oder Windows 10 ab Version 21H2 (GPU in WSL geht erst ab da).
- Aktueller NVIDIA-Treiber für Windows (Game Ready oder Studio), empfohlen ab Version 576.
  Grund: Warp 1.12 ist mit CUDA 12.9 gebaut, torch 2.9.1 mit CUDA 12.8. In Ubuntu **keinen** NVIDIA-Treiber installieren.
- Freier Platz auf C:: mindestens 20 GB. Allein die Python-Umgebung hat im Test 7,8 GB belegt, dazu Ubuntu und Checkpoints.
- Virtualisierung im BIOS an. Ist sie aus, meldet `wsl --install` einen Fehler.

## Schritt 1: WSL2 und Ubuntu installieren (Windows)

PowerShell **als Administrator** öffnen:

```powershell
wsl --install -d Ubuntu-24.04
```

PC neu starten. Danach öffnet sich Ubuntu (sonst im Startmenü „Ubuntu 24.04“ starten).
Benutzername und Passwort anlegen. Das Passwort braucht `sudo` später.

War WSL schon installiert, vorher einmal `wsl --update` ausführen.

## Schritt 2: Setup-Skript holen und starten (Ubuntu)

Im Ubuntu-Fenster:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone -b claude/wsl2-ubuntu-microduck-setup-s05s8v https://github.com/Brastib/Games ~/Games
bash ~/Games/microduck-setup/wsl/setup-microduck.sh
```

(Sobald der Branch in `main` gemergt ist, kann `-b claude/...` weg.)

Das Skript macht nacheinander:

1. Prüft, dass WSL2 läuft (nicht WSL1).
2. Prüft die GPU mit `nvidia-smi` und warnt, falls in Ubuntu ein Linux-NVIDIA-Treiber installiert ist.
3. Installiert `git`, `curl`, `build-essential`.
4. Installiert [uv](https://docs.astral.sh/uv/).
5. Klont microduck_rl nach `~/microduck_rl`. Bricht ab, wenn der Zielordner unter `/mnt/c` liegt (dort ist WSL sehr langsam).
6. Lädt die Python-Pakete mit `UV_HTTP_TIMEOUT=600 uv sync`. Das sind mehrere GB.
7. Testet, ob torch und Warp die GPU nutzen können (kleiner Kernel auf der GPU), und ob `mjlab_microduck` importiert.

Das Skript kann man mehrfach starten. Erledigte Schritte werden übersprungen.

## Schritt 3: Training starten (Ubuntu)

```bash
bash ~/Games/microduck-setup/wsl/train-velocity.sh
```

Das startet:

```bash
uv run train Mjlab-Velocity-Flat-MicroDuck --env.scene.num-envs 4096 --agent.logger tensorboard
```

Wichtig zu wissen:

- **Kein wandb-Konto nötig.** mjlab nutzt sonst standardmäßig wandb und fragt nach einem Login.
  Das Skript stellt deshalb auf lokales Logging (tensorboard) um. Mit wandb: `LOGGER=wandb bash .../train-velocity.sh`
  (vorher einmal `cd ~/microduck_rl && uv run wandb login`).
- **Das Training hört nicht nach 1–2 Stunden von selbst auf.** Es ist auf 50.000 Iterationen eingestellt.
  Pollen nennt 1–2 Stunden bis zu einem brauchbaren Gang (auf ihrer GPU). Danach mit `Strg+C` stoppen.
- **Checkpoints** kommen alle 250 Iterationen nach
  `~/microduck_rl/logs/rsl_rl/velocity/<Datum_Zeit>_velocity/model_<Iteration>.pt`.
  Beim Stoppen gehen höchstens die Iterationen seit dem letzten Checkpoint verloren.
- **GPU-Speicher:** Ob 4096 Umgebungen in die 16 GB der 4070 Ti Super passen, ist nicht getestet.
  Bei „out of memory“: `NUM_ENVS=2048 bash .../train-velocity.sh`.

## Training überwachen

**Kurzer Status** (ca. 10 Zeilen, ideal zum Kopieren in den Chat statt der ganzen Ausgabe):

```bash
bash ~/Games/microduck-setup/wsl/status.sh
```

Zeigt Iteration, ob das Training noch läuft, Belohnung, Episodenlänge, Sturz-Anteil,
Tempo-Fehler (jeweils mit Trend), neuesten Checkpoint und GPU-Auslastung.
Läuft das Training nicht mehr, zeigt es die letzten Zeilen der Trainingsausgabe
(nur wenn mit dem Watchdog gestartet).

**Automatisch weitermachen nach Absturz** (z. B. wenn ein Spiel nebenbei den Grafikspeicher braucht):

```bash
bash ~/Games/microduck-setup/wsl/train-watchdog.sh
```

Startet das Training beim neuesten Checkpoint (oder neu, wenn es keinen gibt). Stürzt es ab,
wartet es 1, 2, 4, 8, 16 Minuten und setzt jeweils beim neuesten Checkpoint fort, höchstens
5-mal (`MAX_RESTARTS=10` für mehr). `Strg+C` beendet alles. Die Ausgabe landet zusätzlich in
`~/microduck_rl/logs/train-console.log`.

Mit nachgebauten Logs im Container getestet; auf dem PC noch nicht.

## Danach: Policy ansehen und exportieren (ungetestet)

Mit lokalem Checkpoint statt wandb (beide Skripte von microduck_rl/mjlab haben dafür `--checkpoint-file`):

```bash
cd ~/microduck_rl
uv run play Mjlab-Velocity-Flat-MicroDuck --checkpoint-file logs/rsl_rl/velocity/<Ordner>/model_<N>.pt
uv run scripts/export.py Mjlab-Velocity-Flat-MicroDuck --checkpoint-file logs/rsl_rl/velocity/<Ordner>/model_<N>.pt
```

`play` öffnet ein Fenster, wenn WSL eine Anzeige hat (WSLg, `DISPLAY` ist gesetzt). Sonst startet es
einen Web-Viewer (viser), den man im Windows-Browser öffnet. Beides ist auf deinem PC nicht getestet.

## Wenn etwas schiefgeht

| Meldung | Lösung |
|---|---|
| `wsl --install`: „WSL-Installation scheint beschädigt“ (`Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG`) | Taste drücken, WSL repariert sich (bei Basti: Update auf 3.0.3). Mit `wsl --version` prüfen, PC neu starten, `wsl --install -d Ubuntu-24.04` erneut. Hilft das nicht: WSL-MSI von github.com/microsoft/WSL/releases installieren. |
| `nvidia-smi` nicht gefunden / Fehler | Windows-NVIDIA-Treiber aktualisieren, in PowerShell `wsl --update` und `wsl --shutdown`, Ubuntu neu öffnen. |
| `WSL1 erkannt` | In PowerShell: `wsl --set-version Ubuntu-24.04 2` |
| `uv sync` bricht beim Download ab | Skript einfach erneut starten. Bereits geladene Pakete bleiben im Cache. |
| `$'\r': command not found` | Datei hat Windows-Zeilenenden. `sed -i 's/\r$//' <datei>.sh` |
| GPU-Test schlägt fehl, `nvidia-smi` geht aber | Meldung von `check_gpu.py` aufheben und mir zeigen. |
| Training „out of memory“ | `NUM_ENVS=2048` (oder 1024) setzen. |

## Dateien

- `wsl/setup-microduck.sh`: Einrichtung in Ubuntu (Schritt 2).
- `wsl/check_gpu.py`: GPU-Test, wird vom Setup-Skript aufgerufen.
- `wsl/train-velocity.sh`: Training starten (Schritt 3).
- `wsl/train-watchdog.sh`: Training starten und nach Absturz automatisch fortsetzen.
- `wsl/status.sh` + `wsl/status.py`: kurzer Statusbericht zum Training.
