'use strict';
/**
 * Startpunkt des Bots.
 * Benötigte Umgebungsvariablen: DISCORD_TOKEN (Pflicht), MONGODB_URI (für Hosting ohne feste Festplatte, z. B. Render).
 */
try { process.loadEnvFile(); } catch { /* keine .env-Datei – Variablen kommen vom Hoster */ }

const crypto = require('crypto');
const { Client, Events, GatewayIntentBits: I, IntentsBitField, Partials, ActivityType, Routes } = require('discord.js');
const store = require('./lib/store');
const lf = require('./lib/linkFilter');
const { onInteraction, commands } = require('./handlers/interactions');
const automod = require('./modules/automod');
const leveling = require('./modules/leveling');
const logs = require('./modules/logs');
const antiraid = require('./modules/antiraid');
const antinuke = require('./modules/antinuke');
const lockdown = require('./modules/lockdown');
const tempvoice = require('./modules/tempvoice');
const temptext = require('./modules/temptext');
const giveaways = require('./modules/giveaways');
const verify = require('./modules/verify');
const welcome = require('./modules/welcome');
const moderation = require('./modules/moderation');
const quests = require('./modules/quests');
const clips = require('./modules/clips');
const extras = require('./modules/extras');
const autoposts = require('./modules/autoposts');
const counting = require('./modules/counting');
const freegames = require('./modules/freegames');
const alert = require('./modules/alert');
const backups = require('./modules/backups');
const platforms = require('./lib/platforms');
const web = require('./web/server');

const client = new Client({
  intents: [I.Guilds, I.GuildMembers, I.GuildMessages, I.MessageContent, I.GuildVoiceStates, I.GuildModeration, I.GuildMessageReactions, I.GuildExpressions, I.GuildPresences],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User, Partials.Reaction],
  allowedMentions: { parse: ['users'], repliedUser: false },
});

const safe = (name, fn) => async (...args) => {
  try { await fn(...args); } catch (e) { console.error(`[${name}]`, e); }
};

// ---------- Privilegierte Intents prüfen ----------
// Sind sie im Developer Portal aus, lehnt Discord den Login ab (Code 4014) und der Bot startet beim Hoster endlos neu.
// Stattdessen läuft er ohne sie weiter und meldet laut, was dann nicht geht.
const PRIVILEGED = [
  { intent: I.GuildMembers, flags: (1 << 14) | (1 << 15), name: 'SERVER MEMBERS INTENT', loses: 'Willkommen, Verifizierung beim Beitritt, Anti-Raid, Beitritts-Logs, Mitglieder-Statistik' },
  { intent: I.MessageContent, flags: (1 << 18) | (1 << 19), name: 'MESSAGE CONTENT INTENT', loses: 'Linkschutz, AutoMod, Auto-Antworten, Zählspiel, Clip-XP (Anhänge)' },
  // freiwillig: nur für eigene PlayStation-Voice-XP
  { intent: I.GuildPresences, flags: (1 << 12) | (1 << 13), name: 'PRESENCE INTENT', loses: 'eigene Voice-XP für PlayStation', optional: true },
];
client.limitedIntents = [];
async function checkIntents() {
  client.rest.setToken(process.env.DISCORD_TOKEN);
  const app = await client.rest.get(Routes.currentApplication()).catch(() => null);
  if (!app) return; // Prüfung nicht möglich – normaler Login entscheidet
  const missing = PRIVILEGED.filter(p => !(app.flags & p.flags));
  if (!missing.length) return;
  client.options.intents = new IntentsBitField(client.options.intents.bitfield & ~missing.reduce((a, p) => a | p.intent, 0)).freeze();
  for (const p of missing.filter(x => x.optional)) console.log(`[bot] ${p.name} ist aus – ${p.loses} ist deshalb nicht aktiv (freiwillig).`);
  const required = missing.filter(p => !p.optional);
  client.limitedIntents = required.map(p => ({ name: p.name, loses: p.loses }));
  if (!required.length) return;
  console.warn([
    '',
    '⚠️  Eingeschränkter Modus: Im Developer Portal → „Bot“ → „Privileged Gateway Intents“ ist ausgeschaltet:',
    ...required.map(p => `   • ${p.name} – ohne funktioniert nicht: ${p.loses}`),
    '   Einschalten, speichern, Bot neu starten.',
    '',
  ].join('\n'));
}

// ---------- Befehle bei Discord anmelden (nur wenn sie sich geändert haben) ----------
async function registerCommands() {
  const body = commands.map(c => c.data.toJSON());
  const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  if (process.env.DEV_GUILD_ID) {
    const g = await client.guilds.fetch(process.env.DEV_GUILD_ID);
    await g.commands.set(body);
    console.log(`[befehle] ${body.length} Befehle auf Test-Server ${g.name} registriert.`);
    return;
  }
  if (store.get('meta', 'cmdhash') === hash && !process.env.FORCE_REGISTER) {
    console.log(`[befehle] ${body.length} Befehle unverändert.`);
    return;
  }
  await client.application.commands.set(body);
  store.set('meta', 'cmdhash', hash);
  console.log(`[befehle] ${body.length} Befehle global registriert.`);
}

