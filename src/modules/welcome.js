'use strict';
/**
 * Willkommen, Abschied und automatische Rollen beim Beitritt.
 */
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { getConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const { fillTemplate } = require('../lib/util');
const cards = require('../lib/cards');

async function buildWelcome(member) {
  const cfg = getConfig(member.guild.id).welcome;
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setDescription(fillTemplate(cfg.message, { member }))
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();
  const payload = { content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } };
  if (cfg.card) {
    const png = await cards.welcomeCard(member).catch(() => null);
    if (png) {
      payload.files = [new AttachmentBuilder(png, { name: 'willkommen.png' })];
      embed.setImage('attachment://willkommen.png').setThumbnail(null);
    }
  }
  return payload;
}

async function onJoin(member) {
  const cfg = getConfig(member.guild.id).welcome;
  // Automatische Rollen
  const roles = (member.user.bot ? cfg.botRoles : cfg.autoRoles).filter(r => member.guild.roles.cache.get(r)?.editable);
  if (roles.length) await member.roles.add(roles, 'Automatische Rolle beim Beitritt').catch(e => console.warn('[autorole]', e.message));
  if (member.user.bot || !cfg.enabled) return;
  const channel = member.guild.channels.cache.get(cfg.channel);
  if (channel?.isTextBased()) await channel.send(await buildWelcome(member)).catch(e => console.warn('[willkommen]', e.message));
  if (cfg.dm && cfg.dmMessage) {
    await member.send({ embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle(`👋 Willkommen auf ${member.guild.name}`).setDescription(fillTemplate(cfg.dmMessage, { member }))] }).catch(() => {});
  }
}

async function onLeave(member) {
  const cfg = getConfig(member.guild.id).goodbye;
  if (!cfg.enabled || member.user.bot) return;
  const channel = member.guild.channels.cache.get(cfg.channel);
  if (!channel?.isTextBased()) return;
  await channel.send({
    embeds: [new EmbedBuilder().setColor(COLORS.err).setDescription(fillTemplate(cfg.message, { member, user: member.user })).setThumbnail(member.user.displayAvatarURL()).setTimestamp()],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

module.exports = { onJoin, onLeave, buildWelcome };
