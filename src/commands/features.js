'use strict';
const {
  SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, OverwriteType,
} = require('discord.js');

const MEMBER = { type: OverwriteType.Member };
const store = require('../lib/store');
const { ok, err, respond } = require('../lib/embeds');
const { isStaff } = require('../lib/perms');
const { parseDuration, formatDuration, ts } = require('../lib/util');
const tempvoice = require('../modules/tempvoice');
const temptext = require('../modules/temptext');
const tickets = require('../modules/tickets');
const rolepanels = require('../modules/rolepanels');
const giveaways = require('../modules/giveaways');

module.exports = [
  // ---------- Temporäre Sprachkanäle per Befehl (gleiche Aktionen wie das Bedienfeld) ----------
  {
    data: new SlashCommandBuilder().setName('voice').setDescription('Deinen temporären Sprachkanal steuern')
      .addSubcommand(s => s.setName('name').setDescription('Umbenennen').addStringOption(o => o.setName('name').setDescription('Neuer Name').setRequired(true).setMaxLength(100)))
      .addSubcommand(s => s.setName('limit').setDescription('Personenlimit').addIntegerOption(o => o.setName('anzahl').setDescription('0 = kein Limit').setRequired(true).setMinValue(0).setMaxValue(99)))
      .addSubcommand(s => s.setName('lock').setDescription('Sperren'))
      .addSubcommand(s => s.setName('unlock').setDescription('Öffnen'))
      .addSubcommand(s => s.setName('hide').setDescription('Verstecken'))
      .addSubcommand(s => s.setName('unhide').setDescription('Sichtbar machen'))
      .addSubcommand(s => s.setName('permit').setDescription('Jemanden reinlassen').addUserOption(o => o.setName('person').setDescription('Wen?').setRequired(true)))
      .addSubcommand(s => s.setName('kick').setDescription('Jemanden rauswerfen').addUserOption(o => o.setName('person').setDescription('Wen?').setRequired(true)))
      .addSubcommand(s => s.setName('ban').setDescription('Jemanden aus deinen Kanälen bannen').addUserOption(o => o.setName('person').setDescription('Wen?').setRequired(true)))
      .addSubcommand(s => s.setName('unban').setDescription('Bann aufheben').addUserOption(o => o.setName('person').setDescription('Wen?').setRequired(true)))
      .addSubcommand(s => s.setName('claim').setDescription('Kanal übernehmen, wenn der Besitzer weg ist'))
      .addSubcommand(s => s.setName('transfer').setDescription('Kanal übergeben').addUserOption(o => o.setName('person').setDescription('An wen?').setRequired(true)))
      .addSubcommand(s => s.setName('panel').setDescription('Bedienfeld hier im Chat anzeigen')),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'claim') return tempvoice.handleButton(i, 'claim');
      const o = tempvoice.resolve(i);
      if (o.error) return respond(i, err(o.error));
      const target = i.options.getUser('person');
      if (target && (target.id === i.user.id || target.bot)) return respond(i, err('Wähle eine andere Person.'));
      const { ch, r } = o;
      const A = tempvoice.actions;
      try {
        switch (sub) {
          case 'name': {
            await i.deferReply({ flags: 64 });
            const res = await A.rename(ch, r, i.options.getString('name'));
            return respond(i, res === 'ok' ? ok('Name geändert.') : res === 'wait' ? ok('Discord erlaubt 2 Umbenennungen pro 10 Minuten – der Name wird gleich übernommen.') : err(res));
          }
          case 'limit': await A.limit(ch, r, i.options.getInteger('anzahl')); break;
          case 'lock': await A.lock(ch, r, true); break;
          case 'unlock': await A.lock(ch, r, false); break;
          case 'hide': await A.hide(ch, r, true); break;
          case 'unhide': await A.hide(ch, r, false); break;
          case 'permit': await A.permit(ch, r, [target.id]); break;
          case 'kick': await A.kick(ch, r, [target.id]); break;
          case 'ban': await A.ban(ch, r, [target.id]); break;
          case 'unban': await A.unban(ch, r, [target.id]); break;
          case 'transfer': await A.transfer(ch, r, target.id); break;
          case 'panel': return tempvoice.handleButton(i, 'info');
        }
        await tempvoice.refreshPanel(ch);
        return respond(i, ok('Erledigt.'));
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  // ---------- Temporäre Textkanäle ----------
  {
    data: new SlashCommandBuilder().setName('tempchannel').setDescription('Temporäre Textkanäle, die sich selbst löschen')
      .addSubcommand(s => s.setName('create').setDescription('Neuen temporären Kanal erstellen')
        .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(90))
        .addStringOption(o => o.setName('dauer').setDescription('Wie lange? z. B. 30m, 2h, 1d (max. 30 Tage)').setRequired(true))
        .addBooleanOption(o => o.setName('privat').setDescription('Nur für dich, eingeladene Personen und das Team sichtbar?'))
        .addUserOption(o => o.setName('mitglied').setDescription('Person einladen (bei privat)'))
        .addChannelOption(o => o.setName('kategorie').setDescription('In welcher Kategorie?').addChannelTypes(ChannelType.GuildCategory)))
      .addSubcommand(s => s.setName('extend').setDescription('Diesen Kanal verlängern').addStringOption(o => o.setName('dauer').setDescription('z. B. 1h').setRequired(true)))
      .addSubcommand(s => s.setName('delete').setDescription('Diesen temporären Kanal sofort löschen')),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'create') {
        if (!isStaff(i.member) && !i.member.permissions.has(P.ManageChannels)) {
          const own = store.values('temptext').filter(r => r.guildId === i.guild.id && r.ownerId === i.user.id).length;
          if (own >= 2) return respond(i, err('Du hast schon 2 temporäre Kanäle. Lösche erst einen.'));
        }
        const ms = parseDuration(i.options.getString('dauer'));
        if (!ms || ms < 60_000 || ms > 30 * 86_400_000) return respond(i, err('Dauer zwischen 1 Minute und 30 Tagen, z. B. `30m`, `2h`, `1d`.'));
        await i.deferReply({ flags: 64 });
        try {
          const member = i.options.getUser('mitglied');
          const r = await temptext.create(i.guild, i.user, {
            name: i.options.getString('name'), durationMs: ms, isPrivate: i.options.getBoolean('privat') ?? false,
            members: member ? [member.id] : [], categoryId: i.options.getChannel('kategorie')?.id || i.channel.parentId,
          });
          return respond(i, ok(`${r.channel} erstellt. Wird ${ts(r.expiresAt)} gelöscht (${formatDuration(ms)}).`));
        } catch (e) { return respond(i, err(`Konnte Kanal nicht erstellen: ${e.message}`)); }
      }
      const rec = store.get('temptext', i.channel.id);
      if (!rec) return respond(i, err('Das ist kein temporärer Kanal.'));
      if (rec.ownerId !== i.user.id && !isStaff(i.member)) return respond(i, err('Nur der Ersteller oder das Team darf das.'));
      if (sub === 'extend') {
        const ms = parseDuration(i.options.getString('dauer'));
        if (!ms) return respond(i, err('Dauer nicht erkannt.'));
        const until = temptext.extend(i.channel.id, ms);
        return respond(i, ok(`Verlängert. Neuer Ablauf: ${ts(until)}.`), { ephemeral: false });
      }
      if (sub === 'delete') {
        store.delete('temptext', i.channel.id);
        await respond(i, ok('Kanal wird gelöscht …'), { ephemeral: false });
        setTimeout(() => i.channel.delete('Temporärer Kanal manuell gelöscht').catch(() => {}), 3000);
      }
    },
  },

  // ---------- Tickets ----------
  {
    data: new SlashCommandBuilder().setName('ticket').setDescription('Ticket verwalten (im Ticket-Kanal benutzen)')
      .addSubcommand(s => s.setName('close').setDescription('Ticket schließen').addStringOption(o => o.setName('grund').setDescription('Grund')))
      .addSubcommand(s => s.setName('add').setDescription('Person zum Ticket hinzufügen').addUserOption(o => o.setName('person').setDescription('Wen?').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Person aus dem Ticket entfernen').addUserOption(o => o.setName('person').setDescription('Wen?').setRequired(true)))
      .addSubcommand(s => s.setName('panel').setDescription('„Ticket öffnen“-Button hier posten (Team)')),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'panel') {
        if (!isStaff(i.member)) return respond(i, err('Nur das Team darf das.'));
        await i.channel.send(tickets.panelMessage());
        return respond(i, ok('Ticket-Button gepostet.'));
      }
      const t = store.get('tickets', i.channel.id);
      if (!t) return respond(i, err('Das ist kein Ticket-Kanal.'));
      if (sub === 'close') return tickets.close(i, i.options.getString('grund') || 'Kein Grund angegeben');
      if (!isStaff(i.member) && t.userId !== i.user.id) return respond(i, err('Nur das Team oder der Ticket-Ersteller darf das.'));
      const u = i.options.getUser('person');
      if (sub === 'add') {
        await i.channel.permissionOverwrites.edit(u.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }, MEMBER);
        return respond(i, ok(`${u} wurde zum Ticket hinzugefügt.`), { ephemeral: false });
      }
      if (sub === 'remove') {
        await i.channel.permissionOverwrites.delete(u.id).catch(() => {});
        return respond(i, ok(`${u} wurde aus dem Ticket entfernt.`), { ephemeral: false });
      }
    },
  },

  // ---------- Rollen-Panels ----------
  {
    data: new SlashCommandBuilder().setName('rolepanel').setDescription('Rollen per Button/Menü zum Selbstabholen')
      .setDefaultMemberPermissions(P.ManageRoles)
      .addSubcommand(s => s.setName('create').setDescription('Neues Panel erstellen')
        .addStringOption(o => o.setName('titel').setDescription('Überschrift').setRequired(true).setMaxLength(200))
        .addStringOption(o => o.setName('beschreibung').setDescription('Text darunter').setMaxLength(2000))
        .addChannelOption(o => o.setName('kanal').setDescription('Wohin? (Standard: hier)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption(o => o.setName('modus').setDescription('Buttons oder Auswahlmenü').addChoices({ name: 'Buttons', value: 'buttons' }, { name: 'Auswahlmenü', value: 'select' }))
        .addBooleanOption(o => o.setName('nur_eine').setDescription('Nur eine Rolle gleichzeitig erlaubt?'))
        .addStringOption(o => o.setName('rollen').setDescription('Gleich mehrere Rollen, mit Komma: Repo, Rounds, Helldivers II').setMaxLength(1500)))
      .addSubcommand(s => s.setName('add').setDescription('Rolle(n) zum Panel hinzufügen (im Kanal des Panels)')
        .addRoleOption(o => o.setName('rolle').setDescription('Eine Rolle'))
        .addStringOption(o => o.setName('rollen').setDescription('Oder gleich mehrere, mit Komma: Repo, Rounds, Helldivers II').setMaxLength(1500))
        .addStringOption(o => o.setName('nachricht_id').setDescription('Nur nötig, wenn mehrere Panels im Kanal sind'))
        .addStringOption(o => o.setName('beschriftung').setDescription('Text auf dem Button').setMaxLength(80))
        .addStringOption(o => o.setName('emoji').setDescription('Emoji, z. B. 🎮'))
        .addStringOption(o => o.setName('farbe').setDescription('Button-Farbe').addChoices({ name: 'Grau', value: 'grau' }, { name: 'Rot', value: 'rot' }, { name: 'Blau', value: 'blau' }, { name: 'Grün', value: 'gruen' })))
      .addSubcommand(s => s.setName('remove').setDescription('Rolle aus dem Panel entfernen (im Kanal des Panels)')
        .addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true))
        .addStringOption(o => o.setName('nachricht_id').setDescription('Nur nötig, wenn mehrere Panels im Kanal sind')))
      .addSubcommand(s => s.setName('banner').setDescription('Banner mit „ETC.“-Uhr über das Panel setzen (im Kanal des Panels, postet es neu)')
        .addStringOption(o => o.setName('titel').setDescription('Großer Titel, z. B. Spiele-Rollen').setRequired(true).setMaxLength(24))
        .addStringOption(o => o.setName('untertitel').setDescription('Kleine Zeile über dem Titel (Standard: Selbst aussuchen)').setMaxLength(40))
        .addStringOption(o => o.setName('text').setDescription('Text unter dem Banner (leer = bisheriger Text)').setMaxLength(1000))
        .addStringOption(o => o.setName('nachricht_id').setDescription('Nur nötig, wenn mehrere Panels im Kanal sind'))),
    async execute(i) {
      const sub = i.options.getSubcommand();
      try {
        if (sub === 'create') {
          const ch = i.options.getChannel('kanal') || i.channel;
          const list = rolepanels.parseRoleList(i.guild, i.options.getString('rollen'));
          if (list.roles.length) await i.deferReply({ flags: 64 });
          const msg = await rolepanels.create(ch, { title: i.options.getString('titel'), description: i.options.getString('beschreibung'), mode: i.options.getString('modus') || 'buttons', unique: i.options.getBoolean('nur_eine') ?? false });
          const added = [], failed = [...list.missing.map(m => `„${m}“ nicht gefunden`)];
          for (const role of list.roles) {
            await rolepanels.addRole(i.guild, msg.id, { role, style: 'grau' }).then(() => added.push(`${role}`)).catch(e => failed.push(e.message));
          }
          return respond(i, ok([`Panel erstellt in ${ch}.`, added.length ? `**Knöpfe:** ${added.join(' ')}` : 'Weitere Rollen: `/rolepanel add rolle:…` (im Kanal des Panels)', failed.length ? `⚠️ ${failed.join(' · ')}` : null].filter(Boolean).join('\n')));
        }
        // Ohne ID: das neueste Rollen-Panel in diesem Kanal
        const id = i.options.getString('nachricht_id')?.trim() || rolepanels.latestIn(i.guild.id, i.channelId);
        if (!id) return respond(i, err('In diesem Kanal gibt es kein Rollen-Panel. Geh in den Kanal mit dem Panel oder gib `nachricht_id` an.'));
        if (sub === 'banner') {
          await i.deferReply({ flags: 64 });
          const msg = await rolepanels.setBanner(i.guild, id, { title: i.options.getString('titel'), kicker: i.options.getString('untertitel'), text: i.options.getString('text') });
          return respond(i, ok(`Banner gesetzt: ${msg.url}`));
        }
        if (sub === 'add') {
          const single = i.options.getRole('rolle');
          const list = rolepanels.parseRoleList(i.guild, i.options.getString('rollen'));
          if (!single && !list.roles.length) return respond(i, err(list.missing.length ? `Nicht gefunden: ${list.missing.join(', ')}` : 'Gib `rolle` oder `rollen` an.'));
          if (!list.roles.length) {
            await rolepanels.addRole(i.guild, id, { role: single, label: i.options.getString('beschriftung'), emoji: i.options.getString('emoji'), style: i.options.getString('farbe') || 'grau' });
            return respond(i, ok('Rolle hinzugefügt.'));
          }
          await i.deferReply({ flags: 64 });
          const added = [], failed = [...list.missing.map(m => `„${m}“ nicht gefunden`)];
          for (const role of [single, ...list.roles].filter((r, n, a) => r && a.findIndex(x => x?.id === r.id) === n)) {
            await rolepanels.addRole(i.guild, id, { role, style: i.options.getString('farbe') || 'grau' }).then(() => added.push(`${role}`)).catch(e => failed.push(`${role.name}: ${e.message}`));
          }
          return respond(i, (added.length ? ok : err)([added.length ? `**Hinzugefügt:** ${added.join(' ')}` : 'Keine Rolle hinzugefügt.', failed.length ? `⚠️ ${failed.join(' · ')}` : null].filter(Boolean).join('\n')));
        }
        await rolepanels.removeRole(i.guild, id, i.options.getRole('rolle').id);
        return respond(i, ok('Rolle entfernt.'));
      } catch (e) { return respond(i, err(e.message)); }
    },
  },

  // ---------- Gewinnspiele ----------
  {
    data: new SlashCommandBuilder().setName('giveaway').setDescription('Gewinnspiele')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand(s => s.setName('start').setDescription('Gewinnspiel starten')
        .addStringOption(o => o.setName('preis').setDescription('Was gibt es zu gewinnen?').setRequired(true).setMaxLength(200))
        .addStringOption(o => o.setName('dauer').setDescription('z. B. 1h, 2d').setRequired(true))
        .addIntegerOption(o => o.setName('gewinner').setDescription('Anzahl Gewinner').setMinValue(1).setMaxValue(20))
        .addChannelOption(o => o.setName('kanal').setDescription('Wohin?').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption(o => o.setName('beschreibung').setDescription('Zusätzlicher Text').setMaxLength(1000))
        .addRoleOption(o => o.setName('pflichtrolle').setDescription('Nur Mitglieder mit dieser Rolle dürfen teilnehmen')))
      .addSubcommand(s => s.setName('end').setDescription('Gewinnspiel sofort beenden').addStringOption(o => o.setName('nachricht_id').setDescription('ID der Gewinnspiel-Nachricht').setRequired(true)))
      .addSubcommand(s => s.setName('reroll').setDescription('Neue Gewinner auslosen')
        .addStringOption(o => o.setName('nachricht_id').setDescription('ID der Gewinnspiel-Nachricht').setRequired(true))
        .addIntegerOption(o => o.setName('anzahl').setDescription('Wie viele neu auslosen?').setMinValue(1).setMaxValue(20))),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'start') {
        const ms = parseDuration(i.options.getString('dauer'));
        if (!ms || ms < 10_000) return respond(i, err('Dauer nicht erkannt. Beispiele: `30m`, `1d`.'));
        const ch = i.options.getChannel('kanal') || i.channel;
        const msg = await giveaways.start(ch, i.user, { prize: i.options.getString('preis'), durationMs: ms, winners: i.options.getInteger('gewinner') || 1, description: i.options.getString('beschreibung'), requiredRole: i.options.getRole('pflichtrolle')?.id });
        return respond(i, ok(`Gewinnspiel gestartet in ${ch}. ID: \`${msg.id}\``));
      }
      const id = i.options.getString('nachricht_id').trim();
      if (sub === 'end') {
        const g = await giveaways.end(i.client, id);
        return respond(i, g ? ok('Gewinnspiel beendet.') : err('Gewinnspiel nicht gefunden oder schon beendet.'));
      }
      const w = await giveaways.reroll(i.client, id, i.options.getInteger('anzahl') || 1);
      return respond(i, w ? ok('Neu ausgelost.') : err('Gewinnspiel nicht gefunden oder noch nicht beendet.'));
    },
  },

  // ---------- Umfragen (native Discord-Umfragen) ----------
  {
    data: new SlashCommandBuilder().setName('poll').setDescription('Umfrage erstellen')
      .addStringOption(o => o.setName('frage').setDescription('Die Frage').setRequired(true).setMaxLength(300))
      .addStringOption(o => o.setName('antworten').setDescription('Antworten mit | getrennt, z. B. Ja | Nein | Vielleicht').setRequired(true))
      .addIntegerOption(o => o.setName('stunden').setDescription('Laufzeit in Stunden (1–768, Standard 24)').setMinValue(1).setMaxValue(768))
      .addBooleanOption(o => o.setName('mehrfach').setDescription('Mehrere Antworten erlaubt?')),
    async execute(i) {
      const answers = i.options.getString('antworten').split('|').map(s => s.trim()).filter(Boolean).slice(0, 10);
      if (answers.length < 2) return respond(i, err('Mindestens 2 Antworten, getrennt mit `|`.'));
      try {
        await i.reply({ poll: { question: { text: i.options.getString('frage') }, answers: answers.map(text => ({ text: text.slice(0, 55) })), duration: i.options.getInteger('stunden') || 24, allowMultiselect: i.options.getBoolean('mehrfach') ?? false } });
      } catch (e) { return respond(i, err(`Umfrage fehlgeschlagen: ${e.message}`)); }
    },
  },

  // ---------- Embed-Baukasten ----------
  {
    data: new SlashCommandBuilder().setName('embed').setDescription('Schöne Nachricht (Embed) erstellen und posten')
      .setDefaultMemberPermissions(P.ManageMessages)
      .addChannelOption(o => o.setName('kanal').setDescription('Wohin? (Standard: hier)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    async execute(i) {
      const ch = i.options.getChannel('kanal') || i.channel;
      const field = (id, label, style, max, req = false) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(req));
      return i.showModal(new ModalBuilder().setCustomId(`emb:${ch.id}`).setTitle('Embed erstellen').addComponents(
        field('title', 'Titel', TextInputStyle.Short, 256),
        field('description', 'Text', TextInputStyle.Paragraph, 4000, true),
        field('color', 'Farbe als Hex (z. B. #ff2d55)', TextInputStyle.Short, 7),
        field('image', 'Bild-Link (optional)', TextInputStyle.Short, 500),
        field('footer', 'Fußzeile (optional)', TextInputStyle.Short, 200)));
    },
  },
];
