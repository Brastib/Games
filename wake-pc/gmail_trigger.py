#!/usr/bin/env python3
"""Gmail-Ausloeser fuer Wake-on-LAN.

Prueft das Gmail-Postfach per IMAP regelmaessig auf eine Mail mit dem Betreff
"WAKE-PC" (einstellbar) und sendet dann das Magic Packet an den PC.

Eine Mail loest nur aus, wenn
  - das erste Wort des Betreffs das Ausloesewort ist (Gross-/Kleinschreibung egal),
  - das Geheimwort im Betreff steht (falls eines eingestellt ist),
  - der Absender erlaubt ist,
  - sie juenger als max_age_minutes ist und
  - sie nicht schon einmal verarbeitet wurde.

Nur Python-Standardbibliothek. Konfiguration: ~/.config/wake-pc/config.ini
"""

import argparse
import email
import email.errors
import email.utils
import imaplib
import json
import logging
import os
import re
import smtplib
import ssl
import subprocess
import sys
import time
from email.header import decode_header, make_header
from email.message import EmailMessage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wol  # noqa: E402

IMAP_HOST = "imap.gmail.com"
SMTP_HOST = "smtp.gmail.com"
DEFAULT_STATE = os.path.expanduser("~/.local/state/wake-pc/processed.json")
MAX_STATE_ENTRIES = 500
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

log = logging.getLogger("wake-pc")


def gmail_settings(config):
    get = lambda key, default="": config.get("gmail", key, fallback=default).strip()  # noqa: E731
    user = get("user")
    allowed = get("allowed_senders") or user
    return {
        "user": user,
        # Google zeigt App-Passwoerter in 4er-Bloecken mit Leerzeichen an.
        "app_password": get("app_password").replace(" ", ""),
        "subject": get("subject", "WAKE-PC") or "WAKE-PC",
        "secret": get("secret"),
        "allowed_senders": [a.strip().lower() for a in allowed.split(",") if a.strip()],
        "mailbox": get("mailbox", "INBOX") or "INBOX",
        "poll_interval": int(get("poll_interval", "30") or 30),
        "max_age_minutes": int(get("max_age_minutes", "15") or 15),
        "confirm": config.getboolean("gmail", "confirm", fallback=True),
        "pc_host": config.get("check", "pc_host", fallback="").strip(),
        "online_timeout": int(config.get("check", "online_timeout", fallback="180").strip() or 180),
    }


def decode_subject(raw):
    try:
        return str(make_header(decode_header(raw or "")))
    except (UnicodeError, LookupError, email.errors.HeaderParseError):
        return raw or ""


def check_message(subject, sender, received_ts, settings, now):
    """Gibt None zurueck, wenn die Mail ausloesen darf, sonst den Ablehnungsgrund."""
    words = subject.split()
    if not words or words[0].upper() != settings["subject"].upper():
        return "Betreff passt nicht"
    if settings["secret"] and settings["secret"] not in words[1:]:
        return "Geheimwort fehlt oder falsch"
    address = email.utils.parseaddr(sender or "")[1].lower()
    if settings["allowed_senders"] and address not in settings["allowed_senders"]:
        return f"Absender nicht erlaubt ({address or 'unbekannt'})"
    if received_ts is None:
        return "Empfangszeit unbekannt"
    if now - received_ts > settings["max_age_minutes"] * 60:
        return "zu alt"
    return None


def imap_since_date(now):
    """IMAP-Datum fuer SEARCH SINCE (ein Tag Puffer, unabhaengig von der Locale)."""
    t = time.gmtime(now - 86400)
    return f"{t.tm_mday:02d}-{MONTHS[t.tm_mon - 1]}-{t.tm_year}"


def quote_mailbox(name):
    return name if name.startswith('"') else '"' + name.replace('"', '\\"') + '"'


def load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            return list(json.load(f))
    except (OSError, ValueError):
        return []


def save_state(path, processed):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(processed[-MAX_STATE_ENTRIES:], f)
    os.replace(tmp, path)


def header_date(value):
    try:
        return email.utils.parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, IndexError):
        return None


def parse_fetch_response(data):
    """Zerlegt die Antwort auf UID FETCH (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS ...]).

    imaplib liefert pro Mail ein Tupel (Metadaten, Header) und danach ein
    bytes-Stueck mit dem Rest der Metadaten. Der Server darf UID und
    INTERNALDATE auch erst nach dem Header schicken, deshalb wird beides
    zusammengefuehrt.
    """
    parts = []
    for item in data:
        if isinstance(item, tuple):
            parts.append([item[0], item[1]])
        elif isinstance(item, bytes) and parts:
            parts[-1][0] += b" " + item
    messages = []
    for meta, header_bytes in parts:
        uid_match = re.search(rb"UID (\d+)", meta)
        date_tuple = imaplib.Internaldate2tuple(meta)
        headers = email.message_from_bytes(header_bytes)
        received = time.mktime(date_tuple) if date_tuple else header_date(headers.get("Date"))
        messages.append({
            "uid": uid_match.group(1).decode() if uid_match else None,
            "received": received,
            "subject": decode_subject(headers.get("Subject")),
            "sender": headers.get("From", ""),
            "message_id": (headers.get("Message-ID") or "").strip(),
        })
    return messages


