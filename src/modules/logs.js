'use strict';
/**
 * Server-Logs: Nachrichten (gelöscht/bearbeitet), Mitglieder (Beitritt/Austritt/Rollen/Nickname/Timeout),
 * Server (Kanäle/Rollen/Banns) und Sprachkanäle.
 */
const { AuditLogEvent, EmbedBuilder } = require('discord.js');
const { sendLog } = require('../lib/logger');
const { COLORS } = require('../lib/embeds');
const { truncate, ts, formatDuration } = require('../lib/util');

const block = s => '```\n' + truncate(String(s || '–').replace(/`/g, "'"), 1000) + '\n```';

async function messageDelete(message) {
  if (!message.guild || message.author?.bot) return;
  if (message.partial && !message.content) {
    return sendLog(message.guild, 'messages', new EmbedBuilder().setColor(COLORS.err).setDescription(`🗑️ Eine ältere Nachricht in <#${message.channelId}> wurde gelöscht (Inhalt unbekannt).`).setTimestamp());
  }
  const e = new EmbedBuilder().setColor(COLORS.err)
    .setAuthor({ name: `Nachricht gelöscht · ${message.author?.tag || 'Unbekannt'}`, iconURL: message.author?.displayAvatarURL() })
    .setDescription(`**Kanal:** <#${message.channelId}> · **Autor:** <@${message.author?.id}>\n${block(message.content)}`)
    .setFooter({ text: `Nachricht-ID: ${message.id}` }).setTimestamp();
  if (message.attachments?.size) e.addFields({ name: 'Anhänge', value: truncate([...message.attachments.values()].map(a => a.name).join(', '), 1000) });
  return sendLog(message.guild, 'messages', e);
}

async function messageUpdate(oldMsg, newMsg) {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content || oldMsg.partial) return;
  return sendLog(newMsg.guild, 'messages', new EmbedBuilder().setColor(COLORS.warn)
    .setAuthor({ name: `Nachricht bearbeitet · ${newMsg.author?.tag}`, iconURL: newMsg.author?.displayAvatarURL() })
    .setDescription(`**Kanal:** <#${newMsg.channelId}> · [Zur Nachricht](${newMsg.url})\n**Vorher:**${block(oldMsg.content)}**Nachher:**${block(newMsg.content)}`)
    .setTimestamp());
}

async function messageBulkDelete(messages, channel) {
  return sendLog(channel.guild, 'messages', new EmbedBuilder().setColor(COLORS.err).setDescription(`🧹 **${messages.size}** Nachrichten in <#${channel.id}> gelöscht.`).setTimestamp());
}

async function memberAdd(member) {
  const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  return sendLog(member.guild, 'members', new EmbedBuilder().setColor(COLORS.ok)
    .setAuthor({ name: `Beigetreten · ${member.user.tag}`, iconURL: member.user.displayAvatarURL() })
    .setDescription(`<@${member.id}> · Mitglied #${member.guild.memberCount}\n**Account erstellt:** ${ts(member.user.createdTimestamp)}${ageDays < 7 ? ' ⚠️ **neuer Account**' : ''}`)
    .setFooter({ text: `ID: ${member.id}` }).setTimestamp());
}

async function memberRemove(member) {
  const roles = member.roles?.cache.filter(r => r.id !== member.guild.id).map(r => `<@&${r.id}>`).join(' ') || '–';
  return sendLog(member.guild, 'members', new EmbedBuilder().setColor(COLORS.err)
    .setAuthor({ name: `Verlassen · ${member.user.tag}`, iconURL: member.user.displayAvatarURL() })
    .setDescription(`<@${member.id}>\n**Beigetreten:** ${member.joinedTimestamp ? ts(member.joinedTimestamp) : 'unbekannt'}\n**Rollen:** ${truncate(roles, 900)}`)
    .setFooter({ text: `ID: ${member.id}` }).setTimestamp());
}

async function memberUpdate(oldM, newM) {
  if (oldM.partial) return;
  const lines = [];
  if (oldM.nickname !== newM.nickname) lines.push(`**Nickname:** ${oldM.nickname || '–'} → ${newM.nickname || '–'}`);
  const added = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id));
  const removed = oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id));
  if (added.size) lines.push(`**Rollen hinzugefügt:** ${added.map(r => `<@&${r.id}>`).join(' ')}`);
  if (removed.size) lines.push(`**Rollen entfernt:** ${removed.map(r => `<@&${r.id}>`).join(' ')}`);
  const oldT = oldM.communicationDisabledUntilTimestamp || 0;
  const newT = newM.communicationDisabledUntilTimestamp || 0;
  if (newT > Date.now() && newT !== oldT) lines.push(`**Timeout bis:** ${ts(newT)} (${formatDuration(newT - Date.now())})`);
  if (oldT > Date.now() && !newT) lines.push('**Timeout aufgehoben**');
  if (!lines.length) return;
  return sendLog(newM.guild, 'members', new EmbedBuilder().setColor(COLORS.info)
    .setAuthor({ name: `Mitglied geändert · ${newM.user.tag}`, iconURL: newM.user.displayAvatarURL() })
    .setDescription(`<@${newM.id}>\n${lines.join('\n')}`).setTimestamp());
}

