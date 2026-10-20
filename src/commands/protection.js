'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder } = require('discord.js');
const { getConfig, saveConfig, DEFAULT_ALLOW } = require('../lib/config');
const { COLORS, ok, err, info, respond } = require('../lib/embeds');
const { isStaff } = require('../lib/perms');
const { parseDuration, formatDuration, ts, truncate } = require('../lib/util');
const lf = require('../lib/linkFilter');
const lockdown = require('../modules/lockdown');
const antiraid = require('../modules/antiraid');

const onOff = v => (v ? '🟢 an' : '⚫ aus');
const ACTIONS = [{ name: 'Nur löschen', value: 'delete' }, { name: 'Löschen + verwarnen', value: 'warn' }, { name: 'Löschen + Timeout', value: 'timeout' }];
const HARD = [...ACTIONS, { name: 'Löschen + kicken', value: 'kick' }, { name: 'Löschen + bannen', value: 'ban' }];
const cleanDomain = d => d.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

module.exports = [
  // ---------------- LOCKDOWN ----------------
  {
    data: new SlashCommandBuilder().setName('lockdown').setDescription('Ganzen Server sperren (Notfall) oder wieder öffnen')
      .setDefaultMemberPermissions(P.ManageChannels)
      .addSubcommand(s => s.setName('start').setDescription('Server in den Lockdown versetzen')
        .addStringOption(o => o.setName('grund').setDescription('Grund').setMaxLength(300))
        .addStringOption(o => o.setName('dauer').setDescription('Automatisch beenden nach z. B. 30m, 2h (leer = manuell)'))
        .addBooleanOption(o => o.setName('sprachkanaele').setDescription('Sprachkanäle auch sperren? (Standard: ja)'))
        .addBooleanOption(o => o.setName('einladungen_pausieren').setDescription('Einladungen pausieren, damit niemand Neues beitritt? (Standard: ja)'))
        .addBooleanOption(o => o.setName('ueberall_ankuendigen').setDescription('Hinweis in jedem gesperrten Kanal posten? (Standard: nein)')))
      .addSubcommand(s => s.setName('end').setDescription('Lockdown beenden und alles wiederherstellen'))
      .addSubcommand(s => s.setName('status').setDescription('Zeigt, ob gerade ein Lockdown läuft'))
      .addSubcommand(s => s.setName('sirenentest').setDescription('Sirene + Durchsage nur in deinem Sprachkanal testen – ohne Lockdown')),
    async execute(i) {
      if (!isStaff(i.member)) return respond(i, err('Nur das Team darf das.'));
      const sub = i.options.getSubcommand();
      const cfg = getConfig(i.guild.id);
      if (sub === 'sirenentest') {
        const vc = i.member.voice.channel;
        if (!vc) return respond(i, err('Geh zuerst in einen Sprachkanal.'));
        await i.deferReply({ flags: 64 });
        const n = await lockdown.voiceAlarm(i.guild, { only: vc.id, test: true });
        return respond(i, n ? ok(`Sirene in ${vc} abgespielt.`) : err('Konnte nicht abspielen – darf ich dem Kanal beitreten und sprechen? (Log: journalctl -u etc-bot)'));
      }
      if (sub === 'status') {
        const l = cfg.lockdown;
        return respond(i, l.active
          ? new EmbedBuilder().setColor(COLORS.protect).setTitle('🔒 Lockdown aktiv').setDescription(`**Seit:** ${ts(l.since)}\n**Grund:** ${l.reason}\n**Von:** ${l.by ? `<@${l.by}>` : 'Automatischer Schutz'}\n**Ende:** ${l.until ? ts(l.until) : 'manuell'}\n**Gesicherte Berechtigungen:** ${l.backup.length}`)
          : ok('Kein Lockdown aktiv.'));
      }
      if (sub === 'start') {
        const durStr = i.options.getString('dauer');
        const ms = durStr ? parseDuration(durStr) : null;
        if (durStr && !ms) return respond(i, err('Dauer nicht erkannt. Beispiele: `30m`, `2h`.'));
        await i.deferReply();
        const r = await lockdown.start(i.guild, {
          reason: i.options.getString('grund') || null, by: i.user, minutes: ms ? ms / 60_000 : 0, // ohne Grund: Standard aus den Einstellungen
          voice: i.options.getBoolean('sprachkanaele') ?? true, pauseInvites: i.options.getBoolean('einladungen_pausieren') ?? true,
          announceAll: i.options.getBoolean('ueberall_ankuendigen') ?? false,
          onProgress: (d, t) => i.editReply(`⏳ Sperre Kanäle … ${d}/${t}`).catch(() => {}),
        });
        if (r.already) return respond(i, err('Es läuft schon ein Lockdown. Beenden mit `/lockdown end`.'));
        if (r.busy) return respond(i, err('Ich bin gerade noch beschäftigt. Bitte kurz warten.'));
        return respond(i, { content: '', embeds: [new EmbedBuilder().setColor(COLORS.protect).setTitle('🔒 Lockdown aktiv')
          .setDescription(`**${r.locked}** Kanäle gesperrt. Einladungen: **${r.invitesPaused ? 'pausiert' : 'aktiv'}**.\n${r.until ? `Endet automatisch ${ts(r.until)}.` : 'Beenden mit `/lockdown end`.'}\nDas Team (Admins + Mod-Rollen) kann weiter schreiben.`)] });
      }
      if (sub === 'end') {
        await i.deferReply();
        const r = await lockdown.end(i.guild, { by: i.user });
        if (r.notActive) return respond(i, err('Es läuft kein Lockdown.'));
        if (r.busy) return respond(i, err('Ich bin gerade noch beschäftigt. Bitte kurz warten.'));
        return respond(i, ok(`Lockdown beendet. ${r.restored} Berechtigungen wiederhergestellt. 🔓`));
      }
    },
  },

  // ---------------- AUTOMOD ----------------
  {
    data: new SlashCommandBuilder().setName('automod').setDescription('Automatische Moderation einstellen')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand(s => s.setName('status').setDescription('Alle AutoMod-Einstellungen anzeigen'))
      .addSubcommand(s => s.setName('toggle').setDescription('AutoMod komplett an/aus').addBooleanOption(o => o.setName('an').setDescription('an?').setRequired(true)))
      .addSubcommandGroup(g => g.setName('links').setDescription('Linkschutz')
        .addSubcommand(s => s.setName('mode').setDescription('Modus und Strafen festlegen')
          .addStringOption(o => o.setName('modus').setDescription('Wie streng?').setRequired(true).addChoices(
            { name: 'Smart – nur gefährliche Links blockieren (empfohlen)', value: 'smart' },
            { name: 'Streng – nur Links von der Erlaubt-Liste', value: 'strict' },
            { name: 'Aus', value: 'off' }))
          .addStringOption(o => o.setName('aktion').setDescription('Was passiert bei unerlaubten Links?').addChoices(...ACTIONS))
          .addStringOption(o => o.setName('phishing_aktion').setDescription('Was passiert bei Betrugs-Links?').addChoices(...HARD))
          .addIntegerOption(o => o.setName('phishing_timeout_minuten').setDescription('Timeout-Länge bei Betrugs-Links').setMinValue(1).setMaxValue(40320)))
        .addSubcommand(s => s.setName('allow').setDescription('Domain erlauben (z. B. meineseite.de)').addStringOption(o => o.setName('domain').setDescription('Domain').setRequired(true)))
        .addSubcommand(s => s.setName('block').setDescription('Domain sperren').addStringOption(o => o.setName('domain').setDescription('Domain').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Domain von Erlaubt-/Sperrliste entfernen').addStringOption(o => o.setName('domain').setDescription('Domain').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('Erlaubt- und Sperrliste anzeigen'))
        .addSubcommand(s => s.setName('test').setDescription('Prüfen, ob ein Link blockiert würde').addStringOption(o => o.setName('link').setDescription('Link').setRequired(true))))
      .addSubcommand(s => s.setName('invites').setDescription('Einladungen zu anderen Servern blockieren')
        .addBooleanOption(o => o.setName('an').setDescription('an?').setRequired(true))
        .addBooleanOption(o => o.setName('eigene_erlaubt').setDescription('Einladungen zu diesem Server erlauben? (Standard: ja)'))
        .addStringOption(o => o.setName('aktion').setDescription('Strafe').addChoices(...ACTIONS)))
      .addSubcommand(s => s.setName('spam').setDescription('Spam-Schutz')
        .addBooleanOption(o => o.setName('an').setDescription('an?').setRequired(true))
        .addIntegerOption(o => o.setName('nachrichten').setDescription('Mehr als … Nachrichten').setMinValue(3).setMaxValue(30))
        .addIntegerOption(o => o.setName('sekunden').setDescription('… in so vielen Sekunden').setMinValue(2).setMaxValue(60))
        .addIntegerOption(o => o.setName('gleiche').setDescription('Gleiche Nachricht so oft = Spam (0 = aus)').setMinValue(0).setMaxValue(20))
        .addIntegerOption(o => o.setName('timeout_minuten').setDescription('Timeout-Länge').setMinValue(1).setMaxValue(10080)))
      .addSubcommand(s => s.setName('mentions').setDescription('Massen-Erwähnungen blockieren')
        .addBooleanOption(o => o.setName('an').setDescription('an?').setRequired(true))
        .addIntegerOption(o => o.setName('maximum').setDescription('Maximal erlaubte Erwähnungen pro Nachricht').setMinValue(1).setMaxValue(50)))
      .addSubcommand(s => s.setName('caps').setDescription('Zu viele GROSSBUCHSTABEN löschen')
        .addBooleanOption(o => o.setName('an').setDescription('an?').setRequired(true))
        .addIntegerOption(o => o.setName('prozent').setDescription('Ab wie viel % Großbuchstaben').setMinValue(50).setMaxValue(100)))
      .addSubcommandGroup(g => g.setName('badwords').setDescription('Wortfilter')
        .addSubcommand(s => s.setName('add').setDescription('Wort(e) hinzufügen, mit Komma getrennt').addStringOption(o => o.setName('woerter').setDescription('z. B. wort1, wort2').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Wort entfernen').addStringOption(o => o.setName('wort').setDescription('Wort').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('Wortliste anzeigen'))
        .addSubcommand(s => s.setName('toggle').setDescription('Wortfilter an/aus')
          .addBooleanOption(o => o.setName('an').setDescription('an?').setRequired(true))
          .addStringOption(o => o.setName('aktion').setDescription('Strafe').addChoices(...ACTIONS))))
      .addSubcommandGroup(g => g.setName('exempt').setDescription('Ausnahmen (werden nicht gefiltert)')
        .addSubcommand(s => s.setName('role').setDescription('Rolle als Ausnahme hinzufügen/entfernen').addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true)))
        .addSubcommand(s => s.setName('channel').setDescription('Kanal/Kategorie als Ausnahme hinzufügen/entfernen').addChannelOption(o => o.setName('kanal').setDescription('Kanal').setRequired(true))))
      .addSubcommand(s => s.setName('escalation').setDescription('Automatische Strafen nach Anzahl der Verwarnungen')
        .addBooleanOption(o => o.setName('an').setDescription('an?'))
        .addIntegerOption(o => o.setName('timeout_ab').setDescription('Timeout ab … Verwarnungen (0 = nie)').setMinValue(0).setMaxValue(50))
        .addIntegerOption(o => o.setName('timeout_minuten').setDescription('Timeout-Länge').setMinValue(1).setMaxValue(40320))
        .addIntegerOption(o => o.setName('kick_ab').setDescription('Kick ab … Verwarnungen (0 = nie)').setMinValue(0).setMaxValue(50))
        .addIntegerOption(o => o.setName('ban_ab').setDescription('Bann ab … Verwarnungen (0 = nie)').setMinValue(0).setMaxValue(50))
        .addIntegerOption(o => o.setName('verfall_tage').setDescription('Verwarnungen zählen nur so viele Tage (0 = für immer)').setMinValue(0).setMaxValue(365))),
    async execute(i) {
      const cfg = getConfig(i.guild.id);
      const a = cfg.automod;
      const group = i.options.getSubcommandGroup(false);
      const sub = i.options.getSubcommand();
      const save = text => { saveConfig(i.guild.id); return respond(i, ok(text)); };

      if (!group && sub === 'status') {
        const e = new EmbedBuilder().setColor(COLORS.brand).setTitle('🤖 AutoMod').setDescription(`**Gesamt:** ${onOff(a.enabled)}`)
          .addFields(
            { name: '🔗 Linkschutz', value: `${a.links.enabled ? a.links.mode : 'aus'} · Aktion: ${a.links.action} · Phishing: ${a.links.phishingAction} (${a.links.phishingMinutes} Min.)\nEigene Erlaubt: ${a.links.allow.length} · Gesperrt: ${a.links.block.length} · Betrugs-DB: ${lf.phishingCount().toLocaleString('de-DE')}`, inline: false },
            { name: '✉️ Einladungen', value: `${onOff(a.invites.enabled)} · eigene erlaubt: ${a.invites.allowOwn ? 'ja' : 'nein'} · ${a.invites.action}`, inline: true },
            { name: '🌊 Spam', value: `${onOff(a.spam.enabled)} · >${a.spam.maxMessages} in ${a.spam.perSeconds}s · ${a.spam.duplicates}× gleich · ${a.spam.timeoutMinutes} Min.`, inline: true },
            { name: '📣 Erwähnungen', value: `${onOff(a.mentions.enabled)} · max. ${a.mentions.max}`, inline: true },
            { name: '🔠 Großbuchstaben', value: `${onOff(a.caps.enabled)} · ab ${a.caps.percent} %`, inline: true },
            { name: '🤬 Wortfilter', value: `${onOff(a.badwords.enabled)} · ${a.badwords.words.length} Wörter`, inline: true },
            { name: '📈 Eskalation', value: `${onOff(a.escalation.enabled)} · Timeout ab ${a.escalation.timeoutAt || '–'} · Kick ab ${a.escalation.kickAt || '–'} · Bann ab ${a.escalation.banAt || '–'} · Verfall ${a.escalation.expireDays || '∞'} Tage`, inline: false },
            { name: '🙈 Ausnahmen', value: [...a.exemptRoles.map(r => `<@&${r}>`), ...a.exemptChannels.map(c => `<#${c}>`)].join(' ') || 'keine (Team ist immer ausgenommen)', inline: false },
          );
        return respond(i, e);
      }
      if (!group && sub === 'toggle') { a.enabled = i.options.getBoolean('an'); return save(`AutoMod ist jetzt **${a.enabled ? 'an' : 'aus'}**.`); }

      if (group === 'links') {
        if (sub === 'mode') {
          const m = i.options.getString('modus');
          a.links.mode = m; a.links.enabled = m !== 'off';
          a.links.action = i.options.getString('aktion') || a.links.action;
          a.links.phishingAction = i.options.getString('phishing_aktion') || a.links.phishingAction;
          a.links.phishingMinutes = i.options.getInteger('phishing_timeout_minuten') || a.links.phishingMinutes;
          return save(`Linkschutz: **${m}** · Aktion: **${a.links.action}** · Betrugs-Links: **${a.links.phishingAction}**.\nGIFs (Tenor, Giphy, Klipy), YouTube, Twitch, Discord-Links und hochgeladene Dateien sind immer erlaubt.`);
        }
        if (sub === 'allow' || sub === 'block') {
          const d = cleanDomain(i.options.getString('domain'));
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return respond(i, err('Das sieht nicht wie eine Domain aus. Beispiel: `meineseite.de`'));
          const list = sub === 'allow' ? a.links.allow : a.links.block;
          const other = sub === 'allow' ? a.links.block : a.links.allow;
          if (!list.includes(d)) list.push(d);
          const idx = other.indexOf(d); if (idx >= 0) other.splice(idx, 1);
          return save(`\`${d}\` ist jetzt **${sub === 'allow' ? 'erlaubt' : 'gesperrt'}**.`);
        }
        if (sub === 'remove') {
          const d = cleanDomain(i.options.getString('domain'));
          a.links.allow = a.links.allow.filter(x => x !== d);
          a.links.block = a.links.block.filter(x => x !== d);
          return save(`\`${d}\` von beiden Listen entfernt.`);
        }
        if (sub === 'list') {
          return respond(i, info(`**Eigene Erlaubt-Liste:** ${a.links.allow.map(d => `\`${d}\``).join(', ') || '–'}\n**Eigene Sperrliste:** ${a.links.block.map(d => `\`${d}\``).join(', ') || '–'}\n\n**Immer erlaubt:** ${truncate(DEFAULT_ALLOW.map(d => `\`${d}\``).join(', '), 3000)}`, '🔗 Linklisten'));
        }
        if (sub === 'test') {
          const url = i.options.getString('link');
          const r = lf.classify(url, a.links);
          let sb = '';
          if (!r.block && r.unknown && process.env.SAFE_BROWSING_KEY) sb = (await lf.safeBrowsingCheck([url])) ? '\n⚠️ Google Safe Browsing: **gefährlich**' : '\nGoogle Safe Browsing: unauffällig';
          return respond(i, r.block ? err(`**Blockiert:** ${r.reason}${r.phishing ? ' (Betrug/Phishing)' : ''}\nDomain: \`${r.host}\``) : ok(`**Erlaubt** (${a.links.mode}).${r.host ? ` Domain: \`${r.host}\`` : ''}${sb}`));
        }
      }
      if (!group && sub === 'invites') {
        a.invites.enabled = i.options.getBoolean('an');
        a.invites.allowOwn = i.options.getBoolean('eigene_erlaubt') ?? a.invites.allowOwn;
        a.invites.action = i.options.getString('aktion') || a.invites.action;
        return save(`Einladungsfilter **${a.invites.enabled ? 'an' : 'aus'}** · eigene Einladungen ${a.invites.allowOwn ? 'erlaubt' : 'verboten'} · Aktion: ${a.invites.action}.`);
      }
      if (!group && sub === 'spam') {
        a.spam.enabled = i.options.getBoolean('an');
        a.spam.maxMessages = i.options.getInteger('nachrichten') ?? a.spam.maxMessages;
        a.spam.perSeconds = i.options.getInteger('sekunden') ?? a.spam.perSeconds;
        a.spam.duplicates = i.options.getInteger('gleiche') ?? a.spam.duplicates;
        a.spam.timeoutMinutes = i.options.getInteger('timeout_minuten') ?? a.spam.timeoutMinutes;
        return save(`Spam-Schutz **${a.spam.enabled ? 'an' : 'aus'}**: mehr als ${a.spam.maxMessages} Nachrichten in ${a.spam.perSeconds} s oder ${a.spam.duplicates}× dasselbe → ${a.spam.timeoutMinutes} Min. Timeout.`);
      }
      if (!group && sub === 'mentions') {
        a.mentions.enabled = i.options.getBoolean('an');
        a.mentions.max = i.options.getInteger('maximum') ?? a.mentions.max;
        return save(`Erwähnungs-Schutz **${a.mentions.enabled ? 'an' : 'aus'}** (max. ${a.mentions.max}).`);
      }
      if (!group && sub === 'caps') {
        a.caps.enabled = i.options.getBoolean('an');
        a.caps.percent = i.options.getInteger('prozent') ?? a.caps.percent;
        return save(`Großbuchstaben-Filter **${a.caps.enabled ? 'an' : 'aus'}** (ab ${a.caps.percent} %).`);
      }
      if (group === 'badwords') {
        if (sub === 'add') {
          const words = i.options.getString('woerter').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
          for (const w of words) if (!a.badwords.words.includes(w)) a.badwords.words.push(w);
          a.badwords.enabled = true;
          return save(`${words.length} Wort/Wörter hinzugefügt. Wortfilter ist **an**.`);
        }
        if (sub === 'remove') {
          const w = i.options.getString('wort').trim().toLowerCase();
          a.badwords.words = a.badwords.words.filter(x => x !== w);
          return save(`\`${w}\` entfernt.`);
        }
        if (sub === 'list') return respond(i, info(a.badwords.words.length ? '||' + truncate(a.badwords.words.join(', '), 3900) + '||' : 'Keine Wörter.', '🤬 Wortfilter'));
        if (sub === 'toggle') {
          a.badwords.enabled = i.options.getBoolean('an');
          a.badwords.action = i.options.getString('aktion') || a.badwords.action;
          return save(`Wortfilter **${a.badwords.enabled ? 'an' : 'aus'}** · Aktion: ${a.badwords.action}.`);
        }
      }
      if (group === 'exempt') {
        if (sub === 'role') {
          const r = i.options.getRole('rolle');
          const idx = a.exemptRoles.indexOf(r.id);
          if (idx >= 0) a.exemptRoles.splice(idx, 1); else a.exemptRoles.push(r.id);
          return save(`${r} ist jetzt ${idx >= 0 ? '**keine** Ausnahme mehr' : 'eine **Ausnahme**'}.`);
        }
        if (sub === 'channel') {
          const c = i.options.getChannel('kanal');
          const idx = a.exemptChannels.indexOf(c.id);
          if (idx >= 0) a.exemptChannels.splice(idx, 1); else a.exemptChannels.push(c.id);
          return save(`${c} ist jetzt ${idx >= 0 ? '**keine** Ausnahme mehr' : 'eine **Ausnahme**'}.`);
        }
      }
      if (!group && sub === 'escalation') {
        const e = a.escalation;
        e.enabled = i.options.getBoolean('an') ?? e.enabled;
        e.timeoutAt = i.options.getInteger('timeout_ab') ?? e.timeoutAt;
        e.timeoutMinutes = i.options.getInteger('timeout_minuten') ?? e.timeoutMinutes;
        e.kickAt = i.options.getInteger('kick_ab') ?? e.kickAt;
        e.banAt = i.options.getInteger('ban_ab') ?? e.banAt;
        e.expireDays = i.options.getInteger('verfall_tage') ?? e.expireDays;
        return save(`Eskalation **${e.enabled ? 'an' : 'aus'}**: Timeout (${e.timeoutMinutes} Min.) ab ${e.timeoutAt || '–'}, Kick ab ${e.kickAt || '–'}, Bann ab ${e.banAt || '–'} Verwarnungen. Verfall: ${e.expireDays || 'nie'} Tage.`);
      }
      return respond(i, err('Unbekannter Unterbefehl.'));
    },
  },

  // ---------------- ANTI-RAID ----------------
  {
    data: new SlashCommandBuilder().setName('antiraid').setDescription('Schutz vor Raids (viele Beitritte auf einmal) und Fake-Accounts')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand(s => s.setName('status').setDescription('Einstellungen anzeigen'))
      .addSubcommand(s => s.setName('set').setDescription('Raid-Erkennung einstellen')
        .addBooleanOption(o => o.setName('an').setDescription('an?'))
        .addIntegerOption(o => o.setName('beitritte').setDescription('Ab so vielen Beitritten …').setMinValue(3).setMaxValue(100))
        .addIntegerOption(o => o.setName('sekunden').setDescription('… in so vielen Sekunden = Raid').setMinValue(3).setMaxValue(600))
        .addStringOption(o => o.setName('aktion').setDescription('Was soll passieren?').addChoices(
          { name: 'Lockdown + Einladungen pausieren (empfohlen)', value: 'lockdown' }, { name: 'Nur Einladungen pausieren + warnen', value: 'alert' }))
        .addIntegerOption(o => o.setName('minuten').setDescription('Wie lange der Schutz aktiv bleibt').setMinValue(1).setMaxValue(1440))
        .addBooleanOption(o => o.setName('einladungen_pausieren').setDescription('Einladungen + DMs während Raid pausieren?'))
        .addBooleanOption(o => o.setName('raider_kicken').setDescription('Accounts aus dem Raid automatisch kicken?')))
      .addSubcommand(s => s.setName('accountage').setDescription('Zu neue Accounts abweisen (gegen Fake-Accounts)')
        .addIntegerOption(o => o.setName('tage').setDescription('Mindestalter des Accounts in Tagen (0 = aus)').setRequired(true).setMinValue(0).setMaxValue(365))
        .addStringOption(o => o.setName('aktion').setDescription('Aktion').addChoices({ name: 'Kicken', value: 'kick' }, { name: 'Bannen', value: 'ban' }, { name: '7 Tage Timeout', value: 'timeout' })))
      .addSubcommand(s => s.setName('start').setDescription('Raid-Schutzmodus jetzt manuell auslösen'))
      .addSubcommand(s => s.setName('stop').setDescription('Raid-Schutzmodus beenden (Lockdown separat mit /lockdown end)')),
    async execute(i) {
      const cfg = getConfig(i.guild.id);
      const ar = cfg.antiraid;
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle('🚨 Anti-Raid').setDescription([
          `**Status:** ${onOff(ar.enabled)}${antiraid.raidActive(cfg) ? ` · 🔴 Raid-Modus bis ${ts(ar.raidUntil)}` : ''}`,
          `**Erkennung:** ${ar.joins} Beitritte in ${ar.seconds} Sekunden`,
          `**Aktion:** ${ar.action === 'lockdown' ? 'Lockdown' : 'nur Warnung'} für ${formatDuration(ar.minutes * 60_000)}`,
          `**Einladungen pausieren:** ${ar.pauseInvites ? 'ja' : 'nein'} · **Raider kicken:** ${ar.kickRaiders ? 'ja' : 'nein'}`,
          `**Mindest-Accountalter:** ${ar.minAccountDays ? `${ar.minAccountDays} Tage → ${ar.accountAction}` : 'aus'}`,
        ].join('\n')));
      }
      if (sub === 'set') {
        ar.enabled = i.options.getBoolean('an') ?? ar.enabled;
        ar.joins = i.options.getInteger('beitritte') ?? ar.joins;
        ar.seconds = i.options.getInteger('sekunden') ?? ar.seconds;
        ar.action = i.options.getString('aktion') ?? ar.action;
        ar.minutes = i.options.getInteger('minuten') ?? ar.minutes;
        ar.pauseInvites = i.options.getBoolean('einladungen_pausieren') ?? ar.pauseInvites;
        ar.kickRaiders = i.options.getBoolean('raider_kicken') ?? ar.kickRaiders;
        saveConfig(i.guild.id);
        return respond(i, ok(`Anti-Raid **${ar.enabled ? 'an' : 'aus'}**: ab ${ar.joins} Beitritten in ${ar.seconds} s → ${ar.action === 'lockdown' ? 'Lockdown' : 'Warnung'} für ${ar.minutes} Min.`));
      }
      if (sub === 'accountage') {
        ar.minAccountDays = i.options.getInteger('tage');
        ar.accountAction = i.options.getString('aktion') || ar.accountAction;
        saveConfig(i.guild.id);
        return respond(i, ok(ar.minAccountDays ? `Accounts jünger als **${ar.minAccountDays} Tage** werden abgewiesen (${ar.accountAction}).` : 'Mindest-Accountalter ausgeschaltet.'));
      }
      if (sub === 'start') {
        await i.deferReply();
        const steps = await antiraid.triggerRaid(i.guild, [], `Manuell von ${i.user.tag}`, i.user);
        return respond(i, new EmbedBuilder().setColor(COLORS.protect).setTitle('🚨 Raid-Schutz aktiv').setDescription(steps.map(s => `• ${s}`).join('\n') || 'Aktiv.'));
      }
      if (sub === 'stop') {
        await antiraid.stopRaid(i.guild);
        return respond(i, ok('Raid-Schutzmodus beendet, Einladungen wieder aktiv. Läuft noch ein Lockdown? → `/lockdown end`'));
      }
    },
  },

  // ---------------- ANTI-NUKE ----------------
  {
    data: new SlashCommandBuilder().setName('antinuke').setDescription('Schutz gegen Zerstörung des Servers (gehackte Admins, böse Bots)')
      .setDefaultMemberPermissions(P.Administrator)
      .addSubcommand(s => s.setName('status').setDescription('Einstellungen anzeigen'))
      .addSubcommand(s => s.setName('set').setDescription('Einstellen (nur Server-Inhaber)')
        .addBooleanOption(o => o.setName('an').setDescription('an?'))
        .addIntegerOption(o => o.setName('schwelle').setDescription('Ab so vielen zerstörerischen Aktionen …').setMinValue(2).setMaxValue(50))
        .addIntegerOption(o => o.setName('sekunden').setDescription('… in so vielen Sekunden').setMinValue(5).setMaxValue(600))
        .addStringOption(o => o.setName('strafe').setDescription('Strafe für den Täter').addChoices(
          { name: 'Alle Rollen entfernen + Timeout (empfohlen)', value: 'strip' }, { name: 'Kicken', value: 'kick' }, { name: 'Bannen', value: 'ban' }))
        .addBooleanOption(o => o.setName('wiederherstellen').setDescription('Gelöschte Kanäle/Rollen wiederherstellen und Banns aufheben?'))
        .addBooleanOption(o => o.setName('bots_blockieren').setDescription('Neue Bots nur von vertrauenswürdigen Personen erlauben?')))
      .addSubcommand(s => s.setName('trust').setDescription('Person als vertrauenswürdig markieren / entfernen (nur Inhaber)')
        .addUserOption(o => o.setName('person').setDescription('Person oder Bot').setRequired(true))),
    async execute(i) {
      const cfg = getConfig(i.guild.id);
      const an = cfg.antinuke;
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        return respond(i, new EmbedBuilder().setColor(COLORS.brand).setTitle('☢️ Anti-Nuke').setDescription([
          `**Status:** ${onOff(an.enabled)}`,
          `**Auslöser:** ${an.threshold} zerstörerische Aktionen in ${an.seconds} Sekunden (Kanäle/Rollen löschen, Massen-Bann/-Kick, Webhooks …)`,
          `**Strafe:** ${{ strip: 'Rollen entfernen + Timeout', kick: 'Kick', ban: 'Bann' }[an.punishment]}`,
          `**Wiederherstellen:** ${an.restore ? 'ja' : 'nein'} · **Bots blockieren:** ${an.blockBots ? 'ja' : 'nein'}`,
          `**Vertrauenswürdig:** <@${i.guild.ownerId}> (Inhaber) ${an.trusted.map(id => `<@${id}>`).join(' ')}`,
          '',
          '⚠️ Damit der Schutz greifen kann, muss **meine Rolle ganz oben** in der Rollenliste stehen.',
        ].join('\n')));
      }
      if (i.user.id !== i.guild.ownerId) return respond(i, err('Nur der Server-Inhaber kann Anti-Nuke ändern (Schutz gegen gehackte Admin-Accounts).'));
      if (sub === 'set') {
        an.enabled = i.options.getBoolean('an') ?? an.enabled;
        an.threshold = i.options.getInteger('schwelle') ?? an.threshold;
        an.seconds = i.options.getInteger('sekunden') ?? an.seconds;
        an.punishment = i.options.getString('strafe') ?? an.punishment;
        an.restore = i.options.getBoolean('wiederherstellen') ?? an.restore;
        an.blockBots = i.options.getBoolean('bots_blockieren') ?? an.blockBots;
        saveConfig(i.guild.id);
        return respond(i, ok(`Anti-Nuke **${an.enabled ? 'an' : 'aus'}**: ab ${an.threshold} Aktionen in ${an.seconds} s → ${an.punishment}.`));
      }
      if (sub === 'trust') {
        const u = i.options.getUser('person');
        const idx = an.trusted.indexOf(u.id);
        if (idx >= 0) an.trusted.splice(idx, 1); else an.trusted.push(u.id);
        saveConfig(i.guild.id);
        return respond(i, ok(`${u} ist jetzt ${idx >= 0 ? '**nicht mehr**' : ''} vertrauenswürdig${idx >= 0 ? '' : ' und wird von Anti-Nuke nicht bestraft'}.`));
      }
    },
  },
];
