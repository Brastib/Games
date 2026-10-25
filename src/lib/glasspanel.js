'use strict';
/**
 * Panel im neuen Discord-Layout (Components V2) mit Glas-Banner:
 * Banner oben (animiertes GIF, sonst Standbild), Text, Trennlinie, Knöpfe, leise Fußzeile.
 * Wird von Rollen-Panels und dem Ticket-Panel benutzt.
 */
const {
  ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, TextDisplayBuilder, SeparatorBuilder, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const { COLORS } = require('./embeds');

/**
 * @param {{ banner: { title: string, caption?: string|null, icon?: string|null }, text: string, rows?: any[], footer?: string, color?: number, emptyText?: string }} p
 */
async function glassPanel({ banner, text, rows = [], footer, color, emptyText }) {
  const cards = require('./cards');
  const gif = await cards.bannerGif(banner).catch(() => null);
  const png = gif ? null : await cards.bannerCard(banner);
  const file = gif ? { buf: gif, name: 'banner.gif' } : png ? { buf: png, name: 'banner.png' } : null;
  const box = new ContainerBuilder().setAccentColor(color || COLORS.brand);
  if (file) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`).setDescription(banner.title)));
  else box.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${banner.title}`));
  box.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  box.addSeparatorComponents(new SeparatorBuilder());
  if (rows.length) box.addActionRowComponents(...rows);
  else if (emptyText) box.addTextDisplayComponents(new TextDisplayBuilder().setContent(emptyText));
  if (footer) box.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
  return { flags: MessageFlags.IsComponentsV2, components: [box], files: file ? [new AttachmentBuilder(file.buf, { name: file.name })] : [] };
}

module.exports = { glassPanel };
