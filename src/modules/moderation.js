'use strict';
/**
 * Moderations-Aktionen mit Fall-Nummern, Verwarnungen, Eskalation und Zeit-Banns.
 */
const { EmbedBuilder } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { sendLog } = require('../lib/logger');
const { COLORS } = require('../lib/embeds');
const { formatDuration, ts, truncate } = require('../lib/util');

const ACTION_INFO = {
  warn: { name: 'Verwarnung', emoji: '⚠️', color: COLORS.warn, verb: 'verwarnt' },
  timeout: { name: 'Timeout', emoji: '⏳', color: COLORS.mod, verb: 'stummgeschaltet (Timeout)' },
  untimeout: { name: 'Timeout aufgehoben', emoji: '🔊', color: COLORS.ok, verb: 'entstummt' },
  kick: { name: 'Kick', emoji: '👢', color: COLORS.mod, verb: 'gekickt' },
  ban: { name: 'Bann', emoji: '🔨', color: COLORS.err, verb: 'gebannt' },
  softban: { name: 'Softbann', emoji: '🧹', color: COLORS.err, verb: 'gesoftbannt' },
  unban: { name: 'Entbannung', emoji: '🕊️', color: COLORS.ok, verb: 'entbannt' },
  automod: { name: 'AutoMod', emoji: '🤖', color: COLORS.warn, verb: 'von AutoMod bestraft' },
};

function nextCaseId(guildId) {
  const meta = store.get('casemeta', guildId) || { next: 1 };
  const id = meta.next++;
  store.set('casemeta', guildId, meta);
  return id;
}

async function addCase(guild, { type, user, moderator, reason, duration }) {
  const id = nextCaseId(guild.id);
  const entry = {
    id, type, userId: user.id, userTag: user.tag || user.username,
    modId: moderator?.id || null, modTag: moderator?.tag || moderator?.username || 'System',
    reason: reason || 'Kein Grund angegeben', duration: duration || null, at: Date.now(),
  };
  store.set('cases', `${guild.id}:${id}`, entry);
  const info = ACTION_INFO[type] || { name: type, emoji: '📝', color: COLORS.info };
  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setAuthor({ name: `Fall #${id} · ${info.name}`, iconURL: user.displayAvatarURL?.() })
    .addFields(
      { name: 'Mitglied', value: `<@${user.id}> (\`${user.id}\`)`, inline: true },
      { name: 'Moderator', value: moderator ? `<@${moderator.id}>` : 'System', inline: true },
      { name: 'Grund', value: truncate(entry.reason, 1000) },
    )
    .setTimestamp();
  if (duration) embed.addFields({ name: 'Dauer', value: formatDuration(duration), inline: true });
  sendLog(guild, 'mod', embed);
  return entry;
}

function getCases(guildId, userId) {
  return store.entries('cases')
    .filter(([k, v]) => k.startsWith(guildId + ':') && (!userId || v.userId === userId))
    .map(([, v]) => v)
    .sort((a, b) => b.id - a.id);
}