// ---------- Name und Profilbild einmalig setzen (danach im Developer Portal frei änderbar) ----------
async function applyBranding(c) {
  if (store.get('meta', 'branding') === 1 || process.env.SKIP_BRANDING) return;
  // Namen nur ändern, wenn BOT_NAME ausdrücklich gesetzt ist – sonst bleibt der Name aus dem Developer Portal
  const name = process.env.BOT_NAME;
  if (name && c.user.username !== name) await c.user.setUsername(name);
  if (!c.user.avatar) await c.user.setAvatar(require('path').join(__dirname, '..', 'assets', 'icon', 'etc-bot-512.png'));
  store.set('meta', 'branding', 1);
  console.log('[bot] Profilbild/Name geprüft.');
}

// ---------- Zeitplaner: Zeit-Banns, Temp-Kanäle, Gewinnspiele, Lockdown-Ende ----------
let ticking = false;
async function tick() {
  if (ticking || !client.isReady()) return;
  ticking = true;
  try {
    await moderation.processTempBans(client);
    await temptext.processTimers(client);
    await giveaways.processTimers(client);
    await lockdown.processTimers(client);
    await antiraid.processTimers(client);
    await extras.processReminders(client);
    await tempvoice.processTimers(client);
    await autoposts.check(client);
    await freegames.check(client);
  } catch (e) {
    console.error('[zeitplaner]', e);
  } finally {
    ticking = false;
  }
}

// ---------- Ereignisse ----------
client.once(Events.ClientReady, safe('ready', async c => {
  console.log(`[bot] Eingeloggt als ${c.user.tag} auf ${c.guilds.cache.size} Server(n).`);
  c.user.setPresence({ activities: [{ name: 'ETC. Bot · /help', type: ActivityType.Watching }], status: 'online' });
  await applyBranding(c).catch(e => console.warn('[bot] Name/Profilbild:', e.message));
  await registerCommands().catch(e => console.error('[befehle] Registrierung fehlgeschlagen:', e.message));
  await tempvoice.cleanup(c).catch(() => {});
  lf.loadPhishingLists().catch(() => {});
  setInterval(() => lf.loadPhishingLists().catch(() => {}), 6 * 3_600_000).unref();
  setInterval(tick, 20_000).unref();
  tick();
  setInterval(() => leveling.voiceTick(c).catch(e => console.error('[voice-xp]', e)), 60_000).unref();
  setInterval(() => extras.updateStats(c).catch(() => {}), 10 * 60_000).unref();
  setInterval(() => { try { backups.daily(c); } catch (e) { console.error('[backup]', e); } }, 10 * 60_000).unref();
  setTimeout(() => { try { backups.daily(c); } catch (e) { console.error('[backup]', e); } }, 60_000).unref();
  await alert.onReady(c).catch(e => console.error('[alarm]', e));
  setInterval(() => clips.cleanup(), 12 * 3_600_000).unref();
  // Mitgliederlisten laden (für Statistik, Bestenlisten, Schutz)
  if (c.options.intents.has(I.GuildMembers)) for (const g of c.guilds.cache.values()) await g.members.fetch().catch(() => {});
  extras.updateStats(c).catch(() => {});
  const invite = `https://discord.com/oauth2/authorize?client_id=${c.user.id}&permissions=8&scope=bot%20applications.commands`;
  console.log(`[bot] Einladungslink: ${invite}`);
}));

client.on(Events.InteractionCreate, onInteraction);

client.on(Events.MessageCreate, safe('message', async m => {
  if (!m.guild || m.author.bot) return;
  if (await automod.handle(m)) return;
  await counting.onMessage(m);
  await leveling.onMessage(m);
  await clips.onMessage(m);
  await quests.progress(m.member, 'msgs', 1, m.channel);
  if (m.mentions?.repliedUser && m.mentions.repliedUser.id !== m.author.id && !m.mentions.repliedUser.bot) await quests.progress(m.member, 'reply', 1, m.channel);
  await extras.autoRespond(m);
}));
client.on(Events.MessageReactionAdd, safe('reactionAdd', async (reaction, user) => {
  if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
  if (reaction) await clips.onReactionAdd(reaction, user);
}));
client.on(Events.MessageReactionRemove, safe('reactionRemove', async (reaction, user) => {
  if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
  if (reaction) await clips.onReactionRemove(reaction, user);
}));
client.on(Events.MessageUpdate, safe('messageUpdate', async (oldM, newM) => {
  if (newM.partial) newM = await newM.fetch().catch(() => null);
  if (!newM) return;
  await logs.messageUpdate(oldM, newM);
  if (oldM.content !== newM.content) await automod.handle(newM, { edited: true });
}));
client.on(Events.MessageDelete, safe('messageDelete', logs.messageDelete));
client.on(Events.MessageBulkDelete, safe('bulkDelete', logs.messageBulkDelete));

