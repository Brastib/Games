'use strict';
/**
 * Temporäre Sprachkanäle ("Join to Create"):
 * Wer den Hub-Kanal betritt, bekommt einen eigenen Sprachkanal. Leer = automatisch gelöscht.
 * Steuerung über ein Bedienfeld mit Buttons (Umbenennen, Limit, Sperren, Verstecken, Erlauben, Rauswerfen, Übernehmen, Übertragen).
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, UserSelectMenuBuilder, OverwriteType, PermissionsBitField, PermissionFlagsBits: P,
} = require('discord.js');

const MEMBER = { type: OverwriteType.Member };
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond, EPHEMERAL } = require('../lib/embeds');
const { fillTemplate, truncate } = require('../lib/util');
const { sendLog } = require('../lib/logger');

const cooldown = new Map();
const OWNER_ALLOW = [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD, P.MoveMembers, P.ManageChannels, P.PrioritySpeaker, P.SendMessages];

function rec(channelId) { return store.get('tempvoice', channelId); }

function panelComponents() {
  const b = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`tv:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);
  return [
    new ActionRowBuilder().addComponents(b('rename', 'Umbenennen', '✏️'), b('limit', 'Limit', '👥'), b('lock', 'Sperren', '🔒'), b('unlock', 'Öffnen', '🔓')),
    new ActionRowBuilder().addComponents(b('hide', 'Verstecken', '🙈'), b('unhide', 'Zeigen', '👁️'), b('permit', 'Erlauben', '✅', ButtonStyle.Success), b('kick', 'Rauswerfen', '👢', ButtonStyle.Danger)),
    new ActionRowBuilder().addComponents(b('claim', 'Übernehmen', '👑', ButtonStyle.Primary), b('transfer', 'Übertragen', '🔁', ButtonStyle.Primary), b('info', 'Info', 'ℹ️')),
  ];
}

function panelEmbed(guild) {
  const cfg = getConfig(guild.id).tempvoice;
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🎛️ Sprachkanal-Steuerung')
    .setDescription([
      cfg.hub ? `Betritt <#${cfg.hub}>, um deinen **eigenen Sprachkanal** zu bekommen.` : 'Betritt den „Kanal erstellen“-Sprachkanal, um deinen eigenen Kanal zu bekommen.',
      'Solange du in deinem Kanal bist, steuerst du ihn mit den Buttons unten.',
      '',
      '✏️ **Umbenennen** · 👥 **Limit** setzen · 🔒 **Sperren** / 🔓 **Öffnen**',
      '🙈 **Verstecken** / 👁️ **Zeigen** · ✅ **Erlauben** (trotz Sperre) · 👢 **Rauswerfen**',
      '👑 **Übernehmen**, wenn der Besitzer weg ist · 🔁 **Übertragen** an jemand anderen',
      '',
      'Leere Kanäle werden automatisch gelöscht.',
    ].join('\n'));
}

async function sendPanel(channel) {
  return channel.send({ embeds: [panelEmbed(channel.guild)], components: panelComponents() });
}

/** Erstellt Kategorie, Hub-Kanal und Steuerungs-Kanal. */
async function setup(guild, { category = null } = {}) {
  const cfg = getConfig(guild.id);
  const cat = category || await guild.channels.create({ name: '🔊 Sprachkanäle', type: ChannelType.GuildCategory });
  const hub = await guild.channels.create({ name: '➕ Kanal erstellen', type: ChannelType.GuildVoice, parent: cat.id });
  // @everyone darf im Steuerungs-Kanal nicht schreiben, sonst gelten die Rechte der Kategorie
  const evOw = cat.permissionOverwrites.cache.get(guild.roles.everyone.id);
  const evDeny = new PermissionsBitField([P.SendMessages, P.AddReactions, P.CreatePublicThreads]).add(evOw?.deny ?? 0n);
  const evAllow = new PermissionsBitField(evOw?.allow ?? 0n).remove(evDeny);
  const panel = await guild.channels.create({
    name: '🎛️・sprachkanal-steuerung', type: ChannelType.GuildText, parent: cat.id,
    permissionOverwrites: [
      ...cat.permissionOverwrites.cache.filter(o => o.id !== guild.roles.everyone.id && o.id !== guild.client.user.id)
        .map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
      { id: guild.roles.everyone.id, allow: evAllow, deny: evDeny },
      { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
    ],
  });
  Object.assign(cfg.tempvoice, { enabled: true, hub: hub.id, category: cat.id, panelChannel: panel.id });
  saveConfig(guild.id);
  await sendPanel(panel);
  return { cat, hub, panel };
}

async function createFor(member) {
  const guild = member.guild;
  const cfg = getConfig(guild.id).tempvoice;
  const hub = guild.channels.cache.get(cfg.hub);
  const category = guild.channels.cache.get(cfg.category) || hub?.parent || null;

  // Spam-Schutz: nur alle 10 Sekunden ein neuer Kanal pro Person
  const last = cooldown.get(member.id) || 0;
  if (Date.now() - last < 10_000) {
    const own = store.entries('tempvoice').find(([, r]) => r.ownerId === member.id && r.guildId === guild.id);
    const ownCh = own && guild.channels.cache.get(own[0]);
    if (ownCh) await member.voice.setChannel(ownCh).catch(() => {});
    else await member.voice.disconnect('Zu schnell neue Kanäle erstellt').catch(() => {});
    return null;
  }
  cooldown.set(member.id, Date.now());

  const base = category ? category.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })) : [];
  const name = truncate(fillTemplate(cfg.nameTemplate || '🔊 {name}', { member }), 100);
  try {
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildVoice, parent: category?.id, userLimit: cfg.limit || 0,
      bitrate: Math.min(guild.maximumBitrate || 96000, 96000),
      permissionOverwrites: [
        ...base.filter(o => o.id !== member.id && o.id !== guild.client.user.id),
        { id: member.id, allow: OWNER_ALLOW },
        { id: guild.client.user.id, allow: [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers, P.ManageRoles] },
      ],
      reason: `Temporärer Sprachkanal für ${member.user.tag}`,
    });
    store.set('tempvoice', channel.id, { guildId: guild.id, ownerId: member.id, createdAt: Date.now() });
    await member.voice.setChannel(channel).catch(async () => {
      // Person ist schon wieder raus → Kanal direkt löschen
      await channel.delete().catch(() => {});
      store.delete('tempvoice', channel.id);
    });
    return channel;
  } catch (e) {
    console.error('[tempvoice] Erstellen fehlgeschlagen:', e.message);
    return null;
  }
}

