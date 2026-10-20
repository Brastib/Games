'use strict';
/**
 * Münzen: Tagesbelohnung mit Serie, Überweisen, Rollen-Shop.
 */
const { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } = require('discord.js');
const store = require('../lib/store');
const { getConfig } = require('../lib/config');
const { COLORS, ok, err, respond } = require('../lib/embeds');
const { ts } = require('../lib/util');

const key = (g, u) => `${g}:${u}`;
const get = (g, u) => ({ coins: 0, lastDaily: 0, dailyStreak: 0, ...(store.get('economy', key(g, u)) || {}) });

function add(guildId, userId, amount) {
  const d = get(guildId, userId);
  d.coins = Math.max(0, Math.round(d.coins + amount));
  store.set('economy', key(guildId, userId), d);
  return d.coins;
}
function balance(guildId, userId) { return get(guildId, userId).coins; }

function richest(guildId) {
  return store.entries('economy').filter(([k]) => k.startsWith(guildId + ':'))
    .map(([k, v]) => ({ userId: k.split(':')[1], coins: v.coins || 0 })).sort((a, b) => b.coins - a.coins);
}

/** Tagesbelohnung (alle 20 Std., Serie bis 48 Std.) */
function daily(member) {
  const cfg = getConfig(member.guild.id).economy;
  const d = get(member.guild.id, member.id);
  const now = Date.now();
  const since = now - (d.lastDaily || 0);
  if (since < 20 * 3_600_000) return { ok: false, next: d.lastDaily + 20 * 3_600_000 };
  d.dailyStreak = since < 48 * 3_600_000 ? (d.dailyStreak || 0) + 1 : 1;
  const amount = Math.round((cfg.daily || 100) * (1 + Math.min(d.dailyStreak - 1, 14) * 0.1));
  d.coins += amount;
  d.lastDaily = now;
  store.set('economy', key(member.guild.id, member.id), d);
  return { ok: true, amount, streak: d.dailyStreak, coins: d.coins };
}

function transfer(guildId, fromId, toId, amount) {
  const from = get(guildId, fromId);
  if (amount <= 0 || from.coins < amount) return false;
  add(guildId, fromId, -amount);
  add(guildId, toId, amount);
  return true;
}

function shopPayload(guild) {
  const cfg = getConfig(guild.id).economy;
  const items = cfg.shop.filter(i => guild.roles.cache.has(i.roleId));
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle(`🛒 Shop · ${guild.name}`)
    .setDescription(items.length
      ? items.map((i, n) => `**${n + 1}.** <@&${i.roleId}> · **${i.price.toLocaleString('de-DE')} ${cfg.emoji}**${i.description ? `\n└ ${i.description}` : ''}`).join('\n')
      : 'Der Shop ist leer. Admins können Rollen mit `/shop add` oder im Web-Dashboard hinzufügen.')
    .setFooter({ text: `Deine ${cfg.name}: /balance · Verdienen: /daily, Quests, Aktivität` });
  const components = items.length ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('shop:buy').setPlaceholder('Rolle kaufen …')
    .addOptions(items.slice(0, 25).map(i => ({ label: `${guild.roles.cache.get(i.roleId).name} – ${i.price} ${cfg.name}`.slice(0, 100), value: i.roleId }))))] : [];
  return { embeds: [embed], components };
}

async function buy(interaction, roleId) {
  const g = interaction.guild;
  const cfg = getConfig(g.id).economy;
  const item = cfg.shop.find(i => i.roleId === roleId);
  const role = g.roles.cache.get(roleId);
  if (!item || !role) return respond(interaction, err('Diese Rolle gibt es im Shop nicht mehr.'));
  if (interaction.member.roles.cache.has(roleId)) return respond(interaction, err(`Du hast ${role} schon.`));
  if (!role.editable) return respond(interaction, err('Ich kann diese Rolle nicht vergeben (meine Rolle steht zu tief).'));
  const bal = balance(g.id, interaction.user.id);
  if (bal < item.price) return respond(interaction, err(`Du hast nur **${bal} ${cfg.emoji}**, brauchst aber **${item.price}**.`));
  add(g.id, interaction.user.id, -item.price);
  try {
    await interaction.member.roles.add(role, 'Im Shop gekauft');
  } catch (e) {
    add(g.id, interaction.user.id, item.price);
    return respond(interaction, err(`Kauf fehlgeschlagen, Münzen zurückgegeben: ${e.message}`));
  }
  return respond(interaction, ok(`Du hast ${role} für **${item.price} ${cfg.emoji}** gekauft! Rest: ${bal - item.price} ${cfg.emoji}`));
}

function dailyText(member, r) {
  const cfg = getConfig(member.guild.id).economy;
  if (!r.ok) return err(`Deine nächste Belohnung gibt es ${ts(r.next)}.`);
  return new EmbedBuilder().setColor(COLORS.ok).setTitle('🎁 Tagesbelohnung')
    .setDescription(`**+${r.amount} ${cfg.emoji}** · Serie: **${r.streak} ${r.streak === 1 ? 'Tag' : 'Tage'}** 🔥\nKontostand: **${r.coins.toLocaleString('de-DE')} ${cfg.emoji}**\n\nJeder Tag in Folge gibt 10 % mehr (bis +140 %).`);
}

module.exports = { get, add, balance, richest, daily, transfer, shopPayload, buy, dailyText };
