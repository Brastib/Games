'use strict';
const { getConfig } = require('./config');

/**
 * Schickt ein Log-Embed in den passenden Log-Kanal.
 * type: mod | messages | members | server | voice | protection
 */
async function sendLog(guild, type, payload) {
  if (!guild) return null;
  const cfg = getConfig(guild.id);
  const channelId = cfg.logs[type] || cfg.logs.fallback;
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return null;
  try {
    const data = payload?.data ? { embeds: [payload] } : payload; // EmbedBuilder oder fertige Nachricht
    return await channel.send({ allowedMentions: { parse: [] }, ...data });
  } catch (e) {
    if (e.code !== 50013 && e.code !== 10003) console.error(`[log:${type}]`, e.message);
    return null;
  }
}

module.exports = { sendLog };