async function onVoiceUpdate(oldState, newState) {
  const guild = newState.guild;
  const cfg = getConfig(guild.id).tempvoice;
  // Verlassen: leeren temporären Kanal löschen
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const r = rec(oldState.channelId);
    const ch = oldState.channel;
    if (r && ch && ch.members.filter(m => !m.user.bot).size === 0) {
      store.delete('tempvoice', ch.id);
      await ch.delete('Temporärer Sprachkanal ist leer').catch(() => {});
    }
  }
  // Beitreten: Hub → neuen Kanal erstellen
  if (cfg.enabled && newState.channelId && newState.channelId === cfg.hub && newState.member && !newState.member.user.bot) {
    await createFor(newState.member);
  }
}

/** Beim Start: verwaiste Einträge und leere Kanäle aufräumen. */
async function cleanup(client) {
  for (const [id, r] of store.entries('tempvoice')) {
    const guild = client.guilds.cache.get(r.guildId);
    const ch = guild?.channels.cache.get(id);
    if (!ch) { store.delete('tempvoice', id); continue; }
    if (ch.members.filter(m => !m.user.bot).size === 0) {
      store.delete('tempvoice', id);
      await ch.delete('Aufräumen nach Neustart').catch(() => {});
    }
  }
}

// ---------- Bedienfeld ----------
function ownedChannel(member, { allowAnyMember = false } = {}) {
  const ch = member.voice?.channel;
  if (!ch) return { error: 'Du musst dafür in deinem temporären Sprachkanal sein.' };
  const r = rec(ch.id);
  if (!r) return { error: 'Das funktioniert nur in temporären Sprachkanälen.' };
  if (!allowAnyMember && r.ownerId !== member.id) return { error: `Nur der Besitzer (<@${r.ownerId}>) kann das. Ist er weg, nutze **Übernehmen**.` };
  return { ch, r };
}

