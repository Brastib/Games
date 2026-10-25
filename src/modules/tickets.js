'use strict';
/**
 * Ticket-System: Panel mit Button → privater Kanal für Mitglied + Support-Team.
 * Schließen erstellt ein Protokoll (Transkript) als Datei im Log-Kanal.
 */
const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, PermissionFlagsBits: P,
} = require('discord.js');
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond, EPHEMERAL } = require('../lib/embeds');
const { isStaff } = require('../lib/perms');
const { sendLog } = require('../lib/logger');
const { truncate } = require('../lib/util');

function panelMessage(title, description) {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle(title || '🎫 Support')
      .setDescription(description || 'Du brauchst Hilfe oder möchtest etwas melden?\nKlicke auf den Button – dann öffnet sich ein **privater Kanal** nur für dich und das Team.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tk:open').setLabel('Ticket öffnen').setEmoji('🎫').setStyle(ButtonStyle.Secondary))],
  };
}

async function setup(guild, { panelChannel, supportRole, category }) {
  const cfg = getConfig(guild.id);
  const cat = category || await guild.channels.create({
    name: '🎫 Tickets', type: ChannelType.GuildCategory,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }, { id: guild.client.user.id, allow: [P.ViewChannel, P.ManageChannels] }],
  });
  cfg.tickets.enabled = true;
  cfg.tickets.category = cat.id;
  if (supportRole) cfg.tickets.supportRoles = [supportRole.id];
  saveConfig(guild.id);
  await panelChannel.send(panelMessage());
  return cat;
}

function openTickets(guildId, userId) {
  return store.entries('tickets').filter(([, t]) => t.guildId === guildId && t.userId === userId);
}

async function onOpenButton(interaction) {
  const cfg = getConfig(interaction.guild.id).tickets;
  if (!cfg.enabled) return respond(interaction, err('Das Ticket-System ist gerade deaktiviert.'));
  const open = openTickets(interaction.guild.id, interaction.user.id).filter(([id]) => interaction.guild.channels.cache.has(id));
  if (open.length >= (cfg.maxOpen || 1)) return respond(interaction, err(`Du hast schon ein offenes Ticket: <#${open[0][0]}>`));
  const modal = new ModalBuilder().setCustomId('tkm:open').setTitle('Ticket öffnen').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('topic').setLabel('Worum geht es?').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true).setPlaceholder('Beschreibe kurz dein Anliegen …')));
  return interaction.showModal(modal);
}

async function onOpenModal(interaction) {
  const guild = interaction.guild;
  const cfg = getConfig(guild.id);
  const t = cfg.tickets;
  const topic = interaction.fields.getTextInputValue('topic');
  await interaction.deferReply({ flags: EPHEMERAL });
  t.counter = (t.counter || 0) + 1;
  saveConfig(guild.id);
  const number = String(t.counter).padStart(4, '0');
  const support = [...new Set([...t.supportRoles, ...cfg.modRoles])].filter(r => guild.roles.cache.has(r));
  const parent = guild.channels.cache.get(t.category);
  try {
    const channel = await guild.channels.create({
      name: `ticket-${number}`,
      type: ChannelType.GuildText,
      parent: parent?.id,
      topic: `Ticket von ${interaction.user.tag} · ${truncate(topic, 200)}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: interaction.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
        { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles] },
        ...support.map(id => ({ id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.ManageMessages] })),
      ],
    });
    store.set('tickets', channel.id, { guildId: guild.id, userId: interaction.user.id, number, topic, createdAt: Date.now(), claimedBy: null });
    await channel.send({
      content: `<@${interaction.user.id}> ${support.map(r => `<@&${r}>`).join(' ')}`,
      allowedMentions: { users: [interaction.user.id], roles: support },
      embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle(`🎫 Ticket #${number}`)
        .setDescription(`Hallo <@${interaction.user.id}>, das Team meldet sich gleich.\n\n**Anliegen:**\n${truncate(topic, 3500)}`)
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk:claim').setLabel('Übernehmen').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tk:close').setLabel('Schließen').setEmoji('🔒').setStyle(ButtonStyle.Danger))],
    });
    sendLog(guild, 'mod', new EmbedBuilder().setColor(COLORS.info).setDescription(`🎫 Ticket <#${channel.id}> (#${number}) geöffnet von <@${interaction.user.id}>`));
    return respond(interaction, ok(`Dein Ticket ist offen: <#${channel.id}>`));
  } catch (e) {
    return respond(interaction, err(`Ticket konnte nicht erstellt werden: ${e.message}`));
  }
}

