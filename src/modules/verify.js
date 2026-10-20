'use strict';
/**
 * Regeln akzeptieren / Verifizierung mit Button und optionalem Rechen-Captcha.
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits: P,
} = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond, EPHEMERAL } = require('../lib/embeds');
const { sendLog } = require('../lib/logger');
const { randomInt } = require('../lib/util');

const DEFAULT_RULES = [
  '**1. Respekt** – Behandle alle freundlich. Keine Beleidigungen, kein Mobbing, keine Diskriminierung.',
  '**2. Kein Spam** – Keine Nachrichtenfluten, keine Massen-Erwähnungen, keine Werbung ohne Erlaubnis.',
  '**3. Sichere Links** – Keine Betrugs-, Phishing- oder IP-Logger-Links. Der Bot löscht so etwas automatisch.',
  '**4. Passende Inhalte** – Keine NSFW-, Gewalt- oder illegalen Inhalte.',
  '**5. Privatsphäre** – Teile keine privaten Daten (Adressen, Telefonnummern, Passwörter) von dir oder anderen.',
  '**6. Richtige Kanäle** – Nutze die Kanäle für ihr jeweiliges Thema.',
  '**7. Team** – Folge den Anweisungen des Teams. Probleme? Öffne ein Ticket.',
  '**8. Discord-Regeln** – Es gelten die Discord-Nutzungsbedingungen und Community-Richtlinien.',
].join('\n\n');

const pendingSetup = new Map(); // userId -> Optionen aus /setup rules
const captchas = new Map();     // userId -> {answer, at}

function rulesMessage(cfg) {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle(`📜 ${cfg.verify.title || 'Regeln'}`).setDescription(cfg.verify.text || DEFAULT_RULES)
      .setFooter({ text: 'Mit dem Klick auf den Button akzeptierst du die Regeln.' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vr:accept').setLabel('Regeln akzeptieren').setEmoji('✅').setStyle(ButtonStyle.Danger))],
  };
}

/** Schritt 1 (aus /setup rules): Modal zum Bearbeiten des Regeltextes anzeigen. */
async function startSetup(interaction, opts) {
  pendingSetup.set(interaction.user.id, opts);
  const cfg = getConfig(interaction.guild.id).verify;
  const modal = new ModalBuilder().setCustomId('vrm:setup').setTitle('Regeln festlegen').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Überschrift').setStyle(TextInputStyle.Short).setMaxLength(100).setValue(cfg.title || 'Regeln').setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Regeltext (du kannst alles ändern)').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue((cfg.text || DEFAULT_RULES).slice(0, 4000)).setRequired(true)));
  return interaction.showModal(modal);
}

/** Schritt 2: Modal abgeschickt → Regeln posten. */
async function finishSetup(interaction) {
  const opts = pendingSetup.get(interaction.user.id);
  pendingSetup.delete(interaction.user.id);
  if (!opts) return respond(interaction, err('Die Einrichtung ist abgelaufen. Bitte `/setup rules` erneut ausführen.'));
  await interaction.deferReply({ flags: EPHEMERAL });
  const guild = interaction.guild;
  const cfg = getConfig(guild.id);
  const channel = guild.channels.cache.get(opts.channelId);
  const role = guild.roles.cache.get(opts.roleId);
  if (!channel || !role) return respond(interaction, err('Kanal oder Rolle nicht gefunden.'));
  if (!role.editable) return respond(interaction, err(`Ich kann die Rolle ${role} nicht vergeben – meine Rolle muss darüber stehen.`));
  Object.assign(cfg.verify, {
    enabled: true, channel: channel.id, role: role.id, unverifiedRole: opts.unverifiedRoleId || null, captcha: !!opts.captcha,
    title: interaction.fields.getTextInputValue('title'), text: interaction.fields.getTextInputValue('text'),
  });
  const msg = await channel.send(rulesMessage(cfg)).catch(e => ({ error: e.message }));
  if (msg.error) return respond(interaction, err(`Ich kann in ${channel} nicht schreiben: ${msg.error}`));
  cfg.verify.messageId = msg.id;
  saveConfig(guild.id);
  let extra = '';
  if (opts.lockChannels) {
    const n = await lockForUnverified(guild, channel, role);
    extra = `\n🔒 ${n} Kanäle sind jetzt nur noch für ${role} sichtbar. Neue Mitglieder sehen nur ${channel}.`;
  }
  return respond(interaction, ok(`Regeln in ${channel} gepostet. Wer akzeptiert, bekommt ${role}.${cfg.verify.captcha ? ' (mit Rechen-Captcha)' : ''}${extra}`));
}

