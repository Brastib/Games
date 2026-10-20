'use strict';
/**
 * Gewinnspiele mit Teilnahme-Button, optionaler Pflicht-Rolle, Auslosung und Neu-Auslosung.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const store = require('../lib/store');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const { ts } = require('../lib/util');

function embed(g) {
  const ended = g.ended;
  return new EmbedBuilder()
    .setColor(ended ? 0x2b2d31 : COLORS.brand)
    .setTitle(`🎉 ${g.prize}`)
    .setDescription([
      g.description || null,
      ended ? `**Beendet** ${ts(g.endsAt)}` : `Endet ${ts(g.endsAt)} (${ts(g.endsAt, 'f')})`,
      `**Gewinner:** ${ended ? (g.winners.length ? g.winners.map(id => `<@${id}>`).join(', ') : 'Niemand hat teilgenommen') : g.winnerCount}`,
      `**Teilnehmer:** ${g.entries.length}`,
      g.requiredRole ? `**Voraussetzung:** <@&${g.requiredRole}>` : null,
      `**Veranstaltet von:** <@${g.hostId}>`,
    ].filter(Boolean).join('\n'))
    .setTimestamp(g.endsAt);
}

function buttons(g) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gw:join').setLabel(g.ended ? 'Beendet' : 'Teilnehmen').setEmoji('🎉')
      .setStyle(ButtonStyle.Primary).setDisabled(!!g.ended))];
}

async function start(channel, host, { prize, durationMs, winners, description, requiredRole }) {
  const g = {
    guildId: channel.guild.id, channelId: channel.id, hostId: host.id, prize, description: description || null,
    winnerCount: winners, endsAt: Date.now() + durationMs, entries: [], winners: [], ended: false, requiredRole: requiredRole || null,
  };
  const msg = await channel.send({ embeds: [embed(g)], components: buttons(g) });
  store.set('giveaways', msg.id, g);
  return msg;
}

function draw(g, count) {
  const pool = [...g.entries];
  const out = [];
  while (pool.length && out.length < count) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

async function end(client, messageId) {
  const g = store.get('giveaways', messageId);
  if (!g || g.ended) return null;
  g.ended = true;
  g.endsAt = Math.min(g.endsAt, Date.now());
  g.winners = draw(g, g.winnerCount);
  store.set('giveaways', messageId, g);
  const ch = client.channels.cache.get(g.channelId);
  const msg = await ch?.messages.fetch(messageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [embed(g)], components: buttons(g) }).catch(() => {});
  if (ch) {
    await ch.send({
      content: g.winners.length ? `🎉 Glückwunsch ${g.winners.map(id => `<@${id}>`).join(', ')}! Ihr habt **${g.prize}** gewonnen!` : `Für **${g.prize}** gab es leider keine Teilnehmer.`,
      allowedMentions: { users: g.winners },
      reply: msg ? { messageReference: messageId, failIfNotExists: false } : undefined,
    }).catch(() => {});
  }
  return g;
}

async function reroll(client, messageId, count = 1) {
  const g = store.get('giveaways', messageId);
  if (!g || !g.ended) return null;
  const pool = { ...g, entries: g.entries.filter(id => !g.winners.includes(id)) };
  const winners = draw(pool, count);
  const ch = client.channels.cache.get(g.channelId);
  if (ch) await ch.send({ content: winners.length ? `🎲 Neu ausgelost: ${winners.map(id => `<@${id}>`).join(', ')} gewinnt **${g.prize}**!` : 'Keine weiteren Teilnehmer zum Auslosen.', allowedMentions: { users: winners } }).catch(() => {});
  return winners;
}

async function onJoin(interaction) {
  const g = store.get('giveaways', interaction.message.id);
  if (!g || g.ended) return respond(interaction, err('Dieses Gewinnspiel ist vorbei.'));
  if (g.requiredRole && !interaction.member.roles.cache.has(g.requiredRole)) return respond(interaction, err(`Du brauchst die Rolle <@&${g.requiredRole}>, um teilzunehmen.`));
  const i = g.entries.indexOf(interaction.user.id);
  if (i >= 0) g.entries.splice(i, 1); else g.entries.push(interaction.user.id);
  store.set('giveaways', interaction.message.id, g);
  await interaction.message.edit({ embeds: [embed(g)], components: buttons(g) }).catch(() => {});
  return respond(interaction, i >= 0 ? ok('Du nimmst nicht mehr teil.') : ok(`Du bist dabei! Viel Glück 🍀 (${g.entries.length} Teilnehmer)`));
}

async function processTimers(client) {
  const now = Date.now();
  for (const [id, g] of store.entries('giveaways')) {
    if (!g.ended && g.endsAt <= now) await end(client, id).catch(e => console.error('[giveaway]', e.message));
    else if (g.ended && now - g.endsAt > 30 * 86_400_000) store.delete('giveaways', id); // nach 30 Tagen aufräumen
  }
}

module.exports = { start, end, reroll, onJoin, processTimers };
