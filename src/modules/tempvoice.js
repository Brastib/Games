'use strict';
/**
 * Temporäre Sprachkanäle ("Join to Create"), Version 2:
 *  - Beliebig viele Hub-Kanäle (im Web-Dashboard oder per /setup tempvoice einstellbar), jeder mit eigener Kategorie/Name/Limit
 *  - Das Bedienfeld erscheint direkt im Text-Chat des neuen Sprachkanals
 *  - Besitzer kann umbenennen, Limit/Bitrate/Region setzen, sperren, verstecken, erlauben, rauswerfen, bannen, entbannen, übertragen
 *  - Name, Limit und Bannliste werden pro Person gemerkt und beim nächsten Kanal automatisch übernommen
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, UserSelectMenuBuilder, StringSelectMenuBuilder, OverwriteType, PermissionsBitField, PermissionFlagsBits: P,
} = require('discord.js');
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond, EPHEMERAL } = require('../lib/embeds');
const { fillTemplate, truncate, ts } = require('../lib/util');
const { sendLog } = require('../lib/logger');

const MEMBER = { type: OverwriteType.Member };
const cooldown = new Map();
const OWNER_ALLOW = [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD, P.MoveMembers, P.ManageChannels, P.PrioritySpeaker, P.SendMessages, P.ReadMessageHistory, P.UseSoundboard];
const OWNER_KEYS = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD', 'MoveMembers', 'ManageChannels', 'PrioritySpeaker', 'SendMessages', 'ReadMessageHistory'];

const rec = channelId => store.get('tempvoice', channelId);
const saveRec = (channelId, r) => store.set('tempvoice', channelId, r);
const prefKey = (g, u) => `${g}:${u}`;
const getPrefs = (g, u) => ({ name: null, limit: null, banned: [], ...(store.get('tvprefs', prefKey(g, u)) || {}) });
const setPrefs = (g, u, p) => store.set('tvprefs', prefKey(g, u), p);

function hubsOf(guildId) { return getConfig(guildId).tempvoice.hubs || []; }

// ---------------- Bedienfeld (Aufbau wie beim bisherigen ETC. Bot) ----------------
function panelEmbed(ch, r) {
  const status = [
    `👑 <@${r.ownerId}>`,
    r.locked ? '🔒 gesperrt' : '🔓 offen',
    r.hidden ? '🙈 versteckt' : null,
    `👥 ${ch.userLimit || '∞'}`,
    r.timerAt ? `⏱️ löscht sich <t:${Math.floor(r.timerAt / 1000)}:R>` : null,
  ].filter(Boolean).join(' · ');
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🎙️ Dein temporärer Sprachkanal')
    .setDescription(`Willkommen, <@${r.ownerId}>! Das ist dein persönlicher Sprachkanal.\nNutze die Buttons unten, um ihn zu verwalten.\n\n${status}`)
    .addFields(
      { name: '⚡ Schnellzugriff', value: 'Schnellladen · Umbenennen · User-Limit · Sperren · Verstecken' },
      { name: '👥 Mitglieder & Extras', value: 'Zutritt · Kicken · Bannen · Timer · Aktivitäten · Musik' },
      { name: '💾 Verwaltung', value: 'Besitzer · Speichern · Laden · Löschen' },
    )
    .setFooter({ text: 'ETC. Bot' });
}

function panelComponents(r = {}) {
  const b = (id, label, style) => new ButtonBuilder().setCustomId(`tv:${id}`).setLabel(label).setStyle(style);
  // Rot-Schwarz: Rot = Hauptaktion, aktiver Zustand oder Rauswurf; alles andere grau
  const { Danger: RED, Secondary: GREY } = ButtonStyle;
  return [
    new ActionRowBuilder().addComponents(
      b('quickload', 'Schnellladen', RED), b('rename', 'Umbenennen', GREY), b('limit', 'User-Limit', GREY),
      r.locked ? b('unlock', 'Entsperren', RED) : b('lock', 'Sperren', GREY),
      r.hidden ? b('unhide', 'Zeigen', RED) : b('hide', 'Verstecken', GREY)),
    new ActionRowBuilder().addComponents(
      b('permit', 'Zutritt erlauben', GREY), b('kick', 'Kicken', RED), b('ban', 'Bannen', RED), b('unban', 'Entbannen', GREY), b('claim', 'Übernehmen', GREY)),
    new ActionRowBuilder().addComponents(
      b('timer', r.timerAt ? 'Timer ⏱️' : 'Timer', r.timerAt ? RED : GREY), b('activity', 'Aktivität', GREY), b('music', 'Musik', GREY), b('bitrate', 'Bitrate', GREY), b('region', 'Region', GREY)),
    new ActionRowBuilder().addComponents(
      b('transfer', 'Besitzer übertragen', GREY), b('save', 'Speichern', GREY), b('load', 'Laden', GREY), b('info', 'Info', GREY), b('delete', 'Kanal löschen', RED)),
  ];
}

/** Allgemeines Bedienfeld für einen separaten Steuerungs-Kanal */
function globalPanelEmbed(guild) {
  const hubs = hubsOf(guild.id);
  return new EmbedBuilder().setColor(COLORS.brand).setTitle('🎙️ Temporäre Sprachkanäle').setDescription([
    hubs.length ? `Betritt ${hubs.map(h => `<#${h.id}>`).join(' oder ')}, um deinen **eigenen Sprachkanal** zu bekommen.` : 'Betritt einen „Kanal erstellen“-Sprachkanal.',
    'Das Bedienfeld erscheint direkt im Chat deines Sprachkanals. Die Buttons hier funktionieren, während du in deinem Kanal bist.',
  ].join('\n'))
    .addFields(
      { name: '⚡ Schnellzugriff', value: 'Schnellladen · Umbenennen · User-Limit · Sperren · Verstecken' },
      { name: '👥 Mitglieder & Extras', value: 'Zutritt · Kicken · Bannen · Timer · Aktivitäten · Musik' },
      { name: '💾 Verwaltung', value: 'Besitzer · Speichern · Laden · Löschen' },
    )
    .setFooter({ text: 'ETC. Bot' });
}

