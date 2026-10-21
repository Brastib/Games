'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const leveling = require('../modules/leveling');
const store = require('../lib/store');

const PAGE = 10;

const BOARDS = {
  xp: { title: 'Level', fmt: (e, cfg, g) => `Level **${leveling.levelFromXp(e.xp, g).level}** · ${e.xp.toLocaleString('de-DE')} XP` },
  coins: { title: 'Münzen', fmt: (e, cfg) => `**${(e.coins || 0).toLocaleString('de-DE')}** ${cfg.economy.emoji}` },
  voiceMin: { title: 'Sprachzeit', fmt: e => `**${Math.floor((e.voiceMin || 0) / 60)} Std. ${(e.voiceMin || 0) % 60} Min.**` },
  clips: { title: 'Clips', fmt: e => `**${e.clips || 0}** Clips` },
};

function leaderboardPayload(guild, page, by = 'xp') {
  if (!BOARDS[by]) by = 'xp';
  const cfg = getConfig(guild.id);
  const list = by === 'coins' ? require('../modules/economy').richest(guild.id) : leveling.leaderboard(guild.id, by);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = list.slice(page * PAGE, page * PAGE + PAGE).map((e, idx) => {
    const pos = page * PAGE + idx;
    return `${medals[pos] || `**${pos + 1}.**`} <@${e.userId}> · ${BOARDS[by].fmt(e, cfg, guild.id)}`;
  });
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle(`🏆 Bestenliste · ${BOARDS[by].title}`).setDescription(lines.join('\n') || 'Noch keine Einträge.').setFooter({ text: `${guild.name} · Seite ${page + 1}/${pages}` })],
    components: pages > 1 ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lb:${by}:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`lb:${by}:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1))] : [],
    allowedMentions: { parse: [] },
  };
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('rückblick').setDescription('📅 Wochen-Rückblick: die letzten 7 Tage (nur du siehst es)'),
    async execute(i) {
      await i.deferReply({ flags: 64 });
      try {
        return respond(i, await require('../modules/recap').payload(i.guild));
      } catch (e) { return respond(i, err(e.message)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('lvl').setDescription('📊 Dein Level, XP und Rang (im Level-Kanal)')
      .addUserOption(o => o.setName('mitglied').setDescription('Wessen Level?')),
    async execute(i) {
      const cfg = getConfig(i.guild.id).levels;
      if (cfg.lvlOnlyInChannel && cfg.channel && i.channelId !== cfg.channel) return respond(i, err(`/lvl geht im Level-Kanal: <#${cfg.channel}>`));
      const member = i.options.getMember('mitglied') || i.member;
      if (member.user.bot) return respond(i, err('Bots sammeln keine XP.'));
      await i.deferReply();
      if (member.id === i.user.id) require('../modules/quests').progress(i.member, 'rank', 1);
      return respond(i, await leveling.rankPayload(member));
    },
  },
  {
    data: new SlashCommandBuilder().setName('rank').setDescription('Dein Level und Rang (oder von jemand anderem)')
      .addUserOption(o => o.setName('mitglied').setDescription('Wessen Rang?')),
    async execute(i) {
      const member = i.options.getMember('mitglied') || i.member;
      if (member.user.bot) return respond(i, err('Bots sammeln keine XP.'));
      await i.deferReply();
      if (member.id === i.user.id) require('../modules/quests').progress(i.member, 'rank', 1);
      return respond(i, await leveling.rankPayload(member));
    },
  },
  {
    data: new SlashCommandBuilder().setName('leaderboard').setDescription('Bestenliste des Servers')
      .addStringOption(o => o.setName('nach').setDescription('Wonach sortieren?').addChoices(
        { name: 'Level / XP', value: 'xp' }, { name: 'Münzen', value: 'coins' }, { name: 'Sprachzeit', value: 'voiceMin' }, { name: 'Clips', value: 'clips' }))
      .addBooleanOption(o => o.setName('liste').setDescription('Als Textliste statt Bild')),
    async execute(i) {
      const by = i.options.getString('nach') || 'xp';
      if (by === 'xp' && i.options.getBoolean('liste') !== true) {
        await i.deferReply();
        const png = await leveling.leaderboardImage(i.guild).catch(() => null);
        if (png) {
          return respond(i, {
            content: '🏆 **Die aktuelle Bestenliste!** Wer schreibt sich diese Runde nach oben?',
            files: [new AttachmentBuilder(png, { name: 'bestenliste.png' })],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('lb:xp:0').setLabel('Ganze Liste').setEmoji('📜').setStyle(ButtonStyle.Secondary))],
          });
        }
        return respond(i, leaderboardPayload(i.guild, 0, by));
      }
      return i.reply(leaderboardPayload(i.guild, 0, by));
    },
  },
  {
    data: new SlashCommandBuilder().setName('level').setDescription('Level verwalten (Team)')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand(s => s.setName('set').setDescription('Level eines Mitglieds setzen')
        .addUserOption(o => o.setName('mitglied').setDescription('Wer?').setRequired(true))
        .addIntegerOption(o => o.setName('level').setDescription('Neues Level').setRequired(true).setMinValue(0).setMaxValue(500)))
      .addSubcommand(s => s.setName('addxp').setDescription('XP geben oder abziehen')
        .addUserOption(o => o.setName('mitglied').setDescription('Wer?').setRequired(true))
        .addIntegerOption(o => o.setName('xp').setDescription('XP (negativ = abziehen)').setRequired(true)))
      .addSubcommand(s => s.setName('reset').setDescription('XP eines Mitglieds zurücksetzen').addUserOption(o => o.setName('mitglied').setDescription('Wer?').setRequired(true)))
      .addSubcommand(s => s.setName('reward').setDescription('Rolle als Belohnung für ein Level (nochmal = entfernen)')
        .addIntegerOption(o => o.setName('level').setDescription('Ab Level').setRequired(true).setMinValue(1).setMaxValue(500))
        .addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true)))
      .addSubcommand(s => s.setName('rewards').setDescription('Alle Belohnungen anzeigen'))
      .addSubcommand(s => s.setName('import').setDescription('Bisherige XP übernehmen (Datei: ID/Name + XP, z. B. vom alten Bot)')
        .addAttachmentOption(o => o.setName('datei').setDescription('CSV, TXT oder JSON').setRequired(true))
        .addStringOption(o => o.setName('modus').setDescription('XP ersetzen oder dazurechnen?').addChoices({ name: 'Ersetzen (Standard)', value: 'set' }, { name: 'Dazurechnen', value: 'add' })))
      .addSubcommand(s => s.setName('formel').setDescription('Level-Formel wählen')
        .addStringOption(o => o.setName('formel').setDescription('Formel').setRequired(true).addChoices({ name: 'ETC. – Level L ab 100 × L² XP (wie bisher)', value: 'etc' }, { name: 'MEE6', value: 'mee6' })))
      .addSubcommand(s => s.setName('noxp').setDescription('Kanal oder Rolle ohne XP (nochmal = wieder mit XP)')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanal'))
        .addRoleOption(o => o.setName('rolle').setDescription('Rolle'))),
    async execute(i) {
      const sub = i.options.getSubcommand();
      const cfg = getConfig(i.guild.id).levels;
      const member = i.options.getMember('mitglied');
      if (['set', 'addxp', 'reset'].includes(sub) && !member) return respond(i, err('Diese Person ist nicht auf dem Server.'));
      if (sub === 'set') {
        const lvl = await leveling.setXp(member, leveling.xpForLevel(i.options.getInteger('level'), i.guild.id));
        return respond(i, ok(`${member} ist jetzt Level **${lvl}**.`));
      }
      if (sub === 'addxp') {
        const d = leveling.getData(i.guild.id, member.id);
        const lvl = await leveling.setXp(member, d.xp + i.options.getInteger('xp'));
        return respond(i, ok(`${member} hat jetzt ${leveling.getData(i.guild.id, member.id).xp} XP (Level ${lvl}).`));
      }
      if (sub === 'reset') {
        store.delete('levels', `${i.guild.id}:${member.id}`);
        return respond(i, ok(`XP von ${member} zurückgesetzt.`));
      }
      if (sub === 'reward') {
        const lvl = String(i.options.getInteger('level'));
        const role = i.options.getRole('rolle');
        if (!role.editable) return respond(i, err(`Ich kann ${role} nicht vergeben – meine Rolle muss darüber stehen.`));
        if (cfg.rewards[lvl] === role.id) { delete cfg.rewards[lvl]; saveConfig(i.guild.id); return respond(i, ok(`Belohnung für Level ${lvl} entfernt.`)); }
        cfg.rewards[lvl] = role.id;
        saveConfig(i.guild.id);
        return respond(i, ok(`Ab Level **${lvl}** gibt es ${role}.`));
      }
      if (sub === 'rewards') {
        const list = Object.entries(cfg.rewards).sort((a, b) => a[0] - b[0]).map(([l, r]) => `Level **${l}** → <@&${r}>`);
        return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle('🎁 Level-Belohnungen').setDescription(list.join('\n') || 'Noch keine. `/level reward`'));
      }
      if (sub === 'import') {
        const file = i.options.getAttachment('datei');
        if (file.size > 2 * 1024 * 1024) return respond(i, err('Die Datei ist größer als 2 MB.'));
        await i.deferReply({ flags: 64 });
        try {
          const text = await (await fetch(file.url)).text();
          const r = await leveling.importXp(i.guild, text, { mode: i.options.getString('modus') || 'set' });
          return respond(i, new EmbedBuilder().setColor(r.imported ? COLORS.ok : COLORS.err).setTitle('📥 XP-Import')
            .setDescription(`**${r.imported}** von ${r.total} Einträgen übernommen.${r.missing.length ? `\n\nNicht gefunden (Name/ID passt zu keinem Mitglied): ${r.missing.slice(0, 30).join(', ')}${r.missing.length > 30 ? ' …' : ''}` : ''}\n\nRollen-Belohnungen werden beim nächsten Level-Up vergeben. Bestenliste: \`/leaderboard\``));
        } catch (e) { return respond(i, err(`Datei konnte nicht gelesen werden: ${e.message}`)); }
      }
      if (sub === 'formel') {
        cfg.formula = i.options.getString('formel');
        saveConfig(i.guild.id);
        return respond(i, ok(`Level-Formel: **${leveling.CURVES[cfg.formula].label}**. Die XP bleiben gleich, nur die Level werden neu berechnet.`));
      }
      if (sub === 'noxp') {
        const ch = i.options.getChannel('kanal');
        const role = i.options.getRole('rolle');
        if (!ch && !role) return respond(i, err('Wähle einen Kanal oder eine Rolle.'));
        const out = [];
        if (ch) { const k = cfg.noXpChannels.indexOf(ch.id); if (k >= 0) cfg.noXpChannels.splice(k, 1); else cfg.noXpChannels.push(ch.id); out.push(`${ch}: ${k >= 0 ? 'gibt wieder XP' : 'keine XP'}`); }
        if (role) { const k = cfg.noXpRoles.indexOf(role.id); if (k >= 0) cfg.noXpRoles.splice(k, 1); else cfg.noXpRoles.push(role.id); out.push(`${role}: ${k >= 0 ? 'bekommt wieder XP' : 'keine XP'}`); }
        saveConfig(i.guild.id);
        return respond(i, ok(out.join('\n')));
      }
    },
  },
];

module.exports.leaderboardPayload = leaderboardPayload;
