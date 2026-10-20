'use strict';
/**
 * Dashboard: Mitgliederliste + Detailansicht + Aktionen (Rollen, Spitzname, XP, Timeout, Verwarnen, Kick, Bann).
 * Rechte wie in Discord: Wer per Discord angemeldet ist, darf nur Personen/Rollen unter seiner höchsten Rolle bearbeiten.
 * Passwort-Anmeldung zählt wie der Server-Inhaber.
 */
const { GatewayIntentBits, PermissionFlagsBits: P } = require('discord.js');
const leveling = require('../modules/leveling');
const economy = require('../modules/economy');
const moderation = require('../modules/moderation');
const { checkHierarchy } = require('../lib/perms');

const FETCH_EVERY = 5 * 60_000;
const lastFetch = new Map(); // guildId -> Zeitpunkt der letzten vollständigen Mitglieder-Abfrage

const hex = n => (n ? '#' + n.toString(16).padStart(6, '0') : null);
const KEY_PERMS = [
  [P.Administrator, 'Administrator'], [P.ManageGuild, 'Server verwalten'], [P.BanMembers, 'Bannen'], [P.KickMembers, 'Kicken'],
  [P.ModerateMembers, 'Timeout'], [P.ManageRoles, 'Rollen verwalten'], [P.ManageChannels, 'Kanäle verwalten'], [P.ManageMessages, 'Nachrichten verwalten'],
];

async function loadMembers(guild) {
  if (!guild.client.options.intents.has(GatewayIntentBits.GuildMembers)) return;
  if (guild.members.cache.size >= guild.memberCount && Date.now() - (lastFetch.get(guild.id) || 0) < FETCH_EVERY) return;
  if (Date.now() - (lastFetch.get(guild.id) || 0) < 15_000) return; // Discord nicht mit Abfragen fluten
  lastFetch.set(guild.id, Date.now());
  await guild.members.fetch().catch(() => {});
}

function summary(guild, m, ranks) {
  const d = leveling.getData(guild.id, m.id);
  const lv = leveling.levelFromXp(d.xp || 0, guild.id);
  const until = m.communicationDisabledUntilTimestamp;
  return {
    id: m.id, name: m.displayName, username: m.user.username, bot: m.user.bot,
    avatar: m.displayAvatarURL({ size: 128, extension: 'png' }),
    color: hex(m.displayColor), joinedAt: m.joinedTimestamp, createdAt: m.user.createdTimestamp,
    roles: m.roles.cache.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position).map(r => r.id),
    level: lv.level, xp: d.xp || 0, rank: ranks.get(m.id) || null,
    msgs: d.msgs || 0, voiceMin: d.voiceMin || 0, clips: d.clips || 0,
    coins: economy.get(guild.id, m.id).coins,
    warns: moderation.getWarns(guild.id, m.id, true).length,
    timeoutUntil: until && until > Date.now() ? until : null,
    owner: guild.ownerId === m.id, booster: !!m.premiumSinceTimestamp,
  };
}

function rankMap(guildId) {
  return new Map(leveling.leaderboard(guildId).filter(e => e.xp > 0).map((e, i) => [e.userId, i + 1]));
}

function detail(guild, m) {
  const s = summary(guild, m, rankMap(guild.id));
  const lv = leveling.levelFromXp(s.xp, guild.id);
  const eco = economy.get(guild.id, m.id);
  const q = require('../lib/store').get('quests', `${guild.id}:${m.id}`) || {};
  return {
    ...s, xpIn: lv.xpIn, xpNeed: lv.xpNeed, nextTotal: lv.nextTotal,
    dailyStreak: eco.dailyStreak || 0, questStreak: q.streak || 0, questsDone: q.total || 0,
    voiceChannel: m.voice?.channel?.name || null,
    perms: KEY_PERMS.filter(([bit]) => m.permissions.has(bit)).map(([, name]) => name),
    warnList: moderation.getWarns(guild.id, m.id).map(w => ({ id: w.id, reason: w.reason, at: w.at, active: moderation.getWarns(guild.id, m.id, true).some(a => a.id === w.id) })).reverse(),
    cases: moderation.getCases(guild.id, m.id).slice(0, 15).map(c => ({ id: c.id, type: c.type, reason: c.reason, modTag: c.modTag, at: c.at, duration: c.duration })),
  };
}

