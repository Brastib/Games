'use strict';
/**
 * Lockdown: Der ganze Server wird schreibgeschützt (und optional Sprachkanäle gesperrt + Einladungen pausiert).
 * Alle vorherigen Berechtigungen werden gesichert und beim Beenden exakt wiederhergestellt – auch nach einem Neustart.
 */
const fs = require('fs');
const path = require('path');
const { ChannelType, EmbedBuilder, PermissionFlagsBits: P } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { sendLog } = require('../lib/logger');
const { COLORS } = require('../lib/embeds');
const { formatDuration, ts } = require('../lib/util');

const TEXT_KEYS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions'];
const VOICE_KEYS = ['Connect', 'SendMessages'];
const LOCKABLE = new Set([
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia,
  ChannelType.GuildVoice, ChannelType.GuildStageVoice,
]);
const busy = new Set();

function isStaffRole(role, cfg) {
  if (cfg.modRoles.includes(role.id)) return true;
  const p = role.permissions;
  return p.has(P.Administrator) || p.has(P.ManageGuild) || p.has(P.ManageMessages) || p.has(P.ModerateMembers);
}

function snapshot(channel, id, keys) {
  const ow = channel.permissionOverwrites.cache.get(id);
  const prev = {};
  for (const k of keys) prev[k] = ow?.allow.has(k) ? true : ow?.deny.has(k) ? false : null;
  return prev;
}