async function setFlagForAll(ch, key, value) {
  const everyoneId = ch.guild.roles.everyone.id;
  const ids = new Set([everyoneId, ...ch.permissionOverwrites.cache.filter(o => o.type === 0).map(o => o.id)]);
  for (const id of ids) {
    if (id === ch.client.user.id) continue;
    await ch.permissionOverwrites.edit(id, { [key]: value }).catch(() => {});
  }
}

async function setOwner(ch, oldOwnerId, newOwnerId) {
  if (oldOwnerId && oldOwnerId !== newOwnerId) await ch.permissionOverwrites.edit(oldOwnerId, { ManageChannels: null, MoveMembers: null, PrioritySpeaker: null }, MEMBER).catch(() => {});
  await ch.permissionOverwrites.edit(newOwnerId, Object.fromEntries(['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD', 'MoveMembers', 'ManageChannels', 'PrioritySpeaker', 'SendMessages'].map(k => [k, true])), MEMBER);
  const r = rec(ch.id);
  r.ownerId = newOwnerId;
  store.set('tempvoice', ch.id, r);
}

async function handleButton(interaction, action) {
  const member = interaction.member;
  if (action === 'claim' || action === 'info') {
    const o = ownedChannel(member, { allowAnyMember: true });
    if (o.error) return respond(interaction, err(o.error));
    if (action === 'info') {
      return respond(interaction, new EmbedBuilder().setColor(COLORS.brand).setTitle(`ℹ️ ${o.ch.name}`)
        .setDescription(`**Besitzer:** <@${o.r.ownerId}>\n**Limit:** ${o.ch.userLimit || 'keins'}\n**Mitglieder:** ${o.ch.members.size}\n**Erstellt:** <t:${Math.floor(o.r.createdAt / 1000)}:R>`));
    }
    if (o.r.ownerId === member.id) return respond(interaction, err('Das ist schon dein Kanal.'));
    if (o.ch.members.has(o.r.ownerId)) return respond(interaction, err(`Der Besitzer <@${o.r.ownerId}> ist noch im Kanal.`));
    await setOwner(o.ch, o.r.ownerId, member.id);
    return respond(interaction, ok(`Du bist jetzt Besitzer von **${o.ch.name}**.`));
  }

  const o = ownedChannel(member);
  if (o.error) return respond(interaction, err(o.error));
  const { ch } = o;

  switch (action) {
    case 'rename': {
      const modal = new ModalBuilder().setCustomId('tvm:rename').setTitle('Kanal umbenennen').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Neuer Name').setStyle(TextInputStyle.Short).setMaxLength(100).setValue(ch.name.slice(0, 100)).setRequired(true)));
      return interaction.showModal(modal);
    }
    case 'limit': {
      const modal = new ModalBuilder().setCustomId('tvm:limit').setTitle('Personen-Limit').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('limit').setLabel('Maximale Personen (0 = kein Limit, max. 99)').setStyle(TextInputStyle.Short).setMaxLength(2).setValue(String(ch.userLimit || 0)).setRequired(true)));
      return interaction.showModal(modal);
    }
    case 'lock':
      await setFlagForAll(ch, 'Connect', false);
      return respond(interaction, ok('Kanal **gesperrt**. Mit ✅ **Erlauben** lässt du einzelne Personen trotzdem rein.'));
    case 'unlock':
      await setFlagForAll(ch, 'Connect', null);
      return respond(interaction, ok('Kanal **geöffnet**.'));
    case 'hide':
      await setFlagForAll(ch, 'ViewChannel', false);
      return respond(interaction, ok('Kanal ist jetzt **unsichtbar** für andere.'));
    case 'unhide':
      await setFlagForAll(ch, 'ViewChannel', null);
      return respond(interaction, ok('Kanal ist wieder **sichtbar**.'));
    case 'permit':
    case 'kick':
    case 'transfer': {
      const labels = { permit: 'Wen möchtest du reinlassen?', kick: 'Wen möchtest du rauswerfen?', transfer: 'An wen übertragen?' };
      const menu = new UserSelectMenuBuilder().setCustomId(`tvs:${action}`).setPlaceholder(labels[action]).setMinValues(1).setMaxValues(action === 'transfer' ? 1 : 10);
      return interaction.reply({ content: labels[action], components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
    }
    default:
      return respond(interaction, err('Unbekannte Aktion.'));
  }
}

