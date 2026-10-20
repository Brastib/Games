'use strict';

const UNIT_MS = {
  s: 1000, sek: 1000, sec: 1000, sekunde: 1000, sekunden: 1000,
  m: 60_000, min: 60_000, minute: 60_000, minuten: 60_000,
  h: 3_600_000, std: 3_600_000, stunde: 3_600_000, stunden: 3_600_000,
  d: 86_400_000, t: 86_400_000, tag: 86_400_000, tage: 86_400_000,
  w: 604_800_000, wo: 604_800_000, woche: 604_800_000, wochen: 604_800_000,
};

/**
 * Wandelt "10m", "1h30m", "2 tage", "45" (= Minuten) in Millisekunden um.
 * Gibt null zurück, wenn nichts erkannt wurde.
 */
function parseDuration(input) {
  if (input == null) return null;
  const str = String(input).trim().toLowerCase().replace(',', '.');
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 60_000);
  const re = /(\d+(?:\.\d+)?)\s*([a-zäöü]+)/g;
  let total = 0;
  let matched = '';
  let m;
  while ((m = re.exec(str)) !== null) {
    const unit = UNIT_MS[m[2]];
    if (!unit) return null;
    total += parseFloat(m[1]) * unit;
    matched += m[0];
  }
  if (!total || matched.replace(/\s/g, '') !== str.replace(/\s/g, '')) return null;
  return Math.round(total);
}

function formatDuration(ms) {
  if (ms == null) return 'dauerhaft';
  let s = Math.max(0, Math.round(ms / 1000));
  const parts = [];
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) parts.push(`${d} ${d === 1 ? 'Tag' : 'Tage'}`);
  if (h) parts.push(`${h} Std.`);
  if (m) parts.push(`${m} Min.`);
  if (s && !d && !h) parts.push(`${s} Sek.`);
  return parts.join(' ') || '0 Sek.';
}

/** Discord-Zeitstempel, z. B. <t:1700000000:R> */
function ts(dateOrMs, style = 'R') {
  const ms = typeof dateOrMs === 'number' ? dateOrMs : new Date(dateOrMs).getTime();
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function truncate(str, max) {
  if (!str) return '';
  str = String(str);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** Platzhalter in Willkommens-/Level-Texten ersetzen. */
function fillTemplate(tpl, { member, user, guild, extra = {} } = {}) {
  const u = user || member?.user;
  const g = guild || member?.guild;
  const map = {
    user: u ? `<@${u.id}>` : '',
    mention: u ? `<@${u.id}>` : '',
    username: u ? u.username : '',
    name: member?.displayName || u?.globalName || u?.username || '',
    server: g ? g.name : '',
    count: g ? String(g.memberCount) : '',
    ...extra,
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (all, key) => (key in map ? map[key] : all));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function progressBar(value, max, len = 14) {
  const f = max > 0 ? Math.round((value / max) * len) : 0;
  return '█'.repeat(Math.min(len, f)) + '░'.repeat(Math.max(0, len - f));
}

/** Hex-Farbe "#ff0000" / "ff0000" → Zahl, sonst null */
function parseColor(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : null;
}

function escapeMd(s) {
  return String(s || '').replace(/([\\*_`~|>])/g, '\\$1');
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  parseDuration, formatDuration, ts, truncate, fillTemplate, chunk, sleep,
  progressBar, parseColor, escapeMd, randomInt,
};