async function voiceUpdate(oldS, newS) {
  const m = newS.member || oldS.member;
  if (!m || m.user.bot) return;
  let text = null;
  if (!oldS.channelId && newS.channelId) text = `🔊 <@${m.id}> ist <#${newS.channelId}> beigetreten`;
  else if (oldS.channelId && !newS.channelId) text = `🔇 <@${m.id}> hat <#${oldS.channelId}> verlassen`;
  else if (oldS.channelId !== newS.channelId) text = `🔀 <@${m.id}>: <#${oldS.channelId}> → <#${newS.channelId}>`;
  if (text) return sendLog(newS.guild, 'voice', new EmbedBuilder().setColor(COLORS.info).setDescription(text).setTimestamp());
}

async function serverEvent(guild, text, color = COLORS.info) {
  return sendLog(guild, 'server', new EmbedBuilder().setColor(color).setDescription(text).setTimestamp());
}

const AUDIT_TEXT = {
  [AuditLogEvent.ChannelCreate]: e => `📁 Kanal **${e.target?.name || e.targetId}** erstellt`,
  [AuditLogEvent.ChannelDelete]: e => `🗑️ Kanal **${e.changes.find(c => c.key === 'name')?.old || e.targetId}** gelöscht`,
  [AuditLogEvent.RoleCreate]: e => `🏷️ Rolle **${e.target?.name || e.targetId}** erstellt`,
  [AuditLogEvent.RoleDelete]: e => `🗑️ Rolle **${e.changes.find(c => c.key === 'name')?.old || e.targetId}** gelöscht`,
  [AuditLogEvent.MemberBanAdd]: e => `🔨 <@${e.targetId}> gebannt${e.reason ? ` · ${truncate(e.reason, 200)}` : ''}`,
  [AuditLogEvent.MemberBanRemove]: e => `🕊️ <@${e.targetId}> entbannt`,
  [AuditLogEvent.MemberKick]: e => `👢 <@${e.targetId}> gekickt${e.reason ? ` · ${truncate(e.reason, 200)}` : ''}`,
  [AuditLogEvent.WebhookCreate]: e => `🪝 Webhook erstellt (\`${e.targetId}\`)`,
  [AuditLogEvent.BotAdd]: e => `🤖 Bot <@${e.targetId}> hinzugefügt`,
  [AuditLogEvent.InviteCreate]: e => `✉️ Einladung \`${e.changes.find(c => c.key === 'code')?.new || ''}\` erstellt`,
  [AuditLogEvent.GuildUpdate]: () => '⚙️ Server-Einstellungen geändert',
};

async function auditEntry(entry, guild) {
  const f = AUDIT_TEXT[entry.action];
  if (!f) return;
  // Eigene Bans/Kicks stehen schon als Fall im Mod-Log
  if (entry.executorId === guild.client.user.id && [AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberBanRemove, AuditLogEvent.MemberKick].includes(entry.action)) return;
  return serverEvent(guild, `${f(entry)}\n**Von:** ${entry.executorId ? `<@${entry.executorId}>` : 'unbekannt'}`);
}

module.exports = { messageDelete, messageUpdate, messageBulkDelete, memberAdd, memberRemove, memberUpdate, voiceUpdate, auditEntry, serverEvent };
