'use strict';
/**
 * Musik-Player pro Server: Warteschlange, Wiederholen, Mischen, Lautstärke, Filter, Springen (Seek),
 * "Läuft gerade"-Nachricht mit Buttons, automatisches Verlassen.
 * Audio: yt-dlp (Quelle) → ffmpeg (Opus) → @discordjs/voice. Kein Opus-Encoding in JavaScript nötig.
 */
const { spawn } = require('child_process');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus,
  entersState, StreamType, NoSubscriberBehavior,
} = require('@discordjs/voice');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const ffmpegPath = require('ffmpeg-static');
const ytdlp = require('./ytdlp');
const { getConfig } = require('../../lib/config');
const { COLORS } = require('../../lib/embeds');
const { truncate, progressBar } = require('../../lib/util');

const FILTERS = {
  off: { label: 'Aus', af: null },
  bassboost: { label: 'Bass-Boost', af: 'bass=g=12,dynaudnorm=f=200' },
  nightcore: { label: 'Nightcore', af: 'aresample=48000,asetrate=48000*1.25,aresample=48000' },
  slowed: { label: 'Slowed + Reverb', af: 'aresample=48000,asetrate=48000*0.85,aresample=48000,aecho=0.8:0.88:60:0.35' },
  vaporwave: { label: 'Vaporwave', af: 'aresample=48000,asetrate=48000*0.8,aresample=48000' },
  '8d': { label: '8D-Audio', af: 'apulsator=hz=0.09' },
  karaoke: { label: 'Karaoke (Stimme leiser)', af: 'pan=stereo|c0=c0-c1|c1=c1-c0' },
  speed: { label: 'Schneller (1,25×)', af: 'atempo=1.25' },
  treble: { label: 'Mehr Höhen', af: 'treble=g=6' },
};
const LOOP_LABEL = { off: 'aus', track: 'Song', queue: 'Warteschlange' };
const players = new Map();

function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return 'LIVE';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

class GuildPlayer {
  constructor(guild) {
    const cfg = getConfig(guild.id).music;
    this.guild = guild;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.loop = 'off';
    this.volume = cfg.defaultVolume || 80;
    this.filter = 'off';
    this.textChannel = null;
    this.connection = null;
    this.voiceChannelId = null;
    this.proc = [];
    this.npMessage = null;
    this.idleSince = Date.now();
    this.emptySince = null;
    this.offset = 0;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.lastError = null;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on(AudioPlayerStatus.Idle, () => this.onIdle().catch(e => console.error('[musik] idle', e)));
    this.player.on('error', e => { this.lastError = e.message; console.warn('[musik] Player-Fehler:', e.message); });
  }

