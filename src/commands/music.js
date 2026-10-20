'use strict';
const {
  SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, InviteTargetType,
} = require('discord.js');
const { getConfig } = require('../lib/config');
const { COLORS, ok, err, respond, EPHEMERAL } = require('../lib/embeds');
const { truncate } = require('../lib/util');
const music = require('../modules/music/player');
const { resolve, suggest, lyrics } = require('../modules/music/resolve');
const quests = require('../modules/quests');

const WATCH_TOGETHER_ID = '880218394199220334'; // offizielle Discord-Aktivität "Watch Together" (YouTube)

/** Prüft Sprachkanal, DJ-Rolle usw. Gibt Fehlertext oder null zurück. */
function check(i, { needPlayer = true, dj = false } = {}) {
  const cfg = getConfig(i.guild.id).music;
  if (!cfg.enabled) return 'Musik ist auf diesem Server ausgeschaltet.';
  const p = music.get(i.guild);
  if (needPlayer && (!p || !p.current)) return 'Gerade läuft keine Musik. Starte etwas mit `/play`.';
  const vc = i.member.voice.channel;
  if (!vc) return 'Geh zuerst in einen Sprachkanal.';
  if (p?.voiceChannelId && p.connection && p.voiceChannelId !== vc.id) return `Ich bin gerade in <#${p.voiceChannelId}>. Komm dorthin.`;
  if (dj && cfg.djRole && !i.member.roles.cache.has(cfg.djRole) && !i.member.permissions.has(P.ManageGuild)) {
    const alone = vc.members.filter(m => !m.user.bot).size <= 1;
    const own = p?.current?.requester === i.user.id;
    if (!alone && !own) return `Dafür brauchst du die DJ-Rolle <@&${cfg.djRole}>.`;
  }
  return null;
}

