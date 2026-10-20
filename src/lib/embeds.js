'use strict';
const { EmbedBuilder, MessageFlags } = require('discord.js');

const COLORS = {
  brand: parseInt((process.env.BRAND_COLOR || 'fd0000').replace('#', ''), 16) || 0xfd0000,
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  err: 0xe74c3c,
  info: 0x5865f2,
  mod: 0xe67e22,
  protect: 0xc0392b,
};

const make = (color, text, title) => {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title);
  if (text) e.setDescription(text);
  return e;
};

const ok = (text, title) => make(COLORS.ok, `✅ ${text}`, title);
const err = (text, title) => make(COLORS.err, `❌ ${text}`, title);
const warn = (text, title) => make(COLORS.warn, `⚠️ ${text}`, title);
const info = (text, title) => make(COLORS.brand, text, title);

/**
 * Antwortet sicher auf eine Interaktion – egal ob schon geantwortet/verzögert wurde.
 * content kann ein Embed, ein String oder ein vollständiges Payload-Objekt sein.
 */
async function respond(interaction, content, { ephemeral = true } = {}) {
  let payload;
  if (content instanceof EmbedBuilder) payload = { embeds: [content] };
  else if (typeof content === 'string') payload = { content };
  else payload = { ...content };
  try {
    if (interaction.deferred || interaction.replied) {
      if (interaction.deferred && !interaction.replied) return await interaction.editReply(payload);
      return await interaction.followUp({ ...payload, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    }
    return await interaction.reply({ ...payload, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  } catch (e) {
    console.error('[respond]', e.message);
    return null;
  }
}

module.exports = { COLORS, ok, err, warn, info, respond, EPHEMERAL: MessageFlags.Ephemeral };
