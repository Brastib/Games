'use strict';
/**
 * Rollen-Panels: Mitglieder holen sich Rollen per Button oder Auswahlmenü selbst.
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, TextDisplayBuilder, SeparatorBuilder, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const store = require('../lib/store');
const { COLORS, ok, err, respond, EPHEMERAL } = require('../lib/embeds');
const { chunk } = require('../lib/util');

const STYLE = { blau: ButtonStyle.Primary, grau: ButtonStyle.Secondary, gruen: ButtonStyle.Success, rot: ButtonStyle.Danger };

function components(panel) {
  if (!panel.roles.length) return [];
  if (panel.mode === 'select') {
    const menu = new StringSelectMenuBuilder().setCustomId('rps:pick').setPlaceholder('Rollen auswählen …')
      .setMinValues(0).setMaxValues(panel.unique ? 1 : panel.roles.length)
      .addOptions(panel.roles.map(r => ({ label: r.label.slice(0, 100), value: r.roleId, emoji: r.emoji || undefined })));
    return [new ActionRowBuilder().addComponents(menu)];
  }
  return chunk(panel.roles, 5).slice(0, 5).map(row => new ActionRowBuilder().addComponents(row.map(r => {
    const b = new ButtonBuilder().setCustomId(`rp:${r.roleId}`).setLabel(r.label.slice(0, 80)).setStyle(STYLE[r.style] || ButtonStyle.Secondary);
    if (r.emoji) b.setEmoji(r.emoji);
    return b;
  })));
}

function embed(panel) {
  return new EmbedBuilder().setColor(panel.color || COLORS.brand).setTitle(panel.title).setDescription(
    (panel.description ? panel.description + '\n\n' : '') +
    (panel.roles.length ? panel.roles.map(r => `${r.emoji ? r.emoji + ' ' : '• '}<@&${r.roleId}>`).join('\n') : '*Noch keine Rollen. Füge welche mit `/rolepanel add` hinzu.*') +
    (panel.unique ? '\n\n*Du kannst nur eine dieser Rollen gleichzeitig haben.*' : ''));
}

/**
 * Nachricht fürs Panel. Mit Banner (panel.banner) im neuen Discord-Layout: Banner-Bild oben, Text, Trennlinie, Knöpfe, Fußzeile.
 * Ohne Banner klassisch als Embed.
 */
async function render(panel) {
  if (!panel.banner) return { embeds: [embed(panel)], components: components(panel) };
  // Animiert (GIF) wenn möglich, sonst Standbild
  const cards = require('../lib/cards');
  const gif = await cards.bannerGif(panel.banner).catch(() => null);
  const png = gif ? null : await cards.bannerCard(panel.banner);
  const file = gif ? { buf: gif, name: 'banner.gif' } : png ? { buf: png, name: 'banner.png' } : null;
  const box = new ContainerBuilder().setAccentColor(panel.color || COLORS.brand);
  if (file) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`).setDescription(panel.banner.title)));
  else box.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${panel.banner.title}`));
  const lines = [];
  if (panel.title && panel.title.toLowerCase() !== String(panel.banner.title).toLowerCase()) lines.push(`**${panel.title}**`);
  lines.push(panel.description || 'Tippe auf einen Knopf, um die Rolle zu bekommen. Nochmal tippen = wieder weg.');
  if (panel.unique) lines.push('-# Du kannst nur eine dieser Rollen gleichzeitig haben.');
  box.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  box.addSeparatorComponents(new SeparatorBuilder());
  const rows = components(panel);
  if (rows.length) box.addActionRowComponents(...rows);
  else box.addTextDisplayComponents(new TextDisplayBuilder().setContent('*Noch keine Rollen. Füge welche mit `/rolepanel add` hinzu.*'));
  box.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# ETC. Bot · Rollen'));
  return { flags: MessageFlags.IsComponentsV2, components: [box], files: file ? [new AttachmentBuilder(file.buf, { name: file.name })] : [] };
}

async function create(channel, { title, description, mode, unique }) {
  const panel = { channelId: channel.id, guildId: channel.guild.id, title, description, mode, unique, roles: [] };
  const msg = await channel.send({ embeds: [embed(panel)], components: components(panel) });
  store.set('rolepanels', msg.id, panel);
  return msg;
}

