'use strict';
/**
 * Gratis-Spiele: kündigt kostenlose Spiele von Epic Games und Steam an und löscht die Nachricht wieder,
 * sobald das Angebot abgelaufen ist. Quelle: GamerPower (öffentliche, kostenlose API, kein Schlüssel nötig).
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { COLORS } = require('../lib/embeds');
const { truncate } = require('../lib/util');

const API = 'https://www.gamerpower.com/api/filter?platform=epic-games-store.steam&type=game';
const CHECK_EVERY = 3 * 3_600_000;
let lastCheck = Date.now() - CHECK_EVERY + 60_000; // erster Durchlauf eine Minute nach dem Start
let cache = { at: 0, list: [] };

/** "2026-11-02 23:59:00" (UTC) → Zeitstempel */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

function normalizeGame(g) {
  return {
    id: String(g.id),
    title: String(g.title || 'Unbekanntes Spiel').replace(/\s*\((Epic Games|Steam|Epic Games Store)\)\s*/gi, ' ').replace(/\s*Giveaway\s*$/i, '').trim(),
    worth: /\d/.test(g.worth || '') ? g.worth : null,
    endsAt: parseDate(g.end_date),
    platform: /epic/i.test(g.platforms) ? 'Epic Games' : /steam/i.test(g.platforms) ? 'Steam' : String(g.platforms || 'PC'),
    url: g.open_giveaway_url || g.gamerpower_url,
    image: g.image || g.thumbnail || null,
    description: truncate(String(g.description || ''), 300),
  };
}

async function fetchGames() {
  if (Date.now() - cache.at < 30 * 60_000) return cache.list;
  const res = await fetch(API, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'ETC-Bot (Discord)' } });
  if (!res.ok) throw new Error(`GamerPower antwortet mit ${res.status}`);
  const data = await res.json();
  // Ohne aktuelle Angebote kommt ein Objekt statt einer Liste
  cache = { at: Date.now(), list: Array.isArray(data) ? data.filter(g => g.status !== 'Expired').map(normalizeGame) : [] };
  return cache.list;
}

function payload(game, roleId) {
  const e = new EmbedBuilder().setColor(COLORS.brand)
    .setAuthor({ name: `🎮 Gratis auf ${game.platform}` })
    .setTitle(truncate(game.title, 250)).setURL(game.url)
    .setDescription(game.description || null)
    .addFields(
      { name: 'Preis', value: game.worth ? `~~${game.worth}~~ → **Gratis**` : '**Gratis**', inline: true },
      { name: 'Endet', value: game.endsAt ? `<t:${Math.floor(game.endsAt / 1000)}:R>` : 'unbekannt', inline: true },
    )
    .setImage(game.image).setFooter({ text: 'Gratis-Spiele · verschwindet automatisch, wenn das Angebot endet' });
  return {
    content: roleId ? `<@&${roleId}>` : null,
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(game.url).setLabel('Jetzt holen').setEmoji('🎁'))],
    allowedMentions: { roles: roleId ? [roleId] : [] },
  };
}

async function runGuild(guild, games, now = Date.now()) {
  const cfg = getConfig(guild.id).freegames;
  const ch = guild.channels.cache.get(cfg.channel);
  if (!ch?.isTextBased()) return { posted: 0, removed: 0 };
  let posted = 0, removed = 0;
  for (const game of games) {
    const k = `${guild.id}:${game.id}`;
    if (store.has('freegames', k) || (game.endsAt && game.endsAt < now)) continue;
    const msg = await ch.send(payload(game, cfg.role)).catch(() => null);
    if (!msg) continue;
    store.set('freegames', k, { guildId: guild.id, channelId: ch.id, messageId: msg.id, endsAt: game.endsAt, postedAt: now, title: game.title });
    posted++;
  }
  const active = new Set(games.map(g => g.id));
  for (const [k, v] of store.entries('freegames')) {
    if (!k.startsWith(guild.id + ':')) continue;
    if (now - v.postedAt > 60 * 86_400_000) { store.delete('freegames', k); continue; } // Merkzettel aufräumen
    if (v.gone) continue;
    const expired = (v.endsAt && v.endsAt < now) || (!active.has(k.split(':')[1]) && now - v.postedAt > 6 * 3_600_000);
    if (!expired) continue;
    if (cfg.deleteExpired) {
      const c = guild.channels.cache.get(v.channelId);
      await c?.messages.delete(v.messageId).catch(() => {});
    }
    store.set('freegames', k, { ...v, gone: true });
    removed++;
  }
  return { posted, removed };
}

/** Alle 3 Stunden aus dem Zeitplaner */
async function check(client, { force = false } = {}) {
  if (!force && Date.now() - lastCheck < CHECK_EVERY) return;
  lastCheck = Date.now();
  const guilds = client.guilds.cache.filter(g => { const c = getConfig(g.id).freegames; return c.enabled && c.channel; });
  if (!guilds.size) return;
  let games;
  try { games = await fetchGames(); } catch (e) { console.warn('[gratis-spiele]', e.message); return; }
  for (const g of guilds.values()) await runGuild(g, games).catch(e => console.error('[gratis-spiele]', e));
}

module.exports = { parseDate, normalizeGame, fetchGames, payload, runGuild, check };