async function sendPanel(channel) {
  return channel.send({ embeds: [globalPanelEmbed(channel.guild)], components: panelComponents() });
}

async function refreshPanel(ch) {
  const r = rec(ch.id);
  if (!r?.panelId) return;
  const msg = await ch.messages?.fetch(r.panelId).catch(() => null);
  if (msg) await msg.edit({ embeds: [panelEmbed(ch, r)], components: panelComponents(r) }).catch(() => {});
}

// ---------------- Einrichten ----------------
async function setup(guild, { category = null, nameTemplate, limit, globalPanel = true } = {}) {
  const cfg = getConfig(guild.id);
  const cat = category || await guild.channels.create({ name: '🔊 Sprachkanäle', type: ChannelType.GuildCategory });
  const hub = await guild.channels.create({ name: '➕ Kanal erstellen', type: ChannelType.GuildVoice, parent: cat.id });
  addHub(guild.id, { id: hub.id, category: cat.id, nameTemplate: nameTemplate || cfg.tempvoice.nameTemplate, limit: limit ?? cfg.tempvoice.limit });
  let panel = null;
  if (globalPanel) {
    const evOw = cat.permissionOverwrites.cache.get(guild.roles.everyone.id);
    const evDeny = new PermissionsBitField([P.SendMessages, P.AddReactions, P.CreatePublicThreads]).add(evOw?.deny ?? 0n);
    const evAllow = new PermissionsBitField(evOw?.allow ?? 0n).remove(evDeny);
    panel = await guild.channels.create({
      name: '🎛️・sprachkanal-steuerung', type: ChannelType.GuildText, parent: cat.id,
      permissionOverwrites: [
        ...cat.permissionOverwrites.cache.filter(o => o.id !== guild.roles.everyone.id && o.id !== guild.client.user.id)
          .map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
        { id: guild.roles.everyone.id, allow: evAllow, deny: evDeny },
        { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
      ],
    });
    cfg.tempvoice.panelChannel = panel.id;
    await sendPanel(panel);
  }
  cfg.tempvoice.enabled = true;
  saveConfig(guild.id);
  return { cat, hub, panel };
}

function addHub(guildId, hub) {
  const cfg = getConfig(guildId);
  cfg.tempvoice.hubs = cfg.tempvoice.hubs.filter(h => h.id !== hub.id);
  cfg.tempvoice.hubs.push({ id: hub.id, category: hub.category || null, nameTemplate: hub.nameTemplate || '🔊 {name}', limit: hub.limit || 0 });
  cfg.tempvoice.enabled = true;
  saveConfig(guildId);
}
function removeHub(guildId, hubId) {
  const cfg = getConfig(guildId);
  cfg.tempvoice.hubs = cfg.tempvoice.hubs.filter(h => h.id !== hubId);
  if (cfg.tempvoice.hub === hubId) cfg.tempvoice.hub = null;
  saveConfig(guildId);
}

// ---------------- Erstellen / Löschen ----------------
async function createFor(member, hub) {
  const guild = member.guild;
  const cfg = getConfig(guild.id).tempvoice;
  const hubCh = guild.channels.cache.get(hub.id);
  const category = guild.channels.cache.get(hub.category) || hubCh?.parent || null;

  const last = cooldown.get(member.id) || 0;
  if (Date.now() - last < 8000) {
    const own = store.entries('tempvoice').find(([, r]) => r.ownerId === member.id && r.guildId === guild.id);
    const ownCh = own && guild.channels.cache.get(own[0]);
    if (ownCh) await member.voice.setChannel(ownCh).catch(() => {});
    else await member.voice.disconnect('Zu schnell neue Kanäle erstellt').catch(() => {});
    return null;
  }
  cooldown.set(member.id, Date.now());

  const prefs = getPrefs(guild.id, member.id);
  const base = category ? category.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })) : [];
  const banned = (prefs.banned || []).filter(id => id !== member.id);
  const name = truncate(prefs.name || fillTemplate(hub.nameTemplate || cfg.nameTemplate || '🔊 {name}', { member }), 100);
  try {
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildVoice, parent: category?.id,
      userLimit: prefs.limit ?? hub.limit ?? 0,
      bitrate: Math.min(guild.maximumBitrate || 96000, 96000),
      permissionOverwrites: [
        ...base.filter(o => o.id !== member.id && o.id !== guild.client.user.id && !banned.includes(o.id)),
        { id: member.id, type: OverwriteType.Member, allow: OWNER_ALLOW },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.Connect, P.Speak, P.ManageChannels, P.MoveMembers, P.ManageRoles, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory] },
        ...banned.map(id => ({ id, type: OverwriteType.Member, deny: [P.Connect, P.ViewChannel] })),
      ],
      reason: `Temporärer Sprachkanal für ${member.user.tag}`,
    });
    const r = { guildId: guild.id, ownerId: member.id, hubId: hub.id, createdAt: Date.now(), locked: false, hidden: false, banned, panelId: null };
    saveRec(channel.id, r);
    try {
      await member.voice.setChannel(channel);
    } catch {
      await channel.delete().catch(() => {});
      store.delete('tempvoice', channel.id);
      return null;
    }
    if (cfg.panelInChat !== false) {
      const msg = await channel.send({ content: `<@${member.id}>`, embeds: [panelEmbed(channel, r)], components: panelComponents(r), allowedMentions: { users: [member.id] } }).catch(() => null);
      if (msg) { r.panelId = msg.id; saveRec(channel.id, r); }
    }
    require('./quests').progress(member, 'tempvoice', 1);
    return channel;
  } catch (e) {
    console.error('[tempvoice] Erstellen fehlgeschlagen:', e.message);
    return null;
  }
}

