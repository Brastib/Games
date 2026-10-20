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
    // Ruhemodus: auf neuen Servern zählt der Bot still mit (XP, Quests), postet aber keine Level-Up-/Quest-Meldungen,
    // bis /nb gelaufen ist oder er im Dashboard ausgeschaltet wird – damit neben dem alten Bot nichts doppelt kommt.
    quiet: false,
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
    // Beim Lockdown: Sirene + Durchsage in allen besetzten Sprachkanälen, Warnung im Chat; Grund, wenn keiner angegeben ist
    lockdownAlarm: { voice: true, chatChannel: null, reason: 'Auf Befehl von Basti' },
    lockedChannels: {},
    // hubs: [{ id, category, nameTemplate, limit }] – "Kanal erstellen"-Sprachkanäle (im Dashboard einstellbar)
    tempvoice: { enabled: false, hubs: [], hub: null, category: null, panelChannel: null, nameTemplate: '🔊 {name}', limit: 0, panelInChat: true },
    temptext: { category: null },
    // archiveCategory: geschlossene Tickets werden dorthin verschoben (nur lesbar) statt gelöscht
    tickets: { enabled: false, category: null, supportRoles: [], logChannel: null, counter: 0, maxOpen: 1, archiveCategory: null, archiveChannel: null },
    levels: {
      // formula: 'etc' = wie der bisherige ETC. Bot (Level L braucht insgesamt 100·L² XP), 'mee6' = MEE6-Kurve
      // style: 'embed' = „⬆️ Level Up!“-Karte mit Profilbild, 'text' = einfache Nachricht
      enabled: true, channel: null, message: '{user} hat **Level {level}** erreicht! 🎉', formula: 'etc', style: 'embed',
      rewards: {}, stackRewards: true, noXpChannels: [], noXpRoles: [], multiplier: 1,
      msgXp: { min: 15, max: 25 }, // XP pro Nachricht (zufällig in diesem Bereich, höchstens 1× pro Minute)
      // psPerMinute: eigene Voice-XP, wenn Discord eine PS4/PS5-Aktivität meldet (0 = wie normal; braucht PRESENCE INTENT)
      voice: { enabled: true, perMinute: 8, psPerMinute: 0, minMembers: 2 },
      tagBoost: { enabled: false, percent: 25 }, // Extra-XP für alle, die den Server-Tag dieses Servers tragen
      clips: {
        enabled: true, channels: [], xp: 40, cooldownMinutes: 5,
        likeEmoji: '🔥', likeXp: 5, maxLikeXp: 100, hallOfFame: null, hallThreshold: 5,
      },
    },
    quests: { enabled: true, perDay: 3, rewardMultiplier: 1, announce: true, channel: null }, // channel: /quests nur dort
    economy: { enabled: true, name: 'Münzen', emoji: '🪙', daily: 100, shop: [] },
    music: {
      enabled: true, djRole: null, defaultVolume: 80, maxQueue: 200, leaveMinutes: 3, channel: null,
      // Gesperrte Begriffe (Titel, Suchbegriff, Kanal): "wort" oder "/regulärer ausdruck/" – Schreibweisen wie L4nds3r werden erkannt
      filter: { enabled: true, terms: [], useBadwords: true },
    },
    counting: {
      enabled: false, channel: null, current: 0, lastUser: null, record: 0, recordBy: null, resetOnFail: true,
      welcome: '🧮 **Zählspiel!** Schreibt nacheinander die nächste Zahl. Niemand darf zweimal hintereinander zählen.',
      failMessage: '❌ {user} hat sich verzählt – richtig wäre **{expected}** gewesen. Rekord: **{record}**. Wir fangen wieder bei **1** an!',
    },
    freegames: { enabled: false, channel: null, deleteExpired: true, role: null },
    fun: { enabled: true },
    prefix: { enabled: true, char: '!' }, // !createvoice / !createtext
    alert: { enabled: false, webhook: null, mentions: [], message: '🚨 **ETC. Bot ist offline!** Bitte nachsehen.' },
    backups: { enabled: true, keep: 7 },
    autoresponders: [],
    stats: { enabled: false, category: null, members: null, humans: null, boosts: null },
    suggestions: { channel: null, counter: 0 },
    // Automatische Wochen-Posts. weekday: 0 = Sonntag … 6 = Samstag, time: "HH:MM" (deutsche Zeit)
    posts: {
      animal: {
        enabled: false, channel: null, weekday: 0, time: '18:00', source: 'mixed', poolChannel: null,
        text: '🐱🐶 **Hier ist dein wöchentliches Tierfoto!**', lastRun: null, used: [],
      },
      leaderboard: {
        enabled: false, channel: null, weekday: 0, everyDays: 7, time: '12:00',
        text: '🏆 **Die aktuelle Bestenliste!** Wer schreibt sich diese Runde nach oben?', lastRun: null,
      },
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
    // Alte Einstellung (ein Hub) in die neue Liste übernehmen
    const tv = cfg.tempvoice;
    if (tv.hub && !tv.hubs.some(h => h.id === tv.hub)) {
      tv.hubs.push({ id: tv.hub, category: tv.category, nameTemplate: tv.nameTemplate, limit: tv.limit });
    }
    cache.set(guildId, cfg);
  }
  return cfg;
}

/** Nach einer Wiederherstellung: Einstellungen neu aus dem Speicher lesen */
function reloadConfig(guildId) { cache.delete(guildId); return getConfig(guildId); }

function saveConfig(guildId) {
  const cfg = getConfig(guildId);
  store.set('guilds', guildId, cfg);
}

module.exports = { getConfig, saveConfig, reloadConfig, defaults, DEFAULT_ALLOW };