async function cleanupEmpty(channel, id) {
  const ow = channel.permissionOverwrites.cache.get(id);
  if (ow && ow.allow.bitfield === 0n && ow.deny.bitfield === 0n && id !== channel.guild.id) {
    await ow.delete('Lockdown beendet: leere Überschreibung entfernt').catch(() => {});
  }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {{reason?:string, by?:import('discord.js').User, minutes?:number, voice?:boolean, pauseInvites?:boolean, announceChannel?:any, announceAll?:boolean, onProgress?:Function}} opts
 */
async function start(guild, opts = {}) {
  const cfg = getConfig(guild.id);
  if (cfg.lockdown.active) return { already: true };
  if (busy.has(guild.id)) return { busy: true };
  busy.add(guild.id);
  const reason = opts.reason || cfg.lockdownAlarm?.reason || 'Kein Grund angegeben';
  const auditReason = `Lockdown: ${reason}`.slice(0, 500);
  const everyone = guild.roles.everyone;
  const backup = [];
  const locked = [];
  const voice = opts.voice !== false;
  try {
    const channels = [...guild.channels.cache.values()].filter(c => LOCKABLE.has(c.type));
    let done = 0;
    for (const channel of channels) {
      done++;
      if (!channel.permissionsFor(everyone)?.has(P.ViewChannel)) continue; // private Kanäle bleiben wie sie sind
      const isVoice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
      if (isVoice && !voice) continue;
      const keys = isVoice ? VOICE_KEYS : TEXT_KEYS;
      try {
        // 1) @everyone sperren
        const prevEveryone = snapshot(channel, everyone.id, keys);
        await channel.permissionOverwrites.edit(everyone.id, Object.fromEntries(keys.map(k => [k, false])), { reason: auditReason });
        backup.push({ c: channel.id, id: everyone.id, prev: prevEveryone });
        // 2) Rollen-Ausnahmen, die Schreiben ausdrücklich erlauben, neutralisieren (außer Team-Rollen)
        for (const ow of channel.permissionOverwrites.cache.values()) {
          if (ow.type !== 0 || ow.id === everyone.id) continue;
          const role = guild.roles.cache.get(ow.id);
          if (!role || isStaffRole(role, cfg)) continue;
          const allowed = keys.filter(k => ow.allow.has(k));
          if (!allowed.length) continue;
          const prev = snapshot(channel, ow.id, allowed);
          await channel.permissionOverwrites.edit(ow.id, Object.fromEntries(allowed.map(k => [k, null])), { reason: auditReason });
          backup.push({ c: channel.id, id: ow.id, prev });
        }
        // 3) Eingetragene Mod-Rollen dürfen weiter schreiben
        for (const roleId of cfg.modRoles) {
          if (!guild.roles.cache.has(roleId)) continue;
          const prev = snapshot(channel, roleId, keys);
          await channel.permissionOverwrites.edit(roleId, Object.fromEntries(keys.map(k => [k, true])), { reason: auditReason });
          backup.push({ c: channel.id, id: roleId, prev });
        }
        locked.push(channel);
      } catch (e) {
        console.warn(`[lockdown] Kanal ${channel.name}: ${e.message}`);
      }
      if (opts.onProgress && done % 10 === 0) opts.onProgress(done, channels.length);
    }

    const until = opts.minutes ? Date.now() + opts.minutes * 60_000 : 0;
    let invitesPaused = false;
    if (opts.pauseInvites !== false) {
      try {
        const pauseUntil = Math.min(until || Date.now() + 24 * 3_600_000, Date.now() + 24 * 3_600_000);
        await guild.setIncidentActions({ invitesDisabledUntil: new Date(pauseUntil) });
        invitesPaused = true;
      } catch (e) {
        console.warn('[lockdown] Einladungen konnten nicht pausiert werden:', e.message);
      }
    }

    cfg.lockdown = { active: true, since: Date.now(), until, reason, by: opts.by?.id || null, backup, invitesPaused };
    saveConfig(guild.id);

    const embed = new EmbedBuilder()
      .setColor(COLORS.protect)
      .setTitle('🔒 Server im Lockdown')
      .setDescription(`Der Server ist vorübergehend gesperrt. Bitte habt etwas Geduld.\n\n**Grund:** ${reason}`)
      .addFields(
        { name: 'Gesperrte Kanäle', value: String(locked.length), inline: true },
        { name: 'Einladungen', value: invitesPaused ? 'pausiert' : 'aktiv', inline: true },
        { name: 'Ende', value: until ? ts(until) : 'manuell (/lockdown end)', inline: true },
      )
      .setTimestamp();
    if (opts.announceChannel?.isTextBased?.()) await opts.announceChannel.send({ embeds: [embed] }).catch(() => {});
    if (opts.announceAll) {
      for (const ch of locked) {
        if (ch.isTextBased() && ch.id !== opts.announceChannel?.id && ch.type !== ChannelType.GuildForum) {
          await ch.send({ embeds: [embed] }).catch(() => {});
        }
      }
    }
    // Warnung im Chat (auch wenn der Lockdown aus dem Dashboard oder automatisch kommt)
    const alarmCh = guild.channels.cache.get(cfg.lockdownAlarm?.chatChannel) || guild.systemChannel;
    if (alarmCh?.isTextBased?.() && alarmCh.id !== opts.announceChannel?.id && !(opts.announceAll && locked.includes(alarmCh))) {
      await alarmCh.send({ embeds: [new EmbedBuilder().setColor(COLORS.protect).setTitle('🚨 LOCKDOWN AKTIV')
        .setDescription(`Der Server ist gesperrt. **Bitte verlasst die Sprachkanäle** und wartet auf Entwarnung.

**Grund:** ${reason}`)
        .setTimestamp()] }).catch(() => {});
    }
    if (cfg.lockdownAlarm?.voice !== false) voiceAlarm(guild).catch(e => console.warn('[lockdown] Sprach-Alarm:', e.message));
    const log = EmbedBuilder.from(embed).setTitle('🔒 Lockdown gestartet')
      .setDescription(`**Grund:** ${reason}\n**Von:** ${opts.by ? `<@${opts.by.id}>` : 'Automatischer Schutz'}`);
    sendLog(guild, 'protection', log);
    return { locked: locked.length, invitesPaused, until };
  } finally {
    busy.delete(guild.id);
  }
}

async function end(guild, { by = null, auto = false } = {}) {
  const cfg = getConfig(guild.id);
  if (!cfg.lockdown.active) return { notActive: true };
  if (busy.has(guild.id)) return { busy: true };
  busy.add(guild.id);
  let restored = 0;
  try {
    const touched = new Set();
    for (const b of cfg.lockdown.backup || []) {
      const channel = guild.channels.cache.get(b.c);
      if (!channel) continue;
      try {
        await channel.permissionOverwrites.edit(b.id, b.prev, { reason: 'Lockdown beendet' });
        touched.add(channel.id + ':' + b.id);
        restored++;
      } catch (e) {
        console.warn(`[lockdown] Wiederherstellen in ${channel.name}: ${e.message}`);
      }
    }
    for (const key of touched) {
      const [cid, id] = key.split(':');
      const ch = guild.channels.cache.get(cid);
      if (ch) await cleanupEmpty(ch, id);
    }
    if (cfg.lockdown.invitesPaused) {
      await guild.setIncidentActions({ invitesDisabledUntil: null }).catch(e => console.warn('[lockdown] Einladungen:', e.message));
    }
    const duration = Date.now() - cfg.lockdown.since;
    cfg.lockdown = { active: false, since: 0, until: 0, reason: '', by: null, backup: [], invitesPaused: false };
    saveConfig(guild.id);
    sendLog(guild, 'protection', new EmbedBuilder()
      .setColor(COLORS.ok)
      .setTitle('🔓 Lockdown beendet')
      .setDescription(`${auto ? 'Automatisch nach Ablauf der Zeit' : `Von ${by ? `<@${by.id}>` : 'unbekannt'}`} · Dauer: ${formatDuration(duration)}`)
      .setTimestamp());
    const alarmCh = guild.channels.cache.get(cfg.lockdownAlarm?.chatChannel) || guild.systemChannel;
    await alarmCh?.send?.({ embeds: [new EmbedBuilder().setColor(COLORS.ok).setTitle('✅ Entwarnung').setDescription('Der Lockdown ist vorbei, alles ist wieder offen.').setTimestamp()] }).catch(() => {});
    return { restored };
  } finally {
    busy.delete(guild.id);
  }
}

// ---------- Einzelnen Kanal sperren ----------
async function lockChannel(channel, reason) {
  const cfg = getConfig(channel.guild.id);
  const isVoice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
  const keys = isVoice ? VOICE_KEYS : TEXT_KEYS;
  const id = channel.guild.roles.everyone.id;
  if (cfg.lockedChannels[channel.id]) return false;
  cfg.lockedChannels[channel.id] = snapshot(channel, id, keys);
  await channel.permissionOverwrites.edit(id, Object.fromEntries(keys.map(k => [k, false])), { reason: `Kanal gesperrt: ${reason}`.slice(0, 500) });
  for (const roleId of cfg.modRoles) {
    if (channel.guild.roles.cache.has(roleId)) await channel.permissionOverwrites.edit(roleId, { SendMessages: true }).catch(() => {});
  }
  saveConfig(channel.guild.id);
  return true;
}

async function unlockChannel(channel) {
  const cfg = getConfig(channel.guild.id);
  const id = channel.guild.roles.everyone.id;
  const prev = cfg.lockedChannels[channel.id];
  if (prev) {
    await channel.permissionOverwrites.edit(id, prev, { reason: 'Kanal entsperrt' });
    delete cfg.lockedChannels[channel.id];
    saveConfig(channel.guild.id);
  } else {
    await channel.permissionOverwrites.edit(id, { SendMessages: null, AddReactions: null, Connect: null }, { reason: 'Kanal entsperrt' });
  }
  return true;
}

async function processTimers(client) {
  for (const guild of client.guilds.cache.values()) {
    const cfg = getConfig(guild.id);
    if (cfg.lockdown.active && cfg.lockdown.until && Date.now() >= cfg.lockdown.until) {
      await end(guild, { auto: true }).catch(e => console.error('[lockdown auto-ende]', e.message));
    }
  }
}

// ---------------- Sprach-Alarm ----------------
const ALARM_SOUND = path.join(__dirname, '..', '..', 'assets', 'sounds', 'lockdown.ogg');

/**
 * Geht nacheinander in jeden besetzten Sprachkanal (ein Bot kann pro Server nur in einem gleichzeitig sein),
 * spielt Sirene + Durchsage „Lockdown aktiv – bitte verlassen Sie den Voice-Kanal“ und verlässt den Kanal danach.
 * @returns {Promise<number>} in wie vielen Kanälen abgespielt wurde
 */
async function voiceAlarm(guild, { only = null, test = false } = {}) {
  const voice = require('@discordjs/voice');
  require('./music/player').get(guild)?.destroy('Lockdown'); // Musik weg – die Sprachverbindung wird gebraucht
  const me = guild.members.me;
  const targets = [...guild.channels.cache.values()]
    .filter(c => c.type === ChannelType.GuildVoice && (!only || c.id === only) && c.members.some(m => !m.user.bot) && c.permissionsFor(me)?.has([P.Connect, P.Speak]))
    .sort((a, b) => b.members.size - a.members.size);
  let played = 0;
  for (const ch of targets) {
    if (!test && !getConfig(guild.id).lockdown.active) break; // inzwischen beendet
    try {
      const conn = voice.joinVoiceChannel({ channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
      await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
      const player = voice.createAudioPlayer();
      conn.subscribe(player);
      player.play(voice.createAudioResource(fs.createReadStream(ALARM_SOUND), { inputType: voice.StreamType.OggOpus }));
      await voice.entersState(player, voice.AudioPlayerStatus.Playing, 5_000);
      await voice.entersState(player, voice.AudioPlayerStatus.Idle, 40_000);
      played++;
    } catch (e) {
      console.warn(`[lockdown] Sprach-Alarm in ${ch.name}: ${e.message}`);
    }
  }
  voice.getVoiceConnection(guild.id)?.destroy();
  return played;
}

module.exports = { voiceAlarm, ALARM_SOUND, start, end, lockChannel, unlockChannel, processTimers };