client.on(Events.GuildMemberAdd, safe('memberAdd', async member => {
  await logs.memberAdd(member);
  if (await antiraid.onJoin(member)) return;
  await verify.onJoin(member);
  await welcome.onJoin(member);
}));
client.on(Events.GuildMemberRemove, safe('memberRemove', async member => {
  await logs.memberRemove(member);
  await welcome.onLeave(member);
}));
client.on(Events.GuildMemberUpdate, safe('memberUpdate', logs.memberUpdate));
client.on(Events.VoiceStateUpdate, safe('voice', async (o, n) => {
  await tempvoice.onVoiceUpdate(o, n);
  await logs.voiceUpdate(o, n);
}));
client.on(Events.ChannelDelete, safe('channelDelete', async ch => {
  antinuke.rememberChannel(ch);
  for (const col of ['tempvoice', 'temptext', 'tickets']) store.delete(col, ch.id);
}));
client.on(Events.GuildRoleDelete, safe('roleDelete', antinuke.rememberRole));
client.on(Events.GuildAuditLogEntryCreate, safe('audit', async (entry, guild) => {
  await antinuke.onAuditEntry(entry, guild);
  await logs.auditEntry(entry, guild);
}));
client.on(Events.GuildCreate, g => console.log(`[bot] Neuer Server: ${g.name} (${g.memberCount} Mitglieder)`));
client.on('raw', platforms.onRaw);
client.on(Events.ShardDisconnect, () => alert.onDisconnect());
client.on(Events.ShardReconnecting, () => alert.onDisconnect());
client.on(Events.ShardResume, () => alert.onConnected(client).catch(() => {}));
client.on(Events.ShardReady, () => alert.onConnected(client).catch(() => {}));
client.on(Events.Error, e => console.error('[discord]', e.message));
client.on(Events.Warn, w => console.warn('[discord]', w));
process.on('unhandledRejection', e => console.error('[unbehandelt]', e));
process.on('uncaughtException', async e => {
  console.error('[absturz]', e);
  await alert.onCrash(client, e);
  await store.flush().catch(() => {});
  process.exit(1);
});

// ---------- Web-Dashboard + Statusseite (hält den Bot beim Hoster außerdem wach) ----------
web.start(client);

// Selbst-Ping alle 10 Minuten (Render schläft sonst nach 15 Min. ohne Anfragen ein)
const keepAliveUrl = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
if (keepAliveUrl) {
  setInterval(() => fetch(keepAliveUrl.replace(/\/$/, '') + '/health').catch(() => {}), 10 * 60_000).unref();
  console.log(`[web] Wach-halten aktiv: ${keepAliveUrl}`);
}

// Wächter: Wenn die Verbindung zu Discord 10 Minuten lang weg ist, neu starten (der Hoster startet den Prozess neu)
let notReadySince = null;
setInterval(() => {
  if (client.isReady()) { notReadySince = null; return; }
  notReadySince ||= Date.now();
  if (Date.now() - notReadySince > 10 * 60_000) {
    console.error('[wächter] Seit 10 Minuten keine Verbindung zu Discord – Neustart.');
    process.exit(1);
  }
}, 60_000).unref();

async function shutdown(sig) {
  console.log(`[bot] ${sig} empfangen – speichere und beende …`);
  alert.onShutdown();
  await store.flush().catch(() => {});
  await client.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------- Start ----------
(async () => {
  if (!process.env.DISCORD_TOKEN) {
    console.error('\n❌ DISCORD_TOKEN fehlt. Trage den Bot-Token beim Hoster als Umgebungsvariable ein (siehe README).\n');
    process.exit(1);
  }
  try {
    await store.init();
  } catch (e) {
    console.error('\n❌ Datenbank-Verbindung fehlgeschlagen:', e.message, '\nPrüfe MONGODB_URI und ob in MongoDB Atlas unter „Network Access“ 0.0.0.0/0 erlaubt ist.\n');
    process.exit(1);
  }
  await checkIntents();
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (e) {
    if (/disallowed intents/i.test(e.message)) {
      console.error('\n❌ Discord blockiert den Bot: Im Developer Portal unter „Bot“ müssen „SERVER MEMBERS INTENT“ und „MESSAGE CONTENT INTENT“ eingeschaltet sein.\n');
    } else if (/token/i.test(e.message)) {
      console.error('\n❌ Der DISCORD_TOKEN ist ungültig. Im Developer Portal unter „Bot“ → „Reset Token“ einen neuen erzeugen.\n');
    } else {
      console.error('\n❌ Login fehlgeschlagen:', e.message);
    }
    process.exit(1);
  }
})();
