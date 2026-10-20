'use strict';
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelType, version: djsVersion } = require('discord.js');
const { COLORS, respond, EPHEMERAL } = require('../lib/embeds');
const { ts, formatDuration } = require('../lib/util');
const store = require('../lib/store');
const lf = require('../lib/linkFilter');

const HELP = {
  start: {
    label: 'Erste Schritte', emoji: '🚀',
    text: [
      '**1.** `/setup quickstart` – legt Logs, Willkommen, Temp-Sprachkanäle und Tickets an',
      '**2.** `/setup rules` – Regeln mit „Akzeptieren“-Button (+ Captcha)',
      '**3.** `/setup modrole` – Team-Rolle eintragen',
      '**4.** `/dashboard` in Discord oder das **Web-Dashboard** (Adresse deines Bots) – alles einstellen',
      '**5.** Meine Rolle in **Server-Einstellungen → Rollen** ganz nach oben ziehen (wichtig für Schutz & Moderation)',
    ].join('\n'),
  },
  mod: {
    label: 'Moderation', emoji: '🔨',
    text: '`/ban` (auch auf Zeit) · `/softban` · `/unban` · `/kick` · `/timeout` · `/untimeout`\n`/warn` · `/warnings` · `/delwarn` · `/clearwarnings` · `/modlogs`\n`/purge` (mit Filtern) · `/slowmode` · `/lock` · `/unlock` · `/nick` · `/role add|remove`\nAb 3/5/7 Verwarnungen gibt es automatisch Timeout/Kick/Bann (`/automod escalation`).',
  },
  protect: {
    label: 'Schutz', emoji: '🛡️',
    text: '**Lockdown:** `/lockdown start|end|status` – sperrt alle Kanäle, pausiert Einladungen, stellt danach alles exakt wieder her.\n**Linkschutz:** `/automod links mode|allow|block|test` – GIFs & bekannte Seiten gehen, Betrug/Phishing/IP-Logger/Kurz-Links werden blockiert.\n**AutoMod:** Spam, Einladungen, Massen-Erwähnungen, GROSSBUCHSTABEN, Wortfilter (`/automod`).\n**Anti-Raid:** erkennt Beitrittswellen → Lockdown + Einladungen pausieren (`/antiraid`). Mindest-Accountalter gegen Fake-Accounts.\n**Anti-Nuke:** stoppt gehackte Admins/Bots, die Kanäle/Rollen löschen oder massenhaft bannen, und stellt sie wieder her (`/antinuke`).',
  },
  channels: {
    label: 'Kanäle & Tickets', emoji: '🔊',
    text: '**Temp-Sprachkanäle:** Hub betreten → eigener Kanal. Das **Bedienfeld erscheint im Chat des Sprachkanals**: Name, Limit, Sperren, Verstecken, Bitrate, Region, Erlauben, Rauswerfen, **Bannen/Entbannen**, Übernehmen, Übertragen. Name, Limit und Bannliste werden für deinen nächsten Kanal gemerkt. Auch per `/voice …`.\n**Temp-Textkanäle:** `/tempchannel create|extend|delete` – löschen sich selbst.\n**Tickets:** Button → privater Kanal, Transkript beim Schließen (`/ticket close|add|remove|panel`).',
  },
  music: {
    label: 'Musik & Sounds', emoji: '🎵',
    text: '`/play` YouTube, SoundCloud, Spotify-Song, Radio, MP3 oder Suche (auch Playlists und eigene Dateien)\n`/pause` · `/resume` · `/skip` · `/stop` · `/queue` · `/nowplaying` · `/remove` · `/shuffle` · `/loop` · `/seek` · `/volume`\n`/filter` Bass-Boost, Nightcore, Slowed + Reverb, 8D, Karaoke …\n`/lyrics` Songtext · `/sound play|add|list` Soundboard · `/watch` YouTube gemeinsam schauen\nDie „Läuft gerade“-Nachricht hat Buttons für alles.',
  },
  members: {
    label: 'Mitglieder', emoji: '👋',
    text: '**Willkommen/Abschied:** `/setup welcome|goodbye|welcometest` – mit Bildkarte.\n**Auto-Rollen:** `/setup autorole`.\n**Regeln akzeptieren:** `/setup rules`.\n**Rollen zum Selbstabholen:** `/rolepanel create|add|remove` (Buttons oder Menü).',
  },
  community: {
    label: 'Level, Quests & Münzen', emoji: '⭐',
    text: '**Level:** XP für Nachrichten, **Sprachzeit** und **Clips** (🔥-Likes geben dem Ersteller XP, die besten landen in der Hall of Fame). `/lvl` (im Level-Kanal) · `/rank` · `/leaderboard` (XP, Münzen, Sprachzeit, Clips) · `/level reward|set|addxp|noxp`\n**Tages-Quests:** `/quests` – jeden Tag neue Aufgaben, Bonus und Serie.\n**Münzen:** `/daily` · `/balance` · `/pay` · `/shop view|add|remove|give`',
  },
  fun: {
    label: 'Extras', emoji: '🎉',
    text: '`/giveaway start|end|reroll` · `/poll` · `/embed` · `/suggest` · `/remind` · `/autoresponse` · `/userinfo` · `/serverinfo` · `/avatar` · `/ping`\nStatistik-Kanäle: `/setup stats`\n**Web-Dashboard:** alles bequem im Browser einstellen (Adresse des Bots öffnen).',
  },
};

