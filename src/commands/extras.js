'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder } = require('discord.js');
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const { parseDuration, ts, truncate } = require('../lib/util');
const extras = require('../modules/extras');

module.exports = [
  {
    data: new SlashCommandBuilder().setName('autoresponse').setDescription('Automatische Antworten auf Wörter/Sätze')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand(s => s.setName('add').setDescription('Neue Auto-Antwort')
        .addStringOption(o => o.setName('ausloeser').setDescription('Wort oder Satz, z. B. „ip“').setRequired(true).setMaxLength(100))
        .addStringOption(o => o.setName('antwort').setDescription('Antwort (Platzhalter: {user} {server})').setRequired(true).setMaxLength(2000))
        .addStringOption(o => o.setName('vergleich').setDescription('Wann auslösen?').addChoices(
          { name: 'Enthält das Wort', value: 'contains' }, { name: 'Genau dieser Text', value: 'exact' }, { name: 'Beginnt damit', value: 'startswith' })))
      .addSubcommand(s => s.setName('remove').setDescription('Auto-Antwort löschen').addStringOption(o => o.setName('ausloeser').setDescription('Auslöser').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('Alle Auto-Antworten')),
    async execute(i) {
      const cfg = getConfig(i.guild.id);
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle('💬 Auto-Antworten')
          .setDescription(cfg.autoresponders.map(a => `**${a.trigger}** (${a.match}) → ${truncate(a.response, 80)}`).join('\n') || 'Noch keine.'));
      }
      const trig = i.options.getString('ausloeser').trim().toLowerCase();
      cfg.autoresponders = cfg.autoresponders.filter(a => a.trigger !== trig);
      if (sub === 'add') {
        if (cfg.autoresponders.length >= 100) return respond(i, err('Maximal 100 Auto-Antworten.'));
        cfg.autoresponders.push({ trigger: trig, response: i.options.getString('antwort'), match: i.options.getString('vergleich') || 'contains', reply: true });
      }
      saveConfig(i.guild.id);
      return respond(i, ok(sub === 'add' ? `Auf **${trig}** antworte ich jetzt automatisch.` : `Auto-Antwort **${trig}** gelöscht.`));
    },
  },
  {
    data: new SlashCommandBuilder().setName('suggest').setDescription('Vorschlag machen – alle können abstimmen')
      .addStringOption(o => o.setName('vorschlag').setDescription('Dein Vorschlag').setRequired(true).setMaxLength(1500)),
    async execute(i) {
      try {
        const { ch } = await extras.createSuggestion(i, i.options.getString('vorschlag'));
        return respond(i, ok(`Danke! Dein Vorschlag steht in ${ch}.`));
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('remind').setDescription('Erinnerung stellen')
      .addStringOption(o => o.setName('in').setDescription('Wann? z. B. 10m, 2h, 1d').setRequired(true))
      .addStringOption(o => o.setName('woran').setDescription('Woran soll ich dich erinnern?').setRequired(true).setMaxLength(1000)),
    async execute(i) {
      const ms = parseDuration(i.options.getString('in'));
      if (!ms || ms < 60_000 || ms > 365 * 86_400_000) return respond(i, err('Zeit zwischen 1 Minute und 1 Jahr, z. B. `10m`, `2h`, `3d`.'));
      const mine = store.values('reminders').filter(r => r.userId === i.user.id).length;
      if (mine >= 25) return respond(i, err('Du hast schon 25 Erinnerungen.'));
      const at = Date.now() + ms;
      extras.addReminder(i.guild.id, i.channel.id, i.user.id, i.options.getString('woran'), at);
      return respond(i, ok(`Ich erinnere dich ${ts(at)} (${ts(at, 'f')}). Per DM, sonst hier im Kanal.`));
    },
  },
];
