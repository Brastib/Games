'use strict';
/**
 * Level-System.
 *  - Formel 'etc' (Standard, wie der bisherige ETC. Bot): Level L braucht insgesamt 100·L² XP
 *    → Level 11 ab 12.100 XP, Level 29 ab 84.100 XP, nächstes Level (30) bei 90.000 XP.
 *  - Formel 'mee6': pro Level 5·L² + 50·L + 100 XP.
 * XP: 15–25 pro Nachricht (höchstens einmal pro Minute), Sprachzeit, Clips, Quests.
 */
const { AttachmentBuilder, EmbedBuilder, GatewayIntentBits } = require('discord.js');
const platforms = require('../lib/platforms');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const { fillTemplate, randomInt, progressBar } = require('../lib/util');
const cards = require('../lib/cards');

const key = (g, u) => `${g}:${u}`;
const mee6Step = l => 5 * l * l + 50 * l + 100;

const CURVES = {
  etc: {
    label: 'ETC. (100 × Level²)',
    total: l => 100 * l * l,
    level: xp => Math.floor(Math.sqrt(Math.max(0, xp) / 100)),
  },
  mee6: {
    label: 'MEE6',
    total: l => { let x = 0; for (let i = 0; i < l; i++) x += mee6Step(i); return x; },
    level: xp => { let l = 0, rest = Math.max(0, xp); while (rest >= mee6Step(l)) { rest -= mee6Step(l); l++; } return l; },
  },
};

function curve(guildId) {
  return CURVES[guildId && getConfig(guildId).levels.formula] || CURVES.etc;
}

/** Level aus Gesamt-XP. xpIn/xpNeed = Fortschritt im aktuellen Level, nextTotal = Gesamt-XP fürs nächste Level */
function levelFromXp(xp, guildId) {
  const c = curve(guildId);
  let level = c.level(xp);
  while (c.total(level + 1) <= xp) level++;
  while (level > 0 && c.total(level) > xp) level--;
  const start = c.total(level), nextTotal = c.total(level + 1);
  return { level, xpIn: xp - start, xpNeed: nextTotal - start, nextTotal };
}
function xpForLevel(level, guildId) { return curve(guildId).total(level); }

function getData(guildId, userId) {
  return store.get('levels', key(guildId, userId)) || { xp: 0, msgs: 0, last: 0 };
}

function leaderboard(guildId, by = 'xp') {
  return store.entries('levels')
    .filter(([k]) => k.startsWith(guildId + ':'))
    .map(([k, v]) => ({ userId: k.split(':')[1], xp: v.xp || 0, msgs: v.msgs || 0, voiceMin: v.voiceMin || 0, clips: v.clips || 0 }))
    .sort((a, b) => (b[by] || 0) - (a[by] || 0));
}

function rankOf(guildId, userId) {
  const i = leaderboard(guildId).findIndex(e => e.userId === userId);
  return i < 0 ? null : i + 1;
}

async function applyRewards(member, level) {
  const cfg = getConfig(member.guild.id).levels;
  const entries = Object.entries(cfg.rewards).map(([l, r]) => [Number(l), r]).sort((a, b) => a[0] - b[0]);
  const earned = entries.filter(([l]) => l <= level);
  if (!earned.length) return [];
  const give = cfg.stackRewards ? earned.map(e => e[1]) : [earned[earned.length - 1][1]];
  const remove = cfg.stackRewards ? [] : earned.slice(0, -1).map(e => e[1]);
  const added = [];
  for (const r of give) {
    const role = member.guild.roles.cache.get(r);
    if (role?.editable && !member.roles.cache.has(r)) { await member.roles.add(role, `Level ${level} erreicht`).catch(() => {}); added.push(role); }
  }
  for (const r of remove) if (member.roles.cache.has(r)) await member.roles.remove(r, 'Höhere Level-Rolle erhalten').catch(() => {});
  return added;
}

/** Level-Up-Nachricht wie beim bisherigen ETC. Bot */
function levelUpPayload(member, level, roles = []) {
  const cfg = getConfig(member.guild.id).levels;
  const text = fillTemplate(cfg.message, { member, extra: { level: String(level) } }) +
    (roles.length ? `\nNeue Rolle: ${roles.map(r => `<@&${r.id}>`).join(', ')}` : '');
  if (cfg.style === 'text') return { content: text, allowedMentions: { users: [member.id] } };
  const { nextTotal } = levelFromXp(xpForLevel(level, member.guild.id), member.guild.id);
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('⬆️ Level Up!')
      .setDescription(text)
      .addFields({ name: 'XP für nächstes Level', value: String(nextTotal) })
      .setThumbnail(member.displayAvatarURL({ size: 256 }))
      .setTimestamp()],
    allowedMentions: { parse: [] },
  };
}

