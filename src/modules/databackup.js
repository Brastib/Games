'use strict';
/**
 * 💾 Datensicherung: alle Bot-Daten (XP, Stamm-Mitglieder, Einstellungen, Tickets, Münzen, Rückblick …) als eine Datei.
 *  - Jeden Tag ab DATENSICHERUNG_ZEIT (Standard 04:00, deutsche Zeit) – nach einem Neustart wird ein verpasster Tag nachgeholt.
 *  - Die Datei geht per DM an den Bot-Besitzer (Schutz, falls der Laptop kaputtgeht)
 *    und liegt zusätzlich im Ordner <DATA_DIR>/datensicherungen (die letzten 14 Tage, Schutz gegen Fehlbedienung).
 *  - Einspielen mit /datensicherung einspielen (nur Bot-Besitzer, mit Bestätigung) – danach startet der Bot neu.
 * Nicht enthalten: Dashboard-Anmeldungen (geheim und nach dem Einspielen ohnehin ungültig).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('../lib/store');

const FORMAT = 'etc-bot-datensicherung';
const EXCLUDE = new Set(['sessions']);
const KEEP_LOCAL = 14;
const MAX_DM = 9.5 * 1024 * 1024; // Discord erlaubt Bots 10 MB pro Datei
const DIR = () => path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'datensicherungen');
const pending = new Map(); // userId -> { data, at }

function snapshot() {
  const data = {};
  for (const [name, map] of store.cols) if (!EXCLUDE.has(name)) data[name] = Object.fromEntries(map);
  return { format: FORMAT, version: 1, createdAt: new Date().toISOString(), botVersion: require('../lib/version'), data };
}

const pack = (snap = snapshot()) => zlib.gzipSync(Buffer.from(JSON.stringify(snap)));

function unpack(buf) {
  let text;
  try { text = zlib.gunzipSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('Die Datei ist beschädigt oder keine Datensicherung.'); }
  if (d?.format !== FORMAT || !d.data || typeof d.data !== 'object') throw new Error('Das ist keine Datensicherung vom ETC. Bot.');
  return d;
}

/** Kurzbeschreibung für DM und Bestätigung */
function summary(snap) {
  const n = name => Object.keys(snap.data[name] || {}).length;
  return `${n('levels')} Personen mit XP · ${n('stammmitglieder')} Stamm-Mitglieder · ${n('guilds')} Server-Einstellungen · ${Object.keys(snap.data).length} Bereiche`;
}

const fileName = (snap, tag = '') => `etc-bot-datensicherung-${snap.createdAt.slice(0, 10)}${tag}.json.gz`;

function saveLocal(buf, name) {
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_LOCAL))) fs.rmSync(path.join(dir, f), { force: true });
  return path.join(dir, name);
}

async function owners(client) {
  const app = await client.application?.fetch().catch(() => client.application);
  const ids = app?.owner?.members ? [...app.owner.members.keys()] : app?.owner ? [app.owner.id] : [];
  return [...new Set([...ids, ...(process.env.OWNER_IDS || '').split(/[\s,]+/).filter(Boolean)])];
}

/** Sicherung erstellen, lokal ablegen und per DM schicken. Gibt { file, size, sent } zurück. */
async function run(client, { reason = 'Tägliche Datensicherung', to = null } = {}) {
  await store.flush().catch(() => {});
  const snap = snapshot();
  const buf = pack(snap);
  const local = saveLocal(buf, fileName(snap));
  store.set('meta', 'lastDataBackup', { at: Date.now(), day: require('./autoposts').nowParts().day, size: buf.length });
  let sent = 0;
  if (buf.length > MAX_DM) {
    console.warn(`[datensicherung] ${Math.round(buf.length / 1024)} KB – zu groß für Discord, nur lokal gespeichert: ${local}`);
  } else {
    for (const id of to ? [to] : await owners(client)) {
      const user = await client.users.fetch(id).catch(() => null);
      const ok = await user?.send({
        content: `💾 **${reason}** · ${summary(snap)}\n-# Datei gut aufheben und nicht weitergeben (enthält alle Einstellungen). Wiederherstellen: \`/datensicherung einspielen\`.`,
        files: [new AttachmentBuilder(buf, { name: fileName(snap) })],
      }).then(() => true).catch(e => { console.warn(`[datensicherung] DM an ${id} ging nicht: ${e.message}`); return false; });
      if (ok) sent++;
    }
  }
  console.log(`[datensicherung] ${Math.round(buf.length / 1024)} KB · ${summary(snap)} · per DM an ${sent} Person(en) · lokal: ${local}`);
  return { file: local, size: buf.length, sent, summary: summary(snap) };
}

