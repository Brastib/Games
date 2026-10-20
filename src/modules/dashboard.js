'use strict';
/**
 * Dashboard direkt in Discord: Übersicht aller Module + Ein/Aus-Schalter per Button.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, err, respond, EPHEMERAL } = require('../lib/embeds');
const { isAdmin } = require('../lib/perms');
const { ts } = require('../lib/util');
const lf = require('../lib/linkFilter');
const cards = require('../lib/cards');
const store = require('../lib/store');
const lockdown = require('./lockdown');

const on = v => (v ? '🟢 an' : '⚫ aus');
const ch = id => (id ? `<#${id}>` : '*nicht gesetzt*');
const MODE = { smart: 'Smart (gefährliche Links)', strict: 'Streng (nur Erlaubt-Liste)', off: 'aus' };

const TOGGLES = {
  automod: { label: 'AutoMod', emoji: '🤖', get: c => c.automod.enabled, set: (c, v) => { c.automod.enabled = v; } },
  links: { label: 'Linkschutz', emoji: '🔗', get: c => c.automod.links.enabled && c.automod.links.mode !== 'off', cycle: true },
  invites: { label: 'Einladungen', emoji: '✉️', get: c => c.automod.invites.enabled, set: (c, v) => { c.automod.invites.enabled = v; } },
  spam: { label: 'Spam', emoji: '🌊', get: c => c.automod.spam.enabled, set: (c, v) => { c.automod.spam.enabled = v; } },
  antiraid: { label: 'Anti-Raid', emoji: '🚨', get: c => c.antiraid.enabled, set: (c, v) => { c.antiraid.enabled = v; } },
  antinuke: { label: 'Anti-Nuke', emoji: '☢️', get: c => c.antinuke.enabled, set: (c, v) => { c.antinuke.enabled = v; }, owner: true },
  welcome: { label: 'Willkommen', emoji: '👋', get: c => c.welcome.enabled, set: (c, v) => { c.welcome.enabled = v; }, need: c => c.welcome.channel || 'Erst `/setup welcome` ausführen.' },
  goodbye: { label: 'Abschied', emoji: '🚪', get: c => c.goodbye.enabled, set: (c, v) => { c.goodbye.enabled = v; }, need: c => c.goodbye.channel || 'Erst `/setup goodbye` ausführen.' },
  levels: { label: 'Level', emoji: '⭐', get: c => c.levels.enabled, set: (c, v) => { c.levels.enabled = v; } },
  tempvoice: { label: 'Temp-Voice', emoji: '🔊', get: c => c.tempvoice.enabled, set: (c, v) => { c.tempvoice.enabled = v; }, need: c => c.tempvoice.hubs.length > 0 || 'Erst `/setup tempvoice` ausführen.' },
  tickets: { label: 'Tickets', emoji: '🎫', get: c => c.tickets.enabled, set: (c, v) => { c.tickets.enabled = v; }, need: c => c.tickets.category || 'Erst `/setup tickets` ausführen.' },
  captcha: { label: 'Captcha', emoji: '🧮', get: c => c.verify.captcha, set: (c, v) => { c.verify.captcha = v; }, need: c => c.verify.enabled || 'Erst `/setup rules` ausführen.' },
};

function view(guild) {
  const c = getConfig(guild.id);
  const a = c.automod;
  const lockText = c.lockdown.active ? `🔴 **AKTIV** seit ${ts(c.lockdown.since)}${c.lockdown.until ? `, Ende ${ts(c.lockdown.until)}` : ''}` : '🟢 nicht aktiv';
  const raid = c.antiraid.raidUntil > Date.now() ? ` · 🚨 Raid-Modus bis ${ts(c.antiraid.raidUntil)}` : '';
  const embed = new EmbedBuilder()
    .setColor(c.lockdown.active ? COLORS.protect : COLORS.brand)
    .setTitle(`🎛️ Dashboard · ${guild.name}`)
    .setThumbnail(guild.iconURL())
    .addFields(
      { name: '🛡️ Schutz', value: [
        `**Lockdown:** ${lockText}`,
        `**AutoMod:** ${on(a.enabled)} · **Linkschutz:** ${a.links.enabled ? MODE[a.links.mode] : 'aus'}`,
        `**Einladungsfilter:** ${on(a.invites.enabled)} · **Spam:** ${on(a.spam.enabled)} · **Erwähnungen:** ${on(a.mentions.enabled)}`,
        `**Anti-Raid:** ${on(c.antiraid.enabled)} (${c.antiraid.joins} Beitritte / ${c.antiraid.seconds}s → ${c.antiraid.action})${raid}`,
        `**Anti-Nuke:** ${on(c.antinuke.enabled)} (ab ${c.antinuke.threshold} Aktionen / ${c.antinuke.seconds}s → ${c.antinuke.punishment})`,
        `**Betrugs-Datenbank:** ${lf.phishingCount().toLocaleString('de-DE')} Domains${process.env.SAFE_BROWSING_KEY ? ' + Google Safe Browsing' : ''}`,
      ].join('\n') },
      { name: '👋 Mitglieder', value: [
        `**Willkommen:** ${on(c.welcome.enabled)} ${ch(c.welcome.channel)}${c.welcome.card && cards.available() ? ' (mit Bild)' : ''}`,
        `**Abschied:** ${on(c.goodbye.enabled)} ${ch(c.goodbye.channel)}`,
        `**Auto-Rollen:** ${c.welcome.autoRoles.map(r => `<@&${r}>`).join(' ') || '–'}`,
        `**Regeln/Verifizierung:** ${on(c.verify.enabled)} ${c.verify.enabled ? `${ch(c.verify.channel)} → <@&${c.verify.role}>${c.verify.captcha ? ' + Captcha' : ''}` : ''}`,
      ].join('\n') },
      { name: '🧰 Funktionen', value: [
        `**Temp-Sprachkanäle:** ${on(c.tempvoice.enabled)} ${c.tempvoice.hubs.map(h => ch(h.id)).join(' ')} · aktiv: ${store.values('tempvoice').filter(r => r.guildId === guild.id).length}`,
        `**Tickets:** ${on(c.tickets.enabled)} · offen: ${store.values('tickets').filter(t => t.guildId === guild.id).length}`,
        `**Level:** ${on(c.levels.enabled)} · Belohnungen: ${Object.keys(c.levels.rewards).length}`,
        `**Mod-Rollen:** ${c.modRoles.map(r => `<@&${r}>`).join(' ') || '–'}`,
      ].join('\n') },
      { name: '📁 Logs', value: `Allgemein ${ch(c.logs.fallback)} · Mod ${ch(c.logs.mod)} · Schutz ${ch(c.logs.protection)}\nNachrichten ${ch(c.logs.messages)} · Mitglieder ${ch(c.logs.members)} · Server ${ch(c.logs.server)} · Voice ${ch(c.logs.voice)}` },
    )
    .setFooter({ text: 'Buttons schalten Module an/aus. Feineinstellungen: /setup, /automod, /antiraid, /antinuke' });

  const keys = Object.keys(TOGGLES);
  const rows = [];
  for (let i = 0; i < keys.length; i += 4) {
    rows.push(new ActionRowBuilder().addComponents(keys.slice(i, i + 4).map(k => {
      const t = TOGGLES[k];
      const val = t.get(c);
      return new ButtonBuilder().setCustomId(`dash:t:${k}`).setLabel(k === 'links' ? `Links: ${a.links.enabled ? a.links.mode : 'off'}` : t.label)
        .setEmoji(t.emoji).setStyle(val ? ButtonStyle.Success : ButtonStyle.Secondary);
    })));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash:lockdown').setLabel(c.lockdown.active ? 'Lockdown beenden' : 'Lockdown starten')
      .setEmoji(c.lockdown.active ? '🔓' : '🔒').setStyle(c.lockdown.active ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('dash:refresh').setLabel('Aktualisieren').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components: rows };
}

async function show(interaction) {
  return interaction.reply({ ...view(interaction.guild), flags: EPHEMERAL });
}

async function handleButton(interaction, parts) {
  if (!isAdmin(interaction.member)) return respond(interaction, err('Nur Admins können das Dashboard bedienen.'));
  const guild = interaction.guild;
  const c = getConfig(guild.id);
  const [action, key] = parts;
  if (action === 'refresh') return interaction.update(view(guild));
  if (action === 'lockdown') {
    await interaction.deferUpdate();
    if (c.lockdown.active) await lockdown.end(guild, { by: interaction.user });
    else await lockdown.start(guild, { reason: 'Über das Dashboard gestartet', by: interaction.user, announceChannel: interaction.channel });
    return interaction.editReply(view(guild));
  }
  if (action === 't') {
    const t = TOGGLES[key];
    if (!t) return;
    if (t.owner && interaction.user.id !== guild.ownerId) return respond(interaction, err('Anti-Nuke kann nur der Server-Inhaber umschalten.'));
    if (t.cycle) {
      const order = ['smart', 'strict', 'off'];
      const cur = c.automod.links.enabled ? c.automod.links.mode : 'off';
      const next = order[(order.indexOf(cur) + 1) % order.length];
      c.automod.links.mode = next;
      c.automod.links.enabled = next !== 'off';
    } else {
      const val = !t.get(c);
      if (val && t.need) {
        const need = t.need(c);
        if (typeof need === 'string' && need.startsWith('Erst')) return respond(interaction, err(need));
      }
      t.set(c, val);
    }
    saveConfig(guild.id);
    return interaction.update(view(guild));
  }
}

module.exports = { show, handleButton, view };