function helpPayload(key = 'start') {
  const h = HELP[key] || HELP.start;
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle(`${h.emoji} Hilfe · ${h.label}`).setDescription(h.text).setFooter({ text: 'Bereich im Menü wählen' })],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('help:menu').setPlaceholder('Bereich wählen …')
      .addOptions(Object.entries(HELP).map(([value, v]) => ({ label: v.label, value, emoji: v.emoji, default: value === key }))))],
  };
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('help').setDescription('Alle Funktionen und Befehle'),
    execute: i => i.reply({ ...helpPayload(), flags: EPHEMERAL }),
  },
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Ist der Bot online? Antwortzeit und Status'),
    async execute(i) {
      const mem = process.memoryUsage().rss / 1024 / 1024;
      return respond(i, new EmbedBuilder().setColor(COLORS.ok).setTitle('🏓 Pong!').setDescription([
        `**Antwortzeit:** ${Math.round(i.client.ws.ping)} ms`,
        `**Online seit:** ${formatDuration(process.uptime() * 1000)}`,
        `**Server:** ${i.client.guilds.cache.size} · **Speicher:** ${store.kind} · **RAM:** ${mem.toFixed(0)} MB`,
        `**Version:** \`${require('../lib/version').slice(0, 70)}\``,
        `**Betrugs-Datenbank:** ${lf.phishingCount().toLocaleString('de-DE')} Domains`,
        `**discord.js** ${djsVersion} · **Node** ${process.version}`,
      ].join('\n')));
    },
  },
  {
    data: new SlashCommandBuilder().setName('userinfo').setDescription('Infos über ein Mitglied').addUserOption(o => o.setName('mitglied').setDescription('Wer?')),
    async execute(i) {
      const user = await (i.options.getUser('mitglied') || i.user).fetch();
      const member = i.options.getMember('mitglied') || (i.options.getUser('mitglied') ? null : i.member);
      const e = new EmbedBuilder().setColor(member?.displayColor || COLORS.brand).setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: `\`${user.id}\``, inline: true },
          { name: 'Account erstellt', value: ts(user.createdTimestamp, 'D') + `\n${ts(user.createdTimestamp)}`, inline: true },
        );
      if (member) {
        e.addFields(
          { name: 'Beigetreten', value: member.joinedTimestamp ? ts(member.joinedTimestamp, 'D') + `\n${ts(member.joinedTimestamp)}` : '–', inline: true },
          { name: `Rollen (${member.roles.cache.size - 1})`, value: member.roles.cache.filter(r => r.id !== i.guild.id).sort((a, b) => b.position - a.position).map(r => `<@&${r.id}>`).slice(0, 30).join(' ') || '–' },
        );
        if (member.isCommunicationDisabled()) e.addFields({ name: '⏳ Timeout bis', value: ts(member.communicationDisabledUntilTimestamp) });
      }
      if (user.bannerURL()) e.setImage(user.bannerURL({ size: 1024 }));
      return respond(i, e, { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('Infos über diesen Server'),
    async execute(i) {
      const g = i.guild;
      const owner = await g.fetchOwner().catch(() => null);
      const ch = g.channels.cache;
      const e = new EmbedBuilder().setColor(COLORS.brand).setTitle(g.name).setThumbnail(g.iconURL({ size: 256 }))
        .addFields(
          { name: 'Inhaber', value: owner ? `<@${owner.id}>` : '–', inline: true },
          { name: 'Erstellt', value: ts(g.createdTimestamp, 'D'), inline: true },
          { name: 'Mitglieder', value: String(g.memberCount), inline: true },
          { name: 'Kanäle', value: `💬 ${ch.filter(c => c.type === ChannelType.GuildText).size} · 🔊 ${ch.filter(c => c.type === ChannelType.GuildVoice).size} · 📁 ${ch.filter(c => c.type === ChannelType.GuildCategory).size}`, inline: true },
          { name: 'Rollen', value: String(g.roles.cache.size - 1), inline: true },
          { name: 'Boosts', value: `${g.premiumSubscriptionCount || 0} (Stufe ${g.premiumTier})`, inline: true },
        )
        .setFooter({ text: `ID: ${g.id}` });
      if (g.bannerURL()) e.setImage(g.bannerURL({ size: 1024 }));
      return respond(i, e, { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('avatar').setDescription('Profilbild groß anzeigen').addUserOption(o => o.setName('mitglied').setDescription('Wessen?')),
    async execute(i) {
      const user = i.options.getUser('mitglied') || i.user;
      const member = i.options.getMember('mitglied') || (user.id === i.user.id ? i.member : null);
      const url = (member || user).displayAvatarURL({ size: 1024 });
      return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle(`Avatar von ${user.username}`).setImage(url).setURL(url), { ephemeral: false });
    },
  },
];

module.exports.helpPayload = helpPayload;