async function handleModal(interaction, action) {
  const o = ownedChannel(interaction.member);
  if (o.error) return respond(interaction, err(o.error));
  if (action === 'rename') {
    const name = interaction.fields.getTextInputValue('name').trim();
    await interaction.deferReply({ flags: EPHEMERAL });
    // Discord erlaubt nur 2 Umbenennungen pro 10 Minuten pro Kanal
    const result = await Promise.race([o.ch.setName(name).then(() => 'ok').catch(e => e.message), new Promise(r => setTimeout(() => r('wait'), 6000))]);
    if (result === 'ok') return respond(interaction, ok(`Kanal heißt jetzt **${name}**.`));
    if (result === 'wait') return respond(interaction, ok('Discord erlaubt nur 2 Umbenennungen in 10 Minuten. Der neue Name wird übernommen, sobald es wieder geht.'));
    return respond(interaction, err(`Umbenennen fehlgeschlagen: ${result}`));
  }
  if (action === 'limit') {
    const n = parseInt(interaction.fields.getTextInputValue('limit'), 10);
    if (Number.isNaN(n) || n < 0 || n > 99) return respond(interaction, err('Bitte eine Zahl von 0 bis 99 eingeben.'));
    await o.ch.setUserLimit(n);
    return respond(interaction, ok(n ? `Limit auf **${n}** Personen gesetzt.` : 'Limit entfernt.'));
  }
}

async function handleSelect(interaction, action) {
  const o = ownedChannel(interaction.member);
  if (o.error) return interaction.update({ content: '❌ ' + o.error, components: [] });
  const ids = interaction.values.filter(id => id !== interaction.user.id);
  if (!ids.length) return interaction.update({ content: '❌ Wähle jemand anderen als dich selbst aus.', components: [] });
  if (action === 'permit') {
    for (const id of ids) await o.ch.permissionOverwrites.edit(id, { ViewChannel: true, Connect: true }, MEMBER).catch(() => {});
    return interaction.update({ content: `✅ ${ids.map(id => `<@${id}>`).join(', ')} darf jetzt rein.`, components: [] });
  }
  if (action === 'kick') {
    for (const id of ids) {
      await o.ch.permissionOverwrites.edit(id, { Connect: false }, MEMBER).catch(() => {});
      const m = o.ch.members.get(id);
      if (m) await m.voice.disconnect('Aus temporärem Kanal geworfen').catch(() => {});
    }
    return interaction.update({ content: `👢 ${ids.map(id => `<@${id}>`).join(', ')} wurde rausgeworfen und kann nicht mehr beitreten.`, components: [] });
  }
  if (action === 'transfer') {
    const target = await interaction.guild.members.fetch(ids[0]).catch(() => null);
    if (!target || target.user.bot) return interaction.update({ content: '❌ Diese Person kann den Kanal nicht übernehmen.', components: [] });
    await setOwner(o.ch, o.r.ownerId, target.id);
    sendLog(interaction.guild, 'voice', new EmbedBuilder().setColor(COLORS.info).setDescription(`🔁 <@${interaction.user.id}> hat **${o.ch.name}** an <@${target.id}> übertragen.`));
    return interaction.update({ content: `🔁 <@${target.id}> ist jetzt Besitzer.`, components: [] });
  }
}

module.exports = { setup, sendPanel, onVoiceUpdate, cleanup, handleButton, handleModal, handleSelect, rec, ownedChannel, setFlagForAll, setOwner };
