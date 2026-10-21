'use strict';
/**
 * Anti-Nuke: Wenn jemand (auch ein gehackter Admin oder ein fremder Bot) in kurzer Zeit viele Kanäle/Rollen löscht,
 * massenhaft bannt/kickt oder Webhooks anlegt, wird er sofort entmachtet und der Schaden – soweit möglich – rückgängig gemacht.
 */
const { AuditLogEvent, EmbedBuilder, PermissionsBitField, PermissionFlagsBits: P, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const store = require('../lib/store');
const { sendLog } = require('../lib/logger');
const { COLORS } = require('../lib/embeds');

const WATCH = {
  [AuditLogEvent.ChannelDelete]: { w: 1, label: 'Kanal gelöscht' },
  [AuditLogEvent.ChannelCreate]: { w: 0.5, label: 'Kanal erstellt' },
  [AuditLogEvent.RoleDelete]: { w: 1, label: 'Rolle gelöscht' },
  [AuditLogEvent.RoleCreate]: { w: 0.5, label: 'Rolle erstellt' },
  [AuditLogEvent.MemberBanAdd]: { w: 1, label: 'Mitglied gebannt' },
  [AuditLogEvent.MemberKick]: { w: 1, label: 'Mitglied gekickt' },
  [AuditLogEvent.MemberPrune]: { w: 3, label: 'Mitglieder entfernt (Prune)' },
  [AuditLogEvent.WebhookCreate]: { w: 1, label: 'Webhook erstellt' },
  [AuditLogEvent.EmojiDelete]: { w: 0.5, label: 'Emoji gelöscht' },
  [AuditLogEvent.StickerDelete]: { w: 0.5, label: 'Sticker gelöscht' },
};
// @everyone-Ping zählt bewusst nicht: Auf ETC. hat die normale Mitglieder-Rolle das Recht – sonst Fehlalarm bei jeder Rollenvergabe
const DANGEROUS = P.Administrator | P.BanMembers | P.KickMembers | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.ManageWebhooks;

const actions = new Map();   // guildId:userId -> [{at, w, action, targetId}]
const deleted = new Map();   // id -> {kind, guildId, data, at}
const punished = new Map();  // guildId:userId -> timestamp

function isTrusted(guild, userId) {
  if (userId === guild.ownerId || userId === guild.client.user.id) return true;
  const cfg = getConfig(guild.id).antinuke;
  if (cfg.trusted.includes(userId)) return true;
  // Ganze Rolle vertraut (z. B. Vize): wer sie hat, wird nicht bestraft
  return !!cfg.trustedRoles?.length && !!guild.members.cache.get(userId)?.roles.cache.some(r => cfg.trustedRoles.includes(r.id));
}

/** Gelöschte Kanäle/Rollen kurz merken, damit sie wiederhergestellt werden können. */
function rememberChannel(channel) {
  if (!channel.guild) return;
  deleted.set(channel.id, {
    kind: 'channel', guildId: channel.guild.id, at: Date.now(),
    data: {
      name: channel.name, type: channel.type, parentId: channel.parentId, position: channel.rawPosition,
      topic: channel.topic ?? undefined, nsfw: channel.nsfw ?? undefined, bitrate: channel.bitrate ?? undefined,
      userLimit: channel.userLimit ?? undefined, rateLimitPerUser: channel.rateLimitPerUser ?? undefined,
      overwrites: [...(channel.permissionOverwrites?.cache.values() || [])].map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })),
    },
  });
  cleanup();
}
function rememberRole(role) {
  deleted.set(role.id, {
    kind: 'role', guildId: role.guild.id, at: Date.now(),
    data: { name: role.name, colors: { primaryColor: role.colors?.primaryColor ?? 0 }, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions.bitfield.toString(), position: role.rawPosition },
  });
  cleanup();
}
function cleanup() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, d] of deleted) if (d.at < cutoff) deleted.delete(id);
}

