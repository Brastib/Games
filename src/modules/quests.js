'use strict';
/**
 * Tägliche Quests: Jeden Tag bekommt jedes Mitglied eigene Aufgaben (z. B. Nachrichten schreiben,
 * Zeit im Sprachkanal, Clips posten, 🔥 sammeln, Songs abspielen). Belohnung: XP + Münzen.
 * Alle Quests eines Tages geschafft = Bonus + Serie (Streak).
 */
const { EmbedBuilder } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const { progressBar } = require('../lib/util');

const TZ = process.env.TZ || 'Europe/Berlin';

const QUESTS = [
  { id: 'msgs', emoji: '💬', amounts: [15, 30, 60], text: n => `Schreibe ${n} Nachrichten` },
  { id: 'voice', emoji: '🎙️', amounts: [15, 30, 60], text: n => `Sei ${n} Minuten mit anderen im Sprachkanal` },
  { id: 'react', emoji: '😀', amounts: [5, 10, 20], text: n => `Reagiere auf ${n} Nachrichten` },
  { id: 'reply', emoji: '↩️', amounts: [3, 6, 10], text: n => `Antworte auf ${n} Nachrichten von anderen` },
  { id: 'clip', emoji: '🎬', amounts: [1, 2], text: n => `Poste ${n === 1 ? 'einen Clip' : `${n} Clips`} im Clip-Kanal`, needs: c => c.levels.clips.enabled && c.levels.clips.channels.length },
  { id: 'likes', emoji: '🔥', amounts: [3, 5, 10], text: n => `Sammle ${n}× 🔥 auf deine Clips`, needs: c => c.levels.clips.enabled && c.levels.clips.channels.length },
  { id: 'music', emoji: '🎵', amounts: [2, 4], text: n => `Starte ${n} Songs mit /play`, needs: c => c.music.enabled },
  { id: 'tempvoice', emoji: '🔊', amounts: [1], text: () => 'Erstelle deinen eigenen Sprachkanal', needs: c => c.tempvoice.enabled && c.tempvoice.hubs.length },
  { id: 'daily', emoji: '🎁', amounts: [1], text: () => 'Hol dir deine Tagesbelohnung mit /daily', needs: c => c.economy.enabled },
  { id: 'rank', emoji: '📊', amounts: [1], text: () => 'Schau dir deinen Rang mit /rank an' },
];
const BY_ID = Object.fromEntries(QUESTS.map(q => [q.id, q]));

/** Tag im Format JJJJ-MM-TT (deutsche Zeit) */
function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function yesterdayKey() { return dayKey(new Date(Date.now() - 86_400_000)); }

// kleine, deterministische Zufallszahlen pro Person und Tag
function seeded(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
}

/** Die heutigen Quests einer Person */
function todays(guildId, userId, day = dayKey()) {
  const cfg = getConfig(guildId);
  const pool = QUESTS.filter(q => !q.needs || q.needs(cfg));
  const rnd = seeded(`${guildId}:${userId}:${day}`);
  const picked = [];
  const avail = [...pool];
  while (picked.length < Math.min(cfg.quests.perDay || 3, avail.length + picked.length) && avail.length) {
    const q = avail.splice(Math.floor(rnd() * avail.length), 1)[0];
    const tier = Math.floor(rnd() * q.amounts.length);
    const mult = cfg.quests.rewardMultiplier || 1;
    picked.push({ id: q.id, emoji: q.emoji, target: q.amounts[tier], text: q.text(q.amounts[tier]), xp: Math.round((60 + tier * 40) * mult), coins: Math.round((30 + tier * 25) * mult) });
  }
  return picked;
}

function state(guildId, userId) {
  const k = `${guildId}:${userId}`;
  const today = dayKey();
  let s = store.get('quests', k) || { day: today, progress: {}, done: [], streak: 0, lastFull: null, total: 0 };
  if (s.day !== today) {
    s = { ...s, day: today, progress: {}, done: [] };
    if (s.lastFull !== yesterdayKey() && s.lastFull !== today) s.streak = 0;
    store.set('quests', k, s);
  }
  return s;
}

