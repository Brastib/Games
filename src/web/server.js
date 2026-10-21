'use strict';
/**
 * Web-Dashboard + Statusseite.
 * Zwei Login-Arten (eine reicht):
 *  - Passwort: DASHBOARD_PASSWORD beim Hoster eintragen. Wer es kennt, darf alle Server des Bots einstellen.
 *    Nach 5 Fehlversuchen ist die IP 15 Minuten gesperrt, nach 20 Fehlversuchen insgesamt der Passwort-Login für alle.
 *  - Discord (OAuth2): DISCORD_CLIENT_SECRET und DASHBOARD_URL (z. B. https://dein-bot.onrender.com).
 *    Im Developer Portal unter OAuth2 → Redirects muss  <DASHBOARD_URL>/callback  eingetragen sein.
 *    Dann darf jeder die Server einstellen, auf denen er "Server verwalten" hat.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { PermissionFlagsBits: P, ChannelType } = require('discord.js');
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');
const { applyChanges } = require('./schema');
const lf = require('../lib/linkFilter');

const API = 'https://discord.com/api/v10';
const SESSION_DAYS = 7;

function baseUrl() {
  const port = process.env.PORT || 3000;
  return (process.env.DASHBOARD_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
}
const oauthReady = () => !!process.env.DISCORD_CLIENT_SECRET;
const passwordReady = () => !!process.env.DASHBOARD_PASSWORD;
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest();
// Fingerabdruck des Passworts: Ändert es sich beim Hoster, sind alte Passwort-Sitzungen ungültig
const passwordTag = () => sha256('etc-dashboard:' + process.env.DASHBOARD_PASSWORD).toString('hex').slice(0, 16);

// ---------- Sperre gegen Durchprobieren ----------
const LIMIT = { perIp: 5, ipMinutes: 15, global: 20, globalMinutes: 15 };
const failsByIp = new Map(); // ip -> { n, until }
let globalFails = [];
function lockedFor(ip, now = Date.now()) {
  globalFails = globalFails.filter(t => now - t < LIMIT.globalMinutes * 60_000);
  const a = failsByIp.get(ip);
  if (a?.until > now) return a.until - now;
  if (globalFails.length >= LIMIT.global) return globalFails[0] + LIMIT.globalMinutes * 60_000 - now;
  return 0;
}
function registerFail(ip, now = Date.now()) {
  if (failsByIp.size > 5000) for (const [k, v] of failsByIp) if (!(v.until > now)) failsByIp.delete(k);
  const a = failsByIp.get(ip) || { n: 0, until: 0 };
  a.n++;
  if (a.n >= LIMIT.perIp) { a.until = now + LIMIT.ipMinutes * 60_000; a.n = 0; }
  failsByIp.set(ip, a);
  globalFails.push(now);
  return a.until > now ? 0 : LIMIT.perIp - a.n;
}
function checkPassword(given) {
  return typeof given === 'string' && given.length <= 200 && crypto.timingSafeEqual(sha256(given), sha256(process.env.DASHBOARD_PASSWORD));
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const secure = baseUrl().startsWith('https://') ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
function session(req) {
  const sid = cookies(req).sid;
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const s = store.get('sessions', sid);
  if (!s || s.exp < Date.now() || (s.password && (!passwordReady() || s.pw !== passwordTag()))) { if (s) store.delete('sessions', sid); return null; }
  return { sid, ...s };
}

function start(client) {
  const app = express();
  app.disable('x-powered-by');
  // Hinter dem Proxy des Hosters (Render & Co.) steht die echte IP in X-Forwarded-For – wichtig für die Login-Sperre
  if (process.env.RENDER || process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(express.json({ limit: '300kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  // ---------- Status ----------
  const startedAt = Date.now();
  const status = () => ({
    status: client.isReady() ? 'online' : 'startet', bot: client.user?.tag || null, server: client.guilds.cache.size,
    ping: Math.round(client.ws.ping), online_seit_sekunden: Math.round((Date.now() - startedAt) / 1000),
    speicher: store.kind, betrugs_domains: lf.phishingCount(), dashboard: oauthReady() || passwordReady(),
    fehlende_intents: client.limitedIntents?.map(x => x.name) || [],
    dashboard_adresse: require('../modules/tunnel').url(),
    version: require('../lib/version'),
    datensicherung: (d => (d ? { tag: d.day, kb: Math.round(d.size / 1024) } : null))(store.get('meta', 'lastDataBackup')),
    laptop: (({ temp, level, battery, load, memUsed }) => ({ temperatur: temp, zustand: level, akku: battery, last: load, ram_prozent: memUsed }))(require('../modules/health').status()),
  });
  app.get('/health', (req, res) => res.json(status()));

  // ---------- Login ----------
  app.get('/auth/methods', (req, res) => res.json({ discord: oauthReady(), password: passwordReady() }));

  app.post('/login/password', async (req, res) => {
    if (req.get('x-requested-with') !== 'dashboard') return res.status(403).json({ error: 'Ungültige Anfrage' });
    if (!passwordReady()) return res.status(503).json({ error: 'Passwort-Login ist nicht eingerichtet (DASHBOARD_PASSWORD fehlt).' });
    const ip = req.ip || 'unbekannt';
    const wait = lockedFor(ip);
    if (wait > 0) return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte in ${Math.ceil(wait / 60_000)} Min. erneut versuchen.` });
    if (!checkPassword(req.body?.password)) {
      const left = registerFail(ip);
      console.warn(`[dashboard] Falsches Passwort von ${ip}${left ? '' : ' – IP gesperrt'}`);
      await new Promise(r => setTimeout(r, 600));
      return res.status(401).json({ error: left ? `Falsches Passwort. Noch ${left} Versuch${left === 1 ? '' : 'e'}.` : `Falsches Passwort. Gesperrt für ${LIMIT.ipMinutes} Min.` });
    }
    failsByIp.delete(ip);
    const sid = crypto.randomBytes(32).toString('hex');
    store.set('sessions', sid, { password: true, pw: passwordTag(), userId: null, username: 'Admin', avatar: null, guilds: [], exp: Date.now() + SESSION_DAYS * 86_400_000 });
    setCookie(res, 'sid', sid, SESSION_DAYS * 86400);
    res.json({ ok: true });
  });

  app.get('/login', (req, res) => {
    if (!oauthReady()) return res.status(503).send('Dashboard ist noch nicht eingerichtet: DISCORD_CLIENT_SECRET fehlt (siehe README).');
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'oauth_state', state, 600);
    const params = new URLSearchParams({
      client_id: client.application?.id || client.user?.id || '', response_type: 'code', scope: 'identify guilds',
      redirect_uri: `${baseUrl()}/callback`, state, prompt: 'none',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== cookies(req).oauth_state) return res.redirect('/?fehler=login');
    try {
      const tokenRes = await fetch(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.application.id, client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code', code: String(code), redirect_uri: `${baseUrl()}/callback`,
        }),
      });
      const token = await tokenRes.json();
      if (!token.access_token) throw new Error(token.error_description || 'Kein Token');
      const auth = { authorization: `Bearer ${token.access_token}` };
      const [user, guilds] = await Promise.all([
        fetch(`${API}/users/@me`, { headers: auth }).then(r => r.json()),
        fetch(`${API}/users/@me/guilds`, { headers: auth }).then(r => r.json()),
      ]);
      const manageable = (Array.isArray(guilds) ? guilds : []).filter(g => g.owner || (BigInt(g.permissions) & (P.ManageGuild | P.Administrator)))
        .map(g => ({ id: g.id, name: g.name, icon: g.icon }));
      const sid = crypto.randomBytes(32).toString('hex');
      store.set('sessions', sid, {
        userId: user.id, username: user.global_name || user.username, avatar: user.avatar, guilds: manageable,
        exp: Date.now() + SESSION_DAYS * 86_400_000,
      });
      setCookie(res, 'sid', sid, SESSION_DAYS * 86400);
      setCookie(res, 'oauth_state', '', 0);
      res.redirect('/');
    } catch (e) {
      console.error('[dashboard] Login fehlgeschlagen:', e.message);
      res.redirect('/?fehler=login');
    }
  });

  app.get('/logout', (req, res) => {
    const s = session(req);
    if (s) store.delete('sessions', s.sid);
    setCookie(res, 'sid', '', 0);
    res.redirect('/');
  });

  // ---------- API ----------
  const api = express.Router();
  api.use((req, res, next) => {
    req.session = session(req);
    if (!req.session) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'dashboard') return res.status(403).json({ error: 'Ungültige Anfrage' });
    next();
  });

  async function access(req, res) {
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) { res.status(404).json({ error: 'Der Bot ist nicht auf diesem Server.' }); return null; }
    if (req.session.password) return { guild, member: null, isOwner: true };
    const member = await guild.members.fetch(req.session.userId).catch(() => null);
    const isOwner = guild.ownerId === req.session.userId;
    if (!member || !(isOwner || member.permissions.has(P.ManageGuild))) { res.status(403).json({ error: 'Du darfst diesen Server nicht verwalten.' }); return null; }
    return { guild, member, isOwner };
  }

  function publicConfig(cfg) {
    const c = JSON.parse(JSON.stringify(cfg));
    c.lockdown = { active: cfg.lockdown.active, since: cfg.lockdown.since, until: cfg.lockdown.until, reason: cfg.lockdown.reason };
    delete c.lockedChannels;
    return c;
  }

  function guildData(guild, isOwner) {
    const cfg = getConfig(guild.id);
    const channels = guild.channels.cache.filter(c => !c.isThread())
      .map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId, position: c.rawPosition }))
      .sort((a, b) => a.position - b.position);
    const roles = guild.roles.cache.filter(r => r.id !== guild.id)
      .map(r => ({ id: r.id, name: r.name, color: r.colors?.primaryColor ?? r.color, position: r.position, managed: r.managed, editable: r.editable }))
      .sort((a, b) => b.position - a.position);
    const leveling = require('../modules/leveling');
    const top = leveling.leaderboard(guild.id).slice(0, 5).map(e => ({ ...e, name: guild.members.cache.get(e.userId)?.displayName || e.userId, level: leveling.levelFromXp(e.xp, guild.id).level }));
    const music = require('../modules/music/player').get(guild);
    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }), memberCount: guild.memberCount, ownerId: guild.ownerId },
      isOwner, config: publicConfig(cfg), channels, roles,
      migration: store.get('migrations', guild.id) || null,
      system: (() => { const h = require('../modules/health'); return { ...h.status(), warn: h.WARN, crit: h.CRIT }; })(),
      events: require('../modules/events').list(guild.id).filter(e => !e.ended).map(e => ({ id: e.id, name: e.name, at: e.at, going: e.going.length, channelId: e.channelId })),
      warnings: (client.limitedIntents || []).map(x => `${x.name} ist im Developer Portal aus – ohne funktioniert nicht: ${x.loses}.`),
      stats: {
        tempvoice: store.values('tempvoice').filter(r => r.guildId === guild.id).length,
        tickets: store.values('tickets').filter(t => t.guildId === guild.id).length,
        phishing: lf.phishingCount(), cases: store.entries('cases').filter(([k]) => k.startsWith(guild.id + ':')).length,
        nowPlaying: music?.current ? { title: music.current.title, queue: music.queue.length } : null,
        top,
      },
    };
  }

  api.get('/me', (req, res) => {
    const s = req.session;
    const appId = client.application?.id || client.user?.id;
    // Passwort-Sitzung: alle Server, auf denen der Bot ist
    const guilds = s.password ? client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.icon })) : s.guilds;
    res.json({
      user: { id: s.userId, name: s.username, avatar: s.avatar ? `https://cdn.discordapp.com/avatars/${s.userId}/${s.avatar}.png?size=64` : null, password: !!s.password },
      invite: `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=8&scope=bot%20applications.commands`,
      guilds: guilds.map(g => ({
        ...g, iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96` : null,
        botPresent: client.guilds.cache.has(g.id),
        invite: `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=8&scope=bot%20applications.commands&guild_id=${g.id}&disable_guild_select=true`,
      })),
    });
  });

  api.get('/guild/:id', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    res.json(guildData(a.guild, a.isOwner));
  });

  api.patch('/guild/:id/config', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    const cfg = getConfig(a.guild.id);
    const { applied, errors } = applyChanges(cfg, req.body?.changes, a.guild, { isOwner: a.isOwner });
    if (applied.length) saveConfig(a.guild.id);
    res.status(Object.keys(errors).length && !applied.length ? 400 : 200).json({ applied, errors, config: publicConfig(cfg) });
  });

  api.post('/guild/:id/action', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    const { type, channelId, reason, minutes } = req.body || {};
    const g = a.guild;
    const user = req.session.password ? client.user : await client.users.fetch(req.session.userId);
    try {
      let message = 'Erledigt.';
      if (type === 'lockdownStart') {
        const r = await require('../modules/lockdown').start(g, { reason: reason ? String(reason).slice(0, 300) : null, by: user, minutes: Math.min(1440, Math.max(0, Number(minutes) || 0)) });
        message = r.already ? 'Lockdown läuft bereits.' : `Lockdown aktiv: ${r.locked} Kanäle gesperrt.`;
      } else if (type === 'lockdownEnd') {
        const r = await require('../modules/lockdown').end(g, { by: user });
        message = r.notActive ? 'Es lief kein Lockdown.' : `Lockdown beendet, ${r.restored} Rechte wiederhergestellt.`;
      } else if (type === 'createHub') {
        const r = await require('../modules/tempvoice').setup(g, { globalPanel: false });
        message = `Neuer Hub „${r.hub.name}“ erstellt.`;
      } else if (type === 'createLogs') {
        await createLogs(g);
        message = 'Log-Kanäle erstellt.';
      } else if (type === 'postRules') {
        const cfg = getConfig(g.id);
        const ch = g.channels.cache.get(cfg.verify.channel);
        if (!ch || !cfg.verify.role) throw new Error('Erst Regel-Kanal und Rolle auswählen.');
        const verify = require('../modules/verify');
        const old = cfg.verify.messageId && await ch.messages.fetch(cfg.verify.messageId).catch(() => null);
        if (old) await old.edit(verify.rulesMessage(cfg));
        else { const m = await ch.send(verify.rulesMessage(cfg)); cfg.verify.messageId = m.id; }
        cfg.verify.enabled = true;
        saveConfig(g.id);
        message = old ? 'Regeln aktualisiert.' : 'Regeln gepostet.';
      } else if (type === 'postTicketPanel') {
        const ch = g.channels.cache.get(String(channelId));
        if (!ch?.isTextBased()) throw new Error('Kanal auswählen.');
        const tickets = require('../modules/tickets');
        const cfg = getConfig(g.id);
        if (!cfg.tickets.category || !g.channels.cache.has(cfg.tickets.category)) await tickets.setup(g, { panelChannel: ch });
        else await ch.send(tickets.panelMessage());
        cfg.tickets.enabled = true; saveConfig(g.id);
        message = `Ticket-Button in #${ch.name} gepostet.`;
      } else if (type === 'postAnimal' || type === 'postLeaderboard' || type === 'postRecap') {
        const ch = await require('../modules/autoposts').runNow(g, { postAnimal: 'animal', postLeaderboard: 'leaderboard', postRecap: 'recap' }[type]);
        message = `Gepostet in #${ch.name}.`;
      } else if (type === 'countingStart') {
        const ch = await require('../modules/counting').start(g, { resetTo: Number(req.body.resetTo) || 0 });
        message = `Zählspiel läuft in #${ch.name}.`;
      } else if (type === 'freegamesNow') {
        const fg = require('../modules/freegames');
        const games = await fg.fetchGames();
        const r = await fg.runGuild(g, games);
        message = games.length ? `${r.posted} neu gepostet, ${r.removed} abgelaufene entfernt (${games.length} gerade gratis).` : 'Gerade gibt es keine Gratis-Spiele.';
      } else if (type === 'alertTest') {
        const n = await require('../modules/alert').send(client, '🧪 **Test-Alarm** aus dem Dashboard – der Notfall-Alarm funktioniert.', { onlyGuild: g.id });
        if (!n) throw new Error('Nicht gesendet: Alarm einschalten und eine gültige Webhook-Adresse eintragen.');
        message = 'Test-Alarm gesendet.';
      } else if (type === 'backupCreate') {
        const r = require('../modules/backups').create(g.id, 'manuell');
        message = `Gesichert (${Math.max(1, Math.round(r.size / 1024))} KB).`;
      } else if (type === 'backupRestore') {
        if (!a.isOwner) throw new Error('Nur der Server-Inhaber kann ein Backup zurückspielen.');
        const r = require('../modules/backups').restore(g.id, req.body.backupId);
        message = `Wiederhergestellt (${r.restored} Einträge). Der vorherige Stand wurde vorher gesichert.`;
      } else if (type === 'archiveSetup') {
        const r = await require('../modules/tickets').setupArchive(g);
        message = `Archiv bereit: ${r.category.name} · #${r.channel.name}.`;
      } else if (type === 'archivePurge') {
        message = `${await require('../modules/tickets').purgeArchive(g)} archivierte Tickets gelöscht.`;
      } else if (type === 'eventEnd') {
        await require('../modules/events').end(g, Number(req.body.eventId));
        message = 'Event beendet.';
      } else if (type === 'setupStats') {
        await require('../modules/extras').setupStats(g);
        message = 'Statistik-Kanäle erstellt.';
      } else {
        return res.status(400).json({ error: 'Unbekannte Aktion' });
      }
      res.json({ message, ...guildData(g, a.isOwner) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  require('./members').mount(api, { client, access });

  // ---------- Backups ----------
  api.get('/guild/:id/backups', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    res.json({ backups: require('../modules/backups').list(a.guild.id) });
  });
  api.get('/guild/:id/backups/:bid/download', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    const b = require('../modules/backups').get(a.guild.id, req.params.bid);
    if (!b) return res.status(404).json({ error: 'Sicherung nicht gefunden.' });
    const day = new Date(b.at).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.set('Content-Disposition', `attachment; filename="etc-bot-backup-${a.guild.id}-${day}.json"`);
    res.json(b);
  });

  app.use('/api', api);

  // ---------- Oberfläche ----------
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  // Alte Links wie /dashboard/?guildId=123 weiter nutzbar
  app.get(['/dashboard', '/dashboard/'], (req, res) => {
    const id = /^\d{15,22}$/.test(String(req.query.guildId || '')) ? `?guildId=${req.query.guildId}` : '';
    res.redirect('/' + id);
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

  const port = process.env.PORT || 3000;
  const logins = [passwordReady() && 'Passwort', oauthReady() && 'Discord'].filter(Boolean);
  app.listen(port, () => console.log(`[web] Dashboard & Statusseite auf Port ${port} (${baseUrl()}) – ${logins.length ? `Login: ${logins.join(' + ')}` : 'Login noch nicht eingerichtet (DASHBOARD_PASSWORD oder DISCORD_CLIENT_SECRET fehlt)'}`));
  return app;
}

async function createLogs(guild) {
  const cfg = getConfig(guild.id);
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles] },
  ];
  const cat = await guild.channels.create({ name: '📁 Server-Logs', type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
  for (const [key, name] of [['mod', '🔨・mod-log'], ['protection', '🛡️・schutz-log'], ['messages', '💬・nachrichten-log'], ['members', '👥・mitglieder-log'], ['server', '⚙️・server-log'], ['voice', '🔊・voice-log']]) {
    const ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: overwrites });
    cfg.logs[key] = ch.id;
  }
  cfg.logs.fallback = cfg.logs.mod;
  saveConfig(guild.id);
}

module.exports = { start };
