'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder, ChannelType } = require('discord.js');
const mod = require('../modules/moderation');
const lockdown = require('../modules/lockdown');
const { checkHierarchy } = require('../lib/perms');
const { COLORS, ok, err, respond, EPHEMERAL } = require('../lib/embeds');
const { parseDuration, formatDuration, truncate } = require('../lib/util');

function actionEmbed(type, user, reason, extra = '') {
  const info = mod.ACTION_INFO[type];
  return new EmbedBuilder().setColor(info.color)
    .setDescription(`${info.emoji} **${user.tag || user.username}** wurde ${info.verb}.\n**Grund:** ${truncate(reason || 'Kein Grund angegeben', 900)}${extra}`);
}

const reasonOpt = o => o.setName('grund').setDescription('Grund (wird gespeichert und dem Mitglied geschickt)').setMaxLength(500);

module.exports = [
  {
    data: new SlashCommandBuilder().setName('ban').setDescription('Mitglied bannen (optional nur für eine bestimmte Zeit)')
      .setDefaultMemberPermissions(P.BanMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen bannen?').setRequired(true))
      .addStringOption(reasonOpt)
      .addStringOption(o => o.setName('dauer').setDescription('Zeit-Bann, z. B. 7d, 12h – leer = dauerhaft'))
      .addIntegerOption(o => o.setName('nachrichten_loeschen').setDescription('Nachrichten der letzten … löschen').addChoices(
        { name: 'Keine', value: 0 }, { name: '1 Stunde', value: 3600 }, { name: '24 Stunden', value: 86400 }, { name: '7 Tage', value: 604800 })),
    async execute(i) {
      const user = i.options.getUser('mitglied');
      const reason = i.options.getString('grund') || 'Kein Grund angegeben';
      const durStr = i.options.getString('dauer');
      const durationMs = durStr ? parseDuration(durStr) : null;
      if (durStr && !durationMs) return respond(i, err('Dauer nicht erkannt. Beispiele: `30m`, `12h`, `7d`.'));
      const problem = checkHierarchy(i.member, i.options.getMember('mitglied'), 'ban');
      if (problem) return respond(i, err(problem));
      await i.deferReply();
      try {
        const c = await mod.ban(i.guild, user, i.user, reason, { deleteSeconds: i.options.getInteger('nachrichten_loeschen') || 0, durationMs });
        return respond(i, actionEmbed('ban', user, reason, `${durationMs ? `\n**Dauer:** ${formatDuration(durationMs)}` : ''}\n*Fall #${c.id}*`));
      } catch (e) { return respond(i, err(`Bannen fehlgeschlagen: ${e.message}`)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('softban').setDescription('Bannen + sofort entbannen: löscht die Nachrichten der letzten 24 Std.')
      .setDefaultMemberPermissions(P.BanMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(i) {
      const user = i.options.getUser('mitglied');
      const reason = i.options.getString('grund') || 'Kein Grund angegeben';
      const problem = checkHierarchy(i.member, i.options.getMember('mitglied'), 'ban');
      if (problem) return respond(i, err(problem));
      await i.deferReply();
      try {
        const c = await mod.ban(i.guild, user, i.user, reason, { deleteSeconds: 86400, soft: true });
        return respond(i, actionEmbed('softban', user, reason, `\n*Fall #${c.id}*`));
      } catch (e) { return respond(i, err(`Fehlgeschlagen: ${e.message}`)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('unban').setDescription('Bann aufheben')
      .setDefaultMemberPermissions(P.BanMembers)
      .addStringOption(o => o.setName('nutzer_id').setDescription('ID der gebannten Person').setRequired(true).setAutocomplete(true))
      .addStringOption(reasonOpt),
    async autocomplete(i) {
      const q = i.options.getFocused().toLowerCase();
      const bans = await i.guild.bans.fetch({ limit: 1000 }).catch(() => null);
      if (!bans) return i.respond([]);
      return i.respond([...bans.values()].filter(b => b.user.tag.toLowerCase().includes(q) || b.user.id.includes(q)).slice(0, 25)
        .map(b => ({ name: `${b.user.tag} (${b.user.id})`.slice(0, 100), value: b.user.id })));
    },
    async execute(i) {
      const id = i.options.getString('nutzer_id').replace(/\D/g, '');
      const reason = i.options.getString('grund') || 'Kein Grund angegeben';
      await i.deferReply();
      try {
        const c = await mod.unban(i.guild, id, i.user, reason);
        return respond(i, ok(`<@${id}> wurde entbannt. *Fall #${c.id}*`));
      } catch (e) { return respond(i, err(`Entbannen fehlgeschlagen: ${e.code === 10026 ? 'Diese Person ist nicht gebannt.' : e.message}`)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('kick').setDescription('Mitglied vom Server werfen')
      .setDefaultMemberPermissions(P.KickMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen kicken?').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(i) {
      const member = i.options.getMember('mitglied');
      if (!member) return respond(i, err('Diese Person ist nicht auf dem Server.'));
      const problem = checkHierarchy(i.member, member, 'kick');
      if (problem) return respond(i, err(problem));
      const reason = i.options.getString('grund') || 'Kein Grund angegeben';
      await i.deferReply();
      try {
        const c = await mod.kick(member, i.user, reason);
        return respond(i, actionEmbed('kick', member.user, reason, `\n*Fall #${c.id}*`));
      } catch (e) { return respond(i, err(`Kicken fehlgeschlagen: ${e.message}`)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('timeout').setDescription('Mitglied stummschalten (Timeout, max. 28 Tage)')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true))
      .addStringOption(o => o.setName('dauer').setDescription('z. B. 10m, 1h, 2d').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(i) {
      const member = i.options.getMember('mitglied');
      if (!member) return respond(i, err('Diese Person ist nicht auf dem Server.'));
      const ms = parseDuration(i.options.getString('dauer'));
      if (!ms || ms < 5000) return respond(i, err('Dauer nicht erkannt. Beispiele: `10m`, `1h`, `2d`.'));
      const problem = checkHierarchy(i.member, member, 'timeout');
      if (problem) return respond(i, err(problem));
      const reason = i.options.getString('grund') || 'Kein Grund angegeben';
      await i.deferReply();
      try {
        const c = await mod.timeout(member, ms, i.user, reason);
        return respond(i, actionEmbed('timeout', member.user, reason, `\n**Dauer:** ${formatDuration(Math.min(ms, 28 * 86_400_000))}\n*Fall #${c.id}*`));
      } catch (e) { return respond(i, err(`Timeout fehlgeschlagen: ${e.message}`)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('untimeout').setDescription('Timeout aufheben')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(i) {
      const member = i.options.getMember('mitglied');
      if (!member) return respond(i, err('Diese Person ist nicht auf dem Server.'));
      if (!member.isCommunicationDisabled()) return respond(i, err('Diese Person hat keinen Timeout.'));
      try {
        const c = await mod.untimeout(member, i.user, i.options.getString('grund') || 'Kein Grund angegeben');
        return respond(i, ok(`Timeout von ${member} aufgehoben. *Fall #${c.id}*`), { ephemeral: false });
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('warn').setDescription('Mitglied verwarnen (ab einer Anzahl gibt es automatisch Strafen)')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true))
      .addStringOption(o => o.setName('grund').setDescription('Grund').setRequired(true).setMaxLength(500)),
    async execute(i) {
      const member = i.options.getMember('mitglied');
      if (!member) return respond(i, err('Diese Person ist nicht auf dem Server.'));
      const problem = checkHierarchy(i.member, member, 'manage');
      if (problem && !problem.startsWith('Meine Rolle')) return respond(i, err(problem));
      const reason = i.options.getString('grund');
      await i.deferReply();
      const r = await mod.warn(i.guild, member, i.user, reason);
      return respond(i, actionEmbed('warn', member.user, reason, `\n**Aktive Verwarnungen:** ${r.count}${r.escalated ? `\n**Automatische Strafe:** ${r.escalated}` : ''}\n*Fall #${r.caseId}*`));
    },
  },
  {
    data: new SlashCommandBuilder().setName('warnings').setDescription('Verwarnungen eines Mitglieds anzeigen')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true)),
    async execute(i) {
      const user = i.options.getUser('mitglied');
      const all = mod.getWarns(i.guild.id, user.id);
      const active = new Set(mod.getWarns(i.guild.id, user.id, true).map(w => w.id));
      const e = new EmbedBuilder().setColor(COLORS.warn).setAuthor({ name: `Verwarnungen · ${user.tag}`, iconURL: user.displayAvatarURL() })
        .setDescription(all.length ? all.slice(-15).reverse().map(w => `**#${w.id}** ${active.has(w.id) ? '🟡' : '⚪ (abgelaufen)'} <t:${Math.floor(w.at / 1000)}:d> · ${truncate(w.reason, 150)}`).join('\n') : 'Keine Verwarnungen. 🎉')
        .setFooter({ text: `${active.size} aktiv · ${all.length} insgesamt · Löschen: /delwarn` });
      return respond(i, e);
    },
  },
  {
    data: new SlashCommandBuilder().setName('delwarn').setDescription('Eine Verwarnung löschen')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true))
      .addIntegerOption(o => o.setName('fall').setDescription('Fall-Nummer (siehe /warnings)').setRequired(true)),
    async execute(i) {
      const user = i.options.getUser('mitglied');
      return mod.removeWarn(i.guild.id, user.id, i.options.getInteger('fall'))
        ? respond(i, ok('Verwarnung gelöscht.')) : respond(i, err('Diese Verwarnung gibt es nicht.'));
    },
  },
  {
    data: new SlashCommandBuilder().setName('clearwarnings').setDescription('Alle Verwarnungen eines Mitglieds löschen')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true)),
    async execute(i) {
      const user = i.options.getUser('mitglied');
      mod.clearWarns(i.guild.id, user.id);
      return respond(i, ok(`Alle Verwarnungen von ${user} gelöscht.`));
    },
  },
  {
    data: new SlashCommandBuilder().setName('modlogs').setDescription('Alle Moderations-Fälle eines Mitglieds')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true)),
    async execute(i) {
      const user = i.options.getUser('mitglied');
      const cases = mod.getCases(i.guild.id, user.id);
      const e = new EmbedBuilder().setColor(COLORS.mod).setAuthor({ name: `Fälle · ${user.tag}`, iconURL: user.displayAvatarURL() })
        .setDescription(cases.length ? truncate(cases.slice(0, 15).map(mod.caseLine).join('\n'), 4000) : 'Keine Einträge.')
        .setFooter({ text: `${cases.length} Fälle insgesamt` });
      return respond(i, e);
    },
  },
  {
    data: new SlashCommandBuilder().setName('purge').setDescription('Nachrichten in diesem Kanal löschen (max. 14 Tage alt)')
      .setDefaultMemberPermissions(P.ManageMessages)
      .addIntegerOption(o => o.setName('anzahl').setDescription('Wie viele? (1–100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption(o => o.setName('von').setDescription('Nur Nachrichten von dieser Person'))
      .addStringOption(o => o.setName('enthaelt').setDescription('Nur Nachrichten mit diesem Text'))
      .addBooleanOption(o => o.setName('nur_bots').setDescription('Nur Nachrichten von Bots'))
      .addBooleanOption(o => o.setName('nur_links').setDescription('Nur Nachrichten mit Links'))
      .addBooleanOption(o => o.setName('nur_dateien').setDescription('Nur Nachrichten mit Anhängen')),
    async execute(i) {
      const amount = i.options.getInteger('anzahl');
      const from = i.options.getUser('von');
      const contains = i.options.getString('enthaelt')?.toLowerCase();
      const bots = i.options.getBoolean('nur_bots');
      const links = i.options.getBoolean('nur_links');
      const files = i.options.getBoolean('nur_dateien');
      await i.deferReply({ flags: EPHEMERAL });
      const filtered = from || contains || bots || links || files;
      const fetched = await i.channel.messages.fetch({ limit: 100 });
      let list = [...fetched.values()].filter(m => Date.now() - m.createdTimestamp < 14 * 86_400_000 - 60_000);
      if (from) list = list.filter(m => m.author.id === from.id);
      if (contains) list = list.filter(m => m.content.toLowerCase().includes(contains));
      if (bots) list = list.filter(m => m.author.bot);
      if (links) list = list.filter(m => /https?:\/\/|www\./i.test(m.content));
      if (files) list = list.filter(m => m.attachments.size);
      list = list.slice(0, amount);
      if (!list.length) return respond(i, err(filtered ? 'Keine passenden Nachrichten gefunden.' : 'Keine löschbaren Nachrichten (älter als 14 Tage?).'));
      const deleted = await i.channel.bulkDelete(list.map(m => m.id), true).catch(e => ({ error: e.message }));
      if (deleted.error) return respond(i, err(deleted.error));
      return respond(i, ok(`${deleted.size} Nachrichten gelöscht.`));
    },
  },
  {
    data: new SlashCommandBuilder().setName('slowmode').setDescription('Langsamen Modus für einen Kanal setzen')
      .setDefaultMemberPermissions(P.ManageChannels)
      .addIntegerOption(o => o.setName('sekunden').setDescription('Wartezeit zwischen Nachrichten (0 = aus, max. 21600)').setRequired(true).setMinValue(0).setMaxValue(21600))
      .addChannelOption(o => o.setName('kanal').setDescription('Kanal (Standard: dieser)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)),
    async execute(i) {
      const ch = i.options.getChannel('kanal') || i.channel;
      const s = i.options.getInteger('sekunden');
      try {
        await ch.setRateLimitPerUser(s, `Slowmode von ${i.user.tag}`);
        return respond(i, ok(s ? `Slowmode in ${ch}: **${formatDuration(s * 1000)}**.` : `Slowmode in ${ch} ausgeschaltet.`), { ephemeral: false });
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('lock').setDescription('Einen Kanal sperren (nur das Team kann schreiben)')
      .setDefaultMemberPermissions(P.ManageChannels)
      .addChannelOption(o => o.setName('kanal').setDescription('Kanal (Standard: dieser)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice))
      .addStringOption(reasonOpt),
    async execute(i) {
      const ch = i.options.getChannel('kanal') || i.channel;
      const reason = i.options.getString('grund') || 'Kein Grund angegeben';
      try {
        const done = await lockdown.lockChannel(ch, reason);
        if (!done) return respond(i, err(`${ch} ist schon gesperrt.`));
        if (ch.isTextBased() && ch.id !== i.channel.id) await ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.protect).setDescription(`🔒 Dieser Kanal wurde gesperrt.\n**Grund:** ${reason}`)] }).catch(() => {});
        return respond(i, new EmbedBuilder().setColor(COLORS.protect).setDescription(`🔒 ${ch} wurde gesperrt.\n**Grund:** ${reason}`), { ephemeral: false });
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('unlock').setDescription('Gesperrten Kanal wieder öffnen')
      .setDefaultMemberPermissions(P.ManageChannels)
      .addChannelOption(o => o.setName('kanal').setDescription('Kanal (Standard: dieser)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice)),
    async execute(i) {
      const ch = i.options.getChannel('kanal') || i.channel;
      try {
        await lockdown.unlockChannel(ch);
        return respond(i, ok(`🔓 ${ch} ist wieder offen.`), { ephemeral: false });
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('nick').setDescription('Nickname eines Mitglieds ändern')
      .setDefaultMemberPermissions(P.ManageNicknames)
      .addUserOption(o => o.setName('mitglied').setDescription('Wen?').setRequired(true))
      .addStringOption(o => o.setName('name').setDescription('Neuer Nickname (leer = zurücksetzen)').setMaxLength(32)),
    async execute(i) {
      const member = i.options.getMember('mitglied');
      if (!member) return respond(i, err('Diese Person ist nicht auf dem Server.'));
      const problem = checkHierarchy(i.member, member, 'manage');
      if (problem && member.id !== i.user.id) return respond(i, err(problem));
      try {
        await member.setNickname(i.options.getString('name') || null, `Von ${i.user.tag}`);
        return respond(i, ok(`Nickname von ${member.user} geändert.`));
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('role').setDescription('Rollen eines Mitglieds verwalten')
      .setDefaultMemberPermissions(P.ManageRoles)
      .addSubcommand(s => s.setName('add').setDescription('Rolle geben')
        .addUserOption(o => o.setName('mitglied').setDescription('Wem?').setRequired(true))
        .addRoleOption(o => o.setName('rolle').setDescription('Welche Rolle?').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Rolle wegnehmen')
        .addUserOption(o => o.setName('mitglied').setDescription('Wem?').setRequired(true))
        .addRoleOption(o => o.setName('rolle').setDescription('Welche Rolle?').setRequired(true))),
    async execute(i) {
      const member = i.options.getMember('mitglied');
      const role = i.options.getRole('rolle');
      if (!member) return respond(i, err('Diese Person ist nicht auf dem Server.'));
      if (!role.editable) return respond(i, err(`Ich kann ${role} nicht vergeben – meine Rolle muss darüber stehen.`));
      if (i.user.id !== i.guild.ownerId && i.member.roles.highest.comparePositionTo(role) <= 0) return respond(i, err('Diese Rolle ist gleich hoch oder höher als deine höchste Rolle.'));
      try {
        if (i.options.getSubcommand() === 'add') { await member.roles.add(role, `Von ${i.user.tag}`); return respond(i, ok(`${member} hat jetzt ${role}.`)); }
        await member.roles.remove(role, `Von ${i.user.tag}`);
        return respond(i, ok(`${role} wurde ${member} weggenommen.`));
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
];
