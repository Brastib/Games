'use strict';
/**
 * Panel im neuen Discord-Layout (Components V2) mit Glas-Banner:
 * Banner oben (animiertes GIF, sonst Standbild), darunter Knöpfe und eine leise Zeile.
 * Wird von Rollen-Panels und dem Ticket-Panel benutzt.
 */
const { MediaGalleryBuilder, MediaGalleryItemBuilder, TextDisplayBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');

/**
 * Schlicht: kein Kasten, kein roter Strich, keine Fußzeile – das Banner ist groß das Titelbild, darunter nur die Knöpfe
 * und eine leise Zeile. So passt das native Discord-Drumherum zum Glas-Look.
 * @param {{ banner: { title: string, caption?: string|null, icon?: string|null }, text?: string|null, rows?: any[], hint?: string|null, emptyText?: string }} p
 */
async function glassPanel({ banner, text, rows = [], hint, emptyText }) {
  const cards = require('./cards');
  const gif = await cards.bannerGif(banner).catch(() => null);
  const png = gif ? null : await cards.bannerCard(banner);
  const file = gif ? { buf: gif, name: 'banner.gif' } : png ? { buf: png, name: 'banner.png' } : null;
  const parts = [];
  // ohne Bildbeschreibung – sonst zeigt Discord ein „ALT“-Schild auf dem Banner
  if (file) parts.push(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`)));
  else parts.push(new TextDisplayBuilder().setContent(`## ${banner.title}`));
  if (text) parts.push(new TextDisplayBuilder().setContent(text));
  if (rows.length) parts.push(...rows);
  else if (emptyText) parts.push(new TextDisplayBuilder().setContent(emptyText));
  if (hint) parts.push(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return { flags: MessageFlags.IsComponentsV2, components: parts, files: file ? [new AttachmentBuilder(file.buf, { name: file.name })] : [] };
}

module.exports = { glassPanel };
