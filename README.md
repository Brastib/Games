# Discord-Bot

Ein deutscher All-in-One-Bot für Discord-Server: Moderation, Server-Schutz (Lockdown, Linkschutz, Anti-Raid, Anti-Nuke),
temporäre Sprach- und Textkanäle, Tickets, Willkommen mit Bildkarte, Regeln akzeptieren, Rollen per Button, Level, Gewinnspiele und mehr.
Vorbilder waren Carl-bot und MEE6, aber alles ist kostenlos und gehört dir.

---

## Was der Bot kann

| Bereich | Funktionen |
|---|---|
| 🔒 **Lockdown** | `/lockdown start` sperrt alle öffentlichen Kanäle (Text + Sprache), pausiert Einladungen und kann auf Zeit laufen. `/lockdown end` stellt **jede** Berechtigung exakt wieder her – auch nach einem Neustart. Einzelne Kanäle: `/lock`, `/unlock`. |
| 🔗 **Linkschutz** | GIFs (Tenor, Giphy, Klipy), hochgeladene Dateien, YouTube, Twitch, Discord-Links usw. funktionieren. Blockiert werden: rund **39.000 bekannte Betrugs-Domains** (öffentliche Listen, alle 6 Std. aktualisiert), gefälschte Discord-/Steam-Seiten (`dlscord.gift`, `steamcommunlty.com` …), IP-Logger (Grabify & Co.), Kurz-Links, nackte IP-Adressen, Punycode-Fälschungen und verdächtige Endungen. Modus **Smart** oder **Streng** (nur Erlaubt-Liste). Optional zusätzlich Google Safe Browsing. Auch bearbeitete und weitergeleitete Nachrichten werden geprüft. |
| 🤖 **AutoMod** | Spam (Nachrichtenflut + gleiche Nachrichten), Einladungen zu fremden Servern, Massen-Erwähnungen, GROSSBUCHSTABEN, Wortfilter (erkennt auch `w0rt`). Team und Ausnahmen werden nicht gefiltert. |
| 🚨 **Anti-Raid** | Erkennt Beitrittswellen → automatischer Lockdown, Einladungen und DMs pausieren, Raider kicken (optional). Mindest-Accountalter gegen Fake-Accounts. |
| ☢️ **Anti-Nuke** | Wenn jemand (gehackter Admin oder fremder Bot) massenhaft Kanäle/Rollen löscht, bannt, kickt oder Webhooks anlegt: sofort alle Rollen weg + Timeout (oder Kick/Bann). Gelöschte Kanäle und Rollen werden wiederhergestellt, Massen-Banns aufgehoben. Gefährliche Rechte (Admin usw.) an Rollen oder Personen werden zurückgesetzt. Nur der Server-Inhaber kann Anti-Nuke ändern. |
| 🔨 **Moderation** | `/ban` (auch Zeit-Bann), `/softban`, `/unban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/warnings`, `/delwarn`, `/clearwarnings`, `/modlogs`, `/purge` (mit Filtern), `/slowmode`, `/nick`, `/role`. Jede Aktion bekommt eine Fall-Nummer, das Mitglied bekommt eine DM. Automatische Strafen ab 3 / 5 / 7 Verwarnungen. |
| 🔊 **Temp-Sprachkanäle** | „➕ Kanal erstellen“ betreten → eigener Kanal. Bedienfeld mit Buttons: Umbenennen, Limit, Sperren, Verstecken, Erlauben, Rauswerfen, Übernehmen, Übertragen. Leere Kanäle verschwinden automatisch. |
| ⏳ **Temp-Textkanäle** | `/tempchannel create` – löscht sich nach z. B. 2 Stunden selbst (mit Vorwarnung), auch privat. |
| 🎫 **Tickets** | Button → privater Kanal mit dem Team, Übernehmen, Schließen mit Protokoll-Datei. |
| 👋 **Willkommen** | Nachricht mit Bildkarte (Avatar, Name, Mitgliedsnummer), Abschied, DM, automatische Rollen. |
| ✅ **Regeln akzeptieren** | Regeln mit Button „Regeln akzeptieren“, optional Rechen-Captcha, optional alle Kanäle erst danach sichtbar. |
| 🎭 **Rollen per Button** | `/rolepanel` – Buttons oder Auswahlmenü, auch „nur eine Rolle“. |
| ⭐ **Level** | XP wie bei MEE6, Rang-Bildkarte, Bestenliste, Rollen als Belohnung. |
| 🎉 **Extras** | Gewinnspiele mit Button, Umfragen, Embed-Baukasten, Infos zu Mitgliedern/Server. |
| 🎛️ **Dashboard** | `/dashboard` zeigt alles auf einen Blick und schaltet Module per Button an/aus – direkt in Discord. |
| 📁 **Logs** | Mod-Aktionen, Schutz-Alarme, gelöschte/bearbeitete Nachrichten, Beitritte/Austritte, Rollen, Sprachkanäle, Server-Änderungen. |

