'use strict';
/**
 * Merkt sich, wer gerade auf PS4/PS5 spielt (für eigene Voice-XP).
 * discord.js gibt die Plattform einer Aktivität nicht weiter – deshalb direkt aus den Gateway-Rohdaten.
 * Kommt nur an, wenn der PRESENCE INTENT im Developer Portal an ist.
 */
const PS = new Set(['ps4', 'ps5']);
const playing = new Set();

function update(presence) {
  const id = presence?.user?.id;
  if (!id) return;
  if ((presence.activities || []).some(a => PS.has(a.platform))) playing.add(id);
  else playing.delete(id);
}

function onRaw(packet) {
  if (packet.t === 'PRESENCE_UPDATE') update(packet.d);
  else if (packet.t === 'GUILD_CREATE') for (const p of packet.d?.presences || []) update(p);
}

module.exports = { onRaw, onPlayStation: id => playing.has(id) };