function parseTime(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

function queueEmbed(p) {
  const lines = p.queue.slice(0, 20).map((t, n) => `**${n + 1}.** ${truncate(t.title, 70)} · \`${music.fmtTime(t.duration)}\` · <@${t.requester}>`);
  const total = p.queue.reduce((s, t) => s + (t.duration || 0), 0);
  return new EmbedBuilder().setColor(COLORS.brand).setTitle('📜 Warteschlange')
    .setDescription(`${p.current ? `**Jetzt:** ${truncate(p.current.title, 80)} · \`${music.fmtTime(p.position())}/${music.fmtTime(p.current.duration)}\`\n\n` : ''}${lines.join('\n') || '*Keine weiteren Songs.*'}${p.queue.length > 20 ? `\n… und ${p.queue.length - 20} weitere` : ''}`)
    .setFooter({ text: `${p.queue.length} Songs · Gesamtdauer ${music.fmtTime(total)} · Wiederholen: ${music.LOOP_LABEL[p.loop]} · Filter: ${music.FILTERS[p.filter].label}` });
}

// Soundboard-Sounds (Discord-Standard + Server)
let defaultSounds = null;
let defaultSoundsAt = 0;
async function allSounds(guild) {
  if (!defaultSounds || Date.now() - defaultSoundsAt > 3_600_000) {
    defaultSounds = await guild.client.fetchDefaultSoundboardSounds().catch(() => null);
    defaultSoundsAt = Date.now();
  }
  const own = await guild.soundboardSounds.fetch().catch(() => null);
  return [...(own?.values() || []), ...(defaultSounds?.values() || [])];
}

async function joinFor(i) {
  const vc = i.member.voice.channel;
  const me = i.guild.members.me;
  const perms = vc.permissionsFor(me);
  if (!perms?.has(P.Connect) || !perms.has(P.Speak)) throw new Error(`Ich darf in ${vc} nicht beitreten oder sprechen.`);
  const p = music.getOrCreate(i.guild);
  const cfg = getConfig(i.guild.id).music;
  p.textChannel = i.guild.channels.cache.get(cfg.channel) || i.channel;
  await p.connect(vc);
  return p;
}

const simple = (name, desc, dj, fn) => ({
  data: new SlashCommandBuilder().setName(name).setDescription(desc),
  async execute(i) {
    const e = check(i, { dj });
    if (e) return respond(i, err(e));
    return fn(i, music.get(i.guild));
  },
});

module.exports = [
  {
    data: new SlashCommandBuilder().setName('play').setDescription('Musik abspielen: YouTube, SoundCloud, Spotify-Song, Radio, MP3 oder Suche')
      .addStringOption(o => o.setName('suche').setDescription('Link oder Songname').setAutocomplete(true).setMaxLength(500))
      .addAttachmentOption(o => o.setName('datei').setDescription('Eigene Audiodatei (MP3, OGG, WAV …)'))
      .addBooleanOption(o => o.setName('als_naechstes').setDescription('Vorne in die Warteschlange setzen')),
    async autocomplete(i) {
      const list = await suggest(i.options.getFocused());
      return i.respond(list.map(s => ({ name: s.slice(0, 100), value: s.slice(0, 100) }))).catch(() => {});
    },
    async execute(i) {
      const e = check(i, { needPlayer: false });
      if (e) return respond(i, err(e));
      const q = i.options.getString('suche');
      const file = i.options.getAttachment('datei');
      if (!q && !file) return respond(i, err('Gib einen Link, einen Songnamen oder eine Datei an.'));
      if (file && !/^(audio|video)\//.test(file.contentType || '')) return respond(i, err('Das ist keine Audio- oder Videodatei.'));
      await i.deferReply();
      let result;
      try {
        result = await resolve(q || '', i.user.id, file);
      } catch (x) { return respond(i, err(`Nichts gefunden: ${truncate(x.message, 300)}`)); }
      let p;
      try { p = await joinFor(i); } catch (x) { return respond(i, err(`Konnte dem Sprachkanal nicht beitreten: ${x.message}`)); }
      const wasIdle = !p.current;
      const added = await p.add(result.tracks, { front: i.options.getBoolean('als_naechstes') ?? false });
      quests.progress(i.member, 'music', 1, i.channel);
      const t = result.tracks[0];
      if (result.playlist) return respond(i, ok(`📃 **${added}** Songs aus **${truncate(result.playlist, 100)}** hinzugefügt.`));
      return respond(i, new EmbedBuilder().setColor(COLORS.ok)
        .setDescription(`${wasIdle ? '▶️ **Spiele:**' : `➕ **Hinzugefügt** (Platz ${p.queue.indexOf(t) + 1}):`} [${truncate(t.title, 150)}](${/^https?:/.test(t.url) ? t.url : 'https://discord.com'}) · \`${music.fmtTime(t.duration)}\` · ${t.source}`)
        .setThumbnail(t.thumbnail || null));
    },
  },
  simple('pause', 'Musik pausieren', false, async (i, p) => { p.pause(); await p.updateNowPlaying(); return respond(i, ok('⏸️ Pausiert.'), { ephemeral: false }); }),
  simple('resume', 'Musik fortsetzen', false, async (i, p) => { p.resume(); await p.updateNowPlaying(); return respond(i, ok('▶️ Weiter geht’s.'), { ephemeral: false }); }),
  simple('skip', 'Song überspringen', true, async (i, p) => { const t = p.current; p.skip(); return respond(i, ok(`⏭️ **${truncate(t.title, 100)}** übersprungen.`), { ephemeral: false }); }),
  simple('stop', 'Musik stoppen, Warteschlange leeren und gehen', true, async (i, p) => { p.destroy(); return respond(i, ok('⏹️ Gestoppt. Bis bald!'), { ephemeral: false }); }),
  simple('nowplaying', 'Was läuft gerade?', false, async (i, p) => respond(i, p.nowPlayingPayload(), { ephemeral: false })),
  simple('shuffle', 'Warteschlange mischen', true, async (i, p) => { p.shuffle(); return respond(i, ok(`🔀 ${p.queue.length} Songs gemischt.`), { ephemeral: false }); }),
  {
    data: new SlashCommandBuilder().setName('queue').setDescription('Warteschlange anzeigen'),
    async execute(i) {
      const p = music.get(i.guild);
      if (!p || !p.current) return respond(i, err('Die Warteschlange ist leer.'));
      return respond(i, queueEmbed(p));
    },
  },
  {
    data: new SlashCommandBuilder().setName('volume').setDescription('Lautstärke (1–200 %)')
      .addIntegerOption(o => o.setName('prozent').setDescription('1–200').setRequired(true).setMinValue(1).setMaxValue(200)),
    async execute(i) {
      const e = check(i, { dj: true }); if (e) return respond(i, err(e));
      const p = music.get(i.guild);
      await i.deferReply();
      await p.setVolume(i.options.getInteger('prozent'));
      await p.updateNowPlaying();
      return respond(i, ok(`🔊 Lautstärke: **${p.volume} %**`));
    },
  },
  {
    data: new SlashCommandBuilder().setName('loop').setDescription('Wiederholen einstellen')
      .addStringOption(o => o.setName('modus').setDescription('Was wiederholen?').setRequired(true).addChoices({ name: 'Aus', value: 'off' }, { name: 'Aktuellen Song', value: 'track' }, { name: 'Ganze Warteschlange', value: 'queue' })),
    async execute(i) {
      const e = check(i, { dj: true }); if (e) return respond(i, err(e));
      const p = music.get(i.guild);
      p.loop = i.options.getString('modus');
      await p.updateNowPlaying();
      return respond(i, ok(`🔁 Wiederholen: **${music.LOOP_LABEL[p.loop]}**`), { ephemeral: false });
    },
  },
  {
    data: new SlashCommandBuilder().setName('seek').setDescription('Zu einer Stelle im Song springen')
      .addStringOption(o => o.setName('zeit').setDescription('z. B. 1:30 oder 90').setRequired(true)),
    async execute(i) {
      const e = check(i, { dj: true }); if (e) return respond(i, err(e));
      const sec = parseTime(i.options.getString('zeit'));
      if (sec == null) return respond(i, err('Zeit nicht erkannt. Beispiel: `1:30`'));
      await i.deferReply();
      const okk = await music.get(i.guild).seek(sec);
      return respond(i, okk ? ok(`⏩ Springe zu **${music.fmtTime(sec)}**.`) : err('Bei Livestreams geht das nicht.'));
    },
  },
  {
    data: new SlashCommandBuilder().setName('filter').setDescription('Audio-Effekt (Bass-Boost, Nightcore, 8D …)')
      .addStringOption(o => o.setName('effekt').setDescription('Effekt').setRequired(true).addChoices(...Object.entries(music.FILTERS).map(([value, f]) => ({ name: f.label, value })))),
    async execute(i) {
      const e = check(i, { dj: true }); if (e) return respond(i, err(e));
      await i.deferReply();
      const p = music.get(i.guild);
      await p.setFilter(i.options.getString('effekt'));
      await p.updateNowPlaying();
      return respond(i, ok(`🎛️ Filter: **${music.FILTERS[p.filter].label}**`));
    },
  },
  {
    data: new SlashCommandBuilder().setName('remove').setDescription('Song aus der Warteschlange entfernen')
      .addIntegerOption(o => o.setName('platz').setDescription('Platz in der Warteschlange').setRequired(true).setMinValue(1)),
    async execute(i) {
      const e = check(i, { dj: true }); if (e) return respond(i, err(e));
      const p = music.get(i.guild);
      const n = i.options.getInteger('platz');
      const [t] = p.queue.splice(n - 1, 1);
      return respond(i, t ? ok(`🗑️ **${truncate(t.title, 100)}** entfernt.`) : err('Diesen Platz gibt es nicht.'), { ephemeral: !t });
    },
  },
  {
    data: new SlashCommandBuilder().setName('lyrics').setDescription('Songtext anzeigen').addStringOption(o => o.setName('song').setDescription('Song (leer = aktueller)')),
    async execute(i) {
      const title = i.options.getString('song') || music.get(i.guild)?.current?.title;
      if (!title) return respond(i, err('Gib einen Song an oder spiele etwas ab.'));
      await i.deferReply();
      const l = await lyrics(title).catch(() => null);
      if (!l) return respond(i, err(`Keinen Songtext für **${truncate(title, 100)}** gefunden.`));
      return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle(`📜 ${truncate(`${l.artist} – ${l.title}`, 250)}`).setDescription(truncate(l.text, 4000)).setFooter({ text: 'Quelle: lrclib.net' }));
    },
  },
  {
    data: new SlashCommandBuilder().setName('sound').setDescription('Soundboard: Sounds im Sprachkanal abspielen')
      .addSubcommand(s => s.setName('play').setDescription('Sound abspielen').addStringOption(o => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)))
      .addSubcommand(s => s.setName('list').setDescription('Alle Sounds anzeigen'))
      .addSubcommand(s => s.setName('add').setDescription('Eigenen Sound zum Server-Soundboard hinzufügen (max. 512 KB, 5 Sek.)')
        .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true).setMinLength(2).setMaxLength(32))
        .addAttachmentOption(o => o.setName('datei').setDescription('MP3 oder OGG').setRequired(true))
        .addStringOption(o => o.setName('emoji').setDescription('Emoji (optional)'))),
    async autocomplete(i) {
      const q = i.options.getFocused().toLowerCase();
      const list = await allSounds(i.guild);
      return i.respond(list.filter(s => s.name.toLowerCase().includes(q)).slice(0, 25)
        .map(s => ({ name: `${s.emoji?.name || '🔈'} ${s.name}${s.guildId ? '' : ' (Discord)'}`.slice(0, 100), value: `${s.guildId || 'default'}:${s.soundId}` }))).catch(() => {});
    },
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const list = await allSounds(i.guild);
        const own = list.filter(s => s.guildId);
        const def = list.filter(s => !s.guildId);
        return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle('🔈 Soundboard').addFields(
          { name: `Server (${own.length})`, value: truncate(own.map(s => `${s.emoji?.name || '🔈'} ${s.name}`).join(' · ') || '– (hinzufügen mit `/sound add`)', 1024) },
          { name: `Discord (${def.length})`, value: truncate(def.map(s => `${s.emoji?.name || '🔈'} ${s.name}`).join(' · ') || '–', 1024) }));
      }
      if (sub === 'add') {
        if (!i.member.permissions.has(P.CreateGuildExpressions) && !i.member.permissions.has(P.ManageGuildExpressions)) return respond(i, err('Dafür brauchst du das Recht „Ausdrücke erstellen“.'));
        const file = i.options.getAttachment('datei');
        if (file.size > 512 * 1024) return respond(i, err('Die Datei ist größer als 512 KB.'));
        if (!/^audio\/(mpeg|ogg|mp3)/.test(file.contentType || '') && !/\.(mp3|ogg)$/i.test(file.name)) return respond(i, err('Nur MP3 oder OGG.'));
        await i.deferReply();
        try {
          const buf = Buffer.from(await (await fetch(file.url)).arrayBuffer());
          const s = await i.guild.soundboardSounds.create({ file: buf, name: i.options.getString('name'), emojiName: i.options.getString('emoji') || undefined, contentType: /ogg/i.test(file.name) ? 'audio/ogg' : 'audio/mpeg' });
          return respond(i, ok(`Sound **${s.name}** hinzugefügt. Abspielen: \`/sound play\``));
        } catch (x) { return respond(i, err(`Hochladen fehlgeschlagen: ${x.message} (max. 5,2 Sekunden lang)`)); }
      }
      // play
      const vc = i.member.voice.channel;
      if (!vc) return respond(i, err('Geh zuerst in einen Sprachkanal.'));
      const p0 = music.get(i.guild);
      if (p0?.connection && p0.voiceChannelId !== vc.id) return respond(i, err(`Ich bin gerade in <#${p0.voiceChannelId}>.`));
      const [gid, soundId] = i.options.getString('name').split(':');
      if (!soundId) return respond(i, err('Wähle einen Sound aus der Liste.'));
      await i.deferReply({ flags: EPHEMERAL });
      try {
        await joinFor(i);
        await vc.sendSoundboardSound({ soundId, guildId: gid === 'default' ? undefined : gid });
        return respond(i, ok('🔈 Abgespielt!'));
      } catch (x) { return respond(i, err(`Sound fehlgeschlagen: ${x.message}`)); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('watch').setDescription('YouTube gemeinsam im Sprachkanal schauen (Discord „Watch Together“)'),
    async execute(i) {
      const vc = i.member.voice.channel;
      if (!vc) return respond(i, err('Geh zuerst in einen Sprachkanal.'));
      try {
        const inv = await vc.createInvite({ targetType: InviteTargetType.EmbeddedApplication, targetApplication: WATCH_TOGETHER_ID, maxAge: 86400, maxUses: 0 });
        return respond(i, {
          embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('📺 Watch Together')
            .setDescription(`Klick auf den Button – dann startet in ${vc} die YouTube-Aktivität. Dort einfach den Link einfügen oder suchen.\n\nAlle im Kanal schauen synchron mit. Die Bildqualität wählt der YouTube-Player (je nach Video und Gerät).`)],
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`https://discord.gg/${inv.code}`).setLabel('Watch Together starten').setEmoji('▶️'))],
        }, { ephemeral: false });
      } catch (x) {
        return respond(i, err(`Discord hat die Aktivität abgelehnt (${x.message}). Alternative: Im Sprachkanal unten auf 🚀 „Aktivitäten“ → „Watch Together“.`));
      }
    },
  },
];

