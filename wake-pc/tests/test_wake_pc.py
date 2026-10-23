import configparser
import io
import os
import socket
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gmail_trigger  # noqa: E402
import wol  # noqa: E402

MAC = "1C-69-7A-12-34-56"
MAC_BYTES = bytes.fromhex("1c697a123456")


class MacTests(unittest.TestCase):
    def test_accepts_common_formats(self):
        for text in ["1C-69-7A-12-34-56", "1c:69:7a:12:34:56", "1C69.7A12.3456",
                     "1c697a123456", " 1C-69-7A-12-34-56 "]:
            self.assertEqual(wol.parse_mac(text), MAC_BYTES, text)

    def test_rejects_invalid_and_placeholders(self):
        for text in ["", "1C-69-7A-12-34", "ZZ-69-7A-12-34-56", "00:00:00:00:00:00",
                     "FF-FF-FF-FF-FF-FF", None]:
            with self.assertRaises(ValueError, msg=text):
                wol.parse_mac(text)

    def test_magic_packet_layout(self):
        packet = wol.build_magic_packet(MAC)
        self.assertEqual(len(packet), 102)
        self.assertEqual(packet[:6], b"\xff" * 6)
        self.assertEqual(packet[6:], MAC_BYTES * 16)


class SendTests(unittest.TestCase):
    def test_packet_arrives_over_udp(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(2)
            port = receiver.getsockname()[1]
            sent = wol.send_magic_packet(MAC, "127.0.0.1", port, repeat=3)
            received = [receiver.recv(1024) for _ in range(3)]
        self.assertEqual(received, [sent] * 3)
        self.assertEqual(sent, wol.build_magic_packet(MAC))

    def test_cli_dry_run_reads_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.ini")
            with open(path, "w") as f:
                f.write(f"[wol]\nmac = {MAC}\nbroadcast = 192.168.178.255\n")
            out = io.StringIO()
            with redirect_stdout(out):
                code = wol.main(["--config", path, "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("192.168.178.255:9", out.getvalue())
        self.assertIn("1c 69 7a 12 34 56", out.getvalue())

    def test_cli_without_mac_fails(self):
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(wol.main(["--config", "/nicht/vorhanden.ini", "--dry-run"]), 2)


def make_settings(**overrides):
    config = configparser.ConfigParser(interpolation=None)
    config.read_string("[gmail]\nuser = ich@gmail.com\napp_password = abcd efgh ijkl mnop\n"
                       "confirm = no\n")
    settings = gmail_trigger.gmail_settings(config)
    settings.update(overrides)
    return settings


class CheckMessageTests(unittest.TestCase):
    now = 1_800_000_000

    def check(self, subject="WAKE-PC", sender="Ich <ich@gmail.com>", age=60, **overrides):
        return gmail_trigger.check_message(subject, sender, self.now - age,
                                           make_settings(**overrides), self.now)

    def test_defaults(self):
        settings = make_settings()
        self.assertEqual(settings["app_password"], "abcdefghijklmnop")
        self.assertEqual(settings["allowed_senders"], ["ich@gmail.com"])

    def test_valid_trigger(self):
        self.assertIsNone(self.check())
        self.assertIsNone(self.check(subject="wake-pc bitte"))

    def test_subject_must_start_with_trigger(self):
        self.assertEqual(self.check(subject="Re: WAKE-PC"), "Betreff passt nicht")
        self.assertEqual(self.check(subject="PC-Wecker: Magic Packet gesendet"),
                         "Betreff passt nicht")
        self.assertEqual(self.check(subject=""), "Betreff passt nicht")

    def test_secret(self):
        self.assertIsNone(self.check(subject="WAKE-PC kaktus42", secret="kaktus42"))
        self.assertEqual(self.check(subject="WAKE-PC", secret="kaktus42"),
                         "Geheimwort fehlt oder falsch")
        self.assertEqual(self.check(subject="WAKE-PC kaktus", secret="kaktus42"),
                         "Geheimwort fehlt oder falsch")

    def test_sender(self):
        self.assertIn("Absender nicht erlaubt", self.check(sender="fremd@example.com"))
        self.assertIsNone(self.check(sender="fremd@example.com",
                                     allowed_senders=["ich@gmail.com", "fremd@example.com"]))

    def test_age(self):
        self.assertEqual(self.check(age=16 * 60), "zu alt")
        self.assertIsNone(self.check(age=-120))  # leicht falsch gehende Uhr


class FakeImap:
    """Minimaler Ersatz fuer imaplib.IMAP4_SSL mit Gmail-typischen Antworten."""

    def __init__(self, messages):
        self.messages = messages  # uid -> (internaldate, header-bytes)
        self.stored = []
        self.searches = []

    def select(self, mailbox):
        self.selected = mailbox
        return "OK", [str(len(self.messages)).encode()]

    def uid(self, command, *args):
        if command == "SEARCH":
            self.searches.append(args)
            return "OK", [" ".join(self.messages).encode()]
        if command == "FETCH":
            data = []
            for uid in args[0].split(","):
                date, headers = self.messages[uid]
                # Wie bei echten Servern: UID kommt hier erst nach dem Header.
                data.append((f'1 (INTERNALDATE "{date}" BODY[HEADER.FIELDS (FROM)] '
                             f'{{{len(headers)}}}'.encode(), headers))
                data.append(f" UID {uid})".encode())
            return "OK", data
        if command == "STORE":
            self.stored.append(args)
            return "OK", []
        raise AssertionError(command)


def internaldate(ts):
    return time.strftime("%d-%b-%Y %H:%M:%S +0000", time.gmtime(ts))


def headers(subject, sender="ich@gmail.com", msgid="<a@mail.gmail.com>"):
    return (f"From: {sender}\r\nSubject: {subject}\r\nMessage-ID: {msgid}\r\n\r\n").encode()


class PollTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state", "processed.json")
        self.wol_cfg = {"mac": MAC, "broadcast": "255.255.255.255", "port": 9, "source_ip": None}
        self.now = time.time()

    def tearDown(self):
        self.tmp.cleanup()

    def test_triggers_once_and_ignores_others(self):
        imap = FakeImap({
            "11": (internaldate(self.now - 30), headers("WAKE-PC", msgid="<neu@x>")),
            "12": (internaldate(self.now - 3600), headers("WAKE-PC", msgid="<alt@x>")),
            "13": (internaldate(self.now - 30), headers("WAKE-PC", "fremd@example.com", "<f@x>")),
            "14": (internaldate(self.now - 30), headers("=?utf-8?q?WAKE-PC_=C3=BC?=",
                                                        msgid="<kodiert@x>")),
        })
        with mock.patch.object(wol, "send_magic_packet") as send, \
                self.assertLogs("wake-pc", "INFO"):
            count = gmail_trigger.poll(imap, make_settings(), self.wol_cfg, self.state, self.now)
            self.assertEqual(count, 2)  # <neu@x> und der kodierte Betreff
            self.assertEqual(send.call_count, 2)
            send.assert_called_with(MAC, "255.255.255.255", 9, None)
            # Zweiter Durchlauf: alles schon verarbeitet, nichts passiert.
            count = gmail_trigger.poll(imap, make_settings(), self.wol_cfg, self.state, self.now)
            self.assertEqual(count, 0)
            self.assertEqual(send.call_count, 2)
        self.assertEqual(sorted(a[0] for a in imap.stored), ["11", "14"])
        self.assertEqual(imap.selected, '"INBOX"')
        self.assertEqual(imap.searches[0][1:], ("SINCE", gmail_trigger.imap_since_date(self.now),
                                               "SUBJECT", '"WAKE-PC"'))

    def test_send_error_does_not_stop_polling(self):
        imap = FakeImap({"11": (internaldate(self.now - 30), headers("WAKE-PC"))})
        with mock.patch.object(wol, "send_magic_packet", side_effect=OSError("Netz weg")), \
                self.assertLogs("wake-pc", "INFO") as logs:
            self.assertEqual(gmail_trigger.poll(imap, make_settings(), self.wol_cfg,
                                                self.state, self.now), 0)
        self.assertTrue(any("Netz weg" in line for line in logs.output))

    def test_confirmation_subject_does_not_retrigger(self):
        sent = []
        with mock.patch.object(gmail_trigger.smtplib, "SMTP_SSL") as smtp:
            smtp.return_value.__enter__.return_value.send_message.side_effect = sent.append
            gmail_trigger.send_confirmation(make_settings(), "ich@gmail.com",
                                            "Magic Packet gesendet\n\nDetails")
        subject = sent[0]["Subject"]
        self.assertTrue(subject.startswith("PC-Wecker:"))
        self.assertEqual(gmail_trigger.check_message(subject, "ich@gmail.com", self.now,
                                                     make_settings(), self.now),
                         "Betreff passt nicht")

    def test_since_date_is_english(self):
        self.assertEqual(gmail_trigger.imap_since_date(1_792_756_800), "22-Oct-2026")

    def test_example_config_parses(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                            "config.example.ini")
        config = wol.load_config(path)
        settings = gmail_trigger.gmail_settings(config)
        self.assertEqual(settings["subject"], "WAKE-PC")
        self.assertEqual(settings["poll_interval"], 30)
        self.assertTrue(settings["confirm"])
        problems = gmail_trigger.validate(settings, wol.wol_settings(config))
        self.assertTrue(any(p.startswith("[wol] mac") for p in problems))


if __name__ == "__main__":
    unittest.main()
