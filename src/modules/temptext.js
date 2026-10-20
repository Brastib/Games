'use strict';
/**
 * Temporäre Textkanäle: werden nach Ablauf der Zeit automatisch gelöscht (mit Vorwarnung).
 */
const { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const { ts, formatDuration } = require('../lib/util');

async function create(guild, owner, { name, durationMs, isPrivate, members = [], categoryId }) {
  const cfg = getConfig(guild.id);
  const overwrites = [];
  if (isPrivate) {
    overwrites.push({ id: guild.roles.everyone.id, deny: [P.ViewChannel] });
    for (const r of cfg.modRoles) if (guild.roles.cache.has(r)) overwrites.push({ id: r, allow: [P.ViewChannel, P.SendMessages] });
    for (const id of members) overwrites.push({ id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] });
  }
  overwrites.push({ id: owner.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ManageMessages, P.ReadMessageHistory] });
  overwrites.push({ id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.EmbedLinks] });
  const expiresAt = Date.now() + durationMs;
  const channel = await guild.channels.create({
    name: name.toLowerCase().replace(/\s+/g, '-').slice(0, 90) || 'temp',
    type: ChannelType.GuildText,
    parent: categoryId || cfg.temptext.category || undefined,
    topic: `⏳ Temporärer Kanal von ${owner.username} · wird gelöscht am ${new Date(expiresAt).toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' })}`,
    permissionOverwrites: overwrites,
    reason: `Temporärer Kanal von ${owner.tag}`,
  });
  store.set('temptext', channel.id, { guildId: guild.id, ownerId: owner.id, expiresAt, warned: false });
  await channel.send({
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('⏳ Temporärer Kanal')
      .setDescription(`Erstellt von <@${owner.id}>.\nDieser Kanal wird ${ts(expiresAt)} **automatisch gelöscht** (${ts(expiresAt, 'f')}).\n\nVerlängern: \`/tempchannel extend\` · Sofort löschen: \`/tempchannel delete\``)],
  }).catch(() => {});
  return { channel, expiresAt };
}

function extend(channelId, ms) {
  const r = store.get('temptext', channelId);
  if (!r) return null;
  r.expiresAt += ms;
  r.warned = false;
  store.set('temptext', channelId, r);
  return r.expiresAt;
}

async function processTimers(client) {
  const now = Date.now();
  for (const [id, r] of store.entries('temptext')) {
    const guild = client.guilds.cache.get(r.guildId);
    const ch = guild?.channels.cache.get(id);
    if (!ch) { store.delete('temptext', id); continue; }
    if (now >= r.expiresAt) {
      store.delete('temptext', id);
      await ch.delete('Temporärer Kanal abgelaufen').catch(() => {});
    } else if (!r.warned && r.expiresAt - now <= 5 * 60_000) {
      r.warned = true;
      store.set('temptext', id, r);
      await ch.send(`⏰ Dieser Kanal wird ${ts(r.expiresAt)} gelöscht. Verlängern mit \`/tempchannel extend\`.`).catch(() => {});
    }
  }
}

module.exports = { create, extend, processTimers, formatDuration };
