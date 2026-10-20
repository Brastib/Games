'use strict';
const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { getConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const { randomInt } = require('../lib/util');
const events = require('../modules/events');

const ANSWERS = [
  'Ja, ganz sicher.', 'Auf jeden Fall.', 'Ohne Zweifel.', 'Sieht gut aus.', 'Die Zeichen stehen auf Ja.', 'Wahrscheinlich.',
  'Frag später nochmal.', 'Das sag ich dir lieber nicht.', 'Kann ich gerade nicht sagen.', 'Konzentrier dich und frag nochmal.',
  'Eher nicht.', 'Meine Quellen sagen nein.', 'Sehr zweifelhaft.', 'Nein.', 'Vergiss es.',
];
const SSP = { schere: '✂️ Schere', stein: '🪨 Stein', papier: '📄 Papier' };
const BEATS = { schere: 'papier', stein: 'schere', papier: 'stein' };

const funOff = i => (getConfig(i.guild.id).fun.enabled ? null : respond(i, err('Fun-Befehle sind auf diesem Server aus.')));

module.exports = [
  {
    data: new SlashCommandBuilder().setName('8ball').setDescription('🎱 Die magische Kugel beantwortet deine Frage')
      .addStringOption(o => o.setName('frage').setDescription('Deine Ja/Nein-Frage').setRequired(true).setMaxLength(200)),
    async execute(i) {
      const off = funOff(i); if (off) return off;
      return respond(i, new EmbedBuilder().setColor(COLORS.brand).setDescription(`❓ ${i.options.getString('frage')}\n🎱 **${ANSWERS[randomInt(0, ANSWERS.length - 1)]}**`), { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('ssp').setDescription('✂️ Schere, Stein, Papier gegen den Bot')
      .addStringOption(o => o.setName('wahl').setDescription('Was nimmst du?').setRequired(true).addChoices(...Object.entries(SSP).map(([value, name]) => ({ name, value })))),
    async execute(i) {
      const off = funOff(i); if (off) return off;
      const me = i.options.getString('wahl'), bot = Object.keys(SSP)[randomInt(0, 2)];
      const result = me === bot ? '🤝 Unentschieden!' : BEATS[me] === bot ? '🎉 Du gewinnst!' : '😈 Ich gewinne!';
      return respond(i, new EmbedBuilder().setColor(COLORS.brand).setDescription(`Du: **${SSP[me]}** · Ich: **${SSP[bot]}**\n${result}`), { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('münze').setDescription('🪙 Münze werfen: Kopf oder Zahl'),
    async execute(i) {
      const off = funOff(i); if (off) return off;
      return respond(i, `🪙 **${randomInt(0, 1) ? 'Kopf' : 'Zahl'}**`, { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('würfel').setDescription('🎲 Würfeln')
      .addIntegerOption(o => o.setName('seiten').setDescription('Seiten pro Würfel (Standard 6)').setMinValue(2).setMaxValue(1000))
      .addIntegerOption(o => o.setName('anzahl').setDescription('Wie viele Würfel? (Standard 1)').setMinValue(1).setMaxValue(20)),
    async execute(i) {
      const off = funOff(i); if (off) return off;
      const sides = i.options.getInteger('seiten') || 6, n = i.options.getInteger('anzahl') || 1;
      const rolls = Array.from({ length: n }, () => randomInt(1, sides));
      return respond(i, `🎲 ${rolls.map(r => `**${r}**`).join(' · ')}${n > 1 ? ` = **${rolls.reduce((a, b) => a + b, 0)}**` : ''} (W${sides})`, { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('event').setDescription('📅 Events planen – mit Zusagen und Erinnerung')
      .addSubcommand(s => s.setName('erstellen').setDescription('Neues Event')
        .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(100))
        .addStringOption(o => o.setName('wann').setDescription('z. B. 24.10. 20:00, morgen 18:30, heute 21:00').setRequired(true).setMaxLength(40))
        .addStringOption(o => o.setName('beschreibung').setDescription('Worum geht es?').setMaxLength(1000))
        .addChannelOption(o => o.setName('kanal').setDescription('Wo posten? (Standard: hier)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand(s => s.setName('liste').setDescription('Geplante Events anzeigen'))
      .addSubcommand(s => s.setName('beenden').setDescription('Event beenden (Team)')
        .addIntegerOption(o => o.setName('nummer').setDescription('Event-Nummer').setRequired(true).setMinValue(1))),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'liste') {
        const open = events.list(i.guild.id).filter(e => !e.ended);
        return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle('📅 Geplante Events')
          .setDescription(open.map(e => `**#${e.id} ${e.name}** · <t:${Math.floor(e.at / 1000)}:F> · ✅ ${e.going.length}`).join('\n') || 'Keine Events geplant.'));
      }
      if (sub === 'beenden') {
        const e = events.list(i.guild.id).find(x => x.id === i.options.getInteger('nummer'));
        if (!e) return respond(i, err('Event nicht gefunden.'));
        if (e.createdBy !== i.user.id && !i.member.permissions.has(P.ManageEvents) && !i.member.permissions.has(P.ManageGuild)) return respond(i, err('Nur wer das Event erstellt hat oder das Team darf es beenden.'));
        await events.end(i.guild, e.id);
        return respond(i, ok(`Event #${e.id} beendet.`));
      }
      const at = events.parseWhen(i.options.getString('wann'));
      if (!at) return respond(i, err('Zeit nicht verstanden. Beispiele: `24.10. 20:00`, `morgen 18:30`, `heute 21:00`.'));
      if (at < Date.now()) return respond(i, err('Dieser Zeitpunkt ist schon vorbei.'));
      const ch = i.options.getChannel('kanal') || i.channel;
      const e = await events.create(ch, i.user, { name: i.options.getString('name'), description: i.options.getString('beschreibung'), at });
      return respond(i, ok(`Event #${e.id} in ${ch} erstellt – <t:${Math.floor(at / 1000)}:F>.`));
    },
  },
];
