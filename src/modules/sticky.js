'use strict';
/**
 * Dauerhafte Mitglieder-Rolle (auf ETC. „ETC. Mitglied“).
 * Wer die Rolle einmal hat, kommt in eine Liste im Bot-Speicher auf dem Laptop (Sammlung „stammmitglieder“).
 * Wer auf der Liste steht, verliert die Rolle nicht mehr: Nimmt sie jemand weg, gibt der Bot sie sofort zurück –
 * auch nach Verlassen und Wiederkommen und wenn sie weggenommen wurde, während der Bot aus war.
 * Wirklich austragen geht nur mit /mitglied entfernen.
 */
const store = require('../lib/store');
const { getConfig, saveConfig } = require('../lib/config');

const COL = 'stammmitglieder';
const key = (guildId, userId) => `${guildId}:${userId}`;

/** Die Rolle: eingestellt, sonst die eine Rolle mit „Mitglied“ im Namen */
function roleOf(guild) {
  const cfg = getConfig(guild.id).memberRole;
  if (!cfg?.enabled) return null;
  if (cfg.role) return guild.roles.cache.get(cfg.role) || null;
  const hits = [...guild.roles.cache.values()].filter(r => !r.managed && /mitglied/i.test(r.name.normalize('NFKC')));
  if (hits.length !== 1) return null;
  // Gefundene Rolle fest merken – sonst würde eine später angelegte zweite „…Mitglied“-Rolle den Schutz still abschalten
  cfg.role = hits[0].id;
  saveConfig(guild.id);
  return hits[0];
}

const isListed = (guildId, userId) => store.has(COL, key(guildId, userId));

// Schutz gegen Endlosschleifen (z. B. ein anderer Bot nimmt die Rolle immer wieder weg): höchstens 3× in 10 Minuten
const readds = new Map();
function mayReadd(guildId, userId) {
  const k = key(guildId, userId), now = Date.now();
  const recent = (readds.get(k) || []).filter(t => now - t < 10 * 60_000);
  if (recent.length >= 3) return false;
  recent.push(now);
  readds.set(k, recent);
  return true;
}

function list(guildId) {
  return store.entries(COL).filter(([k]) => k.startsWith(`${guildId}:`)).map(([k, v]) => ({ userId: k.split(':')[1], ...v }));
}

function remember(member) {
  if (!isListed(member.guild.id, member.id)) store.set(COL, key(member.guild.id, member.id), { since: Date.now(), name: member.user.username });
}

function forget(guildId, userId) {
  store.delete(COL, key(guildId, userId));
}

/** Bei Rollen-Änderung und Beitritt: Rolle da → merken; Rolle weg, aber gelistet → zurückgeben */
async function check(member) {
  const role = roleOf(member.guild);
  if (!role || member.user.bot) return;
  if (member.roles.cache.has(role.id)) return remember(member);
  if (!isListed(member.guild.id, member.id) || !role.editable) return;
  if (!mayReadd(member.guild.id, member.id)) return console.warn(`[mitglied] ${member.user.tag}: Rolle wird ständig weggenommen – gebe sie vorerst nicht mehr zurück.`);
  await member.roles.add(role, 'Mitglieder-Rolle ist dauerhaft (/mitglied entfernen zum Austragen)')
    .catch(e => console.warn(`[mitglied] ${member.user.tag}: ${e.message}`));
  // Hat die Regeln schon einmal akzeptiert → „nicht verifiziert“-Rolle (z. B. nach Wiederkommen) wieder weg
  const unverified = getConfig(member.guild.id).verify?.unverifiedRole;
  if (unverified && member.roles.cache.has(unverified)) await member.roles.remove(unverified, 'Stamm-Mitglied').catch(() => {});
}

/** Nach dem Start: alle mit der Rolle eintragen, Weggenommenes zurückgeben */
async function sync(guild) {
  const role = roleOf(guild);
  if (!role) return { added: 0, restored: 0 };
  let added = 0, restored = 0;
  for (const m of guild.members.cache.values()) {
    if (m.user.bot) continue;
    if (m.roles.cache.has(role.id)) {
      if (!isListed(guild.id, m.id)) { remember(m); added++; }
    } else if (isListed(guild.id, m.id) && role.editable) {
      await m.roles.add(role, 'Mitglieder-Rolle ist dauerhaft').then(() => restored++).catch(() => {});
    }
  }
  if (added || restored) console.log(`[mitglied] ${guild.name}: ${added} neu eingetragen, ${restored} Rollen zurückgegeben (${list(guild.id).length} auf der Liste).`);
  return { added, restored };
}

module.exports = { roleOf, isListed, list, remember, forget, check, sync };