async function refresh(guild, messageId) {
  const panel = store.get('rolepanels', messageId);
  const ch = guild.channels.cache.get(panel.channelId);
  const msg = await ch?.messages.fetch(messageId).catch(() => null);
  if (!msg) throw new Error('Panel-Nachricht nicht gefunden (gelöscht?)');
  const payload = await render(panel);
  await msg.edit(panel.banner ? { ...payload, attachments: [] } : payload); // altes Banner-Bild ersetzen
}

/**
 * Banner über ein bestehendes Panel setzen. Discord kann eine alte Nachricht nicht ins neue Layout umbauen,
 * deshalb wird das Panel neu gepostet (gleiche Knöpfe) und die alte Nachricht gelöscht.
 */
async function setBanner(guild, messageId, { title, caption, icon, text }) {
  const panel = store.get('rolepanels', messageId);
  if (!panel || panel.guildId !== guild.id) throw new Error('Unbekannte Panel-ID.');
  const ch = guild.channels.cache.get(panel.channelId);
  if (!ch) throw new Error('Kanal des Panels nicht gefunden.');
  await adopt(guild, messageId, panel);
  panel.banner = { title, caption: caption || null, icon: icon || null }; // leer = passend zum Titel
  if (text) { panel.description = text; panel.title = title; }
  const msg = await ch.send(await render(panel));
  store.set('rolepanels', msg.id, panel);
  store.delete('rolepanels', messageId);
  await ch.messages.fetch(messageId).then(m => m.delete()).catch(() => {});
  return msg;
}

/** Knöpfe, die schon auf der Nachricht sind, aber (noch) nicht im Speicher stehen, übernehmen – sonst würden sie beim nächsten Ändern verschwinden */
async function adopt(guild, messageId, panel) {
  const msg = await guild.channels.cache.get(panel.channelId)?.messages.fetch(messageId).catch(() => null);
  const byStyle = Object.fromEntries(Object.entries(STYLE).map(([k, v]) => [v, k]));
  const all = list => list.flatMap(c => [c, ...all(c.components || [])]); // auch Knöpfe im neuen Layout (in Containern)
  for (const c of all(msg?.components || [])) {
    const roleId = c.customId?.startsWith('rp:') ? c.customId.slice(3) : null;
    if (!roleId || panel.roles.some(r => r.roleId === roleId) || !guild.roles.cache.has(roleId)) continue;
    panel.roles.push({ roleId, label: c.label || guild.roles.cache.get(roleId).name, emoji: c.emoji?.id ? null : c.emoji?.name || null, style: byStyle[c.style] || 'grau' });
  }
}

async function addRole(guild, messageId, { role, label, emoji, style }) {
  const panel = store.get('rolepanels', messageId);
  if (!panel || panel.guildId !== guild.id) throw new Error('Unbekannte Panel-ID. Nimm die Nachrichten-ID des Panels (Rechtsklick/gedrückt halten → ID kopieren).');
  await adopt(guild, messageId, panel);
  if (panel.roles.length >= 25) throw new Error('Maximal 25 Rollen pro Panel.');
  if (!role.editable) throw new Error(`Ich kann ${role} nicht vergeben – meine Rolle muss darüber stehen.`);
  panel.roles = panel.roles.filter(r => r.roleId !== role.id);
  panel.roles.push({ roleId: role.id, label: label || role.name, emoji: emoji || null, style: style || 'grau' });
  store.set('rolepanels', messageId, panel);
  await refresh(guild, messageId);
}

async function removeRole(guild, messageId, roleId) {
  const panel = store.get('rolepanels', messageId);
  if (!panel || panel.guildId !== guild.id) throw new Error('Unbekannte Panel-ID.');
  await adopt(guild, messageId, panel);
  panel.roles = panel.roles.filter(r => r.roleId !== roleId);
  store.set('rolepanels', messageId, panel);
  await refresh(guild, messageId);
}

