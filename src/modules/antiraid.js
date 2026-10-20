'use strict';
/**
 * Raid-Schutz: erkennt viele Beitritte in kurzer Zeit, sperrt dann automatisch den Server,
 * pausiert Einladungen und kann die Angreifer kicken. Dazu Mindestalter für Accounts.
 */
const { EmbedBuilder } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { sendLog } = require('../lib/logger');
const { COLORS } = require('../lib/embeds');
const { formatDuration, ts } = require('../lib/util');
const lockdown = require('./lockdown');

const joins = new Map(); // guildId -> [{id, at}]

function raidActive(cfg) {
  return cfg.antiraid.raidUntil && Date.now() < cfg.antiraid.raidUntil;
}

function pingText(guild) {
  const cfg = getConfig(guild.id);
  return cfg.modRoles.filter(r => guild.roles.cache.has(r)).map(r => `<@&${r}>`).join(' ');
}

/** Gibt true zurück, wenn das Mitglied entfernt wurde (dann keine Willkommensnachricht). */
async function onJoin(member) {
  const guild = member.guild;
  const cfg = getConfig(guild.id);
  const ar = cfg.antiraid;
  if (!ar.enabled || member.user.bot) return false;

  // Mindestalter des Accounts
  if (ar.minAccountDays > 0) {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (ageDays < ar.minAccountDays) {
      const reason = `Account jünger als ${ar.minAccountDays} Tage (Schutz vor Fake-Accounts)`;
      await member.send(`Dein Account ist zu neu für **${guild.name}**. Bitte versuche es in ein paar Tagen erneut.`).catch(() => {});
      try {
        if (ar.accountAction === 'ban') await member.ban({ reason });
        else if (ar.accountAction === 'timeout') await member.timeout(7 * 86_400_000, reason);
        else await member.kick(reason);
        sendLog(guild, 'protection', new EmbedBuilder().setColor(COLORS.warn)
          .setTitle('🛡️ Neuer Account abgewiesen')
          .setDescription(`<@${member.id}> (\`${member.user.tag}\`) · erstellt ${ts(member.user.createdTimestamp)}\nAktion: **${ar.accountAction}**`));
        return ar.accountAction !== 'timeout';
      } catch (e) {
        console.warn('[antiraid] Account-Alter:', e.message);
      }
    }
  }

  // Während eines Raids: neue Mitglieder direkt kicken (falls eingestellt)
  if (raidActive(cfg) && ar.kickRaiders) {
    await member.kick('Raid-Schutz aktiv').catch(() => {});
    return true;
  }

  // Beitrittsrate messen
  const now = Date.now();
  const list = (joins.get(guild.id) || []).filter(j => now - j.at < ar.seconds * 1000);
  list.push({ id: member.id, at: now });
  joins.set(guild.id, list);
  if (list.length >= ar.joins && !raidActive(cfg)) {
    await triggerRaid(guild, list.map(j => j.id), `${list.length} Beitritte in ${ar.seconds} Sekunden`);
    return ar.kickRaiders;
  }
  return false;
}

async function triggerRaid(guild, memberIds = [], why = 'Manuell ausgelöst', by = null) {
  const cfg = getConfig(guild.id);
  const ar = cfg.antiraid;
  ar.raidUntil = Date.now() + ar.minutes * 60_000;
  saveConfig(guild.id);
  const steps = [];

  if (ar.pauseInvites) {
    try {
      const until = new Date(Math.min(ar.raidUntil, Date.now() + 24 * 3_600_000));
      await guild.setIncidentActions({ invitesDisabledUntil: until, dmsDisabledUntil: until });
      steps.push('Einladungen und Privatnachrichten unter Mitgliedern pausiert');
    } catch {
      steps.push('Einladungen konnten nicht pausiert werden (fehlt „Server verwalten“?)');
    }
  }
  if (ar.action === 'lockdown') {
    const r = await lockdown.start(guild, { reason: `Raid erkannt: ${why}`, minutes: ar.minutes, by, pauseInvites: false });
    if (r.locked != null) steps.push(`Lockdown für ${formatDuration(ar.minutes * 60_000)} (${r.locked} Kanäle)`);
    else if (r.already) steps.push('Lockdown war bereits aktiv');
  }
  if (ar.kickRaiders && memberIds.length) {
    let n = 0;
    for (const id of memberIds) {
      const m = guild.members.cache.get(id);
      if (m && m.kickable) { await m.kick('Raid-Schutz').catch(() => {}); n++; }
    }
    steps.push(`${n} Raid-Accounts gekickt`);
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.protect)
    .setTitle('🚨 RAID ERKANNT')
    .setDescription(`**Auslöser:** ${why}\n**Schutz aktiv bis:** ${ts(ar.raidUntil)}\n\n${steps.map(s => `• ${s}`).join('\n') || '• Nur Warnung (keine Aktion eingestellt)'}`)
    .setFooter({ text: 'Beenden: /antiraid stop · Lockdown beenden: /lockdown end' })
    .setTimestamp();
  if (memberIds.length) embed.addFields({ name: 'Beteiligte Accounts', value: memberIds.slice(0, 30).map(id => `<@${id}>`).join(' ').slice(0, 1024) });
  const ping = pingText(guild);
  await sendLog(guild, 'protection', { content: ping || undefined, embeds: [embed], allowedMentions: { roles: getConfig(guild.id).modRoles } });
  joins.set(guild.id, []);
  return steps;
}

async function stopRaid(guild) {
  const cfg = getConfig(guild.id);
  cfg.antiraid.raidUntil = 0;
  saveConfig(guild.id);
  await guild.setIncidentActions({ invitesDisabledUntil: null, dmsDisabledUntil: null }).catch(() => {});
}

async function processTimers(client) {
  for (const guild of client.guilds.cache.values()) {
    const cfg = getConfig(guild.id);
    if (cfg.antiraid.raidUntil && Date.now() >= cfg.antiraid.raidUntil) {
      cfg.antiraid.raidUntil = 0;
      saveConfig(guild.id);
      sendLog(guild, 'protection', new EmbedBuilder().setColor(COLORS.ok).setTitle('✅ Raid-Schutzmodus beendet').setTimestamp());
    }
  }
}

module.exports = { onJoin, triggerRaid, stopRaid, raidActive, processTimers };
