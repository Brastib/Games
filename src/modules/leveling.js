'use strict';
/**
 * Level-System (wie MEE6): 15–25 XP pro Nachricht, höchstens einmal pro Minute.
 * XP für nächstes Level: 5·L² + 50·L + 100. Rollen-Belohnungen pro Level.
 */
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const { fillTemplate, randomInt, progressBar } = require('../lib/util');
const cards = require('../lib/cards');

const needFor = level => 5 * level * level + 50 * level + 100;
const key = (g, u) => `${g}:${u}`;

function levelFromXp(xp) {
  let level = 0;
  let rest = xp;
  while (rest >= needFor(level)) { rest -= needFor(level); level++; }
  return { level, xpIn: rest, xpNeed: needFor(level) };
}
function xpForLevel(level) {
  let xp = 0;
  for (let l = 0; l < level; l++) xp += needFor(l);
  return xp;
}

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

/**
 * XP gutschreiben (Nachrichten, Sprachzeit, Clips, Quests …) und Level-Aufstieg verkünden.
 * @param {import('discord.js').GuildMember} member
 * @param {number} amount
 * @param {{ channel?: any, stat?: string, statAmount?: number, ignoreMultiplier?: boolean }} opts
 */
async function addXp(member, amount, opts = {}) {
  if (!member?.guild || member.user.bot) return null;
  const cfg = getConfig(member.guild.id).levels;
  if (!cfg.enabled) return null;
  const k = key(member.guild.id, member.id);
  const d = getData(member.guild.id, member.id);
  if (opts.stat) d[opts.stat] = (d[opts.stat] || 0) + (opts.statAmount ?? 1);
  const before = levelFromXp(d.xp).level;
  d.xp = Math.max(0, d.xp + Math.round(amount * (opts.ignoreMultiplier ? 1 : (cfg.multiplier || 1))));
  store.set('levels', k, d);
  const after = levelFromXp(d.xp).level;
  if (after > before) {
    const roles = await applyRewards(member, after);
    const text = fillTemplate(cfg.message, { member, extra: { level: String(after) } }) +
      (roles.length ? `\nNeue Rolle: ${roles.map(r => `<@&${r.id}>`).join(', ')}` : '');
    const target = member.guild.channels.cache.get(cfg.channel) || opts.channel;
    if (target?.isTextBased?.()) await target.send({ content: text, allowedMentions: { users: [member.id] } }).catch(() => {});
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
  await addXp(message.member, randomInt(15, 25), { channel: message.channel, stat: 'msgs' });
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
        if (cfg.levels.enabled && v?.enabled) await addXp(m, v.perMinute || 8, { channel: ch, stat: 'voiceMin' });
        require('./quests').progress(m, 'voice', 1, ch);
      }
    }
  }
}

async function setXp(member, xp) {
  const d = getData(member.guild.id, member.id);
  d.xp = Math.max(0, Math.round(xp));
  store.set('levels', key(member.guild.id, member.id), d);
  const lvl = levelFromXp(d.xp).level;
  await applyRewards(member, lvl);
  return lvl;
}

async function rankPayload(member) {
  const d = getData(member.guild.id, member.id);
  const { level, xpIn, xpNeed } = levelFromXp(d.xp);
  const rank = rankOf(member.guild.id, member.id) || '–';
  const png = await cards.rankCard(member, { level, xpIn, xpNeed, rank, totalXp: d.xp }).catch(() => null);
  if (png) return { files: [new AttachmentBuilder(png, { name: 'rang.png' })] };
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL() })
      .setDescription(`**Rang:** #${rank} · **Level:** ${level}\n${progressBar(xpIn, xpNeed)} ${xpIn}/${xpNeed} XP\n**Gesamt:** ${d.xp} XP · **Nachrichten:** ${d.msgs || 0}`)],
  };
}

module.exports = { needFor, levelFromXp, xpForLevel, getData, leaderboard, rankOf, onMessage, addXp, voiceTick, setXp, rankPayload, applyRewards };