/** Einmalig nach dem Design-Wechsel (Rubin): rote Rollen-Knöpfe werden grau, alle Panels neu gezeichnet */
async function migrateDesign(client) {
  if (store.get('meta', 'design') === 'rubin') return 0;
  let n = 0;
  for (const [id, panel] of store.entries('rolepanels')) {
    const guild = client.guilds.cache.get(panel.guildId);
    if (!guild) continue;
    try {
      await adopt(guild, id, panel);
      for (const r of panel.roles) if (r.style === 'rot') r.style = 'grau';
      store.set('rolepanels', id, panel);
      await refresh(guild, id);
      n++;
    } catch (e) { console.warn(`[rollen-panel] ${id}: ${e.message}`); }
  }
  store.set('meta', 'design', 'rubin');
  return n;
}

async function onButton(interaction, roleId) {
  const panel = store.get('rolepanels', interaction.message.id);
  const member = interaction.member;
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return respond(interaction, err('Diese Rolle gibt es nicht mehr.'));
  try {
    // Dauerhafte Mitglieder-Rolle (Regeln-Knopf): nur einmal holen, nie wieder abgeben
    if (member.roles.cache.has(roleId) && require('./sticky').roleOf(interaction.guild)?.id === roleId) {
      return respond(interaction, ok(`Du hast ${role} schon – die Rolle bleibt dir dauerhaft.`));
    }
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, 'Rollen-Panel');
      return respond(interaction, ok(`Rolle ${role} entfernt.`));
    }
    if (panel?.unique) {
      const keep = require('./sticky').roleOf(interaction.guild)?.id;
      const others = panel.roles.map(r => r.roleId).filter(id => id !== roleId && id !== keep && member.roles.cache.has(id));
      if (others.length) await member.roles.remove(others, 'Rollen-Panel (nur eine erlaubt)');
    }
    await member.roles.add(roleId, 'Rollen-Panel');
    return respond(interaction, ok(`Rolle ${role} erhalten.`));
  } catch (e) {
    return respond(interaction, err(`Das hat nicht geklappt: ${e.message}`));
  }
}

async function onSelect(interaction) {
  const panel = store.get('rolepanels', interaction.message.id);
  if (!panel) return respond(interaction, err('Dieses Panel ist nicht mehr gespeichert.'));
  const member = interaction.member;
  const all = panel.roles.map(r => r.roleId);
  const wanted = new Set(interaction.values);
  const add = all.filter(id => wanted.has(id) && !member.roles.cache.has(id));
  const keep = require('./sticky').roleOf(interaction.guild)?.id; // dauerhafte Rolle nie abgeben
  const remove = all.filter(id => !wanted.has(id) && member.roles.cache.has(id) && id !== keep);
  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    if (add.length) await member.roles.add(add, 'Rollen-Panel');
    if (remove.length) await member.roles.remove(remove, 'Rollen-Panel');
  } catch (e) {
    return respond(interaction, err(`Das hat nicht geklappt: ${e.message}`));
  }
  return respond(interaction, ok(`Gespeichert. ${add.length ? `Neu: ${add.map(id => `<@&${id}>`).join(', ')}. ` : ''}${remove.length ? `Entfernt: ${remove.map(id => `<@&${id}>`).join(', ')}.` : ''}`));
}

/** „Deep Rock Galactic, Rocket League, @Repo“ → Rollen. Vergleicht ohne Groß/klein, Emojis und doppelte Leerzeichen. */
function parseRoleList(guild, text) {
  const norm = s => String(s || '').toLowerCase().replace(/<a?:\w+:\d+>/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const roles = [], missing = [];
  for (const part of String(text || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean)) {
    const id = /<@&(\d+)>/.exec(part)?.[1];
    const role = id ? guild.roles.cache.get(id) : guild.roles.cache.find(r => r.id !== guild.id && norm(r.name) === norm(part));
    if (role && !roles.includes(role)) roles.push(role); else if (!role) missing.push(part);
  }
  return { roles, missing };
}

/** Neuestes Rollen-Panel in einem Kanal (Nachrichten-IDs sind nach Zeit sortierbar) */
function latestIn(guildId, channelId) {
  const ids = store.entries('rolepanels').filter(([, p]) => p.guildId === guildId && p.channelId === channelId).map(([id]) => id);
  return ids.sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))[0] || null;
}

module.exports = { create, addRole, removeRole, adopt, migrateDesign, setBanner, render, embed, components, onButton, onSelect, latestIn, parseRoleList, STYLE };
