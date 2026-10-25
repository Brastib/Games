'use strict';
/**
 * Extras: Auto-Antworten, Statistik-Kanäle, Vorschläge mit Abstimmung, Erinnerungen.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits: P } = require('discord.js');
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const { isStaff } = require('../lib/perms');
const { fillTemplate, truncate } = require('../lib/util');

// ---------------- Auto-Antworten ----------------
const arCooldown = new Map();
async function autoRespond(message) {
  if (!message.guild || message.author.bot || !message.content) return false;
  const list = getConfig(message.guild.id).autoresponders;
  if (!list.length) return false;
  const text = message.content.toLowerCase().trim();
  const hit = list.find(a => {
    const t = String(a.trigger || '').toLowerCase().trim();
    if (!t) return false;
    if (a.match === 'exact') return text === t;
    if (a.match === 'startswith') return text.startsWith(t);
    return new RegExp(`(^|\\W)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`, 'i').test(text);
  });
  if (!hit) return false;
  const k = `${message.channel.id}:${hit.trigger}`;
  if (Date.now() - (arCooldown.get(k) || 0) < 10_000) return false;
  arCooldown.set(k, Date.now());
  const content = fillTemplate(hit.response, { member: message.member });
  if (hit.reply !== false) await message.reply({ content, allowedMentions: { repliedUser: false, users: [message.author.id] } }).catch(() => {});
  else await message.channel.send({ content, allowedMentions: { users: [message.author.id] } }).catch(() => {});
  return true;
}

// ---------------- Statistik-Kanäle ----------------
const STAT_NAMES = {
  members: g => `👥 Mitglieder: ${g.memberCount.toLocaleString('de-DE')}`,
  humans: g => `🧑 Menschen: ${g.members.cache.filter(m => !m.user.bot).size.toLocaleString('de-DE')}`,
  boosts: g => `🚀 Boosts: ${g.premiumSubscriptionCount || 0}`,
};
async function setupStats(guild) {
  const cfg = getConfig(guild.id);
  const deny = [{ id: guild.roles.everyone.id, deny: [P.Connect] }, { id: guild.client.user.id, allow: [P.Connect, P.ManageChannels, P.ViewChannel] }];
  const cat = await guild.channels.create({ name: '📊 Server-Statistik', type: ChannelType.GuildCategory, position: 0 });
  for (const k of Object.keys(STAT_NAMES)) {
    const ch = await guild.channels.create({ name: STAT_NAMES[k](guild), type: ChannelType.GuildVoice, parent: cat.id, permissionOverwrites: deny });
    cfg.stats[k] = ch.id;
  }
  cfg.stats.enabled = true;
  cfg.stats.category = cat.id;
  saveConfig(guild.id);
  return cat;
}
async function updateStats(client) {
  for (const guild of client.guilds.cache.values()) {
    const s = getConfig(guild.id).stats;
    if (!s.enabled) continue;
    for (const k of Object.keys(STAT_NAMES)) {
      const ch = guild.channels.cache.get(s[k]);
      const name = STAT_NAMES[k](guild);
      if (ch && ch.name !== name) await ch.setName(name).catch(() => {});
    }
  }
}

// ---------------- Vorschläge ----------------
function suggestionPayload(s) {
  const status = { open: { t: '🗳️ Offen', c: COLORS.brand }, accepted: { t: '✅ Angenommen', c: COLORS.ok }, declined: { t: '❌ Abgelehnt', c: COLORS.err } }[s.status];
  const total = s.up.length + s.down.length || 1;
  const bar = n => '█'.repeat(Math.round((n / total) * 12)).padEnd(12, '░');
  const e = new EmbedBuilder().setColor(status.c).setAuthor({ name: `Vorschlag #${s.number} · ${status.t}` })
    .setDescription(`${s.text}\n\n👍 \`${bar(s.up.length)}\` **${s.up.length}**\n👎 \`${bar(s.down.length)}\` **${s.down.length}**`)
    .setFooter({ text: `Von ${s.authorTag}` }).setTimestamp(s.at);
  if (s.note) e.addFields({ name: 'Antwort vom Team', value: truncate(s.note, 1000) });
  const open = s.status === 'open';
  return {
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sg:up').setEmoji('👍').setStyle(ButtonStyle.Secondary).setDisabled(!open),
      new ButtonBuilder().setCustomId('sg:down').setEmoji('👎').setStyle(ButtonStyle.Secondary).setDisabled(!open),
      new ButtonBuilder().setCustomId('sg:accept').setLabel('Annehmen').setStyle(ButtonStyle.Secondary).setDisabled(!open),
      new ButtonBuilder().setCustomId('sg:decline').setLabel('Ablehnen').setStyle(ButtonStyle.Secondary).setDisabled(!open))],
  };
}
async function createSuggestion(interaction, text) {
  const cfg = getConfig(interaction.guild.id);
  const ch = interaction.guild.channels.cache.get(cfg.suggestions.channel) || interaction.channel;
  cfg.suggestions.counter = (cfg.suggestions.counter || 0) + 1;
  saveConfig(interaction.guild.id);
  const s = { number: cfg.suggestions.counter, text, authorId: interaction.user.id, authorTag: interaction.user.username, up: [], down: [], status: 'open', at: Date.now() };
  const msg = await ch.send(suggestionPayload(s));
  store.set('suggestions', msg.id, s);
  msg.startThread?.({ name: `Diskussion zu Vorschlag #${s.number}`.slice(0, 100) }).catch(() => {});
  return { msg, ch };
}
async function onSuggestionButton(interaction, action) {
  const s = store.get('suggestions', interaction.message.id);
  if (!s) return respond(interaction, err('Dieser Vorschlag ist nicht mehr gespeichert.'));
  if (action === 'accept' || action === 'decline') {
    if (!isStaff(interaction.member)) return respond(interaction, err('Nur das Team kann Vorschläge annehmen oder ablehnen.'));
    s.status = action === 'accept' ? 'accepted' : 'declined';
  } else {
    const me = interaction.user.id;
    s.up = s.up.filter(x => x !== me);
    s.down = s.down.filter(x => x !== me);
    (action === 'up' ? s.up : s.down).push(me);
  }
  store.set('suggestions', interaction.message.id, s);
  return interaction.update(suggestionPayload(s));
}

// ---------------- Erinnerungen ----------------
function addReminder(guildId, channelId, userId, text, at) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  store.set('reminders', id, { guildId, channelId, userId, text, at });
  return id;
}
async function processReminders(client) {
  const now = Date.now();
  for (const [id, r] of store.entries('reminders')) {
    if (r.at > now) continue;
    store.delete('reminders', id);
    const content = `⏰ <@${r.userId}>, du wolltest erinnert werden: **${truncate(r.text, 1500)}**`;
    const user = await client.users.fetch(r.userId).catch(() => null);
    const sent = user && await user.send(content).then(() => true).catch(() => false);
    if (!sent) {
      const ch = client.channels.cache.get(r.channelId);
      if (ch?.isTextBased()) await ch.send({ content, allowedMentions: { users: [r.userId] } }).catch(() => {});
    }
  }
}

module.exports = { autoRespond, setupStats, updateStats, createSuggestion, onSuggestionButton, addReminder, processReminders, ok };