async function dmUser(user, guild, type, reason, duration) {
  const info = ACTION_INFO[type];
  if (!info || !user?.send) return false;
  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${info.emoji} Du wurdest auf ${guild.name} ${info.verb}`)
    .addFields({ name: 'Grund', value: truncate(reason || 'Kein Grund angegeben', 1000) })
    .setTimestamp();
  if (duration) embed.addFields({ name: 'Dauer', value: formatDuration(duration) });
  try { await user.send({ embeds: [embed] }); return true; } catch { return false; }
}

// ---------- Verwarnungen ----------
function warnKey(g, u) { return `${g}:${u}`; }

function getWarns(guildId, userId, activeOnly = false) {
  const list = store.get('warns', warnKey(guildId, userId)) || [];
  if (!activeOnly) return list;
  const days = getConfig(guildId).automod.escalation.expireDays;
  if (!days) return list;
  const cutoff = Date.now() - days * 86_400_000;
  return list.filter(w => w.at >= cutoff);
}

async function warn(guild, member, moderator, reason, { silent = false } = {}) {
  const user = member.user || member;
  const list = getWarns(guild.id, user.id);
  const c = await addCase(guild, { type: 'warn', user, moderator, reason });
  list.push({ id: c.id, reason: c.reason, modId: moderator?.id || null, at: Date.now() });
  store.set('warns', warnKey(guild.id, user.id), list);
  if (!silent) await dmUser(user, guild, 'warn', reason);
  const active = getWarns(guild.id, user.id, true).length;
  const escalated = member.guild ? await escalate(guild, member, active) : null;
  return { caseId: c.id, count: active, escalated };
}

function removeWarn(guildId, userId, caseId) {
  const list = getWarns(guildId, userId);
  const idx = list.findIndex(w => w.id === caseId);
  if (idx < 0) return false;
  list.splice(idx, 1);
  store.set('warns', warnKey(guildId, userId), list);
  return true;
}

function clearWarns(guildId, userId) {
  return store.delete('warns', warnKey(guildId, userId));
}

/** Automatische Strafe ab einer bestimmten Zahl aktiver Verwarnungen. */
async function escalate(guild, member, count) {
  const esc = getConfig(guild.id).automod.escalation;
  if (!esc.enabled || !member?.guild) return null;
  const me = guild.client.user;
  const reason = `Automatisch: ${count} aktive Verwarnungen`;
  try {
    if (esc.banAt && count >= esc.banAt && member.bannable) {
      await ban(guild, member.user, me, reason, {});
      return 'Bann';
    }
    if (esc.kickAt && count >= esc.kickAt && member.kickable) {
      await kick(member, me, reason);
      return 'Kick';
    }
    if (esc.timeoutAt && count >= esc.timeoutAt && member.moderatable) {
      const ms = esc.timeoutMinutes * 60_000;
      await timeout(member, ms, me, reason);
      return `Timeout (${formatDuration(ms)})`;
    }
  } catch (e) {
    console.error('[eskalation]', e.message);
  }
  return null;
}

// ---------- Aktionen ----------
async function timeout(member, ms, moderator, reason) {
  ms = Math.min(ms, 28 * 86_400_000);
  await dmUser(member.user, member.guild, 'timeout', reason, ms);
  await member.timeout(ms, truncate(`${moderator?.tag || 'System'}: ${reason || '-'}`, 500));
  return addCase(member.guild, { type: 'timeout', user: member.user, moderator, reason, duration: ms });
}

async function untimeout(member, moderator, reason) {
  await member.timeout(null, truncate(`${moderator?.tag || 'System'}: ${reason || '-'}`, 500));
  return addCase(member.guild, { type: 'untimeout', user: member.user, moderator, reason });
}

async function kick(member, moderator, reason) {
  await dmUser(member.user, member.guild, 'kick', reason);
  await member.kick(truncate(`${moderator?.tag || 'System'}: ${reason || '-'}`, 500));
  return addCase(member.guild, { type: 'kick', user: member.user, moderator, reason });
}

async function ban(guild, user, moderator, reason, { deleteSeconds = 0, durationMs = null, soft = false } = {}) {
  await dmUser(user, guild, soft ? 'softban' : 'ban', reason, durationMs);
  await guild.members.ban(user.id, { deleteMessageSeconds: deleteSeconds, reason: truncate(`${moderator?.tag || 'System'}: ${reason || '-'}`, 500) });
  if (soft) {
    await guild.members.unban(user.id, 'Softbann: Nachrichten gelöscht, Bann aufgehoben');
  } else if (durationMs) {
    store.set('tempbans', `${guild.id}:${user.id}`, { guildId: guild.id, userId: user.id, until: Date.now() + durationMs, reason });
  }
  return addCase(guild, { type: soft ? 'softban' : 'ban', user, moderator, reason, duration: durationMs });
}

async function unban(guild, userId, moderator, reason) {
  const user = await guild.client.users.fetch(userId);
  await guild.members.unban(userId, truncate(`${moderator?.tag || 'System'}: ${reason || '-'}`, 500));
  store.delete('tempbans', `${guild.id}:${userId}`);
  return addCase(guild, { type: 'unban', user, moderator, reason });
}

/** Wird vom Zeitplaner aufgerufen: abgelaufene Zeit-Banns aufheben. */
async function processTempBans(client) {
  const now = Date.now();
  for (const [key, tb] of store.entries('tempbans')) {
    if (tb.until > now) continue;
    store.delete('tempbans', key);
    const guild = client.guilds.cache.get(tb.guildId);
    if (!guild) continue;
    try {
      await unban(guild, tb.userId, client.user, 'Zeit-Bann abgelaufen');
    } catch (e) {
      if (e.code !== 10026) console.error('[tempban]', e.message); // 10026 = Bann existiert nicht mehr
    }
  }
}

function caseLine(c) {
  const info = ACTION_INFO[c.type] || { emoji: '📝', name: c.type };
  return `**#${c.id}** ${info.emoji} ${info.name} · ${ts(c.at)} · von ${c.modId ? `<@${c.modId}>` : 'System'}\n└ ${truncate(c.reason, 120)}`;
}

module.exports = {
  ACTION_INFO, addCase, getCases, dmUser, warn, getWarns, removeWarn, clearWarns, escalate,
  timeout, untimeout, kick, ban, unban, processTempBans, caseLine,
};