async function onVoiceUpdate(oldState, newState) {
  const guild = newState.guild;
  const cfg = getConfig(guild.id).tempvoice;
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const r = rec(oldState.channelId);
    const ch = oldState.channel;
    if (r && ch && ch.members.filter(m => !m.user.bot).size === 0) {
      store.delete('tempvoice', ch.id);
      await ch.delete('Temporärer Sprachkanal ist leer').catch(() => {});
    }
  }
  if (!cfg.enabled || !newState.channelId || !newState.member || newState.member.user.bot) return;
  const hub = cfg.hubs.find(h => h.id === newState.channelId);
  if (hub) await createFor(newState.member, hub);
}

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

// ---------------- Aktionen (für Buttons und /voice) ----------------
/** Findet den Kanal: im Chat eines Temp-Kanals = dieser Kanal, sonst der Sprachkanal, in dem man gerade ist. */
function resolve(interaction, { mustOwn = true } = {}) {
  let ch = null;
  if (interaction.channel && rec(interaction.channel.id)) ch = interaction.channel;
  else if (interaction.member?.voice?.channel && rec(interaction.member.voice.channel.id)) ch = interaction.member.voice.channel;
  if (!ch) return { error: 'Benutze das im Chat deines temporären Sprachkanals oder während du darin bist.' };
  const r = rec(ch.id);
  if (mustOwn && r.ownerId !== interaction.user.id) return { error: `Nur der Besitzer (<@${r.ownerId}>) kann das. Ist er weg, nutze **👑 Übernehmen**.` };
  return { ch, r };
}

/** Rollen-Rechte (inkl. @everyone) setzen. Einzeln erlaubte Personen behalten ihren Zugang. */
async function setFlagForAll(ch, key, value) {
  const ids = new Set([ch.guild.roles.everyone.id, ...ch.permissionOverwrites.cache.filter(o => o.type === OverwriteType.Role).map(o => o.id)]);
  for (const id of ids) await ch.permissionOverwrites.edit(id, { [key]: value }).catch(() => {});
}