/** Alle 10 Minuten: fällig, wenn heute noch keine Sicherung lief und die Uhrzeit erreicht ist */
async function check(client) {
  const ap = require('./autoposts');
  const now = ap.nowParts();
  if (store.get('meta', 'lastDataBackup')?.day === now.day) return;
  if (now.minutes < ap.timeToMinutes(process.env.DATENSICHERUNG_ZEIT || '04:00')) return;
  await run(client);
}

function start(client) {
  const tick = () => check(client).catch(e => console.error('[datensicherung]', e));
  setTimeout(tick, 2 * 60_000).unref(); // nach dem Start kurz warten, bis alles geladen ist
  setInterval(tick, 10 * 60_000).unref();
}

// ---------- Einspielen ----------

/** Schritt 1: Datei prüfen und Bestätigung zeigen */
async function prepare(userId, attachment) {
  if (attachment.size > 50 * 1024 * 1024) throw new Error('Die Datei ist zu groß.');
  const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Datei nicht ladbar (HTTP ${res.status})`);
  const snap = unpack(Buffer.from(await res.arrayBuffer()));
  pending.set(userId, { snap, at: Date.now() });
  return {
    content: `⚠️ **Datensicherung vom ${new Date(snap.createdAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} einspielen?**\n${summary(snap)}\n\nDer jetzige Stand wird **ersetzt** (vorher lege ich automatisch eine Sicherung auf dem Laptop an). Danach starte ich neu – ca. 10 Sekunden.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('db:go').setLabel('Einspielen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('db:cancel').setLabel('Abbrechen').setStyle(ButtonStyle.Secondary),
    )],
  };
}

/** Bereiche aus der Sicherung übernehmen (andere bleiben, z. B. neuere Funktionen) */
function apply(snap, client) {
  for (const [name, obj] of Object.entries(snap.data)) {
    if (EXCLUDE.has(name) || !obj || typeof obj !== 'object') continue;
    for (const k of store.entries(name).map(([key]) => key)) if (!(k in obj)) store.delete(name, k);
    for (const [k, v] of Object.entries(obj)) store.set(name, k, v);
  }
  const { reloadConfig } = require('../lib/config');
  for (const id of client?.guilds?.cache.keys() || []) reloadConfig(id);
}

/** Schritt 2: Knopf */
async function handleButton(i, action) {
  if (!(await require('./migrate').isBotOwner(i.user, i.client))) return i.reply({ content: 'Das darf nur der Bot-Besitzer.', flags: 64 });
  const p = pending.get(i.user.id);
  pending.delete(i.user.id);
  if (action === 'cancel') return i.update({ content: 'Abgebrochen – nichts geändert.', components: [] });
  if (!p || Date.now() - p.at > 15 * 60_000) return i.update({ content: 'Zu lange gewartet – bitte `/datensicherung einspielen` nochmal.', components: [] });
  await i.update({ content: '⏳ Spiele ein …', components: [] });
  await store.flush().catch(() => {});
  const before = snapshot();
  saveLocal(pack(before), fileName(before, '-vor-einspielen'));
  apply(p.snap, i.client);
  await store.flush();
  await i.editReply({ content: `✅ **Eingespielt:** ${summary(p.snap)}\nStarte neu – in ca. 10 Sekunden wieder da. Der alte Stand liegt als Sicherung auf dem Laptop.` });
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1500); // sauber neu starten (systemd startet wieder)
}

module.exports = { snapshot, pack, unpack, summary, saveLocal, run, check, start, prepare, apply, handleButton, DIR };
