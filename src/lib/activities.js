'use strict';
/**
 * Discord-Aktivitäten (Spiele/Apps direkt im Sprachkanal). Start über einen Einladungslink.
 * Die IDs sind die öffentlich bekannten Discord-Aktivitäten. Discord kann einzelne davon jederzeit ändern oder abschalten –
 * dann meldet der Bot das und man startet sie über 🚀 „Aktivitäten“ im Sprachkanal.
 */
const { InviteTargetType } = require('discord.js');

const ACTIVITIES = [
  { id: '880218394199220334', name: 'Watch Together (YouTube)', emoji: '📺' },
  { id: '902271654783242291', name: 'Sketch Heads (Malen & Raten)', emoji: '🎨' },
  { id: '1007373802981822582', name: 'Gartic Phone', emoji: '✏️' },
  { id: '879863686565621790', name: 'Letter League (Wörter)', emoji: '🔤' },
  { id: '832012774040141894', name: 'Chess in the Park (Schach)', emoji: '♟️' },
  { id: '832013003968348200', name: 'Checkers in the Park (Dame)', emoji: '⚫' },
  { id: '755827207812677713', name: 'Poker Night', emoji: '🃏' },
  { id: '832025144389533716', name: 'Blazing 8s (Kartenspiel)', emoji: '🔥' },
  { id: '945737671223947305', name: 'Putt Party (Minigolf)', emoji: '⛳' },
  { id: '903769130790969345', name: 'Land-io', emoji: '🗺️' },
  { id: '947957217959759964', name: 'Bobble League (Fußball)', emoji: '⚽' },
  { id: '950505761862189096', name: 'Know What I Meme', emoji: '😂' },
  { id: '976052223358406656', name: 'Ask Away (Fragen)', emoji: '❓' },
];

/** Erstellt einen Startlink für eine Aktivität im Sprachkanal */
async function inviteFor(voiceChannel, activityId) {
  const inv = await voiceChannel.createInvite({ targetType: InviteTargetType.EmbeddedApplication, targetApplication: activityId, maxAge: 86400, maxUses: 0 });
  return `https://discord.gg/${inv.code}`;
}

module.exports = { ACTIVITIES, inviteFor };
