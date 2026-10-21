'use strict';
/**
 * Welche Einstellungen das Web-Dashboard ändern darf – und wie jeder Wert geprüft wird.
 * Alles, was hier nicht steht, kann über das Dashboard nicht verändert werden.
 */
const { ChannelType } = require('discord.js');
const { WEBHOOK_RE } = require('../modules/alert');

const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const VOICE = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
const ANY = null;

class Invalid extends Error {}
const fail = msg => { throw new Invalid(msg); };

const v = {
  bool: () => x => (typeof x === 'boolean' ? x : fail('muss an/aus sein')),
  int: (min, max) => x => (Number.isInteger(x) && x >= min && x <= max ? x : fail(`muss eine ganze Zahl von ${min} bis ${max} sein`)),
  num: (min, max) => x => (typeof x === 'number' && isFinite(x) && x >= min && x <= max ? Math.round(x * 100) / 100 : fail(`muss eine Zahl von ${min} bis ${max} sein`)),
  str: (max, min = 0) => x => (typeof x === 'string' && x.length <= max && x.trim().length >= min ? x : fail(`Text zu lang (max. ${max}) oder leer`)),
  oneOf: (...opts) => x => (opts.includes(x) ? x : fail(`ungültige Auswahl`)),
  time: () => x => (typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : fail('Uhrzeit bitte so: 18:00')),
  channel: (types = ANY, nullable = true) => (x, g) => {
    if (x === null || x === '') return nullable ? null : fail('Kanal fehlt');
    const c = g.channels.cache.get(String(x));
    if (!c) fail('Kanal existiert nicht');
    if (types && !types.includes(c.type)) fail('falscher Kanaltyp');
    return c.id;
  },
  category: (nullable = true) => v.channel([ChannelType.GuildCategory], nullable),
  channels: (types = ANY) => (x, g) => {
    if (!Array.isArray(x) || x.length > 50) fail('Liste ungültig');
    return [...new Set(x.map(id => v.channel(types, false)(id, g)))];
  },
  role: (nullable = true) => (x, g) => {
    if (x === null || x === '') return nullable ? null : fail('Rolle fehlt');
    const r = g.roles.cache.get(String(x));
    if (!r || r.id === g.id) fail('Rolle existiert nicht');
    return r.id;
  },
  roles: () => (x, g) => {
    if (!Array.isArray(x) || x.length > 50) fail('Liste ungültig');
    return [...new Set(x.map(id => v.role(false)(id, g)))];
  },
  domains: () => x => {
    if (!Array.isArray(x) || x.length > 500) fail('Liste ungültig');
    return [...new Set(x.map(d => String(d).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]))]
      .map(d => (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : fail(`„${d}“ ist keine Domain`)));
  },
  words: () => x => {
    if (!Array.isArray(x) || x.length > 300) fail('Liste ungültig');
    return [...new Set(x.map(w => String(w).toLowerCase().trim()).filter(Boolean))].map(w => (w.length <= 60 ? w : fail('Wort zu lang')));
  },
  webhook: () => x => (x === null || x === '' ? null
    : typeof x === 'string' && WEBHOOK_RE.test(x.trim()) ? x.trim() : fail('Das ist keine Discord-Webhook-Adresse (https://discord.com/api/webhooks/…)')),
  // Musik-Filter: "wort" oder "/regulärer ausdruck/"
  terms: () => x => {
    if (!Array.isArray(x) || x.length > 300) fail('Liste ungültig');
    return [...new Set(x.map(t => String(t).trim()).filter(Boolean))].map(t => {
      if (t.length > 120) fail('Begriff zu lang');
      const re = /^\/(.+)\/$/.exec(t);
      if (re) { try { new RegExp(re[1], 'iu'); } catch { fail(`„${t}“ ist kein gültiger Ausdruck`); } }
      return t;
    });
  },
  users: () => x => {
    if (!Array.isArray(x) || x.length > 50) fail('Liste ungültig');
    return [...new Set(x.map(id => (/^\d{17,20}$/.test(String(id)) ? String(id) : fail(`„${id}“ ist keine Nutzer-ID`))))];
  },
  hubs: () => (x, g) => {
    if (!Array.isArray(x) || x.length > 20) fail('Höchstens 20 Hubs');
    return x.map(h => ({
      id: v.channel(VOICE, false)(h.id, g),
      category: v.category()(h.category ?? null, g),
      nameTemplate: v.str(80, 1)(h.nameTemplate || '🔊 {name}'),
      limit: v.int(0, 99)(Number(h.limit) || 0),
    }));
  },
  rewards: () => (x, g) => {
    if (typeof x !== 'object' || Array.isArray(x) || Object.keys(x).length > 100) fail('ungültig');
    const out = {};
    for (const [lvl, roleId] of Object.entries(x)) out[String(v.int(1, 1000)(Number(lvl)))] = v.role(false)(roleId, g);
    return out;
  },
  shop: () => (x, g) => {
    if (!Array.isArray(x) || x.length > 25) fail('Höchstens 25 Artikel');
    return x.map(i => ({ roleId: v.role(false)(i.roleId, g), price: v.int(1, 100_000_000)(Number(i.price)), description: v.str(100)(i.description || '') }));
  },
  autoresponders: () => x => {
    if (!Array.isArray(x) || x.length > 100) fail('Höchstens 100 Auto-Antworten');
    return x.map(a => ({
      trigger: v.str(100, 1)(String(a.trigger || '').toLowerCase().trim()),
      response: v.str(2000, 1)(a.response || ''),
      match: v.oneOf('contains', 'exact', 'startswith')(a.match || 'contains'),
      reply: a.reply !== false,
    }));
  },
};

