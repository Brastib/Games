'use strict';
/**
 * 📅 Wochen-Rückblick: jeden Sonntag (einstellbar) ein Bild mit den letzten 7 Tagen –
 * aktivster Chatter, längste Zeit im Voice, meiste XP und bester Clip (meiste Likes).
 *
 * Gezählt wird pro Tag (deutsche Zeit) im Bot-Speicher, Sammlung „recap“: { msgs, voice, xp } je Person.
 * Voice-Minuten zählen wie bei den Sprach-XP: nicht allein, nicht taub, nicht im AFK-Kanal.
 * Alte Tage (älter als 10 Tage) werden automatisch gelöscht.
 */
const { AttachmentBuilder } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');

const COL = 'recap';
const KINDS = ['msgs', 'voice', 'xp'];
const today = () => require('./autoposts').nowParts().day;

function bump(guildId, userId, kind, amount = 1) {
  if (!amount || amount < 0) return;
  const k = `${guildId}:${today()}`;
  const d = store.get(COL, k) || { msgs: {}, voice: {}, xp: {} };
  d[kind][userId] = (d[kind][userId] || 0) + amount;
  store.set(COL, k, d);
}

/** Jede Minute vom Zeitplaner: Voice-Minuten zählen */
function voiceTick(client) {
  for (const guild of client.guilds.cache.values()) {
    const min = getConfig(guild.id).levels.voice?.minMembers || 2;
    for (const ch of guild.channels.cache.values()) {
      if (!ch.isVoiceBased?.() || ch.id === guild.afkChannelId) continue;
      const humans = ch.members.filter(m => !m.user.bot);
      if (humans.size < min) continue;
      for (const m of humans.values()) if (!m.voice.selfDeaf && !m.voice.serverDeaf) bump(guild.id, m.id, 'voice', 1);
    }
  }
}

/** Die letzten 7 Tage zusammenzählen: { msgs: {uid: n}, voice: …, xp: …, days: [...] } */
function collect(guildId, now = Date.now()) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(require('./autoposts').nowParts(new Date(now - i * 86_400_000)).day);
  const sum = { msgs: {}, voice: {}, xp: {}, days };
  for (const day of days) {
    const d = store.get(COL, `${guildId}:${day}`);
    if (!d) continue;
    for (const kind of KINDS) for (const [uid, n] of Object.entries(d[kind] || {})) sum[kind][uid] = (sum[kind][uid] || 0) + n;
  }
  return sum;
}

const ranking = map => Object.entries(map).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

function bestClip(guildId, since) {
  return store.entries('clips').map(([id, c]) => ({ id, ...c }))
    .filter(c => c.guildId === guildId && c.at >= since && c.likes > 0)
    .sort((a, b) => b.likes - a.likes || a.at - b.at)[0] || null;
}

function cleanup() {
  const cutoff = Date.now() - 10 * 86_400_000;
  for (const [k] of store.entries(COL)) {
    const day = k.split(':')[1];
    if (Date.parse(`${day}T12:00:00Z`) < cutoff) store.delete(COL, k);
  }
}

const voiceText = min => (min >= 60 ? `${Math.floor(min / 60)} Std. ${min % 60} Min.` : `${min} Min.`);
const num = n => n.toLocaleString('de-DE');

/** Alles für Bild und Text */
async function build(guild, now = Date.now()) {
  const s = collect(guild.id, now);
  const clip = bestClip(guild.id, now - 7 * 86_400_000);
  const who = async id => {
    const m = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    const u = m?.user || await guild.client.users.fetch(id).catch(() => null);
    return { id, name: m?.displayName || u?.globalName || u?.username || 'Unbekannt', avatar: (m || u)?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null };
  };
  const tile = async (label, title, list, fmt) => {
    if (!list.length) return { label, title, empty: true };
    const [first, ...rest] = list;
    const runners = await Promise.all(rest.slice(0, 2).map(async ([id, n]) => `${(await who(id)).name} · ${fmt(n, true)}`));
    return { label, title, ...(await who(first[0])), value: fmt(first[1]), runners };
  };
  const msgs = ranking(s.msgs), voice = ranking(s.voice), xp = ranking(s.xp);
  const tiles = [
    await tile('AKTIVSTER CHATTER', '💬 Aktivster Chatter', msgs, n => `${num(n)} Nachrichten`),
    await tile('LÄNGSTE ZEIT IM VOICE', '🎙️ Längste Zeit im Voice', voice, n => voiceText(n)),
    await tile('MEISTE XP', '⭐ Meiste XP', xp, n => `+${num(n)} XP`),
    clip ? { label: 'BESTER CLIP', title: '🎬 Bester Clip', ...(await who(clip.authorId)), value: `${clip.likes} Likes`, runners: [] } : { label: 'BESTER CLIP', title: '🎬 Bester Clip', empty: true },
  ];
  const total = map => Object.values(map).reduce((a, b) => a + b, 0);
  const totals = `${num(total(s.msgs))} Nachrichten  ·  ${voiceText(total(s.voice))} im Voice  ·  ${num(Object.keys({ ...s.msgs, ...s.voice }).length)} aktive Leute`;
  const [y1, m1, d1] = s.days[6].split('-'), [, m2, d2] = s.days[0].split('-');
  const range = `${d1}.${m1}. – ${d2}.${m2}.${y1}`;
  return { tiles, totals, range, clip, empty: !msgs.length && !voice.length && !xp.length && !clip };
}

async function payload(guild, now = Date.now()) {
  const r = await build(guild, now);
  if (r.empty) throw new Error('Diese Woche gibt es noch nichts zum Zurückblicken.');
  const cfg = getConfig(guild.id).posts.recap || {};
  const png = await require('../lib/cards').recapCard(r);
  const winners = r.tiles.filter(t => !t.empty).map(t => `**${t.title}:** <@${t.id}> · ${t.value}`);
  const clipLink = r.clip ? `\n🎬 Bester Clip: https://discord.com/channels/${guild.id}/${r.clip.channelId}/${r.clip.id}` : '';
  // Gewinner immer auch als Text (mit Namen-Erwähnung, aber ohne Ping) – das Bild allein ist nicht anklickbar
  const text = `${cfg.text || '📅 **Wochen-Rückblick**'} · ${r.range}\n${winners.join('\n')}${clipLink}`;
  return { content: text, files: png ? [new AttachmentBuilder(png, { name: 'wochen-rueckblick.png' })] : [], allowedMentions: { parse: [] } };
}

/** Kanal: eingestellt, sonst der Bestenlisten- bzw. Level-Kanal */
function channelOf(guild) {
  const cfg = getConfig(guild.id);
  const id = cfg.posts.recap?.channel || cfg.posts.leaderboard?.channel || cfg.levels.channel;
  return guild.channels.cache.get(id) || null;
}

module.exports = { bump, voiceTick, collect, bestClip, build, payload, channelOf, cleanup, voiceText };
