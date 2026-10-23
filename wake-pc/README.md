# wake-pc – Windows-PC per Wake-on-LAN starten, ausgelöst von Claude

```
Claude (Handy) ──Mail "WAKE-PC"──▶ Gmail ◀──prüft alle 30 s── Linux-Laptop ──Magic Packet──▶ Windows-PC
                                                                   └──Bestätigungsmail "PC-Wecker: …"
```

Das Magic Packet muss **aus dem Heimnetz** kommen. Deshalb läuft alles auf dem
Linux-Laptop. Eine Claude-Code-Sitzung in der Cloud kann den PC nicht direkt wecken.

Benötigt: Linux mit systemd, Python ≥ 3.9. Keine Zusatzpakete.

| Datei | Zweck |
|---|---|
| `wol.py` | sendet das Magic Packet (`wake-pc` nach der Installation) |
| `gmail_trigger.py` | prüft Gmail per IMAP und weckt den PC |
| `install.sh` | richtet Befehl, Konfiguration und systemd-Dienst ein |
| `laptop-no-sleep.sh` | verhindert Bereitschaft/Ruhezustand des Laptops |
| `config.example.ini` | Vorlage für `~/.config/wake-pc/config.ini` |
| `tests/` | Tests: `python3 -m unittest discover -s tests` |

---

## A. Am Windows-PC (einmalig)

1. **LAN-Kabel.** WoL funktioniert in der Regel nur über Ethernet, nicht über WLAN.
2. **BIOS/UEFI:** „Wake on LAN“ bzw. „Power On By PCI-E“ / „Resume by PCI-E Device“
   aktivieren. **„ErP“ / „EuP“ / „Deep Sleep“ deaktivieren** – sonst bekommt die
   Netzwerkkarte im ausgeschalteten Zustand keinen Strom.
3. **Netzwerkadapter** (Geräte-Manager → Netzwerkadapter → Ethernet → Eigenschaften):
   - Energieverwaltung: „Gerät kann den Computer aus dem Ruhezustand aktivieren“ und
     „Nur Magic Packet …“ anhaken.
   - Erweitert: „Wake on Magic Packet“ = Aktiviert. Bei Realtek zusätzlich
     „Shutdown Wake-On-Lan“ = Aktiviert. „Energy Efficient Ethernet“/„Green Ethernet“
     bei Problemen deaktivieren.
4. **Schnellstart aus:** Systemsteuerung → Energieoptionen → „Auswählen, was beim
   Drücken des Netzschalters geschehen soll“ → „Einige Einstellungen sind momentan
   nicht verfügbar“ → Häkchen bei „Schnellstart aktivieren“ entfernen.
5. **MAC-Adresse notieren:** `ipconfig /all` → Abschnitt „Ethernet-Adapter“ →
   „Physische Adresse“ (z. B. `1C-69-7A-12-34-56`).
6. *Optional, für die Online-Prüfung:* IP-Adresse des PCs notieren (am besten im
   Router fest zuweisen) und Ping erlauben (PowerShell als Administrator):
   ```powershell
   New-NetFirewallRule -DisplayName "Ping erlauben (wake-pc)" -Protocol ICMPv4 -IcmpType 8 -Direction Inbound -Action Allow -Profile Private
   ```

Hinweis: Nach einem Stromausfall/Ausstecken brauchen viele Mainboards erst einmal
einen normalen Start, bevor WoL wieder geht.

## B. Gmail vorbereiten

- Der Laptop meldet sich per IMAP mit einem **App-Passwort** an
  (Google-Konto → Sicherheit → App-Passwörter; setzt die 2-Faktor-Anmeldung voraus).
- Das App-Passwort gibt vollen Zugriff auf das Postfach. **Empfehlung:** ein eigenes,
  zweites Gmail-Konto nur für den Auslöser anlegen. Claude schickt die Mail dann von
  deinem Hauptkonto an dieses Konto; in `allowed_senders` steht dein Hauptkonto.
- Zusätzlich ein **Geheimwort** setzen. Dann weckt nur `WAKE-PC <geheimwort>`.

## C. Am Linux-Laptop

```bash
# Branch-Angabe nur noetig, solange die Aenderung nicht in main ist
git clone -b claude/wol-windows-pc-setup-figvt2 https://github.com/brastib/games.git
cd games/wake-pc
./install.sh            # fragt MAC, Gmail-Adresse, App-Passwort, Geheimwort, PC-IP ab
wake-pc                 # Test: PC sofort wecken (vorher normal herunterfahren)
./laptop-no-sleep.sh    # Laptop nicht mehr schlafen lassen
```

