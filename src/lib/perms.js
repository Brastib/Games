'use strict';
const { PermissionFlagsBits: P } = require('discord.js');
const { getConfig } = require('./config');

/** Gilt als Teammitglied: Admin, Server verwalten, Mitglieder moderieren oder eingetragene Mod-Rolle. */
function isStaff(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  const p = member.permissions;
  if (p.has(P.Administrator) || p.has(P.ManageGuild) || p.has(P.ModerateMembers) || p.has(P.ManageMessages)) return true;
  const cfg = getConfig(member.guild.id);
  return cfg.modRoles.some(r => member.roles.cache.has(r));
}

function isAdmin(member) {
  if (!member) return false;
  return member.id === member.guild.ownerId || member.permissions.has(P.Administrator) || member.permissions.has(P.ManageGuild);
}

/**
 * Prüft, ob actor das Ziel moderieren darf. Gibt einen Fehlertext zurück oder null.
 * kind: 'ban' | 'kick' | 'timeout' | 'manage'
 */
function checkHierarchy(actor, target, kind = 'manage') {
  if (!target) return null; // Nutzer ist nicht (mehr) auf dem Server – Bann per ID ist erlaubt
  const guild = target.guild;
  if (target.id === actor.id) return 'Du kannst das nicht bei dir selbst machen.';
  if (target.id === guild.ownerId) return 'Der Server-Inhaber kann nicht moderiert werden.';
  if (target.id === guild.client.user.id) return 'Das kann ich nicht bei mir selbst machen.';
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return 'Diese Person hat eine gleich hohe oder höhere Rolle als du.';
  }
  const can = { ban: target.bannable, kick: target.kickable, timeout: target.moderatable, manage: target.manageable }[kind];
  if (!can) return 'Meine Rolle steht zu niedrig. Zieh meine Rolle in den Server-Einstellungen über die Rolle dieser Person.';
  if (kind === 'timeout' && target.permissions.has(P.Administrator)) return 'Administratoren können keinen Timeout bekommen.';
  return null;
}

module.exports = { isStaff, isAdmin, checkHierarchy };
