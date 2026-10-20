'use strict';
/**
 * Gemeinsame Abspiel-Funktion für /play und den 🎵-Knopf im Temp-Sprachkanal.
 */
const { EmbedBuilder, PermissionFlagsBits: P } = require('discord.js');
const { getConfig } = require('../../lib/config');
const { COLORS } = require('../../lib/embeds');
const { truncate } = require('../../lib/util');
const music = require('./player');
const { resolve } = require('./resolve');

/** Verbindet den Bot mit dem Sprachkanal (ohne etwas abzuspielen) */
async function join(guild, voiceChannel, textChannel) {
  const perms = voiceChannel.permissionsFor(guild.members.me);
  if (!perms?.has(P.Connect) || !perms.has(P.Speak)) throw new Error(`Ich darf in ${voiceChannel} nicht beitreten oder sprechen.`);
  const existing = music.get(guild);
  if (existing?.connection && existing.current && existing.voiceChannelId !== voiceChannel.id) throw new Error(`Ich spiele gerade in <#${existing.voiceChannelId}>.`);
  const p = music.getOrCreate(guild);
  const cfg = getConfig(guild.id).music;
  p.textChannel = guild.channels.cache.get(cfg.channel) || textChannel;
  await p.connect(voiceChannel);
  return p;
}

/**
 * Sucht/liest den Song und spielt ihn (oder hängt ihn an die Warteschlange).
 * @returns {Promise<{tracks: object[], playlist: string|null, added: number, wasIdle: boolean, position: number}>}
 */
async function play({ guild, member, voiceChannel, textChannel, query = '', attachment = null, front = false }) {
  if (!getConfig(guild.id).music.enabled) throw new Error('Musik ist auf diesem Server ausgeschaltet.');
  const result = await resolve(query, member.id, attachment);
  const p = await join(guild, voiceChannel, textChannel);
  const wasIdle = !p.current;
  const added = await p.add(result.tracks, { front });
  require('../quests').progress(member, 'music', 1, textChannel);
  return { ...result, added, wasIdle, position: p.queue.indexOf(result.tracks[0]) + 1 };
}

function resultEmbed(r) {
  if (r.playlist) return new EmbedBuilder().setColor(COLORS.ok).setDescription(`📃 **${r.added}** Songs aus **${truncate(r.playlist, 100)}** hinzugefügt.`);
  const t = r.tracks[0];
  return new EmbedBuilder().setColor(COLORS.ok)
    .setDescription(`${r.wasIdle ? '▶️ **Spiele:**' : `➕ **Hinzugefügt** (Platz ${r.position}):`} [${truncate(t.title, 150)}](${/^https?:/.test(t.url) ? t.url : 'https://discord.com'}) · \`${music.fmtTime(t.duration)}\` · ${t.source}`)
    .setThumbnail(t.thumbnail || null);
}

module.exports = { join, play, resultEmbed };
