'use strict';
/**
 * Clips: XP fürs Posten von Clips im Clip-Kanal, 🔥-Likes geben dem Ersteller XP,
 * Clips mit genug Likes landen in der Hall of Fame.
 */
const { EmbedBuilder } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const leveling = require('./leveling');
const quests = require('./quests');

const CLIP_HOSTS = /(https?:\/\/)?(www\.)?(medal\.tv|clips\.twitch\.tv|twitch\.tv\/\w+\/clip|youtube\.com\/(shorts|clip)\/|youtu\.be\/|streamable\.com|outplayed\.tv|allstar\.gg|gyazo\.com|tiktok\.com|kick\.com\/\w+\/clips?|cdn\.discordapp\.com\/attachments\/\S+\.(mp4|mov|webm))/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|gif)$/i;
const lastClip = new Map();

function isClip(message) {
  if (message.attachments.some(a => (a.contentType || '').startsWith('video/') || VIDEO_EXT.test(a.name || ''))) return true;
  return CLIP_HOSTS.test(message.content || '');
}

function inClipChannel(message, clips) {
  return clips.channels.includes(message.channel.id) || clips.channels.includes(message.channel.parentId);
}

async function onMessage(message) {
  if (!message.guild || message.author.bot || !message.member) return;
  const cfg = getConfig(message.guild.id);
  const clips = cfg.levels.clips;
  if (!clips.enabled || !inClipChannel(message, clips) || !isClip(message)) return;
  const k = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  store.set('clips', message.id, { guildId: message.guild.id, channelId: message.channel.id, authorId: message.author.id, likes: 0, likers: [], xpGiven: 0, hof: false, at: now });
  await message.react(clips.likeEmoji || '🔥').catch(() => {});
  if (now - (lastClip.get(k) || 0) < (clips.cooldownMinutes || 0) * 60_000) return;
  lastClip.set(k, now);
  await leveling.addXp(message.member, clips.xp || 40, { channel: message.channel, stat: 'clips' });
  await quests.progress(message.member, 'clip', 1, message.channel);
}

function emojiMatches(reaction, wanted) {
  const e = reaction.emoji;
  return e.name === wanted || e.toString() === wanted || e.id === wanted;
}

async function onReactionAdd(reaction, user) {
  if (user.bot || !reaction.message.guild) return;
  const guild = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member) await quests.progress(member, 'react', 1);
  const c = store.get('clips', reaction.message.id);
  if (!c) return;
  const cfg = getConfig(guild.id).levels.clips;
  if (!emojiMatches(reaction, cfg.likeEmoji || '🔥') || user.id === c.authorId || c.likers.includes(user.id)) return;
  c.likers.push(user.id);
  c.likes = c.likers.length;
  const author = await guild.members.fetch(c.authorId).catch(() => null);
  if (author) {
    if (c.xpGiven < (cfg.maxLikeXp ?? 100)) {
      const xp = Math.min(cfg.likeXp || 5, (cfg.maxLikeXp ?? 100) - c.xpGiven);
      c.xpGiven += xp;
      await leveling.addXp(author, xp, { stat: 'likes' });
    }
    await quests.progress(author, 'likes', 1);
  }
  // Hall of Fame
  if (!c.hof && cfg.hallOfFame && c.likes >= (cfg.hallThreshold || 5)) {
    c.hof = true;
    const hall = guild.channels.cache.get(cfg.hallOfFame);
    const msg = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    if (hall?.isTextBased() && msg) {
      const video = msg.attachments.find(a => (a.contentType || '').startsWith('video/') || VIDEO_EXT.test(a.name || ''));
      await hall.send({
        content: `🏆 **Clip des Moments** von <@${c.authorId}> · ${c.likes} ${cfg.likeEmoji}\n${msg.url}${video ? `\n${video.url}` : ''}`,
        embeds: msg.content ? [new EmbedBuilder().setColor(COLORS.brand).setDescription(msg.content.slice(0, 2000))] : [],
        allowedMentions: { users: [c.authorId] },
      }).catch(() => {});
      if (author) await leveling.addXp(author, 100, { ignoreMultiplier: true });
    }
  }
  store.set('clips', reaction.message.id, c);
}

async function onReactionRemove(reaction, user) {
  const c = store.get('clips', reaction.message.id);
  if (!c || user.bot) return;
  c.likers = c.likers.filter(id => id !== user.id);
  c.likes = c.likers.length;
  store.set('clips', reaction.message.id, c);
}

/** Alte Clip-Einträge nach 21 Tagen entfernen */
function cleanup() {
  const cutoff = Date.now() - 21 * 86_400_000;
  for (const [id, c] of store.entries('clips')) if (c.at < cutoff) store.delete('clips', id);
}

module.exports = { isClip, onMessage, onReactionAdd, onReactionRemove, cleanup };
