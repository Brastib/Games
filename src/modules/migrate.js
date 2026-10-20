'use strict';
/**
 * /nb – „Neuer Bot“: übernimmt, was der alte Bot auf dem Server gemacht hat – sauber neu aufgebaut.
 *
 * Quellen:
 *  1. Discord: die letzten Nachrichten des alten Bots in allen Textkanälen (Panels, Level-Ups, Tierfotos, Bestenlisten,
 *     Willkommen …) → Kanäle, Uhrzeiten, Rollen-Buttons, letzte bekannte Level. Braucht den MESSAGE CONTENT INTENT.
 *  2. Altes Dashboard (Adresse + Passwort, optional): genaue Einstellungen, XP aller Mitglieder, Wortfilter,
 *     Musik-Filter und hochgeladene Tierfotos. Hat Vorrang vor dem, was aus Nachrichten erschlossen wurde.
 *
 * Ablauf: scan() → Vorschau mit Knöpfen → apply() (vorher automatisches Backup, daher rückgängig machbar).
 */
const crypto = require('crypto');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits: P, AttachmentBuilder, ComponentType,
} = require('discord.js');
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const { truncate } = require('../lib/util');
const backups = require('./backups');
const leveling = require('./leveling');
const { nowParts } = require('./autoposts');

const plans = new Map(); // token -> { guildId, userId, plan, at }
const PLAN_TTL = 30 * 60_000;

// ---------------- Wer darf? ----------------
async function isBotOwner(user, client) {
  const extra = (process.env.OWNER_IDS || '').split(/[\s,]+/).filter(Boolean);
  if (extra.includes(user.id)) return true;
  const app = await client.application?.fetch().catch(() => client.application);
  const owner = app?.owner;
  if (!owner) return false;
  return owner.members ? owner.members.has(user.id) : owner.id === user.id; // Team oder einzelne Person
}

// ---------------- Discord-Nachrichten lesen ----------------
const RX = {
  tempvoice: /umbenenn|user-?limit|sperren|entsperren|verstecken|kicken|bannen|übernehm|claim|bitrate|besitzer|region/i,
  ticket: /ticket|support/i,
  archive: /archiv/i,
  verify: /akzeptier|verifizier|regeln/i,
  levelUp: /level\s*up|hat\s+\**level|level\s+\**\d+\**\s+erreicht|levelaufstieg/i,
  leaderboard: /bestenliste|leaderboard|rangliste/i,
  animal: /tierfoto|tierbild/i,
  welcome: /willkommen|wilkommen|welcome/i,
  goodbye: /\bbye\b|verlassen|tschüss|auf wiedersehen/i,
  freegames: /gratis|kostenlos|free\s*games?|giveaway/i,
  quest: /quest/i,
};

const textOf = m => [m.content, ...m.embeds.flatMap(e => [e.title, e.description, e.author?.name, e.footer?.text, ...(e.fields || []).flatMap(f => [f.name, f.value])])]
  .filter(Boolean).join('\n');
const controlsOf = m => m.components.flatMap(r => r.components || [])
  .filter(c => c.type === ComponentType.Button || c.type === ComponentType.StringSelect);
const cleanLabel = l => String(l || '').replace(/<a?:\w+:\d+>/g, '').replace(/[^\p{L}\p{N}\s\-_.!?&]/gu, '').replace(/^@/, '').trim().toLowerCase();

function rolesOnPanel(guild, controls) {
  const found = new Map();
  for (const c of controls) {
    const entries = c.type === ComponentType.StringSelect ? (c.options || []).map(o => ({ label: o.label, id: o.value })) : [{ label: c.label, id: c.customId }];
    for (const e of entries) {
      const byId = [...String(e.id || '').matchAll(/\d{17,20}/g)].map(x => guild.roles.cache.get(x[0])).find(Boolean);
      const byName = guild.roles.cache.find(r => r.id !== guild.id && cleanLabel(r.name) && cleanLabel(r.name) === cleanLabel(e.label));
      const role = byId || byName;
      if (role && !role.managed) found.set(role.id, { role, label: String(e.label || role.name).slice(0, 80) });
    }
  }
  return [...found.values()];
}

