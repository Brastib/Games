'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, EmbedBuilder } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const tempvoice = require('../modules/tempvoice');
const tickets = require('../modules/tickets');
const verify = require('../modules/verify');
const welcome = require('../modules/welcome');
const dashboard = require('../modules/dashboard');

const LOG_TYPES = [
  { key: 'mod', name: '🔨・mod-log', label: 'Moderation' },
  { key: 'protection', name: '🛡️・schutz-log', label: 'Schutz (Raid/Nuke/Lockdown)' },
  { key: 'messages', name: '💬・nachrichten-log', label: 'Nachrichten' },
  { key: 'members', name: '👥・mitglieder-log', label: 'Mitglieder' },
  { key: 'server', name: '⚙️・server-log', label: 'Server' },
  { key: 'voice', name: '🔊・voice-log', label: 'Sprachkanäle' },
];

async function createLogChannels(guild) {
  const cfg = getConfig(guild.id);
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles] },
    ...cfg.modRoles.filter(r => guild.roles.cache.has(r)).map(id => ({ id, allow: [P.ViewChannel], deny: [P.SendMessages] })),
  ];
  const cat = await guild.channels.create({ name: '📁 Server-Logs', type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
  for (const t of LOG_TYPES) {
    const ch = await guild.channels.create({ name: t.name, type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: overwrites });
    cfg.logs[t.key] = ch.id;
  }
  cfg.logs.fallback = cfg.logs.mod;
  saveConfig(guild.id);
  return cat;
}

const textChannel = (o, name = 'kanal', desc = 'Kanal') => o.setName(name).setDescription(desc).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

module.exports = [
  {
    data: new SlashCommandBuilder().setName('setup').setDescription('Bot einrichten')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand(s => s.setName('quickstart').setDescription('Alles auf einmal: Logs, Willkommen, Temp-Sprachkanäle, Tickets')
        .addRoleOption(o => o.setName('modrolle').setDescription('Rolle deines Teams (optional)')))
      .addSubcommand(s => s.setName('logs').setDescription('Log-Kanäle festlegen oder automatisch erstellen')
        .addBooleanOption(o => o.setName('erstellen').setDescription('Alle Log-Kanäle automatisch anlegen?'))
        .addChannelOption(o => textChannel(o, 'kanal', 'Vorhandener Kanal für Logs'))
        .addStringOption(o => o.setName('typ').setDescription('Welche Logs? (Standard: alle)').addChoices({ name: 'Alle', value: 'fallback' }, ...LOG_TYPES.map(t => ({ name: t.label, value: t.key })))))
      .addSubcommand(s => s.setName('welcome').setDescription('Willkommensnachricht einrichten')
        .addChannelOption(o => textChannel(o).setRequired(true))
        .addStringOption(o => o.setName('nachricht').setDescription('Platzhalter: {user} {name} {server} {count}').setMaxLength(1500))
        .addBooleanOption(o => o.setName('bildkarte').setDescription('Schöne Willkommens-Bildkarte anhängen? (Standard: ja)'))
        .addBooleanOption(o => o.setName('dm').setDescription('Zusätzlich eine Privatnachricht schicken?'))
        .addStringOption(o => o.setName('dm_nachricht').setDescription('Text der Privatnachricht').setMaxLength(1500))
        .addBooleanOption(o => o.setName('an').setDescription('an? (Standard: ja)')))
      .addSubcommand(s => s.setName('welcometest').setDescription('Willkommensnachricht mit dir selbst testen'))
      .addSubcommand(s => s.setName('goodbye').setDescription('Abschiedsnachricht einrichten')
        .addChannelOption(o => textChannel(o).setRequired(true))
        .addStringOption(o => o.setName('nachricht').setDescription('Platzhalter: {username} {server} {count}').setMaxLength(1500))
        .addBooleanOption(o => o.setName('an').setDescription('an? (Standard: ja)')))
      .addSubcommand(s => s.setName('autorole').setDescription('Rolle automatisch beim Beitritt vergeben (nochmal = entfernen)')
        .addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true))
        .addBooleanOption(o => o.setName('fuer_bots').setDescription('Für Bots statt Menschen?')))
      .addSubcommand(s => s.setName('rules').setDescription('Regeln mit „Akzeptieren“-Button (Verifizierung)')
        .addChannelOption(o => textChannel(o, 'kanal', 'Kanal für die Regeln').setRequired(true))
        .addRoleOption(o => o.setName('rolle').setDescription('Rolle, die man nach dem Akzeptieren bekommt').setRequired(true))
        .addRoleOption(o => o.setName('unverifiziert_rolle').setDescription('Rolle für neue Mitglieder bis zum Akzeptieren (optional)'))
        .addBooleanOption(o => o.setName('captcha').setDescription('Kleine Rechenaufgabe gegen Bots?'))
        .addBooleanOption(o => o.setName('kanaele_sperren').setDescription('Alle anderen Kanäle erst nach dem Akzeptieren sichtbar machen?')))
      .addSubcommand(s => s.setName('tempvoice').setDescription('„Kanal erstellen“-Sprachkanal + Steuerung einrichten')
        .addChannelOption(o => o.setName('kategorie').setDescription('Vorhandene Kategorie (sonst wird eine erstellt)').addChannelTypes(ChannelType.GuildCategory))
        .addStringOption(o => o.setName('name_vorlage').setDescription('Name neuer Kanäle, z. B. „🔊 {name}“').setMaxLength(80))
        .addIntegerOption(o => o.setName('limit').setDescription('Standard-Personenlimit (0 = keins)').setMinValue(0).setMaxValue(99))
        .addBooleanOption(o => o.setName('nur_panel').setDescription('Nur das Bedienfeld in diesem Kanal neu posten')))
      .addSubcommand(s => s.setName('tickets').setDescription('Ticket-System einrichten')
        .addChannelOption(o => textChannel(o, 'kanal', 'Kanal für den „Ticket öffnen“-Button').setRequired(true))
        .addRoleOption(o => o.setName('supportrolle').setDescription('Wer sieht die Tickets?'))
        .addChannelOption(o => textChannel(o, 'log_kanal', 'Wohin kommen Protokolle geschlossener Tickets?')))
      .addSubcommand(s => s.setName('levels').setDescription('Level-System einstellen')
        .addBooleanOption(o => o.setName('an').setDescription('an?'))
        .addChannelOption(o => textChannel(o, 'kanal', 'Kanal für Level-Ups (leer = gleicher Kanal)'))
        .addStringOption(o => o.setName('nachricht').setDescription('Platzhalter: {user} {level}').setMaxLength(500))
        .addNumberOption(o => o.setName('multiplikator').setDescription('XP-Multiplikator (z. B. 2 für doppelte XP)').setMinValue(0.1).setMaxValue(10)))
      .addSubcommand(s => s.setName('modrole').setDescription('Team-Rolle hinzufügen/entfernen (darf Mod-Befehle, wird nicht gefiltert)')
        .addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true))),
    async execute(i) {
      const sub = i.options.getSubcommand();
      const g = i.guild;
      const cfg = getConfig(g.id);

      if (sub === 'quickstart') {
        await i.deferReply();
        const done = [];
        const role = i.options.getRole('modrolle');
        try {
          if (role && !cfg.modRoles.includes(role.id)) { cfg.modRoles.push(role.id); done.push(`Team-Rolle: ${role}`); }
          await createLogChannels(g); done.push('📁 Log-Kategorie mit 6 Kanälen');
          const wc = await g.channels.create({ name: '👋・willkommen', type: ChannelType.GuildText, permissionOverwrites: [{ id: g.roles.everyone.id, deny: [P.SendMessages] }, { id: g.client.user.id, allow: [P.SendMessages, P.EmbedLinks, P.AttachFiles] }] });
          Object.assign(cfg.welcome, { enabled: true, channel: wc.id });
          Object.assign(cfg.goodbye, { enabled: true, channel: wc.id });
          saveConfig(g.id);
          done.push(`👋 Willkommen & Abschied in ${wc}`);
          const tv = await tempvoice.setup(g); done.push(`🔊 Temp-Sprachkanäle: ${tv.hub} + Steuerung in ${tv.panel}`);
          const support = await g.channels.create({ name: '🎫・support', type: ChannelType.GuildText, permissionOverwrites: [{ id: g.roles.everyone.id, deny: [P.SendMessages] }, { id: g.client.user.id, allow: [P.SendMessages, P.EmbedLinks] }] });
          await tickets.setup(g, { panelChannel: support, supportRole: role });
          done.push(`🎫 Tickets: Button in ${support}`);
        } catch (e) {
          done.push(`⚠️ Abgebrochen: ${e.message} (Hat der Bot Administrator-Rechte?)`);
        }
        return respond(i, new EmbedBuilder().setColor(COLORS.ok).setTitle('🚀 Schnellstart fertig').setDescription(done.map(d => `• ${d}`).join('\n') +
          '\n\n**Schon aktiv:** AutoMod mit Linkschutz, Spam-, Einladungs- und Erwähnungsfilter, Anti-Raid, Anti-Nuke, Level.\n**Noch empfohlen:**\n• `/setup rules` – Regeln mit Akzeptieren-Button\n• `/dashboard` – alles auf einen Blick\n• Meine Rolle in den Server-Einstellungen **ganz nach oben** ziehen'));
      }

      if (sub === 'logs') {
        if (i.options.getBoolean('erstellen')) {
          await i.deferReply();
          const cat = await createLogChannels(g).catch(e => ({ error: e.message }));
          if (cat.error) return respond(i, err(cat.error));
          return respond(i, ok(`Log-Kategorie **${cat.name}** mit ${LOG_TYPES.length} Kanälen erstellt. Nur Admins${cfg.modRoles.length ? ' und Mod-Rollen' : ''} können sie sehen.`));
        }
        const ch = i.options.getChannel('kanal');
        if (!ch) return respond(i, err('Wähle einen Kanal oder setze `erstellen: True`.'));
        const typ = i.options.getString('typ') || 'fallback';
        if (typ === 'fallback') for (const k of Object.keys(cfg.logs)) cfg.logs[k] = ch.id;
        else cfg.logs[typ] = ch.id;
        saveConfig(g.id);
        return respond(i, ok(`${typ === 'fallback' ? 'Alle Logs' : LOG_TYPES.find(t => t.key === typ).label + '-Logs'} gehen jetzt nach ${ch}.`));
      }

      if (sub === 'welcome') {
        const w = cfg.welcome;
        w.channel = i.options.getChannel('kanal').id;
        w.message = i.options.getString('nachricht') || w.message;
        w.card = i.options.getBoolean('bildkarte') ?? w.card;
        w.dm = i.options.getBoolean('dm') ?? w.dm;
        w.dmMessage = i.options.getString('dm_nachricht') || w.dmMessage;
        w.enabled = i.options.getBoolean('an') ?? true;
        saveConfig(g.id);
        return respond(i, ok(`Willkommen **${w.enabled ? 'an' : 'aus'}** in <#${w.channel}>${w.card ? ' mit Bildkarte' : ''}${w.dm ? ' + Privatnachricht' : ''}.\nTesten: \`/setup welcometest\``));
      }
      if (sub === 'welcometest') {
        await i.deferReply();
        return respond(i, await welcome.buildWelcome(i.member));
      }
      if (sub === 'goodbye') {
        cfg.goodbye.channel = i.options.getChannel('kanal').id;
        cfg.goodbye.message = i.options.getString('nachricht') || cfg.goodbye.message;
        cfg.goodbye.enabled = i.options.getBoolean('an') ?? true;
        saveConfig(g.id);
        return respond(i, ok(`Abschied **${cfg.goodbye.enabled ? 'an' : 'aus'}** in <#${cfg.goodbye.channel}>.`));
      }
      if (sub === 'autorole') {
        const role = i.options.getRole('rolle');
        if (!role.editable || role.managed) return respond(i, err(`Ich kann ${role} nicht vergeben (Rolle zu hoch oder von einer Integration verwaltet).`));
        const list = i.options.getBoolean('fuer_bots') ? cfg.welcome.botRoles : cfg.welcome.autoRoles;
        const idx = list.indexOf(role.id);
        if (idx >= 0) list.splice(idx, 1); else list.push(role.id);
        saveConfig(g.id);
        return respond(i, ok(`${role} wird ${idx >= 0 ? '**nicht mehr**' : ''} automatisch an neue ${i.options.getBoolean('fuer_bots') ? 'Bots' : 'Mitglieder'} vergeben.`));
      }
      if (sub === 'rules') {
        const role = i.options.getRole('rolle');
        if (role.managed || role.id === g.id) return respond(i, err('Diese Rolle kann nicht vergeben werden.'));
        return verify.startSetup(i, {
          channelId: i.options.getChannel('kanal').id, roleId: role.id, unverifiedRoleId: i.options.getRole('unverifiziert_rolle')?.id,
          captcha: i.options.getBoolean('captcha') ?? false, lockChannels: i.options.getBoolean('kanaele_sperren') ?? false,
        });
      }
      if (sub === 'tempvoice') {
        if (i.options.getBoolean('nur_panel')) {
          await tempvoice.sendPanel(i.channel);
          return respond(i, ok('Bedienfeld gepostet.'));
        }
        await i.deferReply();
        cfg.tempvoice.nameTemplate = i.options.getString('name_vorlage') || cfg.tempvoice.nameTemplate;
        cfg.tempvoice.limit = i.options.getInteger('limit') ?? cfg.tempvoice.limit;
        try {
          const r = await tempvoice.setup(g, { category: i.options.getChannel('kategorie') });
          return respond(i, ok(`Fertig! Wer ${r.hub} betritt, bekommt einen eigenen Sprachkanal. Steuerung in ${r.panel}.`));
        } catch (e) { return respond(i, err(e.message)); }
      }
      if (sub === 'tickets') {
        await i.deferReply();
        const panel = i.options.getChannel('kanal');
        const log = i.options.getChannel('log_kanal');
        if (log) cfg.tickets.logChannel = log.id;
        try {
          await tickets.setup(g, { panelChannel: panel, supportRole: i.options.getRole('supportrolle') });
          return respond(i, ok(`Ticket-Button in ${panel} gepostet.`));
        } catch (e) { return respond(i, err(e.message)); }
      }
      if (sub === 'levels') {
        const l = cfg.levels;
        l.enabled = i.options.getBoolean('an') ?? l.enabled;
        const ch = i.options.getChannel('kanal');
        if (ch) l.channel = ch.id;
        l.message = i.options.getString('nachricht') || l.message;
        l.multiplier = i.options.getNumber('multiplikator') ?? l.multiplier;
        saveConfig(g.id);
        return respond(i, ok(`Level **${l.enabled ? 'an' : 'aus'}** · Level-Ups in ${l.channel ? `<#${l.channel}>` : 'dem jeweiligen Kanal'} · XP ×${l.multiplier}.\nBelohnungs-Rollen: \`/level reward\``));
      }
      if (sub === 'modrole') {
        const role = i.options.getRole('rolle');
        const idx = cfg.modRoles.indexOf(role.id);
        if (idx >= 0) cfg.modRoles.splice(idx, 1); else cfg.modRoles.push(role.id);
        saveConfig(g.id);
        return respond(i, ok(`${role} ist ${idx >= 0 ? '**keine** Team-Rolle mehr' : 'jetzt eine **Team-Rolle**'}.`));
      }
    },
  },
  {
    data: new SlashCommandBuilder().setName('dashboard').setDescription('Alle Einstellungen auf einen Blick, mit Schaltern')
      .setDefaultMemberPermissions(P.ManageGuild),
    execute: i => dashboard.show(i),
  },
];