---

## Einrichtung (geht komplett am iPhone im Browser)

Du brauchst 4 kostenlose Konten: **Discord Developer Portal**, **GitHub** (hast du), **MongoDB Atlas**, **Render**. Dauer: etwa 20 Minuten.

### Schritt 1 – Bot bei Discord anlegen
1. Öffne <https://discord.com/developers/applications> und melde dich an.
2. **New Application** → Namen eingeben → erstellen.
3. Links auf **Bot**:
   - **Reset Token** → Token kopieren und sicher notieren. *Der Token ist wie ein Passwort – niemals teilen!*
   - Weiter unten **SERVER MEMBERS INTENT** und **MESSAGE CONTENT INTENT** einschalten → **Save Changes**. (Ohne diese zwei startet der Bot nicht.)
4. Links auf **OAuth2** → kopiere die **Client ID**.
5. Öffne diesen Link (ersetze `DEINE_CLIENT_ID`) und lade den Bot auf deinen Server ein:
   `https://discord.com/oauth2/authorize?client_id=DEINE_CLIENT_ID&permissions=8&scope=bot%20applications.commands`
   (`permissions=8` = Administrator. Das braucht der Bot für Lockdown, Anti-Nuke und Kanäle.)

### Schritt 2 – Kostenlose Datenbank (MongoDB Atlas)
Render löscht bei jedem Neustart die Festplatte. Deshalb speichert der Bot alles in einer kostenlosen Datenbank.
1. Öffne <https://www.mongodb.com/cloud/atlas/register> und registriere dich.
2. Erstelle einen Cluster mit dem Plan **M0 (Free)**. Region: Frankfurt.
3. **Database Access** → Benutzer anlegen (Name + Passwort merken).
4. **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`). (Render hat keine feste IP.)
5. **Connect** → **Drivers** → den Link kopieren. Er sieht so aus:
   `mongodb+srv://NAME:PASSWORT@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   Setze dein echtes Passwort an die Stelle von `<db_password>`.

### Schritt 3 – Bot kostenlos online stellen (Render)
1. Öffne <https://render.com> und melde dich **mit GitHub** an.
2. **New +** → **Blueprint** → dieses Repository auswählen.
3. Render liest die Datei `render.yaml` und fragt nach zwei Werten:
   - `DISCORD_TOKEN` → Token aus Schritt 1
   - `MONGODB_URI` → Link aus Schritt 2
4. **Apply** drücken. Nach 2–4 Minuten steht im Log `Eingeloggt als …` – der Bot ist online. 🎉
5. Oben steht deine Adresse, z. B. `https://discord-bot-xxxx.onrender.com`. Öffnest du sie, siehst du „🟢 Bot ist online“.

### Schritt 4 – Wach halten (wichtig!)
Render legt kostenlose Dienste schlafen, wenn 15 Minuten lang **keine Anfrage von außen** kommt. Die Verbindung des Bots zu Discord zählt dabei nicht. Deshalb:
- Der Bot ruft sich selbst alle 10 Minuten auf (eingebaut, nichts zu tun).
- **Zusätzlich empfohlen:** Bei <https://cron-job.org> (kostenlos) einen Job anlegen, der alle 10 Minuten `https://DEINE-ADRESSE.onrender.com/health` aufruft. Dann wacht der Bot auch nach einem Neustart sofort wieder auf.