  async connect(voiceChannel) {
    if (this.connection && this.voiceChannelId === voiceChannel.id && this.connection.state.status !== VoiceConnectionStatus.Destroyed) return;
    if (this.connection) this.connection.destroy();
    const conn = joinVoiceChannel({ channelId: voiceChannel.id, guildId: this.guild.id, adapterCreator: this.guild.voiceAdapterCreator, selfDeaf: false });
    this.connection = conn;
    this.voiceChannelId = voiceChannel.id;
    conn.subscribe(this.player);
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
      } catch {
        if (this.connection === conn) this.destroy('Verbindung zum Sprachkanal verloren.');
      }
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  }

  get voiceChannel() { return this.guild.channels.cache.get(this.voiceChannelId) || null; }

  position() {
    if (!this.current) return 0;
    const paused = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return this.offset + (Date.now() - this.startedAt - paused - (this.pausedTotal || 0)) / 1000;
  }

  killProcs() {
    for (const p of this.proc) { try { p.kill('SIGKILL'); } catch { /* schon beendet */ } }
    this.proc = [];
  }

  /** Startet einen Song (optional ab Sekunde seek). mode 'pipe' = Fallback, falls direktes Streamen scheitert. */
  async startTrack(track, seek = 0, mode = 'direct') {
    const old = this.proc;
    const procs = [];
    const args = ['-hide_banner', '-loglevel', 'error'];
    let stdinSource = null;
    if (track.direct) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      if (seek > 0) args.push('-ss', String(seek));
      args.push('-i', track.url);
    } else if (mode === 'pipe') {
      const bin = await ytdlp.ensure();
      const yt = spawn(bin, ['--no-warnings', '-q', '-f', 'bestaudio/best', '-o', '-', track.url], { stdio: ['ignore', 'pipe', 'ignore'] });
      procs.push(yt);
      stdinSource = yt.stdout;
      if (seek > 0) args.push('-ss', String(seek));
      args.push('-i', 'pipe:0');
    } else {
      const s = await ytdlp.streamInfo(track.url);
      track.isLive = s.isLive;
      if (!track.duration) track.duration = s.duration;
      if (!track.thumbnail) track.thumbnail = s.thumbnail;
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      const hdr = Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      if (hdr) args.push('-headers', hdr + '\r\n');
      if (seek > 0 && !s.isLive) args.push('-ss', String(seek));
      args.push('-i', s.url);
    }
    const af = [FILTERS[this.filter]?.af, `volume=${(this.volume / 100).toFixed(2)}`].filter(Boolean).join(',');
    args.push('-vn', '-af', af, '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1');
    const ff = spawn(ffmpegPath, args, { stdio: [stdinSource ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (stdinSource) { stdinSource.pipe(ff.stdin); ff.stdin.on('error', () => {}); }
    ff.stderr.on('data', d => { this.lastError = String(d).trim().slice(-300); });
    ff.on('error', e => { this.lastError = e.message; });
    procs.push(ff);
    this.proc = procs;
    this.lastError = null;
    const resource = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus, metadata: track });
    this.player.play(resource);
    this.offset = seek;
    this.startedAt = Date.now();
    this.pausedAt = 0;
    this.pausedTotal = 0;
    track.mode = mode;
    for (const p of old) { try { p.kill('SIGKILL'); } catch { /* egal */ } }
  }

  async onIdle() {
    const finished = this.current;
    if (!finished) return;
    const quickFail = Date.now() - this.startedAt < 5000;
    if (quickFail && this.lastError && !finished.direct && finished.mode !== 'pipe') {
      // Direktes Streamen klappte nicht → über yt-dlp-Pipe nochmal versuchen
      try { return await this.startTrack(finished, this.offset, 'pipe'); } catch { /* weiter zum nächsten */ }
    }
    if (quickFail && this.lastError) this.say(`⚠️ **${truncate(finished.title, 80)}** konnte nicht abgespielt werden. Überspringe …`);
    this.killProcs();
    if (!quickFail || !this.lastError) {
      if (this.loop === 'track') { try { return await this.startTrack(finished, 0); } catch { /* weiter */ } }
      if (this.loop === 'queue') this.queue.push(finished);
      this.history.push(finished);
      if (this.history.length > 50) this.history.shift();
    }
    await this.playNext();
  }

  async playNext() {
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.idleSince = Date.now();
      await this.deleteNowPlaying();
      this.say('✅ Warteschlange zu Ende. Mit `/play` geht es weiter.');
      return;
    }
    this.current = next;
    try {
      await this.startTrack(next, 0);
      await this.sendNowPlaying();
    } catch (e) {
      this.say(`⚠️ **${truncate(next.title, 80)}** übersprungen: ${truncate(e.message, 200)}`);
      this.current = null;
      return this.playNext();
    }
  }

  /** Songs hinzufügen. Startet automatisch, wenn gerade nichts läuft. */
  async add(tracks, { front = false } = {}) {
    const max = getConfig(this.guild.id).music.maxQueue || 200;
    const room = Math.max(0, max - this.queue.length);
    const list = tracks.slice(0, room);
    if (front) this.queue.unshift(...list); else this.queue.push(...list);
    if (!this.current) await this.playNext();
    return list.length;
  }

  pause() { if (this.player.pause()) { this.pausedAt = Date.now(); return true; } return false; }
  resume() {
    if (this.player.unpause()) { if (this.pausedAt) this.pausedTotal = (this.pausedTotal || 0) + (Date.now() - this.pausedAt); this.pausedAt = 0; return true; }
    return false;
  }
  get paused() { return this.player.state.status === AudioPlayerStatus.Paused || this.player.state.status === AudioPlayerStatus.AutoPaused; }
  skip() { if (!this.current) return false; if (this.loop === 'track') this.loop = 'off'; this.player.stop(true); return true; }
  async seek(sec) { if (!this.current || this.current.isLive) return false; await this.startTrack(this.current, Math.max(0, sec), this.current.mode); return true; }
  async restartHere() { if (this.current && !this.current.isLive) await this.startTrack(this.current, this.position(), this.current.mode); }
  async setVolume(v) { this.volume = Math.max(1, Math.min(200, Math.round(v))); await this.restartHere(); }
  async setFilter(f) { this.filter = FILTERS[f] ? f : 'off'; await this.restartHere(); }
  shuffle() { for (let i = this.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]; } }
  cycleLoop() { this.loop = { off: 'track', track: 'queue', queue: 'off' }[this.loop]; return this.loop; }

  destroy(reason) {
    this.queue = [];
    this.current = null;
    this.killProcs();
    this.player.stop(true);
    try { this.connection?.destroy(); } catch { /* schon weg */ }
    this.connection = null;
    this.deleteNowPlaying();
    if (reason) this.say(reason);
    players.delete(this.guild.id);
  }

  async say(text) {
    if (!this.textChannel) return null;
    return this.textChannel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
  }

  nowPlayingPayload() {
    const t = this.current;
    if (!t) return { embeds: [new EmbedBuilder().setColor(COLORS.brand).setDescription('Gerade läuft nichts.')], components: [] };
    const pos = this.position();
    const e = new EmbedBuilder().setColor(COLORS.brand)
      .setAuthor({ name: this.paused ? '⏸️ Pausiert' : '🎶 Läuft gerade' })
      .setTitle(truncate(t.title, 250))
      .setDescription(`${t.isLive ? '🔴 LIVE' : `${progressBar(pos, t.duration || 1, 18)}\n\`${fmtTime(pos)} / ${fmtTime(t.duration)}\``}`)
      .addFields(
        { name: 'Gewünscht von', value: t.requester ? `<@${t.requester}>` : '–', inline: true },
        { name: 'Lautstärke', value: `${this.volume} %`, inline: true },
        { name: 'Wiederholen', value: LOOP_LABEL[this.loop], inline: true },
        { name: 'Filter', value: FILTERS[this.filter].label, inline: true },
        { name: 'Als Nächstes', value: this.queue[0] ? truncate(this.queue[0].title, 60) : '–', inline: true },
        { name: 'Warteschlange', value: `${this.queue.length} Song(s)`, inline: true },
      );
    if (/^https?:/.test(t.url)) e.setURL(t.url);
    if (t.thumbnail) e.setThumbnail(t.thumbnail);
    const b = (id, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`mu:${id}`).setEmoji(emoji).setStyle(style);
    return {
      embeds: [e],
      components: [
        new ActionRowBuilder().addComponents(b('pause', this.paused ? '▶️' : '⏸️', ButtonStyle.Primary), b('skip', '⏭️'), b('stop', '⏹️', ButtonStyle.Danger), b('loop', '🔁', this.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success), b('shuffle', '🔀')),
        new ActionRowBuilder().addComponents(b('back10', '⏪'), b('voldown', '🔉'), b('volup', '🔊'), b('fwd10', '⏩'), b('queue', '📜')),
      ],
    };
  }

  async sendNowPlaying() {
    await this.deleteNowPlaying();
    if (!this.textChannel) return;
    this.npMessage = await this.textChannel.send(this.nowPlayingPayload()).catch(() => null);
  }
  async updateNowPlaying() {
    if (this.npMessage) await this.npMessage.edit(this.nowPlayingPayload()).catch(() => {});
  }
  async deleteNowPlaying() {
    const m = this.npMessage;
    this.npMessage = null;
    if (m) await m.delete().catch(() => {});
  }
}

function get(guild) { return players.get(guild.id) || null; }
function getOrCreate(guild) {
  let p = players.get(guild.id);
  if (!p) { p = new GuildPlayer(guild); players.set(guild.id, p); }
  return p;
}

/** Alle 30 Sek.: leere Kanäle / lange Pausen verlassen */
function sweep() {
  for (const p of players.values()) {
    const mins = (getConfig(p.guild.id).music.leaveMinutes ?? 3) * 60_000;
    const ch = p.voiceChannel;
    const humans = ch ? ch.members.filter(m => !m.user.bot).size : 0;
    if (!humans) { p.emptySince ||= Date.now(); } else p.emptySince = null;
    if (p.emptySince && Date.now() - p.emptySince > mins) { p.destroy('👋 Niemand mehr im Sprachkanal – ich gehe.'); continue; }
    if (!p.current && Date.now() - p.idleSince > mins) p.destroy();
  }
}
setInterval(sweep, 30_000).unref();

module.exports = { FILTERS, LOOP_LABEL, players, get, getOrCreate, fmtTime, GuildPlayer };