function alert(guild, title, description, color = COLORS.protect) {
  const cfg = getConfig(guild.id);
  const ping = cfg.modRoles.filter(r => guild.roles.cache.has(r)).map(r => `<@&${r}>`).join(' ');
  return sendLog(guild, 'protection', {
    content: ping || undefined,
    allowedMentions: { roles: cfg.modRoles },
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp()],
  });
}

async function onAuditEntry(entry, guild) {
  const cfg = getConfig(guild.id).antinuke;
  if (!cfg.enabled || !entry.executorId) return;
  const executorId = entry.executorId;
  if (cfg.trustedRoles?.length && !guild.members.cache.has(executorId)) await guild.members.fetch(executorId).catch(() => null); // für vertraute Rollen
  if (isTrusted(guild, executorId)) return;

  // Fremder Bot wurde hinzugefügt
  if (entry.action === AuditLogEvent.BotAdd && cfg.blockBots) {
    const botMember = await guild.members.fetch(entry.targetId).catch(() => null);
    if (botMember) await botMember.kick('Anti-Nuke: Bots dürfen nur von vertrauenswürdigen Personen hinzugefügt werden').catch(() => {});
    alert(guild, '🤖 Unerlaubter Bot entfernt', `<@${executorId}> hat den Bot <@${entry.targetId}> hinzugefügt. Er wurde wieder entfernt.\nVertrauenswürdige Personen: \`/antinuke trust\``);
    return;
  }

  // Gefährliche Rechte an eine Rolle vergeben → zurücksetzen
  if (entry.action === AuditLogEvent.RoleUpdate) {
    const change = entry.changes.find(c => c.key === 'permissions');
    if (change) {
      const oldP = BigInt(change.old ?? 0), newP = BigInt(change.new ?? 0);
      const added = newP & ~oldP & DANGEROUS;
      if (added) {
        const role = guild.roles.cache.get(entry.targetId);
        if (role?.editable) await role.setPermissions(oldP, 'Anti-Nuke: gefährliche Rechte zurückgesetzt').catch(() => {});
        const names = new PermissionsBitField(added).toArray().join(', ');
        alert(guild, '🛡️ Gefährliche Rechte zurückgesetzt', `<@${executorId}> hat der Rolle <@&${entry.targetId}> **${names}** gegeben. Das wurde rückgängig gemacht.`, COLORS.warn);
        count(guild, executorId, entry.action, entry.targetId, 1);
      }
    }
    return;
  }

  // Admin-Rolle an jemanden vergeben → zurücknehmen
  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const add = entry.changes.find(c => c.key === '$add');
    if (add?.new?.length) {
      // Auch eine vertraute Rolle zählt: sonst könnte sich ein fremder Admin selbst „vertrauenswürdig“ machen
      const trustedRoles = getConfig(guild.id).antinuke.trustedRoles || [];
      const dangerous = add.new.map(r => guild.roles.cache.get(r.id)).filter(r => r && ((r.permissions.bitfield & DANGEROUS) || trustedRoles.includes(r.id)));
      if (dangerous.length) {
        const target = await guild.members.fetch(entry.targetId).catch(() => null);
        if (target) await target.roles.remove(dangerous.filter(r => r.editable), 'Anti-Nuke: gefährliche Rolle entfernt').catch(() => {});
        alert(guild, '🛡️ Gefährliche Rolle entfernt', `<@${executorId}> hat <@${entry.targetId}> die Rolle(n) ${dangerous.map(r => `<@&${r.id}>`).join(', ')} gegeben. Das wurde rückgängig gemacht.\nWenn das gewollt war: \`/antinuke trust\` für die Person.`, COLORS.warn);
        count(guild, executorId, entry.action, entry.targetId, 1);
      }
    }
    return;
  }

  const watch = WATCH[entry.action];
  if (!watch) return;
  count(guild, executorId, entry.action, entry.targetId, watch.w);
}