/**
 * XP gutschreiben (Nachrichten, Sprachzeit, Clips, Quests …) und Level-Aufstieg verkünden.
 * @param {{ channel?: any, stat?: string, statAmount?: number, ignoreMultiplier?: boolean, silent?: boolean }} opts
 */
/** Extra-XP für Mitglieder, die den Server-Tag genau dieses Servers sichtbar tragen */
function tagBoost(member, cfg) {
  const t = cfg.tagBoost, pg = member.user?.primaryGuild;
  return t?.enabled && pg?.identityEnabled && pg.identityGuildId === member.guild.id ? 1 + (t.percent || 0) / 100 : 1;
}

async function addXp(member, amount, opts = {}) {
  if (!member?.guild || member.user.bot) return null;
  const cfg = getConfig(member.guild.id).levels;
  if (!cfg.enabled) return null;
  const k = key(member.guild.id, member.id);
  const d = getData(member.guild.id, member.id);
  if (opts.stat) d[opts.stat] = (d[opts.stat] || 0) + (opts.statAmount ?? 1);
  const before = levelFromXp(d.xp, member.guild.id).level;
  d.xp = Math.max(0, d.xp + Math.round(amount * (opts.ignoreMultiplier ? 1 : (cfg.multiplier || 1) * tagBoost(member, cfg))));
  store.set('levels', k, d);
  const after = levelFromXp(d.xp, member.guild.id).level;
  if (after > before && !opts.silent && !getConfig(member.guild.id).quiet) {
    const roles = await applyRewards(member, after);
    const target = member.guild.channels.cache.get(cfg.channel) || opts.channel;
    if (target?.isTextBased?.()) await target.send(levelUpPayload(member, after, roles)).catch(() => {});
  }
  return { level: after, xp: d.xp, levelUp: after > before };
}

async function onMessage(message) {
  if (!message.guild || message.author.bot || !message.member) return;
  const cfg = getConfig(message.guild.id).levels;
  if (!cfg.enabled) return;
  if (cfg.noXpChannels.includes(message.channel.id) || cfg.noXpChannels.includes(message.channel.parentId)) return;
  if (message.member.roles.cache.some(r => cfg.noXpRoles.includes(r.id))) return;
  const d = getData(message.guild.id, message.author.id);
  const now = Date.now();
  if (now - (d.last || 0) < 60_000) {
    d.msgs = (d.msgs || 0) + 1;
    store.set('levels', key(message.guild.id, message.author.id), d);
    return;
  }
  d.last = now;
  store.set('levels', key(message.guild.id, message.author.id), d);
  const { min = 15, max = 25 } = cfg.msgXp || {};
  await addXp(message.member, randomInt(Math.min(min, max), Math.max(min, max)), { channel: message.channel, stat: 'msgs' });
}

/** Jede Minute: XP für Zeit im Sprachkanal (nicht allein, nicht taub, nicht im AFK-Kanal). */
async function voiceTick(client) {
  for (const guild of client.guilds.cache.values()) {
    const cfg = getConfig(guild.id);
    const v = cfg.levels.voice;
    for (const ch of guild.channels.cache.values()) {
      if (!ch.isVoiceBased() || ch.id === guild.afkChannelId) continue;
      const humans = ch.members.filter(m => !m.user.bot);
      if (humans.size < (v?.minMembers || 2)) continue;
      for (const m of humans.values()) {
        if (m.voice.selfDeaf || m.voice.serverDeaf) continue;
        const rate = v?.psPerMinute && platforms.onPlayStation(m.id) ? v.psPerMinute : v?.perMinute || 8;
        if (cfg.levels.enabled && v?.enabled) await addXp(m, rate, { channel: ch, stat: 'voiceMin' });
        require('./quests').progress(m, 'voice', 1, ch);
      }
    }
  }
}

async function setXp(member, xp) {
  const d = getData(member.guild.id, member.id);
  d.xp = Math.max(0, Math.round(xp));
  store.set('levels', key(member.guild.id, member.id), d);
  const lvl = levelFromXp(d.xp, member.guild.id).level;
  await applyRewards(member, lvl);
  return lvl;
}

async function rankPayload(member) {
  const d = getData(member.guild.id, member.id);
  const { level, xpIn, xpNeed } = levelFromXp(d.xp, member.guild.id);
  const rank = rankOf(member.guild.id, member.id) || '–';
  const png = await cards.rankCard(member, { level, xpIn, xpNeed, rank, totalXp: d.xp }).catch(() => null);
  if (png) return { files: [new AttachmentBuilder(png, { name: 'rang.png' })] };
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL() })
      .setDescription(`**Rang:** #${rank} · **Level:** ${level}\n${progressBar(xpIn, xpNeed)} ${xpIn}/${xpNeed} XP\n**Gesamt:** ${d.xp} XP · **Nachrichten:** ${d.msgs || 0}`)],
  };
}

