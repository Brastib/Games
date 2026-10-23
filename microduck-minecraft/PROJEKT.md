# MicroDuck als Pet in Minecraft

Stand: 23.10.2026. Noch keine Zeile Mod-Code geschrieben. Dieses Dokument hält Ziel, Anforderungen,
Entscheidungen und offene Fragen fest.

## Deine Anforderungen (Aussagen von Basti)

- Die Ente soll **„richtig“** in Minecraft sein, nicht nur eine abgespielte Animation:
  sie sieht ihre Umgebung, weiß wo sie ist „und sonstiges“.
- Sie soll ein **Pet** im Modpack sein:
  `C:\Users\Basti\AppData\Roaming\ModrinthApp\profiles\Tom und. Basti Grind pack` (Modrinth = Minecraft **Java Edition**).
- Sie soll mit dem **Voice-Mod** funktionieren (was genau: offen, siehe unten).
- Es soll **dasselbe** sein, was wir in mjlab trainieren.
- Im Training evtl. ergänzen: **welche Mobs freundlich sind** und **dass der Spieler freundlich ist**.
- Die Ente soll aus ihrer **Kamera in der Ich-Perspektive** sehen, „wie in echt“.

## Fakten aus dem Code (geprüft)

- Die echte Microduck hat im Modell u. a. die Sensor-Punkte `head_camera`, `tof` (Abstandssensor), `imu`, `head_imu`.
- Die aktuelle Lauf-Policy ist **blind**: 61 Eingänge (Körpergefühl + Befehle), 14 Ausgänge (Servos), 50 Hz.
- mjlab 1.3.0 hat Bausteine für mehr: `raycast_sensor`, `terrain_height_sensor`, `camera_sensor`
  und Block-Gelände (`BoxRandomGridTerrainCfg`, Treppen, Trittsteine).
- Echte Ente: ca. 25 cm groß, ca. 800 g. Minecraft-Block: 1 m.

## Vorgeschlagene Architektur (meine Schlussfolgerung, noch nicht gebaut)

Zwei Gehirne:

1. **Körper (in mjlab trainiert):** Laufen, Gleichgewicht, Aufstehen, Treppen/Blöcke.
   Eingänge: Körpergefühl + Höhen-Scan der Blöcke um die Ente.
   Läuft in einer **Zwillingswelt**: MuJoCo simuliert die Ente auf einer Kopie der Minecraft-Blöcke um sie herum.
2. **Verhalten (in Minecraft):** Pet-Logik (zähmen, folgen, sitzen), freundlich/feindlich erkennen,
   Ziele wählen, auf Sprache reagieren. Gibt dem Körper Befehle wie „geh dorthin / so schnell“.

Begründung: Freund/Feind und „der Spieler“ gibt es in der Physik-Simulation nicht. Das gehört ins Verhaltens-Gehirn.
Der Körper muss nur lernen, sicher dorthin zu laufen, wo das Verhalten hinwill.

**Kamera / Ich-Perspektive** in zwei Stufen:
- A: „Sehen“ über Spieldaten mit echtem Sichtfeld der Kopfkamera (nur was im Blickfeld und nicht verdeckt ist).
  Günstig und zuverlässig.
- B: Echtes Kamerabild aus Minecraft rendern (Enten-Kamera als Bild-im-Bild) und daraus Dinge erkennen.
  Deutlich schwerer. Ein mit MuJoCo-Bildern trainiertes Gehirn versteht Minecraft-Bilder nicht ohne Weiteres.

## Risiken / Grenzen

- **Größe:** Eine volle Blockstufe ist viermal so hoch wie die Ente. Maßstab muss festgelegt werden
  (z. B. 1 Block = 5 cm für die Ente, dann ist sie in Minecraft ca. 5 Blöcke hoch).
- **Mehrspieler:** Die Simulation braucht einen PC mit Python + GPU neben dem Server. Wo der Server läuft, ist entscheidend.
- Training auf Blöcken und Kamera-Sehen sind nicht garantiert erfolgreich. Belohnungen werden Nachjustieren brauchen.
- Großes Projekt mit vielen Sitzungen.

## Meilensteine (Vorschlag)

1. Laufen auf flachem Boden trainieren (erster Lauf bei Iteration 1133 gestoppt, Checkpoint `model_1000.pt`; Drehen deutlich besser, Geradeaus-Tempo noch ungenau).
2. Mod-Grundgerüst: Enten-Pet ohne Physik (Modell, zähmen, folgen) für Loader/Version des Packs.
3. Brücke Mod <-> Simulation auf Bastis PC: Ente läuft mit dem trainierten Gehirn in Minecraft (zuerst flach).
4. Neue Trainingsaufgabe: Block-Gelände + Höhen-Scan. Danach Blöcke aus Minecraft in die Zwillingswelt.
5. Verhalten: Freund/Feind, Spieler folgen, Sichtfeld der Kopfkamera (Stufe A).
6. Voice-Mod-Anbindung.
7. Optional: echtes Kamerabild (Stufe B).

## Entscheidungen (Antworten von Basti, 23.10.2026)

- Modloader: **Fabric**.
- Voice-Mod: **Simple Voice Chat**.
- Die Ente soll **auf Sprache hören** (z. B. „Ente, komm her“) und **selbst Geräusche machen**.
- Hosting: **Basti hostet auf seinem PC**. Dadurch kann die Simulation direkt neben dem Server laufen.
  Tom braucht den Mod trotzdem auch (Modell und Animationen auf seiner Seite).

## Offene Fragen

- Genaue Minecraft-Version des Packs (steht in der Modrinth App im Profil, z. B. „Fabric 1.21.1“).
- Spracherkennung: offline auf Bastis PC (z. B. Vosk oder Whisper). Noch nicht ausgewählt und nicht getestet.
- Maßstab der Ente in Minecraft.
