'use strict';
const { EmbedBuilder, MessageFlags } = require('discord.js');

// Rot-Schwarz, aber Rubin statt Neon (lesbarer, edler): Rot ist der Akzent, Abstufungen statt Grün/Blau/Gelb
const BRAND = parseInt((process.env.BRAND_COLOR || 'c8102e').replace('#', ''), 16) || 0xc8102e;
const COLORS = {
  brand: BRAND,
  ok: BRAND,
  info: BRAND,
  warn: 0xf08a24, // Bernstein
  err: 0x8f0b20, // dunkles Rubin
  mod: 0xa50d26,
  protect: 0xe0344f, // helles Rubin – Schutz/Alarm fällt auf
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
