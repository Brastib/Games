'use strict';
/**
 * AutoMod: Linkschutz, Einladungsfilter, Spam, Massen-Erwähnungen, Großbuchstaben, Wortfilter.
 * Teammitglieder (Admins, Mods, Mod-Rollen) und Ausnahme-Rollen/-Kanäle werden nicht gefiltert.
 */
const { EmbedBuilder } = require('discord.js');
const { getConfig } = require('../lib/config');
const { isStaff } = require('../lib/perms');
const { sendLog } = require('../lib/logger');
const { COLORS } = require('../lib/embeds');
const { truncate } = require('../lib/util');
const lf = require('../lib/linkFilter');
const mod = require('./moderation');

const spam = new Map();        // guild:user -> [{at, id, ch, c}]
const inviteCache = new Map(); // code -> {guildId, at}

setInterval(() => {
  const now = Date.now();
  for (const [k, list] of spam) if (!list.length || now - list[list.length - 1].at > 30_000) spam.delete(k);
  for (const [k, v] of inviteCache) if (now - v.at > 3_600_000) inviteCache.delete(k);
}, 60_000).unref();

function normalizeWord(s) {
  return s.toLowerCase()
    .replace(/[0@4]/g, m => ({ 0: 'o', '@': 'a', 4: 'a' })[m])
    .replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[5$]/g, 's').replace(/7/g, 't')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

async function inviteGuildId(client, code) {
  const c = inviteCache.get(code);
  if (c) return c.guildId;
  try {
    const inv = await client.fetchInvite(code);
    inviteCache.set(code, { guildId: inv.guild?.id || null, at: Date.now() });
    return inv.guild?.id || null;
  } catch {
    inviteCache.set(code, { guildId: null, at: Date.now() });
    return null;
  }
}

async function notify(message, text) {
  try {
    const m = await message.channel.send({ content: `<@${message.author.id}> ${text}`, allowedMentions: { users: [message.author.id] } });
    setTimeout(() => m.delete().catch(() => {}), 7000);
  } catch { /* keine Rechte */ }
}

async function punish(message, action, reason, minutes) {
  const member = message.member;
  const me = message.client.user;
  try {
    if (action === 'warn') {
      const r = await mod.warn(message.guild, member, me, `AutoMod: ${reason}`);
      return `Verwarnung (${r.count} aktiv)${r.escalated ? ` → ${r.escalated}` : ''}`;
    }
    if (action === 'timeout' && member.moderatable) {
      await mod.timeout(member, (minutes || 10) * 60_000, me, `AutoMod: ${reason}`);
      return `Timeout ${minutes || 10} Min.`;
    }
    if (action === 'kick' && member.kickable) { await mod.kick(member, me, `AutoMod: ${reason}`); return 'Kick'; }
    if (action === 'ban' && member.bannable) { await mod.ban(message.guild, member.user, me, `AutoMod: ${reason}`, { deleteSeconds: 3600 }); return 'Bann'; }
  } catch (e) {
    console.warn('[automod] Strafe fehlgeschlagen:', e.message);
  }
  return 'Nachricht gelöscht';
}