async function onClaim(interaction) {
  const t = store.get('tickets', interaction.channel.id);
  if (!t) return respond(interaction, err('Das ist kein Ticket.'));
  if (!isStaff(interaction.member) && !getConfig(interaction.guild.id).tickets.supportRoles.some(r => interaction.member.roles.cache.has(r))) {
    return respond(interaction, err('Nur das Team kann Tickets übernehmen.'));
  }
  t.claimedBy = interaction.user.id;
  store.set('tickets', interaction.channel.id, t);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ok).setDescription(`🙋 <@${interaction.user.id}> kümmert sich um dieses Ticket.`)] });
}

async function onCloseButton(interaction) {
  const t = store.get('tickets', interaction.channel.id);
  if (!t) return respond(interaction, err('Das ist kein Ticket.'));
  return interaction.reply({
    content: 'Ticket wirklich schließen?',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tk:closeyes').setLabel('Ja, schließen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tk:closeno').setLabel('Abbrechen').setStyle(ButtonStyle.Secondary))],
    flags: EPHEMERAL,
  });
}

async function buildTranscript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 10; i++) { // bis zu 1000 Nachrichten
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse();
  const lines = all.map(m => {
    const time = new Date(m.createdTimestamp).toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' });
    const att = m.attachments.size ? ' ' + [...m.attachments.values()].map(a => `[Datei: ${a.url}]`).join(' ') : '';
    const emb = m.embeds.length ? ` [Embed: ${m.embeds.map(e => e.title || e.description?.slice(0, 80) || '').join(' | ')}]` : '';
    return `[${time}] ${m.author?.tag || 'Unbekannt'}: ${m.content}${att}${emb}`;
  });
  return lines.join('\n');
}

async function close(interaction, reason = 'Kein Grund angegeben') {
  const channel = interaction.channel;
  const t = store.get('tickets', channel.id);
  if (!t) return respond(interaction, err('Das ist kein Ticket.'));
  const isOwner = t.userId === interaction.user.id;
  if (!isOwner && !isStaff(interaction.member) && !getConfig(interaction.guild.id).tickets.supportRoles.some(r => interaction.member.roles.cache.has(r))) {
    return respond(interaction, err('Du darfst dieses Ticket nicht schließen.'));
  }
  if (interaction.isButton()) await interaction.update({ content: '🔒 Ticket wird geschlossen …', components: [] });
  else await respond(interaction, '🔒 Ticket wird geschlossen …', { ephemeral: false });
  const text = await buildTranscript(channel);
  const file = new AttachmentBuilder(Buffer.from(`Ticket #${t.number} · ${t.topic}\n${'='.repeat(40)}\n${text}\n`, 'utf8'), { name: `ticket-${t.number}.txt` });
  const cfg = getConfig(interaction.guild.id);
  const embed = new EmbedBuilder().setColor(COLORS.mod).setTitle(`🔒 Ticket #${t.number} geschlossen`)
    .setDescription(`**Von:** <@${t.userId}>\n**Geschlossen von:** <@${interaction.user.id}>\n**Übernommen von:** ${t.claimedBy ? `<@${t.claimedBy}>` : '–'}\n**Grund:** ${reason}`)
    .setTimestamp();
  const logCh = interaction.guild.channels.cache.get(cfg.tickets.logChannel);
  if (logCh?.isTextBased()) await logCh.send({ embeds: [embed], files: [file] }).catch(() => {});
  else await sendLog(interaction.guild, 'mod', { embeds: [embed], files: [file] });
  const user = await interaction.client.users.fetch(t.userId).catch(() => null);
  user?.send({ content: `Dein Ticket #${t.number} auf **${interaction.guild.name}** wurde geschlossen. Hier ist das Protokoll:`, files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `ticket-${t.number}.txt` })] }).catch(() => {});
  store.delete('tickets', channel.id);
  const archive = interaction.guild.channels.cache.get(cfg.tickets.archiveCategory);
  if (archive?.type === ChannelType.GuildCategory) {
    // Ins Archiv: nur noch lesbar für das Team, die Person sieht ihr Ticket nicht mehr
    setTimeout(() => toArchive(channel, archive, t).catch(e => console.error('[ticket-archiv]', e.message)), 3000);
    return;
  }
  setTimeout(() => channel.delete(`Ticket geschlossen von ${interaction.user.tag}`).catch(() => {}), 5000);
}