/** Bestenliste als Bild (Top 10) – wie beim bisherigen ETC. Bot */
async function leaderboardImage(guild, limit = 10) {
  const top = leaderboard(guild.id).filter(e => e.xp > 0).slice(0, limit);
  if (!top.length) return null;
  const entries = await Promise.all(top.map(async e => {
    const m = guild.members.cache.get(e.userId) || await guild.members.fetch(e.userId).catch(() => null);
    const u = m?.user || await guild.client.users.fetch(e.userId).catch(() => null);
    return {
      name: m?.displayName || u?.globalName || u?.username || 'Unbekannt',
      avatar: (m || u)?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null,
      level: levelFromXp(e.xp, guild.id).level, xp: e.xp,
    };
  }));
  return cards.leaderboardCard(entries, { title: 'ETC.', subtitle: 'BESTENLISTE' });
}

// ---------------- Import (bisherige XP übernehmen) ----------------
/**
 * Liest eine Liste mit XP ein. Erlaubt:
 *  - JSON: {"<id>": 12345}, [{"id": "...", "xp": 123}], {"players": [{"id","xp","level"}]} (z. B. MEE6-Export)
 *  - CSV/TXT: id,xp  oder  name,xp  oder  id;level  (Trennzeichen , ; Tab; Kopfzeile optional; 114.451 = 114451)
 * Ohne ID wird der Name mit den Mitgliedern des Servers abgeglichen.
 */
function parseImport(text) {
  const rows = [];
  const push = (who, xp, level) => rows.push({ who: String(who ?? '').trim(), xp: xp == null ? null : Number(String(xp).replace(/[.\s]/g, '').replace(',', '.')), level: level == null ? null : Number(level) });
  const trimmed = text.trim().replace(/^﻿/, '');
  if (/^[[{]/.test(trimmed)) {
    const d = JSON.parse(trimmed);
    const list = Array.isArray(d) ? d : (d.players || d.users || d.leaderboard || d.levels || null);
    if (list) for (const e of list) push(e.id ?? e.userId ?? e.user_id ?? e.discordId ?? e.name ?? e.username, e.xp ?? e.totalXp ?? e.total_xp ?? e.experience ?? e.XP, e.level);
    else for (const [k, v] of Object.entries(d)) push(k, typeof v === 'object' ? (v.xp ?? v.totalXp) : v, typeof v === 'object' ? v.level : null);
    return rows;
  }
  let levelColumn = false; // Kopfzeile „Name;Level“ → alle Zahlen darunter sind Level, keine XP
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/[;,\t|]/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    if (/^(id|user|name|nutzer|mitglied)/i.test(parts[0]) && /xp|level|punkte/i.test(parts[1])) { levelColumn = /level/i.test(parts[1]) && !/xp/i.test(parts[1]); continue; }
    const val = parts[1];
    if (levelColumn || (/level/i.test(line) && !/xp/i.test(line))) push(parts[0], null, parseInt(val.replace(/\D/g, ''), 10));
    else push(parts[0], val, parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : null);
  }
  return rows;
}

async function importXp(guild, text, { mode = 'set' } = {}) {
  const rows = parseImport(text);
  if (guild.client.options.intents.has(GatewayIntentBits.GuildMembers)) await guild.members.fetch().catch(() => {});
  const byName = new Map();
  for (const m of guild.members.cache.values()) {
    for (const n of [m.user.username, m.user.globalName, m.displayName, m.nickname]) if (n) byName.set(n.toLowerCase(), m.id);
  }
  let imported = 0;
  const missing = [];
  for (const r of rows) {
    const id = /^\d{17,20}$/.test(r.who) ? r.who : byName.get(r.who.toLowerCase());
    let xp = Number.isFinite(r.xp) ? r.xp : (Number.isFinite(r.level) ? xpForLevel(r.level, guild.id) : null);
    if (!id || xp == null || xp < 0) { missing.push(r.who || '?'); continue; }
    const d = getData(guild.id, id);
    d.xp = Math.round(mode === 'add' ? (d.xp || 0) + xp : xp);
    store.set('levels', key(guild.id, id), d);
    imported++;
  }
  return { imported, missing, total: rows.length };
}

module.exports = {
  CURVES, curve, tagBoost, levelFromXp, xpForLevel, getData, leaderboard, rankOf, onMessage, addXp, voiceTick, setXp,
  rankPayload, applyRewards, levelUpPayload, leaderboardImage, parseImport, importXp,
};