function count(guild, executorId, action, targetId, w) {
  const cfg = getConfig(guild.id).antinuke;
  const key = `${guild.id}:${executorId}`;
  const now = Date.now();
  const list = (actions.get(key) || []).filter(a => now - a.at < cfg.seconds * 1000);
  list.push({ at: now, w, action, targetId });
  actions.set(key, list);
  const total = list.reduce((s, a) => s + a.w, 0);
  if (total >= cfg.threshold) {
    const last = punished.get(key) || 0;
    if (now - last < 60_000) return; // nicht doppelt bestrafen
    punished.set(key, now);
    punish(guild, executorId, list).catch(e => console.error('[antinuke]', e));
  }
}

async function punish(guild, executorId, list) {
  const cfg = getConfig(guild.id).antinuke;
  const lines = [];
  const member = await guild.members.fetch(executorId).catch(() => null);
  const reason = 'Anti-Nuke: zu viele zerstörerische Aktionen in kurzer Zeit';
  if (member) {
    try {
      if (member.user.bot || cfg.punishment === 'ban') {
        await member.ban({ reason });
        lines.push(`Täter **gebannt**`);
      } else if (cfg.punishment === 'kick') {
        await member.kick(reason);
        lines.push('Täter **gekickt**');
      } else {
        const removable = member.roles.cache.filter(r => r.id !== guild.id && r.editable);
        store.set('antinukeUndo', `${guild.id}:${executorId}`, { roles: [...removable.keys()], at: Date.now() }); // für „Fehlalarm“
        await member.roles.remove(removable, reason);
        lines.push(`Alle Rollen entfernt (${removable.size})`);
        if (member.moderatable) {
          await member.timeout(24 * 3_600_000, reason).catch(() => {});
          lines.push('24 Stunden Timeout');
        }
      }
    } catch (e) {
      lines.push(`⚠️ Ich konnte nicht eingreifen: ${e.message}. Meine Rolle muss in der Rollenliste ganz oben stehen!`);
    }
  }

  if (cfg.restore) {
    const restored = await restore(guild, list);
    if (restored.length) lines.push(...restored);
  }

  const summary = {};
  for (const a of list) {
    const label = WATCH[a.action]?.label || 'Aktion';
    summary[label] = (summary[label] || 0) + 1;
  }
  await alert(guild, '☢️ NUKE-VERSUCH GESTOPPT',
    `**Täter:** <@${executorId}> (\`${executorId}\`)\n**Erkannt:** ${Object.entries(summary).map(([k, v]) => `${v}× ${k}`).join(', ')}\n\n${lines.map(l => `• ${l}`).join('\n')}`);
  const owner = await guild.fetchOwner().catch(() => null);
  const undo = store.has('antinukeUndo', `${guild.id}:${executorId}`);
  owner?.send({
    content: `☢️ Auf **${guild.name}** wurde ein Nuke-Versuch von <@${executorId}> gestoppt. Details stehen im Schutz-Log.${undo ? '\n-# War das ein Fehlalarm? Der Knopf gibt alle Rollen zurück, hebt den Timeout auf und vertraut der Person ab jetzt.' : ''}`,
    components: undo ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`an:undo:${guild.id}:${executorId}`).setLabel('Fehlalarm – alles zurück').setEmoji('↩️').setStyle(ButtonStyle.Danger))] : [],
  }).catch(() => {});
}