/** Buttons unter "Läuft gerade" (mu:<aktion>) */
module.exports.handleButton = async function handleButton(i, action) {
  const p = music.get(i.guild);
  if (!p || !p.current) return respond(i, err('Gerade läuft nichts.'));
  if (action === 'queue') return respond(i, queueEmbed(p));
  const e = check(i, { dj: !['pause'].includes(action) || false });
  if (e) return respond(i, err(e));
  switch (action) {
    case 'pause': if (p.paused) p.resume(); else p.pause(); break;
    case 'skip': p.skip(); return i.deferUpdate();
    case 'stop': p.destroy(); return respond(i, ok('⏹️ Gestoppt.'), { ephemeral: false });
    case 'loop': p.cycleLoop(); break;
    case 'shuffle': p.shuffle(); break;
    case 'voldown': await i.deferUpdate(); await p.setVolume(p.volume - 10); return p.updateNowPlaying();
    case 'volup': await i.deferUpdate(); await p.setVolume(p.volume + 10); return p.updateNowPlaying();
    case 'back10': await i.deferUpdate(); await p.seek(p.position() - 10); return p.updateNowPlaying();
    case 'fwd10': await i.deferUpdate(); await p.seek(p.position() + 10); return p.updateNowPlaying();
  }
  return i.update(p.nowPlayingPayload());
};