Nur WoL ohne Gmail: `./install.sh --no-service`.
Alternative zum Testen: `sudo apt install wakeonlan` (Debian/Ubuntu) und
`wakeonlan 1C:69:7A:12:34:56`.

`laptop-no-sleep.sh` sperrt alle Schlaf-Ziele von systemd (wirkt sofort), lässt
Deckel-Zuklappen und Leerlauf nichts mehr tun (wirkt nach Neustart) und stellt bei
GNOME die automatische Bereitschaft ab. Prüfen: `--status`, rückgängig: `--undo`.
Bei KDE zusätzlich in den Systemeinstellungen → Energieverwaltung prüfen.
Der Laptop muss am Netzteil hängen und im Heimnetz sein (WLAN reicht dafür).

## D. Von Claude aus auslösen

**Variante 1 – Gmail (funktioniert, solange der Dienst läuft):**
In der Claude-App mit verbundenem Gmail sagen:
> Schick eine Mail an `<auslöser-adresse>` mit Betreff `WAKE-PC <geheimwort>`.

Innerhalb von ca. 30 s sendet der Laptop das Magic Packet und schickt eine Mail
„PC-Wecker: Magic Packet gesendet …“ zurück (mit `pc_host` auch, ob der PC auf Ping
antwortet). Claude kann diese Antwort im Postfach nachlesen.

**Variante 2 – Claude Code fernsteuern (Remote Control):**
Am Laptop in einem Terminal `claude remote-control` starten. Die Sitzung erscheint
dann in der Claude-Code-App auf dem Handy; dort „führe `wake-pc` aus“ schreiben.
Das Terminal muss dafür offen bleiben (z. B. in `tmux`). Variante 1 braucht das nicht.

## Fehlersuche

- Log: `journalctl -u wake-pc-gmail -f`
- `Ignoriert: … (zu alt)`: Mail älter als `max_age_minutes` oder Laptop-Uhr falsch.
- `Absender nicht erlaubt`: Adresse in `allowed_senders` eintragen.
- Keine Reaktion: Mail landet nicht im Posteingang (Filter?) → `mailbox` anpassen.
- PC startet nicht, obwohl gesendet: BIOS/ErP und Adapter-Einstellungen (A) prüfen,
  `wake-pc --broadcast 192.168.178.255` (Broadcast deines Netzes) versuchen.
- Konfiguration ändern: `nano ~/.config/wake-pc/config.ini`, danach
  `sudo systemctl restart wake-pc-gmail`.

## Deinstallieren

```bash
sudo systemctl disable --now wake-pc-gmail && sudo rm /etc/systemd/system/wake-pc-gmail.service
rm -r ~/.local/lib/wake-pc ~/.local/bin/wake-pc ~/.config/wake-pc ~/.local/state/wake-pc
./laptop-no-sleep.sh --undo
```

---

## Projektstand (2026-10-23)

**Erledigt und getestet (in einer Cloud-Umgebung, nicht in deinem Heimnetz):**
- Magic Packet: Aufbau geprüft, Versand über UDP an localhost empfangen.
- Gmail-Auslöser: Filter (Betreff, Geheimwort, Absender, Alter, doppelte Mails) per
  Unit-Tests; Ablauf Anmelden → Suchen → Abrufen → als gelesen markieren → Packet senden
  mit echtem `imaplib` gegen einen nachgebauten IMAP-Server.
- Shell-Skripte: nur Syntaxprüfung (`bash -n`).

**Noch nicht getestet:** echtes Gmail, echtes Wecken des PCs, `install.sh`,
`laptop-no-sleep.sh` und der systemd-Dienst auf deinem Laptop, Bestätigungsmail per SMTP.

**Offen:**
- [ ] Am PC: BIOS-WoL, ErP aus, Adapter-Einstellungen, Schnellstart aus, LAN-Kabel
- [ ] MAC-Adresse auslesen und bei `install.sh` eintragen
- [ ] Gmail-App-Passwort erstellen (am besten eigenes Auslöser-Konto)
- [ ] Am Laptop `install.sh` ausführen, `wake-pc` testen
- [ ] `laptop-no-sleep.sh` ausführen
- [ ] Ersten Auslöser per Claude-Mail testen