def pc_is_online(host, timeout):
    """Pingt den PC, bis er antwortet oder timeout Sekunden vergangen sind."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = subprocess.run(["ping", "-c", "1", "-W", "2", host],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode == 0:
            return True
        time.sleep(5)
    return False


def send_confirmation(settings, recipient, text):
    msg = EmailMessage()
    # Der Betreff darf NICHT mit dem Ausloesewort beginnen, sonst loest die
    # Bestaetigung selbst wieder aus.
    msg["Subject"] = "PC-Wecker: " + text.splitlines()[0]
    msg["From"] = settings["user"]
    msg["To"] = recipient
    msg["X-Wake-PC"] = "confirmation"
    msg.set_content(text)
    with smtplib.SMTP_SSL(SMTP_HOST, 465, context=ssl.create_default_context(), timeout=30) as smtp:
        smtp.login(settings["user"], settings["app_password"])
        smtp.send_message(msg)


def handle_trigger(message, settings, wol_cfg):
    wol.send_magic_packet(wol_cfg["mac"], wol_cfg["broadcast"], wol_cfg["port"],
                          wol_cfg["source_ip"])
    log.info("Magic Packet an %s gesendet (%s:%s).",
             wol_cfg["mac"], wol_cfg["broadcast"], wol_cfg["port"])
    status = "Magic Packet gesendet"
    details = [f"Ziel-MAC: {wol_cfg['mac']}", f"Broadcast: {wol_cfg['broadcast']}:{wol_cfg['port']}"]
    if settings["pc_host"]:
        online = pc_is_online(settings["pc_host"], settings["online_timeout"])
        log.info("PC %s online: %s", settings["pc_host"], "ja" if online else "nein")
        status += ", PC online" if online else ", PC antwortet (noch) nicht auf Ping"
        details.append(f"Ping {settings['pc_host']}: {'Antwort erhalten' if online else 'keine Antwort'}"
                       f" (gewartet bis zu {settings['online_timeout']} s)")
    if settings["confirm"]:
        recipient = email.utils.parseaddr(message["sender"])[1] or settings["user"]
        try:
            send_confirmation(settings, recipient, status + "\n\n" + "\n".join(details))
        except (smtplib.SMTPException, OSError) as exc:
            log.warning("Bestaetigungsmail fehlgeschlagen: %s", exc)


def poll(imap, settings, wol_cfg, state_path, now=None):
    now = time.time() if now is None else now
    typ, _ = imap.select(quote_mailbox(settings["mailbox"]))
    if typ != "OK":
        raise imaplib.IMAP4.error(f"Postfach {settings['mailbox']!r} nicht gefunden")
    typ, data = imap.uid("SEARCH", None, "SINCE", imap_since_date(now),
                         "SUBJECT", '"' + settings["subject"] + '"')
    if typ != "OK" or not data or not data[0]:
        return 0
    uids = data[0].split()
    typ, data = imap.uid("FETCH", b",".join(uids).decode(),
                         "(UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID DATE)])")
    if typ != "OK":
        return 0

    processed = load_state(state_path)
    triggered = 0
    for message in parse_fetch_response(data):
        key = message["message_id"] or f"uid:{message['uid']}"
        if key in processed:
            continue
        processed.append(key)
        save_state(state_path, processed)
        reason = check_message(message["subject"], message["sender"],
                               message["received"], settings, now)
        if reason:
            log.info("Ignoriert: %r von %s (%s)", message["subject"], message["sender"], reason)
            continue
        log.info("Ausloeser erkannt: %r von %s", message["subject"], message["sender"])
        if message["uid"]:
            imap.uid("STORE", message["uid"], "+FLAGS", "(\\Seen)")
        try:
            handle_trigger(message, settings, wol_cfg)
        except OSError as exc:
            log.error("Magic Packet konnte nicht gesendet werden: %s", exc)
            continue
        triggered += 1
    return triggered


def validate(settings, wol_cfg):
    problems = []
    if not settings["user"]:
        problems.append("[gmail] user fehlt")
    if not settings["app_password"]:
        problems.append("[gmail] app_password fehlt")
    try:
        wol.parse_mac(wol_cfg["mac"])
    except ValueError as exc:
        problems.append(f"[wol] mac: {exc}")
    return problems


def run(config_path, state_path, once=False):
    config = wol.load_config(config_path)
    settings = gmail_settings(config)
    wol_cfg = wol.wol_settings(config)
    problems = validate(settings, wol_cfg)
    if problems:
        for p in problems:
            log.error("Konfiguration %s: %s", config_path, p)
        return 2

    log.info("Starte: Postfach %s, Betreff %r, Abfrage alle %s s, erlaubte Absender: %s",
             settings["mailbox"], settings["subject"], settings["poll_interval"],
             ", ".join(settings["allowed_senders"]))
    backoff = 30
    while True:
        try:
            with imaplib.IMAP4_SSL(IMAP_HOST, 993, ssl_context=ssl.create_default_context(),
                                   timeout=60) as imap:
                imap.login(settings["user"], settings["app_password"])
                log.info("Mit Gmail verbunden.")
                backoff = 30
                while True:
                    poll(imap, settings, wol_cfg, state_path)
                    if once:
                        return 0
                    time.sleep(settings["poll_interval"])
        except (imaplib.IMAP4.error, OSError) as exc:
            log.warning("IMAP-Fehler: %s", exc)
            if once:
                return 1
            log.info("Neuer Versuch in %s s.", backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 900)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Gmail-Ausloeser fuer Wake-on-LAN.")
    parser.add_argument("--config", default=wol.DEFAULT_CONFIG)
    parser.add_argument("--state", default=DEFAULT_STATE)
    parser.add_argument("--once", action="store_true",
                        help="Nur einmal pruefen und beenden (zum Testen der Anmeldung)")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s %(message)s")
    return run(args.config, args.state, args.once)


if __name__ == "__main__":
    sys.exit(main())