function classify(m, guild) {
  const t = textOf(m), controls = controlsOf(m);
  const labels = controls.flatMap(c => (c.type === ComponentType.StringSelect ? (c.options || []).map(o => o.label) : [c.label])).filter(Boolean);
  const L = labels.join(' | ');
  if (controls.length) {
    if (labels.filter(l => RX.tempvoice.test(l)).length >= 3) return { kind: 'tempvoicePanel' };
    if (RX.archive.test(L + t)) return { kind: 'archivePanel' };
    if (RX.ticket.test(L + t)) return { kind: 'ticketPanel' };
    if (RX.verify.test(L)) return { kind: 'verifyPanel', roles: rolesOnPanel(guild, controls) };
    const roles = rolesOnPanel(guild, controls);
    if (roles.length) return { kind: 'rolePanel', roles, title: m.embeds[0]?.title || m.content.split('\n')[0] || 'Rollen', description: m.embeds[0]?.description || null };
  }
  const hasImage = m.attachments.some(a => (a.contentType || '').startsWith('image/')) || m.embeds.some(e => e.image);
  if (RX.levelUp.test(t)) {
    const userId = m.mentions.users.find(u => !u.bot)?.id || /<@!?(\d{17,20})>/.exec(t)?.[1];
    const level = Number(/level\s*\**\s*(\d{1,4})/i.exec(t)?.[1]);
    return { kind: 'levelUp', userId, level: Number.isFinite(level) ? level : null };
  }
  if (RX.animal.test(t) && hasImage) return { kind: 'animal' };
  if (RX.leaderboard.test(t) || m.attachments.some(a => /leader|bestenliste|rang/i.test(a.name || ''))) return { kind: 'leaderboard' };
  if (RX.welcome.test(t) && (m.mentions.users.size || /<@!?\d+>/.test(t))) return { kind: 'welcome' };
  if (RX.goodbye.test(t)) return { kind: 'goodbye' };
  if (RX.freegames.test(t) && m.embeds.length) return { kind: 'freegames' };
  if (RX.quest.test(t)) return { kind: 'quest' };
  return { kind: null };
}

/** Häufigster Wochentag/Uhrzeit und Abstand in Tagen aus den Zeitpunkten der alten Posts */
function scheduleFrom(times) {
  if (!times.length) return null;
  const parts = times.sort((a, b) => a - b).map(t => nowParts(new Date(t)));
  const mode = arr => [...arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0];
  const minutes = mode(parts.map(p => Math.floor(p.minutes / 5) * 5));
  const days = parts.map(p => Math.round(Date.parse(`${p.day}T00:00:00Z`) / 86_400_000));
  const gaps = days.slice(1).map((d, i) => d - days[i]).filter(g => g > 0).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 7;
  return {
    weekday: mode(parts.map(p => p.weekday)),
    time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
    everyDays: gap <= 1 ? 1 : gap >= 6 ? 7 : gap,
  };
}

async function scanDiscord(guild, { oldBotId = null } = {}) {
  const me = guild.members.me;
  const channels = guild.channels.cache.filter(c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    && c.permissionsFor(me)?.has([P.ViewChannel, P.ReadMessageHistory]));
  const perBot = new Map(), hits = [], counting = [];
  for (const ch of channels.values()) {
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs?.size) continue;
    const human = msgs.filter(m => !m.author.bot);
    const numbers = human.filter(m => /^\s*\d{1,9}\s*$/.test(m.content));
    if (numbers.size >= 5 && numbers.size >= human.size * 0.7) {
      const last = numbers.first();
      counting.push({ channel: ch, current: Number(last.content.trim()), lastUser: last.author.id, size: numbers.size });
    }
    for (const m of msgs.values()) {
      if (!m.author.bot || m.author.id === guild.client.user.id || m.webhookId) continue;
      if (oldBotId && m.author.id !== oldBotId) continue;
      perBot.set(m.author.id, (perBot.get(m.author.id) || 0) + 1);
      hits.push(m);
    }
  }
  const botId = oldBotId || [...perBot].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const res = { botId, botTag: null, channels: {}, panels: [], rolePanels: [], verifyPanels: [], levels: new Map(), schedule: {}, counting: counting.sort((a, b) => b.size - a.size)[0] || null, scanned: channels.size };
  const tally = {}, times = { animal: [], leaderboard: [] };
  for (const m of hits) {
    if (m.author.id !== botId) continue;
    res.botTag ??= m.author.tag;
    const c = classify(m, guild);
    if (!c.kind) continue;
    (tally[c.kind] ||= new Map()).set(m.channel.id, (tally[c.kind].get(m.channel.id) || 0) + 1);
    if (c.kind.endsWith('Panel')) res.panels.push({ kind: c.kind, channelId: m.channel.id, messageId: m.id });
    if (c.kind === 'rolePanel') res.rolePanels.push({ channelId: m.channel.id, messageId: m.id, roles: c.roles, title: c.title, description: c.description });
    if (c.kind === 'verifyPanel') res.verifyPanels.push({ channelId: m.channel.id, messageId: m.id, roles: c.roles });
    if (c.kind === 'levelUp' && c.userId && c.level != null) res.levels.set(c.userId, Math.max(res.levels.get(c.userId) || 0, c.level));
    if (times[c.kind]) times[c.kind].push(m.createdTimestamp);
  }
  for (const [kind, map] of Object.entries(tally)) res.channels[kind] = [...map].sort((a, b) => b[1] - a[1])[0][0];
  res.schedule.animal = scheduleFrom(times.animal);
  res.schedule.leaderboard = scheduleFrom(times.leaderboard);
  if (!res.botTag && botId) res.botTag = (await guild.client.users.fetch(botId).catch(() => null))?.tag || botId;
  return res;
}