/** Alle öffentlichen Kanäle nur für die verifizierte Rolle sichtbar machen. */
async function lockForUnverified(guild, rulesChannel, role) {
  const everyone = guild.roles.everyone;
  let n = 0;
  for (const ch of guild.channels.cache.values()) {
    if (ch.isThread() || ch.id === rulesChannel.id) continue;
    if (!ch.permissionsFor(everyone)?.has(P.ViewChannel)) continue;
    if (ch.type === ChannelType.GuildCategory && ch.id === rulesChannel.parentId) continue;
    try {
      await ch.permissionOverwrites.edit(role.id, { ViewChannel: true }, { reason: 'Verifizierung eingerichtet' });
      await ch.permissionOverwrites.edit(everyone.id, { ViewChannel: false }, { reason: 'Verifizierung eingerichtet' });
      n++;
    } catch { /* weiter */ }
  }
  await rulesChannel.permissionOverwrites.edit(everyone.id, { ViewChannel: true, SendMessages: false, AddReactions: false }).catch(() => {});
  await rulesChannel.permissionOverwrites.edit(role.id, { ViewChannel: true }).catch(() => {});
  return n;
}

async function grant(interaction) {
  const cfg = getConfig(interaction.guild.id).verify;
  const member = interaction.member;
  const role = interaction.guild.roles.cache.get(cfg.role);
  if (!role) return respond(interaction, err('Die Verifizierungs-Rolle existiert nicht mehr. Bitte sag dem Team Bescheid.'));
  try {
    await member.roles.add(role, 'Regeln akzeptiert');
    if (cfg.unverifiedRole && member.roles.cache.has(cfg.unverifiedRole)) await member.roles.remove(cfg.unverifiedRole, 'Regeln akzeptiert').catch(() => {});
  } catch (e) {
    return respond(interaction, err(`Ich konnte dir die Rolle nicht geben: ${e.message}`));
  }
  sendLog(interaction.guild, 'members', new EmbedBuilder().setColor(COLORS.ok).setDescription(`✅ <@${member.id}> hat die Regeln akzeptiert.`).setTimestamp());
  return respond(interaction, ok('Danke! Du hast die Regeln akzeptiert und hast jetzt Zugriff auf den Server. Viel Spaß! 🎉'));
}

async function handleButton(interaction) {
  const cfg = getConfig(interaction.guild.id).verify;
  if (!cfg.enabled) return respond(interaction, err('Die Verifizierung ist deaktiviert.'));
  if (cfg.role && interaction.member.roles.cache.has(cfg.role)) return respond(interaction, ok('Du hast die Regeln schon akzeptiert.'));
  if (!cfg.captcha) return grant(interaction);
  const a = randomInt(2, 9), b = randomInt(2, 9);
  captchas.set(interaction.user.id, { answer: a + b, at: Date.now() });
  const modal = new ModalBuilder().setCustomId('vrm:captcha').setTitle('Kurzer Menschen-Test').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('answer').setLabel(`Was ist ${a} + ${b}?`).setStyle(TextInputStyle.Short).setMaxLength(3).setRequired(true)));
  return interaction.showModal(modal);
}

async function handleCaptcha(interaction) {
  const c = captchas.get(interaction.user.id);
  captchas.delete(interaction.user.id);
  if (!c || Date.now() - c.at > 5 * 60_000) return respond(interaction, err('Zeit abgelaufen. Klick bitte noch mal auf den Button.'));
  const given = parseInt(interaction.fields.getTextInputValue('answer').trim(), 10);
  if (given !== c.answer) return respond(interaction, err('Leider falsch. Klick noch mal auf den Button und versuch es erneut.'));
  return grant(interaction);
}

async function onJoin(member) {
  const cfg = getConfig(member.guild.id).verify;
  if (cfg.enabled && cfg.unverifiedRole && !member.user.bot) {
    await member.roles.add(cfg.unverifiedRole, 'Noch nicht verifiziert').catch(() => {});
  }
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of captchas) if (v.at < cutoff) captchas.delete(k);
}, 60_000).unref();

module.exports = { DEFAULT_RULES, rulesMessage, startSetup, finishSetup, handleButton, handleCaptcha, onJoin, lockForUnverified };
