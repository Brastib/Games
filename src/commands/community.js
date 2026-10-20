'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const quests = require('../modules/quests');
const economy = require('../modules/economy');

module.exports = [
  {
    data: new SlashCommandBuilder().setName('quests').setDescription('Deine täglichen Quests und deine Serie')
      .addUserOption(o => o.setName('mitglied').setDescription('Wessen Quests?')),
    async execute(i) {
      if (!getConfig(i.guild.id).quests.enabled) return respond(i, err('Quests sind auf diesem Server ausgeschaltet.'));
      const member = i.options.getMember('mitglied') || i.member;
      return respond(i, quests.embedFor(member), { ephemeral: member.id === i.user.id ? false : true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('daily').setDescription('Tägliche Münz-Belohnung abholen (Serie = mehr Münzen)'),
    async execute(i) {
      if (!getConfig(i.guild.id).economy.enabled) return respond(i, err('Münzen sind auf diesem Server ausgeschaltet.'));
      const r = economy.daily(i.member);
      if (r.ok) await quests.progress(i.member, 'daily', 1, i.channel);
      return respond(i, economy.dailyText(i.member, r), { ephemeral: !r.ok });
    },
  },
  {
    data: new SlashCommandBuilder().setName('balance').setDescription('Kontostand anzeigen').addUserOption(o => o.setName('mitglied').setDescription('Wessen?')),
    async execute(i) {
      const cfg = getConfig(i.guild.id).economy;
      const user = i.options.getUser('mitglied') || i.user;
      const d = economy.get(i.guild.id, user.id);
      const pos = economy.richest(i.guild.id).findIndex(e => e.userId === user.id);
      return respond(i, new EmbedBuilder().setColor(COLORS.brand).setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
        .setDescription(`**${d.coins.toLocaleString('de-DE')} ${cfg.emoji}** ${cfg.name}\nPlatz **${pos >= 0 ? pos + 1 : '–'}** auf dem Server · Daily-Serie: **${d.dailyStreak || 0}**`), { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('pay').setDescription('Münzen an jemanden überweisen')
      .addUserOption(o => o.setName('mitglied').setDescription('An wen?').setRequired(true))
      .addIntegerOption(o => o.setName('betrag').setDescription('Wie viel?').setRequired(true).setMinValue(1)),
    async execute(i) {
      const cfg = getConfig(i.guild.id).economy;
      const to = i.options.getUser('mitglied');
      const amount = i.options.getInteger('betrag');
      if (to.bot || to.id === i.user.id) return respond(i, err('Wähle eine andere Person.'));
      if (!economy.transfer(i.guild.id, i.user.id, to.id, amount)) return respond(i, err(`Du hast nicht genug ${cfg.name}.`));
      return respond(i, ok(`${amount} ${cfg.emoji} an ${to} überwiesen.`), { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('shop').setDescription('Rollen mit Münzen kaufen')
      .addSubcommand(s => s.setName('view').setDescription('Shop anzeigen'))
      .addSubcommand(s => s.setName('add').setDescription('Rolle in den Shop stellen (Team)')
        .addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true))
        .addIntegerOption(o => o.setName('preis').setDescription('Preis').setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName('beschreibung').setDescription('Kurze Beschreibung').setMaxLength(100)))
      .addSubcommand(s => s.setName('remove').setDescription('Rolle aus dem Shop nehmen (Team)').addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true)))
      .addSubcommand(s => s.setName('give').setDescription('Münzen geben oder abziehen (Team)')
        .addUserOption(o => o.setName('mitglied').setDescription('Wem?').setRequired(true))
        .addIntegerOption(o => o.setName('betrag').setDescription('Betrag (negativ = abziehen)').setRequired(true))),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'view') return respond(i, economy.shopPayload(i.guild), { ephemeral: false });
      if (!i.member.permissions.has(P.ManageGuild)) return respond(i, err('Nur Admins (Server verwalten) dürfen das.'));
      const cfg = getConfig(i.guild.id).economy;
      if (sub === 'add') {
        const role = i.options.getRole('rolle');
        if (!role.editable || role.managed) return respond(i, err(`Ich kann ${role} nicht vergeben.`));
        cfg.shop = cfg.shop.filter(x => x.roleId !== role.id);
        cfg.shop.push({ roleId: role.id, price: i.options.getInteger('preis'), description: i.options.getString('beschreibung') || '' });
        saveConfig(i.guild.id);
        return respond(i, ok(`${role} kostet jetzt **${i.options.getInteger('preis')} ${cfg.emoji}** im Shop.`));
      }
      if (sub === 'remove') {
        const role = i.options.getRole('rolle');
        cfg.shop = cfg.shop.filter(x => x.roleId !== role.id);
        saveConfig(i.guild.id);
        return respond(i, ok(`${role} aus dem Shop entfernt.`));
      }
      if (sub === 'give') {
        const u = i.options.getUser('mitglied');
        const total = economy.add(i.guild.id, u.id, i.options.getInteger('betrag'));
        return respond(i, ok(`${u} hat jetzt **${total} ${cfg.emoji}**.`));
      }
    },
  },
];