// ---------------- Altes Dashboard lesen (nur lesen, nichts ändern) ----------------
async function fetchOldDashboard(url, password, guildId) {
  let base;
  try { base = new URL(url); } catch { throw new Error('Die Dashboard-Adresse ist keine gültige URL.'); }
  if (!/^https?:$/.test(base.protocol)) throw new Error('Die Dashboard-Adresse muss mit https:// beginnen.');
  const root = base.origin;
  const t = () => AbortSignal.timeout(20_000);
  const login = await fetch(`${root}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }), signal: t() })
    .catch(() => { throw new Error('Das alte Dashboard ist nicht erreichbar.'); });
  const ok = await login.json().catch(() => ({}));
  if (!login.ok || !ok.success) throw new Error('Anmeldung am alten Dashboard fehlgeschlagen – Passwort richtig?');
  const cookie = (login.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const get = async p => {
    const r = await fetch(`${root}/api/${p}?guildId=${encodeURIComponent(guildId)}`, { headers: { cookie }, signal: t() }).catch(() => null);
    return r?.ok ? r.json().catch(() => null) : null;
  };
  const [config, members, badwords, musicfilter, levelroles, animals] = await Promise.all(
    ['config', 'guild/members', 'badwords', 'musicfilter', 'levelroles', 'guild/animals'].map(get));
  if (!config || config.error) throw new Error('Das alte Dashboard kennt diesen Server nicht.');
  const arr = x => (Array.isArray(x) ? x : []);
  return { root, config, members: arr(members), badwords: arr(badwords), musicfilter: arr(musicfilter), levelroles: arr(levelroles), animals: arr(animals) };
}

// ---------------- Plan bauen ----------------
const fixTypos = s => String(s || '').replace(/\bWilkommen\b/g, 'Willkommen').replace(/\s+$/, '');
const on = v => v === true || v === 1 || v === '1' || v === 'true';
const num = (v, d = null) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

function buildPlan(guild, d, x) {
  const c = x?.config || {};
  const chan = id => (id && guild.channels.cache.get(String(id))) || null;
  const role = id => (id && guild.roles.cache.get(String(id))) || null;
  const items = [], skipped = [];
  const add = (area, text, fn) => items.push({ area, text, fn });
  const cfgOf = () => getConfig(guild.id);

  // 👋 Willkommen / Abschied
  const wCh = chan(c.welcome_channel_id) || chan(d.channels.welcome);
  if (wCh) {
    const message = c.welcome_message ? fixTypos(c.welcome_message) : null;
    const auto = role(c.welcome_autorole_id);
    add('👋 Willkommen', `${wCh}${message ? ` · „${truncate(message, 60)}“` : ''}${auto ? ` · Auto-Rolle ${auto}` : ''}`, () => {
      const w = cfgOf().welcome;
      Object.assign(w, { enabled: true, channel: wCh.id }, message ? { message } : {});
      if (auto && !w.autoRoles.includes(auto.id)) w.autoRoles.push(auto.id);
    });
  }
  const gCh = chan(c.leave_channel_id) || chan(d.channels.goodbye);
  if (gCh) {
    // Beim Verlassen ist die Person nicht mehr auf dem Server – Name statt Erwähnung
    const message = c.leave_message ? String(c.leave_message).replace(/\{user\}/g, '**{username}**') : null;
    add('🚪 Abschied', `${gCh}${message ? ` · „${truncate(message, 60)}“` : ''}`, () => Object.assign(cfgOf().goodbye, { enabled: true, channel: gCh.id }, message ? { message } : {}));
  }

  // 📜 Logs
  const logMap = { mod: c.log_channel_mod_id, messages: c.log_channel_msg_id, members: c.log_channel_member_id, voice: c.log_channel_voice_id, server: c.log_channel_server_id };
  const logs = Object.entries(logMap).filter(([, id]) => chan(id));
  if (logs.length) {
    add('📜 Logs', [...new Set(logs.map(([, id]) => `${chan(id)}`))].join(', '), () => {
      const l = cfgOf().logs;
      for (const [k, id] of logs) l[k] = String(id);
      l.fallback ||= String(logs[0][1]);
    });
  }

  // 🐱🐶 Tierfoto
  const aCh = chan(c.animal_photo_channel_id) || chan(d.channels.animal);
  if (aCh) {
    const s = d.schedule.animal;
    const weekday = num(c.animal_photo_day, s?.weekday ?? 0), time = /^\d{1,2}:\d{2}$/.test(c.animal_photo_time || '') ? c.animal_photo_time.padStart(5, '0') : s?.time || '18:00';
    const photos = (x?.animals || []).filter(p => p.filename);
    const enabled = c.animal_photo_enable !== undefined ? on(c.animal_photo_enable) : true;
    add('🐱🐶 Tierfoto', `${aCh} · ${require('./autoposts').WEEKDAYS[weekday]} ${time}${photos.length ? ` · ${photos.length} eigene Fotos in neuen Sammel-Kanal` : ''}${enabled ? '' : ' · aus'}`, async () => {
      const p = cfgOf().posts.animal;
      Object.assign(p, { enabled, channel: aCh.id, weekday, time, lastRun: nowParts().day }); // heute nicht noch einmal posten
      if (!photos.length) return null;
      const pool = await guild.channels.create({
        name: '🐾・tierfoto-sammlung', type: ChannelType.GuildText, parent: aCh.parentId || null,
        topic: 'Fotos für das wöchentliche Tierfoto. Admins können hier weitere Bilder hochladen.',
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }, { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.AttachFiles, P.ReadMessageHistory] }],
      });
      let up = 0;
      for (const ph of photos) {
        const res = await fetch(`${x.root}/assets/animals/${encodeURIComponent(ph.filename)}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
        if (!res?.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 9.5 * 1024 * 1024) continue;
        if (await pool.send({ files: [new AttachmentBuilder(buf, { name: ph.filename.replace(/[^\w.-]/g, '_') })] }).catch(() => null)) up++;
      }
      Object.assign(p, { source: 'pool', poolChannel: pool.id, used: [] });
      return `${up}/${photos.length} Fotos nach ${pool} übernommen`;
    });
  }

  // 🏆 Bestenliste
  const lbCh = chan(c.weekly_leaderboard_channel_id) || chan(d.channels.leaderboard);
  if (lbCh) {
    const s = d.schedule.leaderboard;
    const everyDays = Math.min(30, Math.max(1, num(c.leaderboard_interval_days, s?.everyDays ?? 7)));
    const time = /^\d{1,2}:\d{2}$/.test(c.weekly_leaderboard_time || '') ? c.weekly_leaderboard_time.padStart(5, '0') : s?.time || '12:00';
    const enabled = c.weekly_leaderboard_enable !== undefined ? on(c.weekly_leaderboard_enable) : true;
    add('🏆 Bestenliste', `${lbCh} · ${everyDays === 1 ? 'täglich' : everyDays === 7 ? 'wöchentlich' : `alle ${everyDays} Tage`} ${time}${enabled ? '' : ' · aus'}`, () => {
      Object.assign(cfgOf().posts.leaderboard, { enabled, channel: lbCh.id, everyDays, weekday: s?.weekday ?? 0, time, lastRun: nowParts().day });
    });
  }

  // ⭐ Level-Einstellungen
  const lvCh = chan(c.level_up_channel_id) || chan(d.channels.levelUp);
  const xpBits = [];
  if (num(c.xp_min_msg) != null) xpBits.push(`${c.xp_min_msg}–${c.xp_max_msg} XP/Nachricht`);
  if (num(c.xp_voice_pc ?? c.xp_voice_min) != null) xpBits.push(`Voice ${c.xp_voice_pc ?? c.xp_voice_min}/Min.${num(c.xp_voice_playstation) ? ` (PS ${c.xp_voice_playstation})` : ''}`);
  if (num(c.xp_clip_min) != null) xpBits.push(`Clips ${c.xp_clip_min}–${c.xp_clip_max}`);
  if (on(c.xp_server_tag_boost_enable)) xpBits.push(`Server-Tag +${c.xp_server_tag_boost_percent || 25} %`);
  if (lvCh || xpBits.length) {
    add('⭐ Level', [lvCh ? `Level-Up in ${lvCh}` : null, ...xpBits, 'Formel 100 × Level²'].filter(Boolean).join(' · '), () => {
      const l = cfgOf().levels;
      l.formula = 'etc';
      if (lvCh) l.channel = lvCh.id;
      if (num(c.xp_min_msg) != null) l.msgXp = { min: num(c.xp_min_msg), max: num(c.xp_max_msg, num(c.xp_min_msg)) };
      if (num(c.xp_voice_pc ?? c.xp_voice_min) != null) l.voice.perMinute = num(c.xp_voice_pc ?? c.xp_voice_min);
      if (num(c.xp_voice_playstation) != null) l.voice.psPerMinute = num(c.xp_voice_playstation);
      if (num(c.xp_clip_min) != null) l.clips.xp = Math.round((num(c.xp_clip_min) + num(c.xp_clip_max, num(c.xp_clip_min))) / 2);
      if (c.xp_server_tag_boost_enable !== undefined) l.tagBoost = { enabled: on(c.xp_server_tag_boost_enable), percent: num(c.xp_server_tag_boost_percent, 25) };
    });
  }
  const levelRoles = (x?.levelroles || []).map(r => ({ level: num(r.level ?? r.lvl), role: role(r.role_id ?? r.roleId ?? r.role) })).filter(r => r.level != null && r.role);
  if (levelRoles.length) add('🎖️ Level-Rollen', levelRoles.map(r => `L${r.level} ${r.role}`).join(', '), () => { for (const r of levelRoles) cfgOf().levels.rewards[r.level] = r.role.id; });

  // 📈 XP aller Mitglieder
  const oldXp = (x?.members || []).filter(m => num(m.xp, 0) > 0 || num(m.messageCount, 0) > 0 || num(m.voiceSeconds, 0) > 0);
  if (oldXp.length) {
    add('📈 XP & Statistik', `${oldXp.length} Mitglieder (XP, Nachrichten, Sprachzeit) – nur nach oben, nichts geht verloren`, () => {
      let n = 0;
      for (const m of oldXp) {
        const k = `${guild.id}:${m.id}`;
        const cur = leveling.getData(guild.id, m.id);
        const next = { ...cur, xp: Math.max(cur.xp || 0, Math.round(num(m.xp, 0))), msgs: Math.max(cur.msgs || 0, num(m.messageCount, 0)), voiceMin: Math.max(cur.voiceMin || 0, Math.round(num(m.voiceSeconds, 0) / 60)) };
        store.set('levels', k, next);
        n++;
      }
      return `${n} Mitglieder übernommen`;
    });
  } else if (d.levels.size) {
    add('📈 XP (geschätzt)', `${d.levels.size} Mitglieder – aus den letzten Level-Up-Nachrichten (Mindest-XP für ihr Level)`, () => {
      for (const [userId, level] of d.levels) {
        const cur = leveling.getData(guild.id, userId);
        store.set('levels', `${guild.id}:${userId}`, { ...cur, xp: Math.max(cur.xp || 0, leveling.xpForLevel(level, guild.id)) });
      }
    });
  }

  // 🗓️ Quests
  const qCh = chan(c.quest_channel_id) || chan(d.channels.quest);
  if (qCh) add('🗓️ Quests', `/quests nur in ${qCh}`, () => { cfgOf().quests.channel = qCh.id; });

  // 🧮 Zählspiel
  const cCh = chan(c.counting_channel_id) || d.counting?.channel || null;
  if (cCh) {
    const current = num(c.counting_current_num, d.counting?.current ?? 0);
    const lastUser = c.counting_last_user_id || d.counting?.lastUser || null;
    add('🧮 Zählspiel', `${cCh} · weiter ab ${current + 1}`, async () => {
      Object.assign(cfgOf().counting, { enabled: true, channel: cCh.id, current, lastUser, record: Math.max(cfgOf().counting.record || 0, current) });
      await cCh.send(`🧮 **ETC. Bot zählt ab jetzt mit.** Nächste Zahl: **${current + 1}**`).catch(() => {});
    });
  }

  // 🎮 Gratis-Spiele
  const fCh = chan(c.freegames_channel_id) || chan(d.channels.freegames);
  if (fCh) {
    const enabled = c.freegames_enable !== undefined ? on(c.freegames_enable) : true;
    add('🎮 Gratis-Spiele', `${fCh}${enabled ? '' : ' · aus'}${/inaktiv|inactive|alt\b/i.test(fCh.name) ? ' · ⚠️ Kanalname sagt „inaktiv“ – im Dashboard prüfen' : ''}`,
      () => { Object.assign(cfgOf().freegames, { enabled, channel: fCh.id }); });
  }

  // 🔊 Temp-Sprachkanäle
  const hub = chan(c.temp_voice_creator_channel_id);
  const guessedHubs = hub ? [hub] : guild.channels.cache.filter(ch => ch.type === ChannelType.GuildVoice && /erstell|create|join\s*to|➕|neuer\s*kanal/i.test(ch.name)).first(3);
  if (guessedHubs.length) {
    const cat = chan(c.temp_voice_category_id);
    const nameTemplate = c.temp_voice_prefix ? `${String(c.temp_voice_prefix).trim()} {name}` : null;
    add('🔊 Temp-Sprachkanäle', `Hub ${guessedHubs.map(h => `${h}`).join(', ')}${nameTemplate ? ` · Name „${nameTemplate}“` : ''} · Bedienfeld im Kanal-Chat`, () => {
      const tv = cfgOf().tempvoice;
      tv.enabled = true;
      tv.panelInChat = c.temp_voice_enable_panel !== undefined ? on(c.temp_voice_enable_panel) : true;
      for (const h of guessedHubs) {
        tv.hubs = tv.hubs.filter(x => x.id !== h.id);
        tv.hubs.push({ id: h.id, category: cat?.id || h.parentId || null, nameTemplate: nameTemplate || tv.nameTemplate, limit: 0 });
      }
    });
  }

  // 🎫 Tickets
  const tCat = chan(c.support_category_id);
  const tPanel = chan(c.support_channel_id) || chan(d.channels.ticketPanel);
  const tRole = role(c.support_team_role_id);
  if (tPanel) {
    add('🎫 Tickets', `Neuer Ticket-Button in ${tPanel}${tCat ? ` · Kategorie ${tCat.name}` : ''}${tRole ? ` · Team ${tRole}` : ''}`, async () => {
      const t = cfgOf().tickets;
      Object.assign(t, { enabled: true }, tCat ? { category: tCat.id } : {});
      if (tRole && !t.supportRoles.includes(tRole.id)) t.supportRoles.push(tRole.id);
      const tickets = require('./tickets');
      if (!t.category || !guild.channels.cache.has(t.category)) await tickets.setup(guild, { panelChannel: tPanel, supportRole: tRole });
      else await tPanel.send(tickets.panelMessage());
    });
  }
  if (c.support_archive_category_id || d.channels.archivePanel) skipped.push(['🗄️ Ticket-Archiv', 'kommt mit der Ticket-Archiv-Funktion (Trello-Karte)']);

  // 🎭 Rollen-Buttons (aus den Nachrichten)
  for (const rp of d.rolePanels) {
    const ch = chan(rp.channelId);
    if (!ch || !rp.roles.length) continue;
    add('🎭 Rollen-Buttons', `${ch} · ${rp.roles.map(r => `${r.role}`).join(' ')}`, async () => {
      const rolepanels = require('./rolepanels');
      const msg = await rolepanels.create(ch, { title: truncate(rp.title || 'Rollen', 200), description: rp.description || 'Tippe auf einen Knopf, um die Rolle zu bekommen oder abzugeben.', mode: 'buttons', unique: false });
      for (const r of rp.roles) await rolepanels.addRole(guild, msg.id, { role: r.role, label: r.label, style: 'grau' }).catch(() => {});
    });
  }
  for (const vp of d.verifyPanels) skipped.push(['✅ Regeln-Panel', `in <#${vp.channelId}> gefunden – im Dashboard (Willkommen → Regeln akzeptieren) Rolle wählen und „Regeln posten“`]);

  // 🧹 Filter
  const words = (x?.badwords || []).filter(w => w.word && !on(w.is_regex)).map(w => String(w.word).toLowerCase());
  if (words.length) add('🧹 Wortfilter', `${words.length} Wörter`, () => {
    const b = cfgOf().automod.badwords;
    b.words = [...new Set([...b.words, ...words])].slice(0, 300);
    b.enabled = true;
  });
  const terms = (x?.musicfilter || []).filter(t => t.begriff).map(t => (on(t.is_regex) ? `/${t.begriff}/` : String(t.begriff)));
  if (terms.length) add('🎵 Musik-Filter', `${terms.length} gesperrte Begriffe`, () => {
    const f = cfgOf().music.filter;
    f.terms = [...new Set([...f.terms, ...terms])].slice(0, 300);
    f.enabled = true;
  });

  // 🚨 Notfall-Alarm
  if (c.emergency_webhook_url) {
    const mentions = [c.emergency_owner_id, c.emergency_backup_user_id].filter(id => /^\d{17,20}$/.test(String(id || '')));
    add('🚨 Notfall-Alarm', `Webhook übernommen${mentions.length ? ` · pingt ${mentions.map(id => `<@${id}>`).join(' ')}` : ''}`, () => {
      const { WEBHOOK_RE } = require('./alert');
      if (!WEBHOOK_RE.test(c.emergency_webhook_url)) throw new Error('Webhook-Adresse ungültig');
      Object.assign(cfgOf().alert, { enabled: true, webhook: c.emergency_webhook_url, mentions }, c.emergency_message ? { message: `🚨 ${String(c.emergency_message).slice(0, 480)}` } : {});
    });
  }

  // 💾 Backups, 🤖 AutoMod
  if (c.backup_retention_count) add('💾 Backups', `täglich, ${c.backup_retention_count} behalten`, () => Object.assign(cfgOf().backups, { enabled: c.backup_enabled !== undefined ? on(c.backup_enabled) : true, keep: Math.min(30, Math.max(1, num(c.backup_retention_count, 7))) }));
  if (c.enable_automod !== undefined) add('🤖 AutoMod', on(c.enable_automod) ? 'an' : 'aus', () => { cfgOf().automod.enabled = on(c.enable_automod); });
  if (c.enable_antispam === '0' || c.enable_antiraid === '0') skipped.push(['🛡️ Spam-/Raid-Schutz', 'war im alten Bot aus – bleibt im neuen an (empfohlen), im Dashboard abschaltbar']);
  if (on(c.enable_fun) || c.bot_prefix) skipped.push(['🎉 Fun- & Prefix-Befehle', 'kommen noch (Trello-Karte)']);
  if (c.temp_voice_roles_whitelist || c.voice_blacklist_roles) skipped.push(['🔊 Temp-Voice-Rollenlisten', 'gibt es im neuen Bot noch nicht']);

  // 🧽 alte Panels (nur bei „aufräumen“)
  const oldPanels = d.panels.filter(p => p.kind !== 'verifyPanel');
  if (c.support_channel_id && c.support_message_id && !oldPanels.some(p => p.messageId === String(c.support_message_id))) oldPanels.push({ kind: 'ticketPanel', channelId: String(c.support_channel_id), messageId: String(c.support_message_id) });
  if (c.support_archive_panel_channel_id && c.support_archive_panel_message_id) oldPanels.push({ kind: 'archivePanel', channelId: String(c.support_archive_panel_channel_id), messageId: String(c.support_archive_panel_message_id) });

  return { items, skipped, oldPanels, oldBot: d.botTag || (d.botId ? `<@${d.botId}>` : null), source: x ? 'Discord + altes Dashboard' : 'Discord-Nachrichten', scanned: d.scanned };
}

