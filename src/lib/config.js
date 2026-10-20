'use strict';
/**
 * Server-Einstellungen. Jeder Server bekommt eine Kopie der Standardwerte,
 * gespeicherte Werte überschreiben sie. Neue Standardwerte erscheinen automatisch.
 */
const store = require('./store');

const DEFAULT_ALLOW = [
  // GIFs & Medien
  'tenor.com', 'giphy.com', 'klipy.com', 'imgur.com', 'gyazo.com', 'medal.tv', 'streamable.com',
  // Discord selbst
  'discord.com', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.gift', 'discord.new',
  // Große Plattformen
  'youtube.com', 'youtu.be', 'twitch.tv', 'kick.com', 'twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com',
  'instagram.com', 'tiktok.com', 'reddit.com', 'redd.it', 'spotify.com', 'spotify.link', 'soundcloud.com',
  'github.com', 'githubusercontent.com', 'wikipedia.org', 'wikimedia.org', 'google.com', 'google.de',
  'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'epicgames.com', 'roblox.com', 'minecraft.net',
  'microsoft.com', 'apple.com', 'amazon.de', 'amazon.com', 'pinterest.com', 'tumblr.com',
];

function defaults() {
  return {
    modRoles: [],
    logs: { fallback: null, mod: null, messages: null, members: null, server: null, voice: null, protection: null },
    welcome: {
      enabled: false, channel: null, card: true,
      message: 'Willkommen {user} auf **{server}**! Du bist Mitglied Nummer **{count}**.',
      dm: false, dmMessage: 'Hey {name}, willkommen auf **{server}**! Lies dir bitte die Regeln durch.',
      autoRoles: [], botRoles: [],
    },
    goodbye: { enabled: false, channel: null, message: '**{username}** hat den Server verlassen. Jetzt sind wir noch {count}.' },
    verify: {
      enabled: false, channel: null, role: null, unverifiedRole: null, captcha: false, messageId: null,
      title: 'Regeln', text: '',
    },
    automod: {
      enabled: true,
      exemptRoles: [], exemptChannels: [],
      links: { enabled: true, mode: 'smart', action: 'delete', allow: [], block: [], phishingAction: 'timeout', phishingMinutes: 60 },
      invites: { enabled: true, allowOwn: true, action: 'delete' },
      spam: { enabled: true, maxMessages: 6, perSeconds: 5, duplicates: 4, timeoutMinutes: 5 },
      mentions: { enabled: true, max: 5, timeoutMinutes: 10 },
      caps: { enabled: false, percent: 70, minLength: 12 },
      badwords: { enabled: false, words: [], action: 'delete' },
      escalation: { enabled: true, timeoutAt: 3, timeoutMinutes: 60, kickAt: 5, banAt: 7, expireDays: 30 },
    },
    antiraid: {
      enabled: true, joins: 8, seconds: 10, action: 'lockdown', minutes: 15,
      pauseInvites: true, kickRaiders: false, minAccountDays: 0, accountAction: 'kick',
      raidUntil: 0,
    },
    antinuke: {
      enabled: true, threshold: 4, seconds: 30, punishment: 'strip', restore: true, blockBots: false,
      trusted: [],
    },
    lockdown: { active: false, since: 0, until: 0, reason: '', by: null, backup: [], invitesPaused: false },
    lockedChannels: {},
    tempvoice: { enabled: false, hub: null, category: null, panelChannel: null, nameTemplate: '🔊 {name}', limit: 0 },
    temptext: { category: null },
    tickets: { enabled: false, category: null, supportRoles: [], logChannel: null, counter: 0, maxOpen: 1 },
    levels: {
      enabled: true, channel: null, message: 'GG {user}, du bist jetzt **Level {level}**! 🎉',
      rewards: {}, stackRewards: true, noXpChannels: [], noXpRoles: [], multiplier: 1,
    },
  };
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function mergeDefaults(def, saved) {
  if (!isPlainObject(saved)) return def;
  for (const key of Object.keys(saved)) {
    if (isPlainObject(def[key]) && isPlainObject(saved[key]) && key !== 'rewards' && key !== 'lockedChannels') {
      def[key] = mergeDefaults(def[key], saved[key]);
    } else {
      def[key] = saved[key];
    }
  }
  return def;
}

const cache = new Map();

function getConfig(guildId) {
  let cfg = cache.get(guildId);
  if (!cfg) {
    cfg = mergeDefaults(defaults(), store.get('guilds', guildId));
    cache.set(guildId, cfg);
  }
  return cfg;
}

function saveConfig(guildId) {
  const cfg = getConfig(guildId);
  store.set('guilds', guildId, cfg);
}

module.exports = { getConfig, saveConfig, defaults, DEFAULT_ALLOW };