const actions = {
  async rename(ch, r, name) {
    const p = getPrefs(ch.guild.id, r.ownerId); p.name = name; setPrefs(ch.guild.id, r.ownerId, p);
    return Promise.race([ch.setName(name).then(() => 'ok').catch(e => e.message), new Promise(res => setTimeout(() => res('wait'), 6000))]);
  },
  async limit(ch, r, n) {
    await ch.setUserLimit(n);
    const p = getPrefs(ch.guild.id, r.ownerId); p.limit = n; setPrefs(ch.guild.id, r.ownerId, p);
  },
  async lock(ch, r, on) { await setFlagForAll(ch, 'Connect', on ? false : null); r.locked = on; saveRec(ch.id, r); },
  async hide(ch, r, on) { await setFlagForAll(ch, 'ViewChannel', on ? false : null); r.hidden = on; saveRec(ch.id, r); },
  async permit(ch, r, ids) {
    for (const id of ids) {
      await ch.permissionOverwrites.edit(id, { ViewChannel: true, Connect: true }, MEMBER).catch(() => {});
      r.banned = (r.banned || []).filter(x => x !== id);
    }
    saveRec(ch.id, r);
  },
  async kick(ch, r, ids) {
    for (const id of ids) await ch.members.get(id)?.voice.disconnect('Aus temporärem Kanal geworfen').catch(() => {});
  },
  async ban(ch, r, ids) {
    const p = getPrefs(ch.guild.id, r.ownerId);
    r.banned ||= [];
    for (const id of ids) {
      await ch.permissionOverwrites.edit(id, { Connect: false, ViewChannel: false }, MEMBER).catch(() => {});
      await ch.members.get(id)?.voice.disconnect('Aus temporärem Kanal gebannt').catch(() => {});
      if (!r.banned.includes(id)) r.banned.push(id);
      if (!p.banned.includes(id)) p.banned.push(id);
    }
    p.banned = p.banned.slice(-50);
    saveRec(ch.id, r); setPrefs(ch.guild.id, r.ownerId, p);
  },
  async unban(ch, r, ids) {
    const p = getPrefs(ch.guild.id, r.ownerId);
    for (const id of ids) {
      await ch.permissionOverwrites.delete(id).catch(() => {});
      r.banned = (r.banned || []).filter(x => x !== id);
      p.banned = p.banned.filter(x => x !== id);
    }
    saveRec(ch.id, r); setPrefs(ch.guild.id, r.ownerId, p);
  },
  async transfer(ch, r, newOwnerId) {
    if (r.ownerId !== newOwnerId) await ch.permissionOverwrites.edit(r.ownerId, { ManageChannels: null, MoveMembers: null, PrioritySpeaker: null }, MEMBER).catch(() => {});
    await ch.permissionOverwrites.edit(newOwnerId, Object.fromEntries(OWNER_KEYS.map(k => [k, true])), MEMBER);
    r.ownerId = newOwnerId;
    saveRec(ch.id, r);
  },
  async reset(ch, r) {
    const keep = getPrefs(ch.guild.id, r.ownerId);
    setPrefs(ch.guild.id, r.ownerId, { ...keep, name: null, limit: null, banned: [] });
    for (const id of r.banned || []) await ch.permissionOverwrites.delete(id).catch(() => {});
    await setFlagForAll(ch, 'Connect', null);
    await setFlagForAll(ch, 'ViewChannel', null);
    await ch.setUserLimit(0).catch(() => {});
    Object.assign(r, { locked: false, hidden: false, banned: [] });
    saveRec(ch.id, r);
  },
};

// ---------------- Profile: Speichern / Laden / Schnellladen ----------------
/** Aktuelle Einstellungen des Kanals als Profil */
function capture(ch, r) {
  const permitted = ch.permissionOverwrites.cache
    .filter(o => o.type === OverwriteType.Member && o.id !== r.ownerId && o.id !== ch.client.user.id && o.allow.has(P.Connect))
    .map(o => o.id);
  return { name: ch.name, limit: ch.userLimit || 0, bitrate: ch.bitrate, region: ch.rtcRegion || null, locked: !!r.locked, hidden: !!r.hidden, permitted, banned: [...(r.banned || [])] };
}

/** Profil auf den Kanal anwenden */
async function applyProfile(ch, r, data) {
  const done = [];
  if (data.name && data.name !== ch.name) { const res = await actions.rename(ch, r, data.name); done.push(res === 'ok' ? `Name „${data.name}“` : 'Name (folgt gleich, Discord-Limit)'); }
  if ((data.limit ?? 0) !== ch.userLimit) { await actions.limit(ch, r, data.limit ?? 0); done.push(`Limit ${data.limit || '∞'}`); }
  if (data.bitrate && data.bitrate !== ch.bitrate) { await ch.setBitrate(Math.min(data.bitrate, ch.guild.maximumBitrate || 96000)).catch(() => {}); done.push('Bitrate'); }
  if ((data.region || null) !== (ch.rtcRegion || null)) { await ch.setRTCRegion(data.region || null).catch(() => {}); done.push('Region'); }
  if (!!data.locked !== !!r.locked) { await actions.lock(ch, r, !!data.locked); done.push(data.locked ? 'gesperrt' : 'offen'); }
  if (!!data.hidden !== !!r.hidden) { await actions.hide(ch, r, !!data.hidden); done.push(data.hidden ? 'versteckt' : 'sichtbar'); }
  if (data.permitted?.length) { await actions.permit(ch, r, data.permitted); done.push(`${data.permitted.length} erlaubt`); }
  const newBans = (data.banned || []).filter(id => !(r.banned || []).includes(id) && id !== r.ownerId);
  if (newBans.length) { await actions.ban(ch, r, newBans); done.push(`${newBans.length} gebannt`); }
  return done;
}

