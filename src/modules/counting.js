'use strict';
/**
 * Zählspiel: Im Zähl-Kanal wird nacheinander hochgezählt. Niemand darf zweimal hintereinander zählen.
 * Richtig → ✅ (💯 bei Hundertern, 🏆 bei neuem Rekord). Falsch → ❌ + Meldung, auf Wunsch zurück auf 0.
 */
const { getConfig, saveConfig } = require('../lib/config');
const { fillTemplate } = require('../lib/util');

/** Liest die Zahl am Anfang der Nachricht („42“, „42 juhu“). Gibt null zurück, wenn keine Zahl dasteht. */
function parseNumber(content) {
  const m = /^\s*(\d{1,12})(?!\d)/.exec(content || '');
  return m ? Number(m[1]) : null;
}

/** Prüft einen Zählversuch – ohne Discord, damit es testbar ist. */
function judge(cfg, userId, n) {
  const expected = (cfg.current || 0) + 1;
  if (n !== expected) return { ok: false, expected, why: 'falsche Zahl' };
  if (cfg.lastUser === userId) return { ok: false, expected, why: 'zweimal hintereinander' };
  return { ok: true, expected };
}

/** @returns {Promise<boolean>} true, wenn die Nachricht ins Zählspiel gehörte */
async function onMessage(message) {
  const cfg = getConfig(message.guild.id).counting;
  if (!cfg.enabled || message.channel.id !== cfg.channel) return false;
  const n = parseNumber(message.content);
  if (n == null) return true; // normale Unterhaltung im Kanal stört nicht
  const r = judge(cfg, message.author.id, n);
  if (r.ok) {
    cfg.current = n;
    cfg.lastUser = message.author.id;
    const record = n > (cfg.record || 0);
    if (record) { cfg.record = n; cfg.recordBy = message.author.id; }
    saveConfig(message.guild.id);
    await message.react(n % 100 === 0 ? '💯' : record && n % 10 === 0 ? '🏆' : '✅').catch(() => {});
    return true;
  }
  await message.react('❌').catch(() => {});
  const text = fillTemplate(cfg.failMessage, {
    user: message.author, guild: message.guild, extra: { expected: r.expected, number: n, record: cfg.record || 0, reason: r.why },
  });
  if (cfg.resetOnFail) { cfg.current = 0; cfg.lastUser = null; }
  saveConfig(message.guild.id);
  await message.channel.send({ content: r.why === 'zweimal hintereinander' ? `${text}\n-# Grund: ${r.why}` : text, allowedMentions: { users: [message.author.id] } }).catch(() => {});
  return true;
}

/** Startet das Spiel im Kanal neu (Willkommensnachricht + nächste Zahl) */
async function start(guild, { resetTo = 0 } = {}) {
  const cfg = getConfig(guild.id).counting;
  const ch = guild.channels.cache.get(cfg.channel);
  if (!ch?.isTextBased()) throw new Error('Erst einen Zähl-Kanal wählen.');
  cfg.enabled = true;
  cfg.current = Math.max(0, Math.floor(resetTo));
  cfg.lastUser = null;
  saveConfig(guild.id);
  await ch.send(`${cfg.welcome}\nNächste Zahl: **${cfg.current + 1}**`);
  return ch;
}

module.exports = { parseNumber, judge, onMessage, start };
