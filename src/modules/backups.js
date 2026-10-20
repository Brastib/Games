'use strict';
/**
 * Backups pro Server: täglich automatisch, „Jetzt sichern“, Herunterladen als JSON, Wiederherstellen.
 * Vor jeder Wiederherstellung wird automatisch eine Sicherung des aktuellen Stands angelegt.
 * Gesichert werden die dauerhaften Daten (Einstellungen, Level, Münzen, Verwarnungen, Fälle, Quests, Profile, Panels …),
 * nicht die gerade offenen Temp-Kanäle und Tickets.
 */
const store = require('../lib/store');
const { getConfig, reloadConfig } = require('../lib/config');

const DURABLE = ['guilds', 'levels', 'economy', 'warns', 'cases', 'casemeta', 'quests', 'tvprefs', 'rolepanels', 'suggestions', 'reminders', 'giveaways', 'tempbans'];
const belongs = (guildId, k, v) => k === guildId || k.startsWith(guildId + ':') || v?.guildId === guildId;
const dayKey = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
// Echte Kopie: Der Speicher hält dieselben Objekte, die der Bot laufend verändert
const clone = v => JSON.parse(JSON.stringify(v));

function collect(guildId) {
  const data = {};
  for (const col of DURABLE) {
    for (const [k, v] of store.entries(col)) if (belongs(guildId, k, v)) (data[col] ||= {})[k] = v;
  }
  return data;
}

function list(guildId) {
  return store.entries('backups').filter(([k]) => k.startsWith(guildId + ':'))
    .map(([, b]) => ({ id: b.at, at: b.at, reason: b.reason, size: b.size, counts: Object.fromEntries(Object.entries(b.data).map(([c, o]) => [c, Object.keys(o).length])) }))
    .sort((a, b) => b.at - a.at);
}

function create(guildId, reason = 'manuell') {
  const at = Date.now();
  const data = clone(collect(guildId));
  const size = Buffer.byteLength(JSON.stringify(data));
  store.set('backups', `${guildId}:${at}`, { guildId, at, reason, size, data });
  const keep = Math.max(1, getConfig(guildId).backups.keep || 7);
  for (const old of list(guildId).filter(b => b.reason !== 'vor Wiederherstellung').slice(keep)) store.delete('backups', `${guildId}:${old.at}`);
  for (const old of list(guildId).filter(b => b.reason === 'vor Wiederherstellung').slice(3)) store.delete('backups', `${guildId}:${old.at}`);
  return { id: at, size };
}

function get(guildId, id) { return store.get('backups', `${guildId}:${Number(id)}`) || null; }

function restore(guildId, id) {
  const snap = get(guildId, id);
  if (!snap) throw new Error('Sicherung nicht gefunden.');
  create(guildId, 'vor Wiederherstellung');
  for (const col of DURABLE) {
    for (const [k, v] of store.entries(col)) if (belongs(guildId, k, v)) store.delete(col, k);
    for (const [k, v] of Object.entries(snap.data[col] || {})) store.set(col, k, clone(v));
  }
  reloadConfig(guildId);
  return { restored: Object.values(snap.data).reduce((n, o) => n + Object.keys(o).length, 0) };
}

/** Einmal am Tag pro Server (aus dem Zeitplaner) */
function daily(client) {
  const today = dayKey(Date.now());
  for (const g of client.guilds.cache.values()) {
    if (!getConfig(g.id).backups.enabled) continue;
    const last = list(g.id).find(b => b.reason === 'täglich');
    if (!last || dayKey(last.at) !== today) create(g.id, 'täglich');
  }
}

module.exports = { DURABLE, collect, list, create, get, restore, daily };
