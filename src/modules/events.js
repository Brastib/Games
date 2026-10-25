'use strict';
/**
 * Events: Termin mit Beschreibung, Knöpfe „Bin dabei“ / „Absagen“, Teilnehmerliste.
 * 15 Minuten vorher werden alle Zusagen erinnert, zum Start gibt es eine Meldung. 6 Stunden danach endet es automatisch.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const store = require('../lib/store');
const { COLORS } = require('../lib/embeds');
const { truncate } = require('../lib/util');

const TZ = 'Europe/Berlin';
const REMIND_BEFORE = 15 * 60_000;
const AUTO_END = 6 * 3_600_000;

/** Versatz von Berlin zu UTC (in ms) zu einem Zeitpunkt */
function berlinOffset(utc) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(utc)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(utc / 60_000) * 60_000;
}

/**
 * Liest deutsche Zeitangaben (Berliner Zeit): „24.10. 20:00“, „24.10.2026 20:00“, „heute 20:00“, „morgen 18:30“, „20:00“.
 * @returns {number|null} Zeitstempel oder null
 */
function parseWhen(text, now = Date.now()) {
  const s = String(text || '').trim().toLowerCase();
  const time = /(\d{1,2})[:.](\d{2})\s*(?:uhr)?$/.exec(s) || /(\d{1,2})\s*uhr$/.exec(s);
  if (!time) return null;
  const hh = +time[1], mm = +(time[2] || 0);
  if (hh > 23 || mm > 59) return null;
  const today = new Date(now + berlinOffset(now)); // „Berliner“ Datum als UTC-Felder
  let y = today.getUTCFullYear(), mo = today.getUTCMonth(), d = today.getUTCDate();
  const date = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/.exec(s);
  if (date) {
    d = +date[1]; mo = +date[2] - 1;
    if (date[3]) y = +date[3] < 100 ? 2000 + +date[3] : +date[3];
  } else if (/übermorgen/.test(s)) d += 2;
  else if (/morgen/.test(s)) d += 1;
  const wall = Date.UTC(y, mo, d, hh, mm);
  let at = wall - berlinOffset(wall);
  if (date && !date[3] && at < now - 86_400_000) at = Date.UTC(y + 1, mo, d, hh, mm) - berlinOffset(Date.UTC(y + 1, mo, d, hh, mm)); // „24.01.“ im Dezember → nächstes Jahr
  return Number.isFinite(at) ? at : null;
}

const key = (guildId, id) => `${guildId}:${id}`;
const list = guildId => store.entries('events').filter(([k]) => k.startsWith(guildId + ':')).map(([, e]) => e).sort((a, b) => a.at - b.at);

function payload(e) {
  const ts = Math.floor(e.at / 1000);
  const going = e.going.length ? e.going.map(id => `<@${id}>`).join(' ') : '–';
  const embed = new EmbedBuilder().setColor(e.ended ? 0x2b2d31 : COLORS.brand)
    .setTitle(`📅 ${truncate(e.name, 200)}${e.ended ? ' (beendet)' : ''}`)
    .setDescription(e.description || null)
    .addFields(
      { name: 'Wann', value: `<t:${ts}:F> · <t:${ts}:R>` },
      { name: `✅ Dabei (${e.going.length})`, value: truncate(going, 1024) },
      { name: `❌ Abgesagt (${e.notGoing.length})`, value: String(e.notGoing.length ? e.notGoing.length : '–'), inline: true },
    )
    .setFooter({ text: `Event #${e.id} · Erinnerung 15 Min. vorher an alle Zusagen` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ev:yes:${e.id}`).setLabel('Bin dabei').setEmoji('✅').setStyle(ButtonStyle.Secondary).setDisabled(!!e.ended),
    new ButtonBuilder().setCustomId(`ev:no:${e.id}`).setLabel('Absagen').setStyle(ButtonStyle.Secondary).setDisabled(!!e.ended));
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

async function create(channel, user, { name, description, at }) {
  const meta = store.get('casemeta', `events:${channel.guild.id}`) || { next: 1 };
  const id = meta.next++;
  store.set('casemeta', `events:${channel.guild.id}`, meta);
  const e = { guildId: channel.guild.id, id, name, description: description || null, at, channelId: channel.id, messageId: null, createdBy: user.id, going: [user.id], notGoing: [], reminded: false, started: false, ended: false };
  const msg = await channel.send(payload(e));
  e.messageId = msg.id;
  store.set('events', key(e.guildId, id), e);
  return e;
}

async function refresh(guild, e) {
  const ch = guild.channels.cache.get(e.channelId);
  await ch?.messages.edit(e.messageId, payload(e)).catch(() => {});
}

async function end(guild, id) {
  const e = store.get('events', key(guild.id, id));
  if (!e) throw new Error('Event nicht gefunden.');
  e.ended = true;
  store.set('events', key(guild.id, id), e);
  await refresh(guild, e);
  return e;
}

async function onButton(i, action, id) {
  const e = store.get('events', key(i.guild.id, id));
  if (!e || e.ended) return i.reply({ content: 'Dieses Event ist vorbei.', flags: 64 });
  e.going = e.going.filter(u => u !== i.user.id);
  e.notGoing = e.notGoing.filter(u => u !== i.user.id);
  (action === 'yes' ? e.going : e.notGoing).push(i.user.id);
  store.set('events', key(e.guildId, id), e);
  return i.update(payload(e));
}

/** Aus dem Zeitplaner: Erinnerung, Start, automatisches Ende, alte Events aufräumen */
async function processTimers(client, now = Date.now()) {
  for (const [k, e] of store.entries('events')) {
    const guild = client.guilds.cache.get(e.guildId);
    if (!guild) continue;
    if (e.ended) { if (now - e.at > 30 * 86_400_000) store.delete('events', k); continue; }
    const ch = guild.channels.cache.get(e.channelId);
    if (!e.reminded && now >= e.at - REMIND_BEFORE && now < e.at) {
      e.reminded = true;
      if (e.going.length) await ch?.send({ content: `⏰ **${e.name}** startet <t:${Math.floor(e.at / 1000)}:R>! ${e.going.map(id => `<@${id}>`).join(' ')}`, allowedMentions: { users: e.going } }).catch(() => {});
    }
    if (!e.started && now >= e.at) {
      e.started = true; e.reminded = true;
      await ch?.send({ content: `🎉 **${e.name}** geht jetzt los! ${e.going.map(id => `<@${id}>`).join(' ')}`, allowedMentions: { users: e.going } }).catch(() => {});
    }
    if (now >= e.at + AUTO_END) { e.ended = true; await refresh(guild, e); }
    store.set('events', k, e);
  }
}

module.exports = { parseWhen, list, payload, create, end, onButton, processTimers };