async function toArchive(channel, archive, t) {
  await channel.setParent(archive.id, { lockPermissions: true });
  await channel.setName(`archiv-${String(t.number).padStart(4, '0')}`).catch(() => {});
  await channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.mod).setDescription(`🗄️ Archiviert <t:${Math.floor(Date.now() / 1000)}:R>. Löschen: Knopf in <#${getConfig(channel.guild.id).tickets.archiveChannel}>.`)] }).catch(() => {});
}

/** Archiv-Kategorie (nur Team) + #archiv-verwaltung mit „Archiv leeren“-Knopf anlegen */
async function setupArchive(guild) {
  const cfg = getConfig(guild.id);
  const team = [...new Set([...cfg.tickets.supportRoles, ...cfg.modRoles])].filter(r => guild.roles.cache.has(r));
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.ReadMessageHistory] },
    ...team.map(id => ({ id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] })),
  ];
  let cat = guild.channels.cache.get(cfg.tickets.archiveCategory);
  if (!cat) cat = await guild.channels.create({ name: '🗄️ Ticket-Archiv', type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
  let mgmt = guild.channels.cache.get(cfg.tickets.archiveChannel);
  if (!mgmt) {
    mgmt = await guild.channels.create({ name: 'archiv-verwaltung', type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: overwrites });
    await mgmt.send({
      embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('🗄️ Ticket-Archiv').setDescription('Geschlossene Tickets landen hier und bleiben nachlesbar.\nMit dem Knopf werden **alle** archivierten Tickets auf einmal gelöscht.')],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tk:purge').setLabel('Archiv leeren').setEmoji('🗑️').setStyle(ButtonStyle.Danger))],
    });
  }
  cfg.tickets.archiveCategory = cat.id;
  cfg.tickets.archiveChannel = mgmt.id;
  saveConfig(guild.id);
  return { category: cat, channel: mgmt };
}

/** Alle archivierten Tickets löschen (die Verwaltung bleibt) */
async function purgeArchive(guild) {
  const cfg = getConfig(guild.id).tickets;
  const old = guild.channels.cache.filter(c => c.parentId === cfg.archiveCategory && c.id !== cfg.archiveChannel && c.type === ChannelType.GuildText);
  let n = 0;
  for (const c of old.values()) if (await c.delete('Ticket-Archiv geleert').then(() => true).catch(() => false)) n++;
  return n;
}

async function handleButton(interaction, action) {
  if (action === 'open') return onOpenButton(interaction);
  if (action === 'claim') return onClaim(interaction);
  if (action === 'close') return onCloseButton(interaction);
  if (action === 'closeyes') return close(interaction);
  if (action === 'closeno') return interaction.update({ content: 'Abgebrochen.', components: [] });
  if (action === 'purge') {
    if (!isStaff(interaction.member)) return respond(interaction, err('Nur das Team darf das Archiv leeren.'));
    await interaction.deferReply({ flags: EPHEMERAL });
    return respond(interaction, ok(`${await purgeArchive(interaction.guild)} archivierte Tickets gelöscht.`));
  }
}

module.exports = { setup, panelMessage, handleButton, onOpenModal, close, setupArchive, purgeArchive, toArchive };
