'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder, ChannelType } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const quests = require('../modules/quests');
const autoposts = require('../modules/autoposts');

const DAY_CHOICES = autoposts.WEEKDAYS.map((name, value) => ({ name, value }));
const timeOk = t => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t || '');
const economy = require('../modules/economy');

module.exports = [
  {
    data: new SlashCommandBuilder().setName('autopost').setDescription('Automatische Wochen-Posts: Tierfoto und Bestenliste')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand(s => s.setName('tierfoto').setDescription('🐱🐶 Wöchentliches Tierfoto einstellen')
        .addBooleanOption(o => o.setName('an').setDescription('an?'))
        .addChannelOption(o => o.setName('kanal').setDescription('Wohin posten?').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption(o => o.setName('tag').setDescription('Wochentag').addChoices(...DAY_CHOICES))
        .addStringOption(o => o.setName('uhrzeit').setDescription('Uhrzeit, z. B. 18:00').setMaxLength(5))
        .addStringOption(o => o.setName('quelle').setDescription('Woher kommen die Fotos?').addChoices(...Object.entries(autoposts.SOURCES).map(([value, name]) => ({ name, value }))))
        .addChannelOption(o => o.setName('sammelkanal').setDescription('Kanal mit euren Tierfotos (für Quelle „Eigener Sammel-Kanal“)').addChannelTypes(ChannelType.GuildText))
        .addStringOption(o => o.setName('text').setDescription('Text über dem Foto').setMaxLength(300)))
      .addSubcommand(s => s.setName('bestenliste').setDescription('🏆 Wöchentliche Bestenliste als Bild einstellen')
        .addBooleanOption(o => o.setName('an').setDescription('an?'))
        .addChannelOption(o => o.setName('kanal').setDescription('Wohin posten?').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption(o => o.setName('tag').setDescription('Wochentag').addChoices(...DAY_CHOICES))
        .addStringOption(o => o.setName('uhrzeit').setDescription('Uhrzeit, z. B. 12:00').setMaxLength(5))
        .addStringOption(o => o.setName('text').setDescription('Text über der Bestenliste').setMaxLength(300)))
      .addSubcommand(s => s.setName('jetzt').setDescription('Sofort posten (zum Testen)')
        .addStringOption(o => o.setName('was').setDescription('Was?').setRequired(true).addChoices({ name: 'Tierfoto', value: 'animal' }, { name: 'Bestenliste', value: 'leaderboard' })))
      .addSubcommand(s => s.setName('status').setDescription('Einstellungen anzeigen')),
    async execute(i) {
      const sub = i.options.getSubcommand();
      const posts = getConfig(i.guild.id).posts;
      const line = (label, p) => `**${label}:** ${p.enabled ? '🟢 an' : '⚫ aus'} · ${p.channel ? `<#${p.channel}>` : 'kein Kanal'} · jeden **${autoposts.WEEKDAYS[p.weekday]}** um **${p.time} Uhr**`;
      if (sub === 'status') {
        return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle('📅 Automatische Posts').setDescription([
          line('🐱🐶 Tierfoto', posts.animal) + ` · Quelle: ${autoposts.SOURCES[posts.animal.source]}${posts.animal.source === 'pool' && posts.animal.poolChannel ? ` (<#${posts.animal.poolChannel}>)` : ''}`,
          line('🏆 Bestenliste', posts.leaderboard),
        ].join('\n')));
      }
      if (sub === 'jetzt') {
        await i.deferReply({ flags: 64 });
        const type = i.options.getString('was');
        try {
          const ch = await autoposts.runNow(i.guild, type, i.guild.channels.cache.get(posts[type].channel) || i.channel);
          return respond(i, ok(`Gepostet in ${ch}.`));
        } catch (e) { return respond(i, err(e.message)); }
      }
      const p = posts[sub === 'tierfoto' ? 'animal' : 'leaderboard'];
      const time = i.options.getString('uhrzeit');
      if (time && !timeOk(time)) return respond(i, err('Uhrzeit bitte so: `18:00`'));
      p.enabled = i.options.getBoolean('an') ?? (p.enabled || !!i.options.getChannel('kanal'));
      p.channel = i.options.getChannel('kanal')?.id || p.channel;
      p.weekday = i.options.getInteger('tag') ?? p.weekday;
      if (time) p.time = time.padStart(5, '0');
      p.text = i.options.getString('text') || p.text;
      if (sub === 'tierfoto') {
        p.source = i.options.getString('quelle') || p.source;
        p.poolChannel = i.options.getChannel('sammelkanal')?.id || p.poolChannel;
        if (p.source === 'pool' && !p.poolChannel) return respond(i, err('Für „Eigener Sammel-Kanal“ bitte auch `sammelkanal` angeben.'));
      }
      if (p.enabled && !p.channel) return respond(i, err('Bitte einen Kanal angeben.'));
      saveConfig(i.guild.id);
      return respond(i, ok(`${line(sub === 'tierfoto' ? '🐱🐶 Tierfoto' : '🏆 Bestenliste', p)}\nTesten: \`/autopost jetzt\``));
    },
  },
  {
    data: new SlashCommandBuilder().setName('quests').setDescription('Deine täglichen Quests und deine Serie')
      .addUserOption(o => o.setName('mitglied').setDescription('Wessen Quests?')),
    async execute(i) {
      const qc = getConfig(i.guild.id).quests;
      if (!qc.enabled) return respond(i, err('Quests sind auf diesem Server ausgeschaltet.'));
      if (qc.channel && i.channelId !== qc.channel) return respond(i, err(`/quests geht nur in <#${qc.channel}>.`));
      const member = i.options.getMember('mitglied') || i.member;
      // Mit eigenem Quest-Kanal (wie beim alten Bot) sieht nur die Person selbst die Antwort
      return respond(i, quests.embedFor(member), { ephemeral: !!qc.channel || member.id !== i.user.id });
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