/**
 * Fortschritt melden. Wird von überall aufgerufen (Nachrichten, Sprachzeit, Clips, /play …).
 * channel: optional, dort wird ein abgeschlossener Quest kurz verkündet.
 */
async function progress(member, type, amount = 1, channel = null) {
  if (!member?.guild || member.user?.bot) return;
  const cfg = getConfig(member.guild.id);
  if (!cfg.quests.enabled) return;
  const list = todays(member.guild.id, member.id);
  const quest = list.find(q => q.id === type);
  if (!quest) return;
  const k = `${member.guild.id}:${member.id}`;
  const s = state(member.guild.id, member.id);
  if (s.done.includes(type)) return;
  s.progress[type] = (s.progress[type] || 0) + amount;
  if (s.progress[type] < quest.target) { store.set('quests', k, s); return; }

  s.done.push(type);
  s.total = (s.total || 0) + 1;
  const leveling = require('./leveling');
  const economy = require('./economy');
  await leveling.addXp(member, quest.xp, { channel, ignoreMultiplier: true });
  economy.add(member.guild.id, member.id, quest.coins);
  const lines = [`${quest.emoji} **Quest geschafft:** ${quest.text} → **+${quest.xp} XP** · **+${quest.coins} ${cfg.economy.emoji}**`];

  if (list.every(q => s.done.includes(q.id))) {
    s.streak = s.lastFull === yesterdayKey() ? (s.streak || 0) + 1 : 1;
    s.lastFull = dayKey();
    const bonusXp = 150 + Math.min(s.streak, 10) * 25;
    const bonusCoins = 100 + Math.min(s.streak, 10) * 20;
    await leveling.addXp(member, bonusXp, { channel, ignoreMultiplier: true });
    economy.add(member.guild.id, member.id, bonusCoins);
    lines.push(`🏆 **Alle Tages-Quests erledigt!** Bonus **+${bonusXp} XP** · **+${bonusCoins} ${cfg.economy.emoji}** · Serie: **${s.streak} 🔥**`);
  }
  store.set('quests', k, s);
  if (cfg.quests.announce && !cfg.quiet && channel?.isTextBased?.()) {
    const m = await channel.send({ content: `<@${member.id}>`, embeds: [new EmbedBuilder().setColor(COLORS.ok).setDescription(lines.join('\n'))], allowedMentions: { users: [member.id] } }).catch(() => null);
    if (m) setTimeout(() => m.delete().catch(() => {}), 30_000);
  }
}

function embedFor(member) {
  const cfg = getConfig(member.guild.id);
  const list = todays(member.guild.id, member.id);
  const s = state(member.guild.id, member.id);
  const lines = list.map(q => {
    const p = Math.min(s.progress[q.id] || 0, q.target);
    const done = s.done.includes(q.id);
    return `${done ? '✅' : q.emoji} **${q.text}**\n${progressBar(done ? q.target : p, q.target, 12)} ${done ? q.target : p}/${q.target} · ${q.xp} XP + ${q.coins} ${cfg.economy.emoji}`;
  });
  const nextReset = new Date();
  nextReset.setHours(24, 0, 0, 0);
  return new EmbedBuilder().setColor(COLORS.brand)
    .setAuthor({ name: `Tages-Quests · ${member.displayName}`, iconURL: member.user.displayAvatarURL() })
    .setDescription(lines.join('\n\n') || 'Heute gibt es keine Quests.')
    .addFields(
      { name: '🔥 Serie', value: `${s.streak || 0} ${s.streak === 1 ? 'Tag' : 'Tage'}`, inline: true },
      { name: '🏅 Quests gesamt', value: String(s.total || 0), inline: true },
      { name: '🎁 Alle geschafft', value: 'Bonus-XP + Münzen', inline: true },
    )
    .setFooter({ text: 'Neue Quests jeden Tag um Mitternacht' });
}

module.exports = { QUESTS, BY_ID, todays, state, progress, embedFor, dayKey };