async function violation(message, { rule, reason, publicText, action = 'delete', minutes }) {
  await message.delete().catch(() => {});
  await notify(message, publicText);
  const result = action === 'delete' ? 'Nachricht gelöscht' : await punish(message, action, reason, minutes);
  const embed = new EmbedBuilder()
    .setColor(COLORS.warn)
    .setAuthor({ name: `AutoMod · ${rule}`, iconURL: message.author.displayAvatarURL() })
    .setDescription(`**Mitglied:** <@${message.author.id}> (\`${message.author.id}\`)\n**Kanal:** <#${message.channel.id}>\n**Grund:** ${reason}\n**Aktion:** ${result}`)
    .setTimestamp();
  if (message.content) embed.addFields({ name: 'Nachricht', value: '```\n' + truncate(message.content.replace(/`/g, "'"), 1000) + '\n```' });
  sendLog(message.guild, 'mod', embed);
  return true;
}

function isExempt(message, am) {
  if (am.exemptChannels.includes(message.channel.id) || (message.channel.parentId && am.exemptChannels.includes(message.channel.parentId))) return true;
  return message.member.roles.cache.some(r => am.exemptRoles.includes(r.id));
}

/**
 * Prüft eine neue oder bearbeitete Nachricht.
 * @returns {Promise<boolean>} true, wenn die Nachricht entfernt wurde
 */
async function handle(message, { edited = false } = {}) {
  if (!message.guild || message.author.bot || message.webhookId || !message.member) return false;
  const am = getConfig(message.guild.id).automod;
  if (!am.enabled || isStaff(message.member) || isExempt(message, am)) return false;

  const snapshots = message.messageSnapshots ? [...message.messageSnapshots.values()].map(s => s.content || '').join('\n') : '';
  const text = [message.content || '', snapshots].join('\n');

  // 1) Einladungen zu fremden Servern
  if (am.invites.enabled) {
    for (const code of lf.extractInvites(text)) {
      if (am.invites.allowOwn && (await inviteGuildId(message.client, code)) === message.guild.id) continue;
      return violation(message, { rule: 'Einladungen', reason: `Einladung zu einem fremden Server (${code})`, publicText: 'Einladungen zu anderen Servern sind hier nicht erlaubt.', action: am.invites.action });
    }
  }

  // 2) Linkschutz
  if (am.links.enabled && am.links.mode !== 'off') {
    const urls = lf.extractUrls(text).filter(u => !lf.extractInvites(u).length);
    const unknown = [];
    for (const url of urls) {
      const r = lf.classify(url, am.links);
      if (r.block) {
        return violation(message, {
          rule: r.phishing ? 'Phishing-Schutz' : 'Linkschutz',
          reason: `${r.reason} (${r.host})`,
          publicText: r.phishing
            ? '🚫 Dieser Link ist gefährlich (Betrug/Phishing) und wurde entfernt. Klickt so etwas nie an!'
            : `🔗 Dieser Link ist hier nicht erlaubt (${r.reason}).`,
          action: r.phishing ? am.links.phishingAction : am.links.action,
          minutes: am.links.phishingMinutes,
        });
      }
      if (r.unknown) unknown.push(url);
    }
    if (unknown.length && process.env.SAFE_BROWSING_KEY) {
      const bad = await lf.safeBrowsingCheck(unknown);
      if (bad) {
        return violation(message, {
          rule: 'Phishing-Schutz', reason: `Google Safe Browsing meldet: gefährliche Seite (${bad})`,
          publicText: '🚫 Dieser Link ist laut Google gefährlich und wurde entfernt.',
          action: am.links.phishingAction, minutes: am.links.phishingMinutes,
        });
      }
    }
  }

  // 3) Wortfilter
  if (am.badwords.enabled && am.badwords.words.length && message.content) {
    const norm = normalizeWord(message.content);
    const hit = am.badwords.words.find(w => {
      const nw = normalizeWord(w);
      return new RegExp(`(^|[^a-z0-9äöüß])${nw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9äöüß])`, 'i').test(norm);
    });
    if (hit) return violation(message, { rule: 'Wortfilter', reason: 'Verbotenes Wort', publicText: 'Bitte achte auf deine Wortwahl.', action: am.badwords.action });
  }

  // 4) Massen-Erwähnungen
  if (am.mentions.enabled) {
    const n = message.mentions.users.filter(u => u.id !== message.author.id).size + message.mentions.roles.size;
    if (n > am.mentions.max) {
      return violation(message, { rule: 'Massen-Erwähnung', reason: `${n} Erwähnungen in einer Nachricht`, publicText: 'Bitte erwähne nicht so viele auf einmal.', action: 'timeout', minutes: am.mentions.timeoutMinutes });
    }
  }

  // 5) Großbuchstaben
  if (am.caps.enabled && message.content && message.content.length >= am.caps.minLength) {
    const letters = message.content.replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '').replace(/[^a-zA-ZäöüÄÖÜ]/g, '');
    if (letters.length >= am.caps.minLength) {
      const upper = letters.replace(/[^A-ZÄÖÜ]/g, '').length;
      if ((upper / letters.length) * 100 >= am.caps.percent) {
        return violation(message, { rule: 'Großbuchstaben', reason: `${Math.round((upper / letters.length) * 100)} % Großbuchstaben`, publicText: 'Bitte nicht so viel in GROSSBUCHSTABEN schreiben.', action: 'delete' });
      }
    }
  }

  // 6) Spam (nicht bei bearbeiteten Nachrichten)
  if (am.spam.enabled && !edited) {
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const list = (spam.get(key) || []).filter(m => now - m.at < 15_000);
    const norm = (message.content || '').trim().toLowerCase();
    list.push({ at: now, id: message.id, ch: message.channel.id, c: norm });
    spam.set(key, list);
    const recent = list.filter(m => now - m.at < am.spam.perSeconds * 1000).length;
    const dupes = norm ? list.filter(m => m.c === norm).length : 0;
    if (recent > am.spam.maxMessages || (am.spam.duplicates && dupes >= am.spam.duplicates)) {
      spam.delete(key);
      const byChannel = {};
      for (const m of list) (byChannel[m.ch] ||= []).push(m.id);
      for (const [cid, ids] of Object.entries(byChannel)) {
        const ch = message.guild.channels.cache.get(cid);
        if (ch?.bulkDelete) await ch.bulkDelete(ids, true).catch(() => {});
      }
      return violation(message, {
        rule: 'Spam', reason: recent > am.spam.maxMessages ? `${recent} Nachrichten in ${am.spam.perSeconds} Sek.` : `${dupes}× dieselbe Nachricht`,
        publicText: 'Bitte nicht spammen.', action: 'timeout', minutes: am.spam.timeoutMinutes,
      });
    }
  }
  return false;
}

module.exports = { handle, normalizeWord };