function saveProfile(guildId, ownerId, name, data) {
  const p = getPrefs(guildId, ownerId);
  p.profiles = (p.profiles || []).filter(x => x.name.toLowerCase() !== name.toLowerCase());
  p.profiles.unshift({ name, data, savedAt: Date.now() });
  p.profiles = p.profiles.slice(0, 5);
  p.quick = name;
  setPrefs(guildId, ownerId, p);
  return p.profiles.length;
}

// ---------------- Timer: Kanal löscht sich nach einer Zeit ----------------
async function processTimers(client) {
  const now = Date.now();
  for (const [id, r] of store.entries('tempvoice')) {
    if (!r.timerAt) continue;
    const ch = client.guilds.cache.get(r.guildId)?.channels.cache.get(id);
    if (!ch) { store.delete('tempvoice', id); continue; }
    if (now >= r.timerAt) {
      store.delete('tempvoice', id);
      await ch.delete('Timer des temporären Sprachkanals abgelaufen').catch(() => {});
    } else if (!r.timerWarned && r.timerAt - now <= 60_000) {
      r.timerWarned = true;
      saveRec(id, r);
      await ch.send(`⏱️ Dieser Kanal löscht sich <t:${Math.floor(r.timerAt / 1000)}:R>. Timer verlängern: **Timer**-Knopf.`).catch(() => {});
    }
  }
}

// ---------------- Interaktionen ----------------
const SELECT_TEXT = {
  permit: 'Wen möchtest du reinlassen (auch wenn gesperrt)?',
  kick: 'Wen möchtest du rauswerfen?',
  ban: 'Wen möchtest du bannen? (kann nicht mehr beitreten oder den Kanal sehen)',
  transfer: 'An wen möchtest du den Kanal übergeben?',
};

function inChannel(interaction, ch) {
  return ch.members.has(interaction.user.id);
}

