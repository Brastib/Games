'use strict';
/**
 * Prefix-Befehle wie beim alten Bot („Kanal-Manager“):
 *   !createvoice [Name]  → eigener Temp-Sprachkanal (man muss schon in einem Sprachkanal sein)
 *   !createtext [Name]   → eigener Text-Kanal für 24 Stunden
 * Zeichen und an/aus im Dashboard (Spiele & Spaß). Braucht den MESSAGE CONTENT INTENT.
 */
const { getConfig } = require('../lib/config');
const { truncate } = require('../lib/util');

const reply = (m, text) => m.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => {});

/** @returns {Promise<boolean>} true, wenn die Nachricht ein Prefix-Befehl war */
async function onMessage(message) {
  const cfg = getConfig(message.guild.id);
  const p = cfg.prefix;
  if (!p?.enabled || !p.char || !message.content.startsWith(p.char)) return false;
  const [cmd, ...rest] = message.content.slice(p.char.length).trim().split(/\s+/);
  const name = truncate(rest.join(' ').trim(), 90);
  switch ((cmd || '').toLowerCase()) {
    case 'createvoice': case 'cv': {
      const vc = message.member.voice.channel;
      if (!vc) { await reply(message, '🔊 Geh zuerst in einen Sprachkanal – dann verschiebe ich dich in deinen eigenen.'); return true; }
      const tempvoice = require('./tempvoice');
      const hub = cfg.tempvoice.hubs[0] || { id: vc.id, category: vc.parentId, nameTemplate: cfg.tempvoice.nameTemplate, limit: 0 };
      const ch = await tempvoice.createFor(message.member, name ? { ...hub, nameTemplate: name } : hub);
      await reply(message, ch ? `✅ Dein Sprachkanal: ${ch} – das Bedienfeld ist im Chat des Kanals.` : '❌ Ging gerade nicht (zu schnell hintereinander?).');
      return true;
    }
    case 'createtext': case 'ct': {
      const { channel } = await require('./temptext').create(message.guild, message.member, {
        name: name || `💬-${message.member.displayName}`, durationMs: 24 * 3_600_000, isPrivate: false,
        categoryId: message.channel.parentId,
      });
      await reply(message, `✅ Dein Text-Kanal: ${channel} – er verschwindet nach 24 Stunden (verlängern mit /tempchannel).`);
      return true;
    }
    case 'hilfe': case 'help':
      await reply(message, `**Prefix-Befehle:** \`${p.char}createvoice [Name]\` · \`${p.char}createtext [Name]\` – alles andere geht mit / (z. B. /help).`);
      return true;
    default:
      return false;
  }
}

module.exports = { onMessage };
