'use strict';
/**
 * Eigene Emojis des Bots (Application Emojis): gelten auf jedem Server, ohne Emoji-Plätze des Servers zu belegen.
 * Für die Glas-Icons auf den Knöpfen. Gibt es ein Emoji mit dem Namen schon, wird es wiederverwendet.
 * Ändert sich das Design, ändert sich der Namens-Präfix (Banner-Version) – dann entstehen neue.
 */
const cache = new Map(); // name -> { id, name }
let loaded = null;

async function load(client) {
  if (!loaded) {
    loaded = client.application.emojis.fetch()
      .then(list => { for (const e of list.values()) cache.set(e.name, { id: e.id, name: e.name }); })
      .catch(e => { loaded = null; throw e; });
  }
  return loaded;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} name  nur a-z, 0-9, _ (2–32 Zeichen)
 * @param {() => Promise<Buffer|null>} build  zeichnet das Bild, falls es das Emoji noch nicht gibt
 * @returns {Promise<{id: string, name: string}|null>}
 */
async function ensure(client, name, build) {
  if (!client?.application?.emojis) return null;
  try {
    await load(client);
    if (cache.has(name)) return cache.get(name);
    const png = await build();
    if (!png) return null;
    const e = await client.application.emojis.create({ attachment: png, name });
    const v = { id: e.id, name: e.name };
    cache.set(name, v);
    return v;
  } catch (e) {
    console.warn(`[emojis] ${name}: ${e.message}`);
    return null;
  }
}

/** Glas-Knopf-Icon als Emoji: glyph (gamepad, ticket, shield, help, star) oder Kürzel */
function knob(client, { glyph, text }) {
  const cards = require('./cards');
  const key = (glyph || String(text).toLowerCase()).replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'x';
  return ensure(client, `etc${cards.BANNER_VERSION}_${glyph ? 'g' : 't'}_${key}`, () => cards.knobIcon({ glyph, text }));
}

module.exports = { ensure, knob, _cache: cache };