const ACTION = v.oneOf('delete', 'warn', 'timeout');
const HARD = v.oneOf('delete', 'warn', 'timeout', 'kick', 'ban');

const SCHEMA = {
  modRoles: v.roles(),
  'logs.fallback': v.channel(TEXT), 'logs.mod': v.channel(TEXT), 'logs.protection': v.channel(TEXT), 'logs.messages': v.channel(TEXT),
  'logs.members': v.channel(TEXT), 'logs.server': v.channel(TEXT), 'logs.voice': v.channel(TEXT),

  'welcome.enabled': v.bool(), 'welcome.channel': v.channel(TEXT), 'welcome.message': v.str(1500, 1), 'welcome.card': v.bool(),
  'welcome.dm': v.bool(), 'welcome.dmMessage': v.str(1500), 'welcome.autoRoles': v.roles(), 'welcome.botRoles': v.roles(),
  'goodbye.enabled': v.bool(), 'goodbye.channel': v.channel(TEXT), 'goodbye.message': v.str(1500, 1),
  'verify.enabled': v.bool(), 'verify.channel': v.channel(TEXT), 'verify.role': v.role(), 'verify.unverifiedRole': v.role(),
  'verify.captcha': v.bool(), 'verify.title': v.str(100, 1), 'verify.text': v.str(4000),

  'automod.enabled': v.bool(), 'automod.exemptRoles': v.roles(), 'automod.exemptChannels': v.channels(),
  'automod.links.enabled': v.bool(), 'automod.links.mode': v.oneOf('smart', 'strict', 'off'), 'automod.links.action': ACTION,
  'automod.links.phishingAction': HARD, 'automod.links.phishingMinutes': v.int(1, 40320), 'automod.links.allow': v.domains(), 'automod.links.block': v.domains(),
  'automod.invites.enabled': v.bool(), 'automod.invites.allowOwn': v.bool(), 'automod.invites.action': ACTION,
  'automod.spam.enabled': v.bool(), 'automod.spam.maxMessages': v.int(3, 30), 'automod.spam.perSeconds': v.int(2, 60),
  'automod.spam.duplicates': v.int(0, 20), 'automod.spam.timeoutMinutes': v.int(1, 10080),
  'automod.mentions.enabled': v.bool(), 'automod.mentions.max': v.int(1, 50),
  'automod.caps.enabled': v.bool(), 'automod.caps.percent': v.int(50, 100),
  'automod.badwords.enabled': v.bool(), 'automod.badwords.words': v.words(), 'automod.badwords.action': ACTION,
  'automod.escalation.enabled': v.bool(), 'automod.escalation.timeoutAt': v.int(0, 50), 'automod.escalation.timeoutMinutes': v.int(1, 40320),
  'automod.escalation.kickAt': v.int(0, 50), 'automod.escalation.banAt': v.int(0, 50), 'automod.escalation.expireDays': v.int(0, 365),

  'antiraid.enabled': v.bool(), 'antiraid.joins': v.int(3, 100), 'antiraid.seconds': v.int(3, 600), 'antiraid.action': v.oneOf('lockdown', 'alert'),
  'antiraid.minutes': v.int(1, 1440), 'antiraid.pauseInvites': v.bool(), 'antiraid.kickRaiders': v.bool(),
  'antiraid.minAccountDays': v.int(0, 365), 'antiraid.accountAction': v.oneOf('kick', 'ban', 'timeout'),

  'antinuke.enabled': v.bool(), 'antinuke.threshold': v.int(2, 50), 'antinuke.seconds': v.int(5, 600),
  'antinuke.punishment': v.oneOf('strip', 'kick', 'ban'), 'antinuke.restore': v.bool(), 'antinuke.blockBots': v.bool(), 'antinuke.trusted': v.users(), 'antinuke.trustedRoles': v.roles(), 'memberRole.enabled': v.bool(), 'memberRole.role': v.role(),

  'tempvoice.enabled': v.bool(), 'tempvoice.panelInChat': v.bool(), 'tempvoice.hubs': v.hubs(),
  'tickets.enabled': v.bool(), 'tickets.supportRoles': v.roles(), 'tickets.logChannel': v.channel(TEXT), 'tickets.maxOpen': v.int(1, 5),

  'levels.enabled': v.bool(), 'levels.channel': v.channel(TEXT), 'levels.message': v.str(500, 1), 'levels.multiplier': v.num(0.1, 10),
  'levels.formula': v.oneOf('etc', 'mee6'), 'levels.style': v.oneOf('embed', 'text'), 'levels.announce': v.bool(), 'levels.lvlOnlyInChannel': v.bool(),
  'levels.msgXp.min': v.int(0, 500), 'levels.msgXp.max': v.int(0, 500), 'levels.voice.psPerMinute': v.int(0, 100),
  'levels.tagBoost.enabled': v.bool(), 'levels.tagBoost.percent': v.int(1, 500), 'quests.channel': v.channel(TEXT),
  'music.filter.enabled': v.bool(), 'music.filter.useBadwords': v.bool(), 'music.filter.terms': v.terms(),
  'counting.channel': v.channel([ChannelType.GuildText]), 'counting.resetOnFail': v.bool(), 'counting.enabled': v.bool(),
  'counting.welcome': v.str(500, 1), 'counting.failMessage': v.str(500, 1),
  'freegames.enabled': v.bool(), 'freegames.channel': v.channel(TEXT), 'freegames.deleteExpired': v.bool(), 'freegames.role': v.role(),
  'alert.enabled': v.bool(), 'alert.webhook': v.webhook(), 'alert.mentions': v.users(), 'alert.message': v.str(500, 1),
  'backups.enabled': v.bool(), 'backups.keep': v.int(1, 30),
  'levels.noXpChannels': v.channels(), 'levels.noXpRoles': v.roles(), 'levels.stackRewards': v.bool(), 'levels.rewards': v.rewards(),
  'levels.voice.enabled': v.bool(), 'levels.voice.perMinute': v.int(0, 100), 'levels.voice.minMembers': v.int(1, 10),
  'levels.clips.enabled': v.bool(), 'levels.clips.channels': v.channels(TEXT.concat([ChannelType.GuildForum])), 'levels.clips.xp': v.int(0, 1000),
  'levels.clips.cooldownMinutes': v.int(0, 1440), 'levels.clips.likeEmoji': v.str(60, 1), 'levels.clips.likeXp': v.int(0, 100),
  'levels.clips.maxLikeXp': v.int(0, 10000), 'levels.clips.hallOfFame': v.channel(TEXT), 'levels.clips.hallThreshold': v.int(1, 100),

  'quests.enabled': v.bool(), 'quests.perDay': v.int(1, 5), 'quests.rewardMultiplier': v.num(0.1, 10), 'quests.announce': v.bool(),
  'economy.enabled': v.bool(), 'economy.name': v.str(20, 1), 'economy.emoji': v.str(60, 1), 'economy.daily': v.int(1, 100000), 'economy.shop': v.shop(),
  'music.enabled': v.bool(), 'music.djRole': v.role(), 'music.defaultVolume': v.int(1, 200), 'music.maxQueue': v.int(10, 1000),
  'music.leaveMinutes': v.int(0, 60), 'music.channel': v.channel(TEXT),

  'posts.animal.enabled': v.bool(), 'posts.animal.channel': v.channel(TEXT), 'posts.animal.weekday': v.int(0, 6), 'posts.animal.time': v.time(),
  'posts.animal.source': v.oneOf('mixed', 'dogs', 'cats', 'pool'), 'posts.animal.poolChannel': v.channel([ChannelType.GuildText]), 'posts.animal.text': v.str(300, 1),
  'posts.leaderboard.enabled': v.bool(), 'posts.leaderboard.channel': v.channel(TEXT), 'posts.leaderboard.weekday': v.int(0, 6),
  'posts.leaderboard.time': v.time(), 'posts.leaderboard.text': v.str(300, 1), 'posts.leaderboard.everyDays': v.int(1, 30),
  'posts.recap.enabled': v.bool(), 'posts.recap.channel': v.channel(TEXT), 'posts.recap.weekday': v.int(0, 6), 'posts.recap.time': v.time(), 'posts.recap.text': v.str(300, 1),

  quiet: v.bool(),
  'lockdownAlarm.voice': v.bool(), 'lockdownAlarm.chatChannel': v.channel(TEXT), 'lockdownAlarm.reason': v.str(200, 1),
  'fun.enabled': v.bool(), 'prefix.enabled': v.bool(), 'prefix.char': x => (typeof x === 'string' && /^[^\s\w/@#<>]{1,3}$/.test(x) ? x : fail('1–3 Zeichen wie ! ? . $ – keine Buchstaben, kein /')),
  'tickets.archiveCategory': v.category(),
  autoresponders: v.autoresponders(),
  'stats.enabled': v.bool(),
  'suggestions.channel': v.channel(TEXT),
};

const OWNER_ONLY = key => key.startsWith('antinuke.');

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
  o[parts.at(-1)] = value;
}

/** Prüft und übernimmt Änderungen. Gibt { applied, errors } zurück. */
function applyChanges(cfg, changes, guild, { isOwner }) {
  const applied = [];
  const errors = {};
  for (const [path, raw] of Object.entries(changes || {})) {
    const check = SCHEMA[path];
    if (!check) { errors[path] = 'nicht änderbar'; continue; }
    if (OWNER_ONLY(path) && !isOwner) { errors[path] = 'nur der Server-Inhaber darf Anti-Nuke ändern'; continue; }
    try {
      setPath(cfg, path, check(raw, guild));
      applied.push(path);
    } catch (e) {
      if (e instanceof Invalid) errors[path] = e.message; else throw e;
    }
  }
  return { applied, errors };
}

module.exports = { SCHEMA, applyChanges, Invalid };