Render gibt 750 Gratis-Stunden pro Monat – genug für **einen** Dienst rund um die Uhr (ein Monat hat höchstens 744 Stunden).

### Schritt 5 – Im Discord einrichten
1. **Server-Einstellungen → Rollen**: die Rolle des Bots **ganz nach oben** ziehen. Sonst kann er höhere Rollen nicht moderieren und Anti-Nuke greift nicht.
2. `/setup quickstart modrolle:@Team` → legt Logs, Willkommen, Temp-Sprachkanäle und Tickets automatisch an.
3. `/setup rules kanal:#regeln rolle:@Mitglied captcha:True` → Regeln mit Akzeptieren-Button.
4. `/dashboard` → alles prüfen und Module an- oder ausschalten.
5. `/help` → Übersicht aller Befehle.

---

## Ehrliche Grenzen

- **Render (gratis)** startet Dienste ab und zu neu. Der Bot ist dann ca. 1 Minute offline und verbindet sich selbst neu. Einstellungen bleiben dank MongoDB erhalten.
- **Anti-Nuke** kann gelöschte Kanäle und Rollen neu anlegen, aber **alte Nachrichten** in gelöschten Kanälen und die **Rollen-Zuweisungen** an Mitglieder kann Discord nicht zurückgeben.
- Der Bot kann nur Personen moderieren, deren höchste Rolle **unter** seiner eigenen steht. Den Server-Inhaber kann niemand moderieren.
- Discord erlaubt nur **2 Umbenennungen pro 10 Minuten** pro Kanal (betrifft Temp-Sprachkanäle).
- **iPhone als Server** geht nicht: iOS beendet Apps im Hintergrund, ein Bot würde nach kurzer Zeit stoppen. Am iPhone kannst du aber alles einrichten und den Bot steuern.
- Eine **Web-Oberfläche** wie bei MEE6 gibt es (noch) nicht. Die Einstellungen laufen über `/dashboard`, `/setup`, `/automod`, `/antiraid`, `/antinuke` direkt in Discord.

### Stabilere Gratis-Alternative: Oracle Cloud „Always Free“
Oracle gibt eine dauerhaft kostenlose Linux-VM, die nie schläft. Zur Identitätsprüfung wird eine Kreditkarte verlangt (es wird nichts abgebucht). Einrichtung dort:
```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
git clone https://github.com/DEIN-NAME/Discord-Bot.git && cd Discord-Bot
npm ci --omit=dev
cp .env.example .env && nano .env      # DISCORD_TOKEN eintragen (MONGODB_URI optional, sonst Ordner ./data)
sudo npm i -g pm2 && pm2 start src/index.js --name discord-bot && pm2 save && pm2 startup
```

---

## Für Entwickler

```bash
npm install
npm run check   # Selbsttest ohne Discord: Befehle, Linkschutz, Lockdown, AutoMod, Bildkarten
npm start       # braucht DISCORD_TOKEN in .env
```

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `DISCORD_TOKEN` | ja | Bot-Token |
| `MONGODB_URI` | bei Render ja | Datenbank; ohne wird in `./data` gespeichert |
| `SAFE_BROWSING_KEY` | nein | Google Safe Browsing API-Schlüssel für unbekannte Links |
| `BRAND_COLOR` | nein | Embed-Farbe, z. B. `ff2d55` |
| `DEV_GUILD_ID` | nein | Befehle nur auf diesem Server registrieren (sofort sichtbar) |
| `KEEPALIVE_URL` | nein | Adresse für den Selbst-Ping (bei Render automatisch) |
| `PHISHING_LISTS` | nein | Eigene Betrugslisten (kommagetrennte URLs zu JSON-Listen) |

**Aufbau:** `src/index.js` (Start, Ereignisse, Zeitplaner, Statusseite) · `src/commands/` (Slash-Befehle) · `src/modules/` (Funktionen) · `src/lib/` (Speicher, Einstellungen, Linkfilter, Bildkarten) · `scripts/selftest.js`

Schriftart Poppins: SIL Open Font License (`assets/fonts/LIZENZ.txt`).
