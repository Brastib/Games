#!/usr/bin/env python3
"""Wake-on-LAN: sendet ein Magic Packet an den Windows-PC.

Nur Python-Standardbibliothek, keine Zusatzpakete noetig.

Beispiele:
    python3 wol.py                      # MAC aus der Konfigurationsdatei
    python3 wol.py AA-BB-CC-DD-EE-FF    # MAC direkt angeben
    python3 wol.py --dry-run            # Paket nur anzeigen, nicht senden
"""

import argparse
import configparser
import os
import re
import socket
import sys
import time

DEFAULT_CONFIG = os.path.expanduser("~/.config/wake-pc/config.ini")
DEFAULT_BROADCAST = "255.255.255.255"
DEFAULT_PORT = 9


def parse_mac(mac):
    """Akzeptiert AA:BB:.., AA-BB-.. (Windows ipconfig), AABB.CCDD.EEFF und AABBCCDDEEFF."""
    digits = re.sub(r"[\s:\-.]", "", mac or "")
    if not re.fullmatch(r"[0-9A-Fa-f]{12}", digits):
        raise ValueError(f"Ungueltige MAC-Adresse: {mac!r}")
    raw = bytes.fromhex(digits)
    if raw == b"\x00" * 6 or raw == b"\xff" * 6:
        raise ValueError(f"MAC-Adresse ist ein Platzhalter: {mac!r}")
    return raw


def build_magic_packet(mac):
    """6x 0xFF, danach die MAC-Adresse 16-mal hintereinander (102 Bytes)."""
    return b"\xff" * 6 + parse_mac(mac) * 16


def send_magic_packet(mac, broadcast=DEFAULT_BROADCAST, port=DEFAULT_PORT,
                      source_ip=None, repeat=3):
    packet = build_magic_packet(mac)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        if source_ip:
            sock.bind((source_ip, 0))
        # Mehrfach senden, falls ein einzelnes UDP-Paket verloren geht.
        for i in range(repeat):
            sock.sendto(packet, (broadcast, port))
            if i < repeat - 1:
                time.sleep(0.1)
    return packet


def load_config(path=DEFAULT_CONFIG):
    config = configparser.ConfigParser(interpolation=None)
    if path and os.path.exists(path):
        config.read(path, encoding="utf-8")
    return config


def wol_settings(config):
    """Liest den Abschnitt [wol] mit Standardwerten."""
    section = config["wol"] if config.has_section("wol") else {}
    return {
        "mac": section.get("mac", "").strip(),
        "broadcast": section.get("broadcast", DEFAULT_BROADCAST).strip() or DEFAULT_BROADCAST,
        "port": int(section.get("port", DEFAULT_PORT) or DEFAULT_PORT),
        "source_ip": section.get("source_ip", "").strip() or None,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Wake-on-LAN Magic Packet senden.")
    parser.add_argument("mac", nargs="?", help="MAC-Adresse (sonst aus der Konfiguration)")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help="Pfad zur config.ini")
    parser.add_argument("--broadcast", help="Broadcast-Adresse, z. B. 192.168.178.255")
    parser.add_argument("--port", type=int, help="UDP-Port (Standard 9)")
    parser.add_argument("--dry-run", action="store_true", help="Paket nur anzeigen")
    args = parser.parse_args(argv)

    settings = wol_settings(load_config(args.config))
    mac = args.mac or settings["mac"]
    broadcast = args.broadcast or settings["broadcast"]
    port = args.port or settings["port"]

    if not mac:
        print(f"Keine MAC-Adresse angegeben und keine in {args.config} gefunden.",
              file=sys.stderr)
        return 2
    try:
        packet = build_magic_packet(mac)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    if args.dry_run:
        print(f"Ziel: {broadcast}:{port}  Laenge: {len(packet)} Bytes")
        print(packet.hex(" "))
        return 0

    try:
        send_magic_packet(mac, broadcast, port, settings["source_ip"])
    except OSError as exc:
        print(f"Senden fehlgeschlagen: {exc}", file=sys.stderr)
        return 1
    print(f"Magic Packet an {mac} gesendet ({broadcast}:{port}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