/** Knopf aus der DM: Fehlalarm rückgängig machen (nur der Server-Inhaber) */
async function handleUndo(i) {
  const [, , guildId, userId] = i.customId.split(':');
  const guild = i.client.guilds.cache.get(guildId);
  if (!guild) return i.reply({ content: 'Den Server finde ich nicht mehr.' });
  if (i.user.id !== guild.ownerId) return i.reply({ content: 'Das darf nur der Server-Inhaber.' });
  const key = `${guildId}:${userId}`;
  const saved = store.get('antinukeUndo', key);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return i.reply({ content: 'Die Person ist nicht mehr auf dem Server.' });
  const lines = [];
  const roles = (saved?.roles || []).filter(id => guild.roles.cache.get(id)?.editable && !member.roles.cache.has(id));
  if (roles.length) await member.roles.add(roles, 'Anti-Nuke: Fehlalarm, Rollen zurück').then(() => lines.push(`${roles.length} Rollen zurückgegeben`)).catch(e => lines.push(`⚠️ Rollen: ${e.message}`));
  if (member.isCommunicationDisabled()) await member.timeout(null, 'Anti-Nuke: Fehlalarm').then(() => lines.push('Timeout aufgehoben')).catch(e => lines.push(`⚠️ Timeout: ${e.message}`));
  const cfg = getConfig(guildId);
  if (!cfg.antinuke.trusted.includes(userId)) { cfg.antinuke.trusted.push(userId); saveConfig(guildId); }
  lines.push('ab jetzt vertrauenswürdig (Anti-Nuke greift bei ihr/ihm nicht mehr)');
  store.delete('antinukeUndo', key);
  alert(guild, '↩️ Fehlalarm rückgängig gemacht', `<@${userId}>: ${lines.join(' · ')}`, COLORS.ok);
  return i.update({ content: `${i.message.content.split('\n')[0]}\n✅ **Rückgängig gemacht:** ${lines.join(' · ')}`, components: [] });
}

async function restore(guild, list) {
  const out = [];
  const roleMap = {};
  const channelMap = {};
  // 1) Rollen
  for (const a of list.filter(x => x.action === AuditLogEvent.RoleDelete)) {
    const snap = deleted.get(a.targetId);
    if (!snap) continue;
    try {
      const r = await guild.roles.create({ ...snap.data, permissions: BigInt(snap.data.permissions), reason: 'Anti-Nuke: Rolle wiederhergestellt' });
      roleMap[a.targetId] = r.id;
      deleted.delete(a.targetId);
    } catch { /* weiter */ }
  }
  if (Object.keys(roleMap).length) out.push(`${Object.keys(roleMap).length} Rolle(n) wiederhergestellt (Mitglieder müssen sie neu bekommen)`);
  // 2) Kanäle – Kategorien zuerst
  const chDel = list.filter(x => x.action === AuditLogEvent.ChannelDelete).map(a => ({ a, snap: deleted.get(a.targetId) })).filter(x => x.snap);
  chDel.sort((x, y) => (y.snap.data.type === ChannelType.GuildCategory) - (x.snap.data.type === ChannelType.GuildCategory));
  for (const { a, snap } of chDel) {
    const d = snap.data;
    try {
      const parent = d.parentId ? (channelMap[d.parentId] || (guild.channels.cache.has(d.parentId) ? d.parentId : null)) : null;
      const overwrites = d.overwrites
        .map(o => ({ id: roleMap[o.id] || o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }))
        .filter(o => guild.roles.cache.has(o.id) || o.type === 1);
      const ch = await guild.channels.create({
        name: d.name, type: d.type, topic: d.topic, nsfw: d.nsfw, bitrate: d.bitrate, userLimit: d.userLimit,
        rateLimitPerUser: d.rateLimitPerUser, parent, permissionOverwrites: overwrites, reason: 'Anti-Nuke: Kanal wiederhergestellt',
      });
      channelMap[a.targetId] = ch.id;
      deleted.delete(a.targetId);
    } catch { /* weiter */ }
  }
  if (Object.keys(channelMap).length) out.push(`${Object.keys(channelMap).length} Kanal/Kanäle wiederhergestellt (alte Nachrichten sind leider weg)`);
  // 3) Banns rückgängig
  let unbanned = 0;
  for (const a of list.filter(x => x.action === AuditLogEvent.MemberBanAdd)) {
    if (await guild.members.unban(a.targetId, 'Anti-Nuke: Massen-Bann rückgängig').then(() => true).catch(() => false)) unbanned++;
  }
  if (unbanned) out.push(`${unbanned} Bann(s) aufgehoben`);
  return out;
}

module.exports = { onAuditEntry, rememberChannel, rememberRole, isTrusted, handleUndo, DANGEROUS };