function mount(api, { client, access }) {
  api.get('/guild/:id/members', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    await loadMembers(a.guild);
    const ranks = rankMap(a.guild.id);
    const members = a.guild.members.cache.map(m => summary(a.guild, m, ranks));
    res.json({ members, total: a.guild.memberCount, complete: members.length >= a.guild.memberCount });
  });

  api.get('/guild/:id/members/:uid', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    const m = await a.guild.members.fetch(req.params.uid).catch(() => null);
    if (!m) return res.status(404).json({ error: 'Mitglied nicht gefunden.' });
    res.json(detail(a.guild, m));
  });

  api.post('/guild/:id/members/:uid/action', async (req, res) => {
    const a = await access(req, res); if (!a) return;
    const g = a.guild;
    const target = await g.members.fetch(req.params.uid).catch(() => null);
    if (!target) return res.status(404).json({ error: 'Mitglied nicht gefunden.' });
    // Passwort-Sitzung = Inhaber; sonst die echte Person mit ihren Rollen
    const actor = a.member || { id: g.ownerId };
    const isOwner = actor.id === g.ownerId;
    const moderator = a.member?.user || client.user;
    const b = req.body || {};
    const reason = `${String(b.reason || '').slice(0, 400) || 'Kein Grund angegeben'} (Dashboard${a.member ? '' : ', Passwort'})`;
    const guard = kind => { const e = checkHierarchy(actor, target, kind); if (e) throw new Error(e); };
    const actorAbove = role => isOwner || actor.roles.highest.comparePositionTo(role) > 0;
    try {
      let message;
      switch (b.type) {
        case 'roleAdd': case 'roleRemove': {
          const role = g.roles.cache.get(String(b.roleId));
          if (!role || role.id === g.id) throw new Error('Rolle nicht gefunden.');
          if (role.managed) throw new Error('Diese Rolle gehört zu einer App und kann nicht vergeben werden.');
          if (!role.editable) throw new Error('Meine Rolle steht zu niedrig für diese Rolle.');
          if (!actorAbove(role)) throw new Error('Diese Rolle steht über deiner höchsten Rolle.');
          if (b.type === 'roleAdd') await target.roles.add(role, reason); else await target.roles.remove(role, reason);
          message = b.type === 'roleAdd' ? `@${role.name} gegeben.` : `@${role.name} entfernt.`;
          break;
        }
        case 'nick': {
          if (target.id !== g.ownerId) guard('manage'); else throw new Error('Den Namen des Inhabers kann ich nicht ändern.');
          const nick = String(b.nick || '').trim().slice(0, 32) || null;
          await target.setNickname(nick, reason);
          message = nick ? `Spitzname: ${nick}` : 'Spitzname entfernt.';
          break;
        }
        case 'xp': case 'level': {
          const n = Number(b.value);
          if (!Number.isFinite(n) || n < 0 || n > (b.type === 'level' ? 1000 : 100_000_000)) throw new Error('Ungültige Zahl.');
          const xp = b.type === 'level' ? leveling.xpForLevel(Math.floor(n), g.id) : n;
          const lvl = await leveling.setXp(target, xp);
          message = `Jetzt Level ${lvl} (${Math.round(xp).toLocaleString('de-DE')} XP).`;
          break;
        }
        case 'coins': {
          const n = Math.trunc(Number(b.value));
          if (!Number.isFinite(n) || Math.abs(n) > 10_000_000) throw new Error('Ungültige Zahl.');
          message = `Kontostand: ${economy.add(g.id, target.id, n).toLocaleString('de-DE')}`;
          break;
        }
        case 'timeout': {
          guard('timeout');
          const minutes = Math.min(40320, Math.max(1, Math.round(Number(b.minutes) || 0)));
          await moderation.timeout(target, minutes * 60_000, moderator, reason);
          message = `Timeout für ${minutes >= 1440 ? `${Math.round(minutes / 1440)} Tag(e)` : minutes >= 60 ? `${Math.round(minutes / 60)} Std.` : `${minutes} Min.`}.`;
          break;
        }
        case 'untimeout':
          guard('timeout');
          await moderation.untimeout(target, moderator, reason);
          message = 'Timeout aufgehoben.';
          break;
        case 'warn': {
          guard('manage');
          const r = await moderation.warn(g, target, moderator, reason);
          message = `Verwarnt (Fall #${r.caseId}, ${r.count} aktiv).${r.escalated ? ` Automatisch: ${r.escalated}` : ''}`;
          break;
        }
        case 'unwarn':
          if (!moderation.removeWarn(g.id, target.id, Number(b.caseId))) throw new Error('Verwarnung nicht gefunden.');
          message = 'Verwarnung gelöscht.';
          break;
        case 'kick':
          guard('kick');
          await moderation.kick(target, moderator, reason);
          return res.json({ message: `${target.user.username} gekickt.`, gone: true });
        case 'ban':
          guard('ban');
          await moderation.ban(g, target.user, moderator, reason, { deleteSeconds: Math.min(7, Math.max(0, Number(b.deleteDays) || 0)) * 86400 });
          return res.json({ message: `${target.user.username} gebannt.`, gone: true });
        default:
          return res.status(400).json({ error: 'Unbekannte Aktion' });
      }
      const fresh = await g.members.fetch({ user: target.id, force: true }).catch(() => target);
      res.json({ message, member: detail(g, fresh) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { mount, summary, detail };
