'use strict';
/**
 * Verteilt alle Interaktionen (Slash-Befehle, Buttons, Menüs, Formulare) an die richtigen Module.
 * customId-Schema: "<bereich>:<aktion>[:<wert>]"
 */
const { Collection, EmbedBuilder, InteractionContextType } = require('discord.js');
const { COLORS, err, respond } = require('../lib/embeds');
const { parseColor, truncate } = require('../lib/util');
const tempvoice = require('../modules/tempvoice');
const tickets = require('../modules/tickets');
const verify = require('../modules/verify');
const rolepanels = require('../modules/rolepanels');
const giveaways = require('../modules/giveaways');
const dashboard = require('../modules/dashboard');
const economy = require('../modules/economy');
const extras = require('../modules/extras');

const FILES = ['moderation', 'protection', 'setup', 'features', 'levels', 'community', 'music', 'extras', 'fun', 'info'];
const commands = new Collection();
for (const f of FILES) {
  for (const cmd of require(`../commands/${f}`)) {
    cmd.data.setContexts?.(InteractionContextType.Guild); // nur auf Servern, nicht in DMs
    commands.set(cmd.data.name, cmd);
  }
}
const { leaderboardPayload } = require('../commands/levels');
const { helpPayload } = require('../commands/info');

async function handleEmbedModal(i, channelId) {
  const ch = i.guild.channels.cache.get(channelId);
  if (!ch?.isTextBased()) return respond(i, err('Kanal nicht gefunden.'));
  const get = id => i.fields.getTextInputValue(id)?.trim();
  const e = new EmbedBuilder().setColor(parseColor(get('color')) ?? COLORS.brand).setDescription(get('description'));
  if (get('title')) e.setTitle(truncate(get('title'), 256));
  if (get('footer')) e.setFooter({ text: get('footer') });
  const img = get('image');
  if (img) {
    if (!/^https?:\/\/\S+$/i.test(img)) return respond(i, err('Der Bild-Link muss mit http:// oder https:// beginnen.'));
    e.setImage(img);
  }
  try {
    await ch.send({ embeds: [e] });
    return respond(i, { embeds: [new EmbedBuilder().setColor(COLORS.ok).setDescription(`✅ Gepostet in ${ch}.`)] });
  } catch (x) {
    return respond(i, err(`Posten fehlgeschlagen: ${x.message}`));
  }
}

async function onInteraction(i) {
  try {
    if (i.isChatInputCommand()) {
      if (!i.inGuild()) return respond(i, err('Befehle funktionieren nur auf Servern.'));
      const cmd = commands.get(i.commandName);
      if (!cmd) return respond(i, err('Diesen Befehl kenne ich nicht (mehr).'));
      return await cmd.execute(i);
    }
    if (i.isAutocomplete()) {
      const cmd = commands.get(i.commandName);
      if (cmd?.autocomplete) return await cmd.autocomplete(i);
      return;
    }
    // Knopf aus der Anti-Nuke-DM an den Inhaber (kommt ohne Server)
    if (i.isButton() && i.customId.startsWith('an:undo:')) return await require('../modules/antinuke').handleUndo(i);
    if (!i.inGuild()) return;
    const [ns, action, value] = i.customId.split(':');

    if (i.isButton()) {
      switch (ns) {
        case 'tv': return await tempvoice.handleButton(i, action);
        case 'tvc': return await tempvoice.handleConfirm(i, action, value);
        case 'tk': return await tickets.handleButton(i, action);
        case 'vr': return await verify.handleButton(i);
        case 'rp': return await rolepanels.onButton(i, action);
        case 'gw': return await giveaways.onJoin(i);
        case 'dash': return await dashboard.handleButton(i, [action, value]);
        case 'mu': return await require('../commands/music').handleButton(i, action);
        case 'sg': return await extras.onSuggestionButton(i, action);
        case 'ev': return await require('../modules/events').onButton(i, action, Number(value));
        case 'nb': return await require('../modules/migrate').handleButton(i, action, value);
        case 'db': return await require('../modules/databackup').handleButton(i, action);
        case 'lb': return await i.update({ content: '', files: [], attachments: [], ...leaderboardPayload(i.guild, parseInt(value, 10) || 0, action) });
      }
      return;
    }
    if (i.isStringSelectMenu()) {
      if (ns === 'rps') return await rolepanels.onSelect(i);
      if (ns === 'tvu') return await tempvoice.handleSelect(i, action, value);
      if (ns === 'help') return await i.update(helpPayload(i.values[0]));
      if (ns === 'shop') return await economy.buy(i, i.values[0]);
      return;
    }
    if (i.isUserSelectMenu()) {
      if (ns === 'tvs') return await tempvoice.handleSelect(i, action, value);
      return;
    }
    if (i.isModalSubmit()) {
      switch (ns) {
        case 'tvm': return await tempvoice.handleModal(i, action);
        case 'tkm': return await tickets.onOpenModal(i);
        case 'vrm': return action === 'setup' ? await verify.finishSetup(i) : await verify.handleCaptcha(i);
        case 'emb': return await handleEmbedModal(i, action);
      }
    }
  } catch (e) {
    console.error(`[interaktion ${i.isChatInputCommand?.() ? '/' + i.commandName : i.customId}]`, e);
    if (i.isRepliable?.()) {
      const msg = e.code === 50013 ? 'Mir fehlen die nötigen Rechte. Gib mir Administrator oder zieh meine Rolle weiter nach oben.' : `Da ist etwas schiefgelaufen: ${truncate(e.message, 300)}`;
      await respond(i, err(msg)).catch(() => {});
    }
  }
}

module.exports = { onInteraction, commands };