// ---------------- Vorschau / Ausführen ----------------
function previewPayload(plan, token) {
  const lines = plan.items.map(it => `**${it.area}** – ${it.text}`);
  const desc = [
    `Alter Bot: **${plan.oldBot || 'nicht erkannt'}** · Quelle: ${plan.source} · ${plan.scanned} Kanäle gelesen`,
    '',
    lines.length ? lines.join('\n') : '*Nichts zum Übernehmen gefunden.*',
  ].join('\n');
  const e = new EmbedBuilder().setColor(COLORS.brand).setTitle(`🔄 Übernahme vom alten Bot (${plan.items.length})`).setDescription(truncate(desc, 4000));
  if (plan.skipped.length) e.addFields({ name: 'Nicht übernommen', value: truncate(plan.skipped.map(([a, why]) => `${a}: ${why}`).join('\n'), 1024) });
  e.setFooter({ text: `Vorher wird automatisch ein Backup erstellt. ${plan.oldPanels.length} alte Panels gefunden.` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nb:go:${token}`).setLabel('Übernehmen').setEmoji('✅').setStyle(ButtonStyle.Danger).setDisabled(!plan.items.length),
    new ButtonBuilder().setCustomId(`nb:clean:${token}`).setLabel('Übernehmen + alte Panels löschen').setEmoji('🧹').setStyle(ButtonStyle.Secondary).setDisabled(!plan.items.length),
    new ButtonBuilder().setCustomId(`nb:cancel:${token}`).setLabel('Abbrechen').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row] };
}

async function apply(guild, plan, { clean = false, by = null } = {}) {
  backups.create(guild.id, 'vor /nb');
  const done = [], failed = [];
  for (const it of plan.items) {
    try {
      const r = await it.fn();
      done.push(`${it.area} – ${typeof r === 'string' ? r : it.text}`);
    } catch (e) {
      failed.push(`${it.area} – ${e.message}`);
    }
    saveConfig(guild.id);
  }
  let removed = 0;
  if (clean) {
    for (const p of plan.oldPanels) {
      const ch = guild.channels.cache.get(p.channelId);
      if (await ch?.messages.delete(p.messageId).then(() => true).catch(() => false)) removed++;
    }
  }
  const report = { at: Date.now(), by, source: plan.source, oldBot: plan.oldBot, done, failed, skipped: plan.skipped.map(([a, why]) => `${a}: ${why}`), removed };
  store.set('migrations', guild.id, report);
  return report;
}

function reportPayload(r) {
  const e = new EmbedBuilder().setColor(r.failed.length ? COLORS.warn : COLORS.ok).setTitle('✅ Übernahme abgeschlossen')
    .setDescription(truncate(r.done.map(x => `• ${x}`).join('\n') || 'Nichts übernommen.', 4000));
  if (r.failed.length) e.addFields({ name: '⚠️ Hat nicht geklappt', value: truncate(r.failed.join('\n'), 1024) });
  if (r.removed) e.addFields({ name: '🧹 Aufgeräumt', value: `${r.removed} alte Panels gelöscht` });
  e.addFields({ name: '👉 Jetzt noch', value: 'Den alten Bot vom Server entfernen (oder abschalten) – sonst begrüßt, zählt und postet alles doppelt.' });
  e.setFooter({ text: 'Rückgängig: Dashboard → System → Backups → Sicherung „vor /nb“ zurückspielen' });
  return { embeds: [e], components: [] };
}

async function start(interaction, { oldBot = null, dashboard = null, password = null } = {}) {
  const guild = interaction.guild;
  if (guild.client.limitedIntents?.some(x => x.name === 'MESSAGE CONTENT INTENT')) {
    await interaction.editReply({ content: '⚠️ Ohne **MESSAGE CONTENT INTENT** kann ich die Nachrichten des alten Bots nicht lesen. Ich nutze nur das alte Dashboard (falls angegeben).' }).catch(() => {});
  }
  const d = await scanDiscord(guild, { oldBotId: oldBot?.id || null });
  let x = null, dashErr = null;
  const url = dashboard || process.env.OLD_DASHBOARD_URL, pw = password || process.env.OLD_DASHBOARD_PASSWORD;
  if (url && pw) {
    try { x = await fetchOldDashboard(url, pw, guild.id); } catch (e) { dashErr = e.message; }
  }
  const plan = buildPlan(guild, d, x);
  if (dashErr) plan.skipped.unshift(['🌐 Altes Dashboard', dashErr]);
  else if (!x) plan.skipped.unshift(['🌐 Altes Dashboard', 'nicht angegeben – mit `dashboard:` und `passwort:` gibt es genaue Einstellungen und alle XP']);
  const token = crypto.randomBytes(6).toString('hex');
  for (const [k, v] of plans) if (Date.now() - v.at > PLAN_TTL) plans.delete(k);
  plans.set(token, { guildId: guild.id, userId: interaction.user.id, plan, at: Date.now() });
  return previewPayload(plan, token);
}

async function handleButton(i, action, token) {
  const entry = plans.get(token);
  if (!entry || entry.guildId !== i.guild.id) return i.update({ content: '⌛ Diese Vorschau ist abgelaufen. Bitte `/nb` neu starten.', embeds: [], components: [] });
  if (i.user.id !== entry.userId) return i.reply({ content: 'Das ist nicht deine Übernahme.', flags: 64 });
  if (action === 'cancel') { plans.delete(token); return i.update({ content: 'Abgebrochen – nichts geändert.', embeds: [], components: [] }); }
  plans.delete(token);
  await i.update({ content: '⏳ Übernehme … (Fotos hochladen kann einen Moment dauern)', components: [] });
  const report = await apply(i.guild, entry.plan, { clean: action === 'clean', by: i.user.id });
  return i.editReply({ content: '', ...reportPayload(report) });
}

module.exports = { isBotOwner, classify, scheduleFrom, scanDiscord, fetchOldDashboard, buildPlan, apply, start, handleButton, previewPayload };