async function handleButton(interaction, action) {
  // Für alle im Kanal: Info, Übernehmen, Aktivität, Musik
  if (['claim', 'info', 'activity', 'music'].includes(action)) {
    const o = resolve(interaction, { mustOwn: false });
    if (o.error) return respond(interaction, err(o.error));
    const { ch, r } = o;
    if (action === 'info') {
      return respond(interaction, new EmbedBuilder().setColor(COLORS.brand).setTitle(`ℹ️ ${ch.name}`)
        .setDescription(`**Besitzer:** <@${r.ownerId}>\n**Mitglieder:** ${ch.members.size}${ch.userLimit ? '/' + ch.userLimit : ''}\n**Bitrate:** ${Math.round(ch.bitrate / 1000)} kbps · **Region:** ${ch.rtcRegion || 'automatisch'}\n**Erstellt:** ${ts(r.createdAt)}${r.timerAt ? `\n**Löscht sich:** ${ts(r.timerAt)}` : ''}\n**Gebannt:** ${r.banned?.length ? r.banned.map(id => `<@${id}>`).join(' ') : '–'}`));
    }
    if (action === 'claim') {
      if (r.ownerId === interaction.user.id) return respond(interaction, err('Das ist schon dein Kanal.'));
      if (ch.members.has(r.ownerId)) return respond(interaction, err(`Der Besitzer <@${r.ownerId}> ist noch im Kanal.`));
      if (!inChannel(interaction, ch)) return respond(interaction, err('Du musst im Kanal sein, um ihn zu übernehmen.'));
      await actions.transfer(ch, r, interaction.user.id);
      await refreshPanel(ch);
      return respond(interaction, ok(`Du bist jetzt Besitzer von **${ch.name}**.`));
    }
    if (!inChannel(interaction, ch)) return respond(interaction, err('Du musst dafür im Sprachkanal sein.'));
    if (action === 'music') {
      return interaction.showModal(new ModalBuilder().setCustomId('tvm:music').setTitle('Lied abspielen 🎵').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel('YouTube-Link / Direkt-Link / Songname').setStyle(TextInputStyle.Short)
          .setPlaceholder('https://www.youtube.com/watch?... oder Songtitel').setMaxLength(500).setRequired(true))));
    }
    const { ACTIVITIES } = require('../lib/activities');
    const menu = new StringSelectMenuBuilder().setCustomId(`tvu:activity:${ch.id}`).setPlaceholder('Aktivität wählen …')
      .addOptions(ACTIVITIES.slice(0, 25).map(a => ({ label: a.name.slice(0, 100), value: a.id, emoji: a.emoji })));
    return interaction.reply({ content: '🎮 Welche Aktivität soll in diesem Sprachkanal starten?', components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
  }

  const o = resolve(interaction);
  if (o.error) return respond(interaction, err(o.error));
  const { ch, r } = o;
  const modal = (id, title, label, value, max, placeholder) => {
    const input = new TextInputBuilder().setCustomId('v').setLabel(label).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true);
    if (value !== null && value !== undefined && String(value).length) input.setValue(String(value).slice(0, max));
    if (placeholder) input.setPlaceholder(placeholder);
    return interaction.showModal(new ModalBuilder().setCustomId(`tvm:${id}`).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input)));
  };

  switch (action) {
    case 'rename': return modal('rename', 'Kanal umbenennen', 'Neuer Name', ch.name, 100);
    case 'limit': return modal('limit', 'User-Limit', 'Maximale Personen (0 = kein Limit, max. 99)', ch.userLimit || 0, 2);
    case 'bitrate': return modal('bitrate', 'Bitrate', `kbps (8 bis ${Math.round((ch.guild.maximumBitrate || 96000) / 1000)})`, Math.round(ch.bitrate / 1000), 3);
    case 'timer': return modal('timer', 'Kanal-Timer', 'Kanal löschen in … Minuten (0 = Timer aus)', r.timerAt ? Math.max(1, Math.round((r.timerAt - Date.now()) / 60_000)) : 60, 4);
    case 'save': return modal('save', 'Einstellungen speichern', 'Name des Profils (max. 5 Profile)', getPrefs(ch.guild.id, r.ownerId).quick || 'Standard', 30);
    case 'lock': case 'unlock':
      await actions.lock(ch, r, action === 'lock'); await refreshPanel(ch);
      return respond(interaction, ok(action === 'lock' ? 'Kanal **gesperrt**. Mit **Zutritt erlauben** lässt du einzelne Personen trotzdem rein.' : 'Kanal **entsperrt**.'));
    case 'hide': case 'unhide':
      await actions.hide(ch, r, action === 'hide'); await refreshPanel(ch);
      return respond(interaction, ok(action === 'hide' ? 'Kanal ist jetzt **unsichtbar** für andere.' : 'Kanal ist wieder **sichtbar**.'));
    case 'quickload': {
      const p = getPrefs(ch.guild.id, r.ownerId);
      const prof = (p.profiles || []).find(x => x.name === p.quick) || (p.profiles || [])[0];
      if (!prof) return respond(interaction, err('Du hast noch nichts gespeichert. Richte den Kanal ein und drücke **Speichern**.'));
      await interaction.deferReply({ flags: EPHEMERAL });
      const done = await applyProfile(ch, r, prof.data);
      await refreshPanel(ch);
      return respond(interaction, ok(`Profil **${prof.name}** geladen${done.length ? `: ${done.join(', ')}` : ' (war schon so eingestellt)'}.`));
    }
    case 'load': {
      const p = getPrefs(ch.guild.id, r.ownerId);
      const options = (p.profiles || []).map(x => ({ label: x.name.slice(0, 100), value: `p:${x.name}`.slice(0, 100), description: `${x.data.name} · Limit ${x.data.limit || '∞'}${x.data.locked ? ' · gesperrt' : ''}`.slice(0, 100), emoji: x.name === p.quick ? '⚡' : '💾' }));
      options.push({ label: 'Alles zurücksetzen', value: 'reset', description: 'Offen, sichtbar, kein Limit, Bannliste leeren', emoji: '🧹' });
      const menu = new StringSelectMenuBuilder().setCustomId(`tvu:load:${ch.id}`).setPlaceholder('Profil wählen …').addOptions(options);
      return interaction.reply({ content: options.length > 1 ? 'Welches Profil möchtest du laden?' : 'Noch keine Profile gespeichert. Du kannst aber alles zurücksetzen:', components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
    }
    case 'delete':
      return interaction.reply({
        content: '🗑️ Kanal wirklich löschen? Alle werden rausgeworfen.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tvc:delete:${ch.id}`).setLabel('Ja, löschen').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('tvc:cancel').setLabel('Abbrechen').setStyle(ButtonStyle.Secondary))],
        flags: EPHEMERAL,
      });
    case 'permit': case 'kick': case 'ban': case 'transfer': {
      const menu = new UserSelectMenuBuilder().setCustomId(`tvs:${action}:${ch.id}`).setPlaceholder('Person(en) auswählen …').setMinValues(1).setMaxValues(action === 'transfer' ? 1 : 10);
      return interaction.reply({ content: SELECT_TEXT[action], components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
    }
    case 'unban': {
      if (!r.banned?.length) return respond(interaction, err('In diesem Kanal ist niemand gebannt.'));
      const options = await Promise.all(r.banned.slice(0, 25).map(async id => {
        const u = await interaction.client.users.fetch(id).catch(() => null);
        return { label: (u?.username || id).slice(0, 100), value: id };
      }));
      const menu = new StringSelectMenuBuilder().setCustomId(`tvu:unban:${ch.id}`).setPlaceholder('Wen entbannen?').setMinValues(1).setMaxValues(options.length).addOptions(options);
      return interaction.reply({ content: 'Wen möchtest du entbannen?', components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
    }
    case 'region': {
      const regions = await interaction.client.fetchVoiceRegions().catch(() => null);
      const options = [{ label: 'Automatisch', value: 'auto', emoji: '🌐' }, ...[...(regions?.values() || [])].filter(x => !x.deprecated).slice(0, 24).map(x => ({ label: x.name, value: x.id }))];
      const menu = new StringSelectMenuBuilder().setCustomId(`tvu:region:${ch.id}`).setPlaceholder('Region wählen').addOptions(options);
      return interaction.reply({ content: 'Welche Sprach-Region? (beeinflusst den Ping)', components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
    }
    default:
      return respond(interaction, err('Unbekannte Aktion.'));
  }
}

/** Bestätigung „Kanal löschen“ (tvc:delete:<kanal>) */
async function handleConfirm(interaction, action, channelId) {
  if (action === 'cancel') return interaction.update({ content: 'Abgebrochen.', components: [] });
  const ch = interaction.guild.channels.cache.get(channelId);
  const r = ch && rec(ch.id);
  if (!ch || !r) return interaction.update({ content: '❌ Der Kanal existiert nicht mehr.', components: [] });
  if (r.ownerId !== interaction.user.id) return interaction.update({ content: '❌ Nur der Besitzer kann den Kanal löschen.', components: [] });
  await interaction.update({ content: '🗑️ Kanal wird gelöscht …', components: [] });
  store.delete('tempvoice', ch.id);
  await ch.delete(`Vom Besitzer ${interaction.user.tag} gelöscht`).catch(() => {});
}

async function handleModal(interaction, action) {
  const v = interaction.fields.getTextInputValue('v').trim();
  if (action === 'music') {
    const o = resolve(interaction, { mustOwn: false });
    if (o.error) return respond(interaction, err(o.error));
    if (!inChannel(interaction, o.ch)) return respond(interaction, err('Du musst dafür im Sprachkanal sein.'));
    await interaction.deferReply({ flags: EPHEMERAL });
    try {
      const service = require('./music/service');
      const res = await service.play({ guild: interaction.guild, member: interaction.member, voiceChannel: o.ch, textChannel: o.ch, query: v });
      return respond(interaction, { embeds: [service.resultEmbed(res)] });
    } catch (e) { return respond(interaction, err(e.message)); }
  }
  const o = resolve(interaction);
  if (o.error) return respond(interaction, err(o.error));
  if (action === 'rename') {
    await interaction.deferReply({ flags: EPHEMERAL });
    const result = await actions.rename(o.ch, o.r, v);
    if (result === 'ok') return respond(interaction, ok(`Kanal heißt jetzt **${v}**.`));
    if (result === 'wait') return respond(interaction, ok('Discord erlaubt nur 2 Umbenennungen in 10 Minuten. Der neue Name wird übernommen, sobald es wieder geht.'));
    return respond(interaction, err(`Umbenennen fehlgeschlagen: ${result}`));
  }
  if (action === 'save') {
    const name = v.slice(0, 30) || 'Standard';
    const count = saveProfile(o.ch.guild.id, o.r.ownerId, name, capture(o.ch, o.r));
    return respond(interaction, ok(`Gespeichert als **${name}** (⚡ Schnellladen lädt dieses Profil). Du hast ${count}/5 Profile.`));
  }
  const n = parseInt(v, 10);
  if (action === 'limit') {
    if (Number.isNaN(n) || n < 0 || n > 99) return respond(interaction, err('Bitte eine Zahl von 0 bis 99.'));
    await actions.limit(o.ch, o.r, n); await refreshPanel(o.ch);
    return respond(interaction, ok(n ? `Limit: **${n}** Personen.` : 'Limit entfernt.'));
  }
  if (action === 'bitrate') {
    const max = Math.round((o.ch.guild.maximumBitrate || 96000) / 1000);
    if (Number.isNaN(n) || n < 8 || n > max) return respond(interaction, err(`Bitte eine Zahl von 8 bis ${max}.`));
    await o.ch.setBitrate(n * 1000); await refreshPanel(o.ch);
    return respond(interaction, ok(`Bitrate: **${n} kbps**.`));
  }
  if (action === 'timer') {
    if (Number.isNaN(n) || n < 0 || n > 1440) return respond(interaction, err('Bitte Minuten von 0 bis 1440 (24 Std.).'));
    o.r.timerAt = n ? Date.now() + n * 60_000 : null;
    o.r.timerWarned = false;
    saveRec(o.ch.id, o.r);
    await refreshPanel(o.ch);
    return respond(interaction, ok(n ? `⏱️ Der Kanal löscht sich ${ts(o.r.timerAt)}.` : 'Timer ausgeschaltet.'));
  }
}

/** Auswahlmenüs: tvs:<aktion>:<kanal> (Personen) und tvu:<aktion>:<kanal> (Liste) */
async function handleSelect(interaction, action, channelId) {
  const ch = interaction.guild.channels.cache.get(channelId);
  const r = ch && rec(ch.id);
  if (!ch || !r) return interaction.update({ content: '❌ Der Kanal existiert nicht mehr.', components: [] });
  if (action === 'activity') {
    if (!ch.members.has(interaction.user.id)) return interaction.update({ content: '❌ Du musst im Sprachkanal sein.', components: [] });
    const { ACTIVITIES, inviteFor } = require('../lib/activities');
    const act = ACTIVITIES.find(a => a.id === interaction.values[0]);
    try {
      const url = await inviteFor(ch, act.id);
      await ch.send({ content: `🎮 <@${interaction.user.id}> startet **${act.name}** – macht mit!`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Mitmachen').setEmoji(act.emoji))], allowedMentions: { parse: [] } }).catch(() => {});
      return interaction.update({ content: `${act.emoji} **${act.name}** ist bereit:`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Starten').setEmoji('▶️'))] });
    } catch (e) {
      return interaction.update({ content: `❌ Discord hat die Aktivität abgelehnt (${e.message}). Starte sie über 🚀 „Aktivitäten“ im Sprachkanal.`, components: [] });
    }
  }
  if (r.ownerId !== interaction.user.id) return interaction.update({ content: '❌ Nur der Besitzer kann das.', components: [] });
  if (action === 'region') {
    const region = interaction.values[0] === 'auto' ? null : interaction.values[0];
    await ch.setRTCRegion(region);
    await refreshPanel(ch);
    return interaction.update({ content: `🌍 Region: **${region || 'automatisch'}**`, components: [] });
  }
  if (action === 'load') {
    await interaction.update({ content: '⏳ Lade …', components: [] });
    if (interaction.values[0] === 'reset') {
      await actions.reset(ch, r); await refreshPanel(ch);
      return interaction.editReply({ content: '🧹 Alles zurückgesetzt: offen, sichtbar, kein Limit, Bannliste geleert.' });
    }
    const name = interaction.values[0].slice(2);
    const p = getPrefs(ch.guild.id, r.ownerId);
    const prof = (p.profiles || []).find(x => x.name === name);
    if (!prof) return interaction.editReply({ content: '❌ Profil nicht gefunden.' });
    const done = await applyProfile(ch, r, prof.data);
    p.quick = prof.name; setPrefs(ch.guild.id, r.ownerId, p);
    await refreshPanel(ch);
    return interaction.editReply({ content: `💾 Profil **${prof.name}** geladen${done.length ? `: ${done.join(', ')}` : ''}.` });
  }
  const ids = interaction.values.filter(id => id !== interaction.user.id && id !== interaction.client.user.id);
  if (!ids.length) return interaction.update({ content: '❌ Wähle jemand anderen als dich selbst aus.', components: [] });
  const list = ids.map(id => `<@${id}>`).join(', ');
  if (action === 'permit') { await actions.permit(ch, r, ids); await refreshPanel(ch); return interaction.update({ content: `✅ ${list} darf jetzt rein.`, components: [] }); }
  if (action === 'kick') { await actions.kick(ch, r, ids); return interaction.update({ content: `👢 ${list} wurde rausgeworfen (kann wieder beitreten – zum Aussperren **Bannen**).`, components: [] }); }
  if (action === 'ban') {
    const protectedIds = ids.filter(id => {
      const m = interaction.guild.members.cache.get(id);
      return m && (m.permissions.has(P.Administrator) || m.id === interaction.guild.ownerId);
    });
    await actions.ban(ch, r, ids.filter(id => !protectedIds.includes(id)));
    await refreshPanel(ch);
    return interaction.update({ content: `🚫 ${list} ist aus deinem Kanal gebannt${protectedIds.length ? ' (Admins können nicht gebannt werden)' : ''}. Das gilt auch für deine nächsten Kanäle.`, components: [] });
  }
  if (action === 'unban') { await actions.unban(ch, r, ids); await refreshPanel(ch); return interaction.update({ content: `♻️ ${list} ist entbannt.`, components: [] }); }
  if (action === 'transfer') {
    const target = await interaction.guild.members.fetch(ids[0]).catch(() => null);
    if (!target || target.user.bot) return interaction.update({ content: '❌ Diese Person kann den Kanal nicht übernehmen.', components: [] });
    await actions.transfer(ch, r, target.id);
    await refreshPanel(ch);
    sendLog(interaction.guild, 'voice', new EmbedBuilder().setColor(COLORS.info).setDescription(`🔁 <@${interaction.user.id}> hat **${ch.name}** an <@${target.id}> übertragen.`));
    return interaction.update({ content: `🔁 <@${target.id}> ist jetzt Besitzer.`, components: [] });
  }
}

module.exports = {
  setup, sendPanel, addHub, removeHub, onVoiceUpdate, cleanup, handleButton, handleModal, handleSelect, handleConfirm,
  rec, resolve, actions, refreshPanel, setFlagForAll, getPrefs, createFor, capture, applyProfile, saveProfile, processTimers, panelComponents,
};
