'use strict';
/**
 * Automatische Wochen-Posts (wie beim bisherigen ETC. Bot):
 *  - 🐱🐶 Wöchentliches Tierfoto: zufälliger Hund/Katze aus freien Bilder-Diensten
 *    oder ein zufälliges Foto aus einem eigenen Sammel-Kanal (z. B. #haustiere, mit Nennung, wer es gepostet hat)
 *  - 🏆 Bestenliste als Bild
 * Zeitpunkt: Wochentag + Uhrzeit (deutsche Zeit). Verpasste Posts (Neustart) werden am selben Tag nachgeholt.
 */
const { AttachmentBuilder } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');

const TZ = process.env.TZ || 'Europe/Berlin';
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const SOURCES = { mixed: 'Hunde & Katzen', dogs: 'Hunde', cats: 'Katzen', pool: 'Eigener Sammel-Kanal' };

/** Aktuelle deutsche Zeit: { weekday, minutes, day } */
function nowParts(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    day: `${p.year}-${p.month}-${p.day}`,
  };
}
function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
const dayNumber = day => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** everyDays 7 = wöchentlich am Wochentag; sonst alle N Tage (1 = täglich) ab dem letzten Post */
function isDue(p, now = nowParts()) {
  if (!p.enabled || !p.channel || p.lastRun === now.day || now.minutes < timeToMinutes(p.time)) return false;
  const every = Number(p.everyDays) || 7;
  if (every === 7) return now.weekday === Number(p.weekday);
  return !p.lastRun || dayNumber(now.day) - dayNumber(p.lastRun) >= every;
}

async function download(url, maxBytes = 8 * 1024 * 1024) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Bild nicht ladbar (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('Bild zu groß');
  const type = res.headers.get('content-type') || '';
  const ext = /png/.test(type) ? 'png' : /gif/.test(type) ? 'gif' : /webp/.test(type) ? 'webp' : 'jpg';
  return { buf, ext };
}

async function apiAnimal(kind) {
  if (kind === 'cats') {
    const d = await (await fetch('https://api.thecatapi.com/v1/images/search', { signal: AbortSignal.timeout(10000) })).json();
    return d[0].url;
  }
  const d = await (await fetch('https://dog.ceo/api/breeds/image/random', { signal: AbortSignal.timeout(10000) })).json();
  return d.message;
}

/** Zufälliges, noch nicht gepostetes Foto aus dem Sammel-Kanal */
async function poolAnimal(guild, p) {
  const ch = guild.channels.cache.get(p.poolChannel);
  if (!ch?.isTextBased()) throw new Error('Sammel-Kanal nicht gefunden');
  const found = [];
  let before;
  for (let i = 0; i < 5; i++) {
    const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    for (const m of batch.values()) {
      if (m.author.bot) continue;
      for (const a of m.attachments.values()) if ((a.contentType || '').startsWith('image/')) found.push({ url: a.url, author: m.author.id, id: a.id, link: m.url });
    }
    before = batch.last().id;
  }
  if (!found.length) throw new Error('Im Sammel-Kanal sind noch keine Fotos');
  let fresh = found.filter(f => !(p.used || []).includes(f.id));
  if (!fresh.length) { p.used = []; fresh = found; }
  return fresh[Math.floor(Math.random() * fresh.length)];
}

async function postAnimal(guild, channel) {
  const p = getConfig(guild.id).posts.animal;
  let url, credit = '';
  if (p.source === 'pool' && p.poolChannel) {
    const pick = await poolAnimal(guild, p);
    url = pick.url;
    credit = `\n📷 Foto von <@${pick.author}>`;
    p.used = [...(p.used || []), pick.id].slice(-200);
  } else {
    const kind = p.source === 'mixed' || !p.source || p.source === 'pool' ? (Math.random() < 0.5 ? 'dogs' : 'cats') : p.source;
    url = await apiAnimal(kind);
  }
  const { buf, ext } = await download(url);
  await channel.send({
    content: `${p.text || '🐱🐶 **Hier ist dein wöchentliches Tierfoto!**'}${credit}`,
    files: [new AttachmentBuilder(buf, { name: `tierfoto.${ext}` })],
    allowedMentions: { parse: [] },
  });
  saveConfig(guild.id);
}

async function postLeaderboard(guild, channel) {
  const p = getConfig(guild.id).posts.leaderboard;
  const png = await require('./leveling').leaderboardImage(guild);
  if (!png) throw new Error('Noch niemand hat XP gesammelt.');
  await channel.send({ content: p.text || '🏆 **Die aktuelle Bestenliste!**', files: [new AttachmentBuilder(png, { name: 'bestenliste.png' })], allowedMentions: { parse: [] } });
}

async function runNow(guild, type, channelOverride = null) {
  const p = getConfig(guild.id).posts[type];
  const channel = channelOverride || guild.channels.cache.get(p.channel);
  if (!channel?.isTextBased()) throw new Error('Kein Kanal eingestellt.');
  if (type === 'animal') await postAnimal(guild, channel);
  else await postLeaderboard(guild, channel);
  return channel;
}

/** Wird jede 20 Sekunden vom Zeitplaner aufgerufen */
async function check(client) {
  const now = nowParts();
  for (const guild of client.guilds.cache.values()) {
    const cfg = getConfig(guild.id);
    for (const type of ['animal', 'leaderboard']) {
      const p = cfg.posts[type];
      if (!isDue(p, now)) continue;
      p.lastRun = now.day;
      saveConfig(guild.id);
      try { await runNow(guild, type); } catch (e) { console.warn(`[autopost:${type}] ${guild.name}: ${e.message}`); }
    }
  }
}

module.exports = { WEEKDAYS, SOURCES, nowParts, timeToMinutes, isDue, check, runNow, postAnimal, postLeaderboard };
