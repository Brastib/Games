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

function leaderboard(guildId) {
  return store.entries('levels')
    .filter(([k]) => k.startsWith(guildId + ':'))
    .map(([k, v]) => ({ userId: k.split(':')[1], xp: v.xp, msgs: v.msgs }))
    .sort((a, b) => b.xp - a.xp);
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

async function onMessage(message) {
  if (!message.guild || message.author.bot || !message.member) return;
  const cfg = getConfig(message.guild.id).levels;
  if (!cfg.enabled) return;
  if (cfg.noXpChannels.includes(message.channel.id) || cfg.noXpChannels.includes(message.channel.parentId)) return;
  if (message.member.roles.cache.some(r => cfg.noXpRoles.includes(r.id))) return;
  const d = getData(message.guild.id, message.author.id);
  const now = Date.now();
  d.msgs = (d.msgs || 0) + 1;
  if (now - (d.last || 0) < 60_000) { store.set('levels', key(message.guild.id, message.author.id), d); return; }
  const before = levelFromXp(d.xp).level;
  d.xp += Math.round(randomInt(15, 25) * (cfg.multiplier || 1));
  d.last = now;
  store.set('levels', key(message.guild.id, message.author.id), d);
  const after = levelFromXp(d.xp).level;
  if (after > before) {
    const roles = await applyRewards(message.member, after);
    const text = fillTemplate(cfg.message, { member: message.member, extra: { level: String(after) } }) +
      (roles.length ? `\nNeue Rolle: ${roles.map(r => `<@&${r.id}>`).join(', ')}` : '');
    const target = message.guild.channels.cache.get(cfg.channel) || message.channel;
    await target.send({ content: text, allowedMentions: { users: [message.author.id] } }).catch(() => {});
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

module.exports = { needFor, levelFromXp, xpForLevel, getData, leaderboard, rankOf, onMessage, setXp, rankPayload, applyRewards };
