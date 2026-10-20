'use strict';
/**
 * Selbsttest ohne Discord-Verbindung: lädt alle Module, prüft die Slash-Befehle gegen Discords Grenzen,
 * testet Linkschutz, Zeitangaben, Speicher, Level-Formel, Lockdown (mit nachgebauten Kanälen),
 * AutoMod (mit nachgebauten Nachrichten) und rendert Beispiel-Bildkarten.
 * Start: npm run check
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}

(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botdata-'));
  delete process.env.MONGODB_URI;
  const store = require('../src/lib/store');
  await store.init();

  console.log('\n📦 Module');
  const { commands } = require('../src/handlers/interactions');
  await test('Alle Module laden ohne Fehler', () => {
    const walkDir = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walkDir(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
    for (const f of walkDir(path.join(__dirname, '../src'))) if (!f.endsWith('index.js')) require(f);
  });

  console.log('\n⌨️  Slash-Befehle');
  const body = commands.map(c => c.data.toJSON());
  await test(`${body.length} Befehle bauen gültiges JSON`, () => assert(body.length > 20));
  await test('Höchstens 100 Befehle', () => assert(body.length <= 100));
  function walk(o, cb, depth = 0) {
    cb(o, depth);
    for (const opt of o.options || []) walk(opt, cb, depth + 1);
  }
  await test('Namen/Beschreibungen/Auswahlen innerhalb der Discord-Grenzen', () => {
    for (const c of body) {
      walk(c, (o) => {
        assert(/^[-_\p{Ll}\p{Lo}\p{N}]{1,32}$/u.test(o.name) && o.name === o.name.toLowerCase(), `Ungültiger Name: ${o.name}`); // Discord-Regel: Kleinbuchstaben inkl. Umlaute
        assert(o.description && o.description.length <= 100, `Beschreibung zu lang/leer: ${c.name}/${o.name} (${o.description?.length})`);
        assert((o.options || []).length <= 25, `Zu viele Optionen in ${o.name}`);
        for (const ch of o.choices || []) assert(ch.name.length <= 100, `Auswahl zu lang: ${ch.name}`);
        const req = (o.options || []).map(x => !!x.required);
        assert(req.indexOf(false) === -1 || req.lastIndexOf(true) < req.indexOf(false), `Pflicht-Optionen müssen zuerst kommen: ${c.name}/${o.name}`);
      });
    }
  });
  await test('Jeder Befehl unter 4000 Zeichen (Discord-Grenze)', () => {
    for (const c of body) {
      let n = 0;
      walk(c, o => { n += o.name.length + (o.description || '').length; for (const ch of o.choices || []) n += ch.name.length + String(ch.value).length; });
      assert(n <= 4000, `/${c.name} hat ${n} Zeichen`);
    }
  });
  const sizes = body.map(c => { let n = 0; walk(c, o => { n += o.name.length + (o.description || '').length; for (const ch of o.choices || []) n += ch.name.length + String(ch.value).length; }); return [c.name, n]; }).sort((a, b) => b[1] - a[1]);
  console.log(`     größte: ${sizes.slice(0, 3).map(([n, s]) => `/${n} ${s}`).join(', ')}`);

  console.log('\n🔗 Linkschutz');
  const lf = require('../src/lib/linkFilter');
  const smart = { mode: 'smart', allow: [], block: [] };
  const allowed = ['https://tenor.com/view/cat-123', 'https://media.discordapp.net/a.gif', 'https://giphy.com/gifs/x', 'https://klipy.com/gifs/x',
    'https://youtu.be/abc', 'https://www.twitch.tv/x', 'https://discogs.com', 'https://glitch.com', 'https://www.spiegel.de/x', 'https://discordbotlist.com', 'https://github.com/x/y'];
  const blocked = ['https://dlscord.gift/x', 'https://disc0rd.com/n', 'https://steamcommunlty.com/t', 'https://discord-nitro-free.ru/c', 'http://1.2.3.4/x',
    'https://bit.ly/x', 'https://grabify.link/x', 'https://free.tk', 'https://xn--dscord-6va.com', 'https://discord.com@evil.ru', 'https://steamcommunity-trade.com'];
  await test('GIFs und normale Seiten sind erlaubt', () => { for (const u of allowed) assert(!lf.classify(u, smart).block, u); });
  await test('Betrug, IP-Logger, Kurz-Links, IP-Adressen werden blockiert', () => { for (const u of blocked) assert(lf.classify(u, smart).block, u); });
  await test('Streng-Modus: nur Erlaubt-Liste', () => {
    assert(lf.classify('https://spiegel.de', { mode: 'strict', allow: [] }).block);
    assert(!lf.classify('https://spiegel.de', { mode: 'strict', allow: ['spiegel.de'] }).block);
    assert(!lf.classify('https://tenor.com/x', { mode: 'strict', allow: [] }).block);
  });
  await test('Eigene Sperrliste schlägt alles', () => assert(lf.classify('https://youtube.com', { mode: 'smart', block: ['youtube.com'] }).block));
  await test('Links im Text finden (mit/ohne https)', () => {
    const u = lf.extractUrls('a https://tenor.com/x b discord-nitro.ru/claim c z.B. nix (www.test.de).');
    assert.deepStrictEqual(u.sort(), ['discord-nitro.ru/claim', 'https://tenor.com/x', 'www.test.de'].sort());
  });
  await test('Discord-Einladungen erkennen', () => assert.deepStrictEqual(lf.extractInvites('discord.gg/abc und https://discord.com/invite/XyZ'), ['abc', 'XyZ']));
  const n = await lf.loadPhishingLists();
  await test(`Öffentliche Betrugslisten laden (${n} Domains)`, () => assert(n > 1000, 'Listen nicht erreichbar'));

  console.log('\n⏱️  Zeitangaben');
  const { parseDuration, formatDuration, fillTemplate } = require('../src/lib/util');
  await test('parseDuration', () => {
    assert.strictEqual(parseDuration('10m'), 600_000);
    assert.strictEqual(parseDuration('1h30m'), 5_400_000);
    assert.strictEqual(parseDuration('2 tage'), 172_800_000);
    assert.strictEqual(parseDuration('45'), 2_700_000);
    assert.strictEqual(parseDuration('7d'), 604_800_000);
    assert.strictEqual(parseDuration('quatsch'), null);
    assert.strictEqual(parseDuration('10x'), null);
  });
  await test('formatDuration', () => assert.strictEqual(formatDuration(90_061_000), '1 Tag 1 Std. 1 Min.'));
  await test('Platzhalter ersetzen', () => assert.strictEqual(
    fillTemplate('Hi {user} auf {server} #{count} {unbekannt}', { user: { id: '1', username: 'max' }, guild: { name: 'G', memberCount: 5 } }), 'Hi <@1> auf G #5 {unbekannt}'));

  console.log('\n💾 Speicher & Einstellungen');
  const { getConfig, saveConfig } = require('../src/lib/config');
  await test('Standardwerte + Speichern + Neu laden', async () => {
    const c = getConfig('g1'); c.modRoles.push('r1'); saveConfig('g1');
    await store.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'guilds.json'), 'utf8'));
    assert.deepStrictEqual(raw.g1.modRoles, ['r1']);
    assert.strictEqual(raw.g1.automod.links.mode, 'smart');
  });

  console.log('\n⭐ Level');
  const lv = require('../src/modules/leveling');
  await test('Level-Formel ETC. (100 × Level²) passt zu den Screenshots des alten Bots', () => {
    assert.strictEqual(lv.levelFromXp(0).level, 0);
    assert.strictEqual(lv.levelFromXp(100).level, 1);
    assert.strictEqual(lv.levelFromXp(lv.xpForLevel(10)).level, 10);
    assert.strictEqual(lv.levelFromXp(lv.xpForLevel(10) - 1).level, 9);
    assert.strictEqual(lv.levelFromXp(84_100).nextTotal, 90_000, 'Level 29 → nächstes Level bei 90.000 XP');
    assert.strictEqual(lv.levelFromXp(114_451).level, 33, '114.451 XP = Level 33');
  });
  await test('Level-Formel MEE6 pro Server umschaltbar', () => {
    getConfig('g-mee6').levels.formula = 'mee6';
    assert.strictEqual(lv.levelFromXp(254, 'g-mee6').level, 1);
    assert.strictEqual(lv.levelFromXp(255, 'g-mee6').level, 2, 'MEE6: Level 2 ab 100 + 155 XP');
    assert.strictEqual(lv.levelFromXp(255).level, 1, 'ohne Server bleibt die ETC.-Formel');
  });
  await test('XP-Import: CSV mit Tausenderpunkten, Level-Spalte, JSON', () => {
    assert.deepStrictEqual(lv.parseImport('Name;XP\nBastian;114.451\nMax;2.000'), [{ who: 'Bastian', xp: 114451, level: null }, { who: 'Max', xp: 2000, level: null }]);
    assert.deepStrictEqual(lv.parseImport('Name;Level\nMax;12\nLea;Level 7').map(r => r.level), [12, 7]);
    assert.deepStrictEqual(lv.parseImport('[{"id":"123456789012345678","xp":5000}]'), [{ who: '123456789012345678', xp: 5000, level: null }]);
  });
  await test('XP-Import ordnet Namen Mitgliedern zu und meldet Unbekannte', async () => {
    const member = (id, username, displayName) => ({ id, displayName, nickname: null, user: { username, globalName: null } });
    const guild = { id: 'g-imp', client: { options: { intents: { has: () => false } } }, members: { cache: new Map([['111111111111111111', member('111111111111111111', 'bastian', 'Bastian')], ['222222222222222222', member('222222222222222222', 'max', 'Maxi')]]) } };
    const r = await lv.importXp(guild, 'Name;XP\nBastian;114.451\nMaxi;500\nUnbekannt;5');
    assert.deepStrictEqual([r.imported, r.missing], [2, ['Unbekannt']]);
    assert.strictEqual(lv.levelFromXp(lv.getData('g-imp', '111111111111111111').xp, 'g-imp').level, 33);
    await lv.importXp(guild, 'Maxi;100', { mode: 'add' });
    assert.strictEqual(lv.getData('g-imp', '222222222222222222').xp, 600, 'Modus „dazu“ addiert');
  });

  // ---------- Nachgebaute Discord-Objekte ----------
  const { PermissionsBitField, ChannelType, Collection } = require('discord.js');
  function fakeOverwrites(initial = []) {
    const cache = new Collection();
    const mk = (id, type, allow = 0n, deny = 0n) => ({
      id, type, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny),
      delete: async () => { cache.delete(id); },
    });
    for (const o of initial) cache.set(o.id, mk(o.id, o.type, o.allow, o.deny));
    return {
      cache,
      async edit(id, opts) {
        const cur = cache.get(id) || mk(id, id.startsWith('role') || id === 'guild' ? 0 : 1);
        let allow = cur.allow.bitfield, deny = cur.deny.bitfield;
        for (const [k, v] of Object.entries(opts)) {
          const bit = PermissionsBitField.Flags[k];
          allow &= ~bit; deny &= ~bit;
          if (v === true) allow |= bit; else if (v === false) deny |= bit;
        }
        cache.set(id, mk(id, cur.type, allow, deny));
      },
    };
  }
  const F = PermissionsBitField.Flags;
  function fakeGuild() {
    const everyone = { id: 'guild' };
    const roles = new Collection([['guild', { id: 'guild', permissions: new PermissionsBitField(F.ViewChannel | F.SendMessages) }],
      ['role-member', { id: 'role-member', permissions: new PermissionsBitField(F.SendMessages) }],
      ['role-mod', { id: 'role-mod', permissions: new PermissionsBitField(F.ManageMessages) }]]);
    const guild = { id: 'g-lock', roles: { everyone, cache: roles }, channels: { cache: new Collection() }, setIncidentActions: async () => ({}), client: { user: { id: 'bot' } } };
    const mkCh = (id, type, ow, visible = true) => ({
      id, name: id, type, guild, permissionOverwrites: fakeOverwrites(ow),
      permissionsFor: () => ({ has: () => visible }), isTextBased: () => type !== ChannelType.GuildVoice, send: async () => ({}),
    });
    guild.channels.cache.set('allgemein', mkCh('allgemein', ChannelType.GuildText, []));
    guild.channels.cache.set('chat', mkCh('chat', ChannelType.GuildText, [{ id: 'guild', type: 0, allow: F.AddReactions, deny: 0n }, { id: 'role-member', type: 0, allow: F.SendMessages, deny: 0n }]));
    guild.channels.cache.set('voice', mkCh('voice', ChannelType.GuildVoice, [{ id: 'guild', type: 0, allow: 0n, deny: F.Speak }]));
    guild.channels.cache.set('privat', mkCh('privat', ChannelType.GuildText, [{ id: 'guild', type: 0, allow: 0n, deny: F.ViewChannel }], false));
    return guild;
  }
  const dump = g => JSON.stringify([...g.channels.cache.values()].map(c => [c.id, [...c.permissionOverwrites.cache.values()].map(o => [o.id, String(o.allow.bitfield), String(o.deny.bitfield)]).sort()]));

  console.log('\n🔒 Lockdown (nachgebauter Server)');
  const lockdown = require('../src/modules/lockdown');
  await test('Start sperrt öffentliche Kanäle, Ende stellt alles exakt wieder her', async () => {
    const g = fakeGuild();
    getConfig(g.id).modRoles = ['role-mod'];
    const before = dump(g);
    const r = await lockdown.start(g, { reason: 'Test', pauseInvites: true });
    assert.strictEqual(r.locked, 3, 'allgemein, chat, voice');
    const chat = g.channels.cache.get('chat').permissionOverwrites.cache;
    assert(chat.get('guild').deny.has(F.SendMessages), '@everyone darf nicht schreiben');
    assert(!chat.get('role-member').allow.has(F.SendMessages), 'Member-Rolle neutralisiert');
    assert(chat.get('role-mod').allow.has(F.SendMessages), 'Mod-Rolle darf schreiben');
    assert(g.channels.cache.get('voice').permissionOverwrites.cache.get('guild').deny.has(F.Connect), 'Voice gesperrt');
    assert.strictEqual(g.channels.cache.get('privat').permissionOverwrites.cache.size, 1, 'privater Kanal unberührt');
    assert((await lockdown.start(g, {})).already, 'kein doppelter Lockdown');
    await lockdown.end(g, {});
    assert.strictEqual(dump(g), before, 'Berechtigungen nach dem Ende identisch');
  });

  console.log('\n🔊 Temp-Sprachkanäle (nachgebauter Kanal)');
  const tempvoice = require('../src/modules/tempvoice');
  await test('Bedienfeld nur in Rot und Grau (Rot-Schwarz-Theme)', () => {
    const { ButtonStyle } = require('discord.js');
    for (const r of [{}, { locked: true, hidden: true, timerAt: Date.now() }]) {
      const styles = tempvoice.panelComponents(r).flatMap(row => row.components.map(b => b.data.style));
      assert.strictEqual(styles.length, 20);
      assert(styles.every(st => st === ButtonStyle.Danger || st === ButtonStyle.Secondary), 'nur rot/grau');
    }
  });
  await test('Profile: max. 5, gleicher Name ersetzt, letztes = Schnellladen', () => {
    for (const n of ['Zocken', 'Chill', 'Film', 'Lernen', 'Party', 'Nacht']) tempvoice.saveProfile('g-prof', 'u1', n, { name: n, limit: 4 });
    tempvoice.saveProfile('g-prof', 'u1', 'chill', { name: 'Chill 2', limit: 2 });
    const p = tempvoice.getPrefs('g-prof', 'u1');
    assert.deepStrictEqual(p.profiles.map(x => x.name), ['chill', 'Nacht', 'Party', 'Lernen', 'Film']);
    assert.strictEqual(p.quick, 'chill');
  });
  await test('Sperren, Bannen, Entbannen, Übertragen + gemerkte Bannliste', async () => {
    const g = fakeGuild();
    g.id = 'g-tv';
    const ch = { id: 'vc1', name: 'Kanal', guild: g, client: g.client, permissionOverwrites: fakeOverwrites([{ id: 'guild', type: 0, allow: 0n, deny: 0n }, { id: 'role-member', type: 0, allow: F.Connect, deny: 0n }]), members: new Collection(), setUserLimit: async () => {} };
    ch.permissionOverwrites.delete = async id => { ch.permissionOverwrites.cache.delete(id); };
    store.set('tempvoice', 'vc1', { guildId: 'g-tv', ownerId: 'owner1', createdAt: Date.now(), locked: false, hidden: false, banned: [] });
    const r = tempvoice.rec('vc1');
    const ow = () => ch.permissionOverwrites.cache;
    await tempvoice.actions.lock(ch, r, true);
    assert(ow().get('guild').deny.has(F.Connect) && ow().get('role-member').deny.has(F.Connect), 'gesperrt');
    await tempvoice.actions.permit(ch, r, ['friend']);
    assert(ow().get('friend').allow.has(F.Connect), 'Freund darf rein');
    await tempvoice.actions.ban(ch, r, ['troll']);
    assert(ow().get('troll').deny.has(F.Connect) && ow().get('troll').deny.has(F.ViewChannel), 'gebannt');
    assert.deepStrictEqual(tempvoice.getPrefs('g-tv', 'owner1').banned, ['troll'], 'Bannliste gemerkt');
    await tempvoice.actions.unban(ch, r, ['troll']);
    assert(!ow().has('troll') && tempvoice.getPrefs('g-tv', 'owner1').banned.length === 0, 'entbannt');
    await tempvoice.actions.lock(ch, r, false);
    assert(!ow().get('guild').deny.has(F.Connect), 'wieder offen');
    const snap = tempvoice.capture(ch, r);
    assert(snap.permitted.includes('friend') && !snap.locked, 'Profil merkt erlaubte Personen und Sperre');
    await tempvoice.actions.transfer(ch, r, 'friend');
    assert.strictEqual(tempvoice.rec('vc1').ownerId, 'friend');
    assert(ow().get('friend').allow.has(F.ManageChannels), 'neuer Besitzer hat Rechte');
  });

  console.log('\n🤖 AutoMod (nachgebaute Nachrichten)');
  const automod = require('../src/modules/automod');
  function fakeMessage(content, { staff = false } = {}) {
    const g = { id: 'g-auto', ownerId: 'owner', roles: { cache: new Collection() }, channels: { cache: new Collection() }, client: { user: { id: 'bot', tag: 'Bot#0' } } };
    const state = { deleted: false, notices: [] };
    const member = {
      id: 'u1', guild: g, user: { id: 'u1', tag: 'u#1', send: async () => {} }, roles: { cache: new Collection() },
      permissions: new PermissionsBitField(staff ? F.Administrator : 0n), moderatable: true, kickable: true, bannable: true,
      timeout: async () => { state.timeout = true; },
    };
    const msg = {
      id: String(Math.random()), content, guild: g, member, webhookId: null,
      author: { id: 'u1', bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
      channel: { id: 'c1', parentId: null, send: async m => { state.notices.push(m.content); return { delete: async () => {} }; } },
      client: g.client, mentions: { users: new Collection(), roles: new Collection() },
      delete: async () => { state.deleted = true; },
    };
    return { msg, state };
  }
  await test('GIF-Link bleibt stehen', async () => { const { msg, state } = fakeMessage('lol https://tenor.com/view/x-123'); assert(!(await automod.handle(msg))); assert(!state.deleted); });
  await test('Phishing-Link wird gelöscht + Timeout', async () => { const { msg, state } = fakeMessage('free nitro https://discord-nitro-free.ru/claim'); assert(await automod.handle(msg)); assert(state.deleted && state.timeout); });
  await test('IP-Logger wird gelöscht', async () => { const { msg, state } = fakeMessage('schau grabify.link/abc'); assert(await automod.handle(msg)); assert(state.deleted); });
  await test('Admins werden nicht gefiltert', async () => { const { msg, state } = fakeMessage('https://bit.ly/x', { staff: true }); assert(!(await automod.handle(msg))); assert(!state.deleted); });
  await test('Spam: 7 Nachrichten in kurzer Zeit → Timeout', async () => {
    let last;
    for (let k = 0; k < 7; k++) { last = fakeMessage(`nachricht ${k}`); last.msg.author.id = 'spammer'; last.msg.member.id = 'spammer'; await automod.handle(last.msg); }
    assert(last.state.deleted && last.state.timeout);
  });

  // ---------- Fake-Mitglied für Quests/Level/Münzen ----------
  function fakeMember(id, guildId = 'g-q') {
    const sent = [];
    const guild = { id: guildId, roles: { cache: new Collection() }, channels: { cache: new Collection() } };
    const channel = { isTextBased: () => true, send: async m => { sent.push(m); return { delete: async () => {} }; } };
    const avatar = () => 'https://cdn.discordapp.com/embed/avatars/0.png';
    return { id, guild, user: { id, bot: false, displayAvatarURL: avatar }, displayAvatarURL: avatar, roles: { cache: new Collection(), add: async () => {} }, displayName: id, sent, channel };
  }

  console.log('\n🗓️  Quests, Level & Münzen');
  const quests = require('../src/modules/quests');
  const economy = require('../src/modules/economy');
  await test('Tages-Quests sind pro Person und Tag fest und passen zur Einstellung', () => {
    const a = quests.todays('g-q', 'u1'), b = quests.todays('g-q', 'u1');
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.length, 3);
    assert(a.every(q => q.target > 0 && q.xp > 0 && q.coins > 0));
    assert(!a.some(q => q.id === 'clip'), 'Clip-Quest nur mit Clip-Kanal');
  });
  await test('Quest erledigen gibt XP + Münzen, alle erledigen gibt Bonus + Serie', async () => {
    const m = fakeMember('u2');
    const list = quests.todays('g-q', 'u2');
    const xp0 = lv.getData('g-q', 'u2').xp;
    for (const q of list) await quests.progress(m, q.id, q.target, m.channel);
    const st = quests.state('g-q', 'u2');
    assert.strictEqual(st.done.length, list.length);
    assert.strictEqual(st.streak, 1);
    assert(lv.getData('g-q', 'u2').xp > xp0 + list.reduce((s, q) => s + q.xp, 0), 'Bonus-XP fehlt');
    assert(economy.balance('g-q', 'u2') >= list.reduce((s, q) => s + q.coins, 0) + 100);
    assert(m.sent.length >= list.length, 'Meldung im Chat');
  });
  await test('Tagesbelohnung nur einmal, Überweisen prüft Kontostand', () => {
    const m = fakeMember('u3');
    const r1 = economy.daily(m), r2 = economy.daily(m);
    assert(r1.ok && r1.amount === 100 && !r2.ok);
    assert(!economy.transfer('g-q', 'u3', 'u4', 1000));
    assert(economy.transfer('g-q', 'u3', 'u4', 40));
    assert.strictEqual(economy.balance('g-q', 'u4'), 40);
  });
  await test('Level-Ups standardmäßig still, mit Schalter gemeldet', async () => {
    const m = fakeMember('u5');
    const still = await lv.addXp(m, 150, { channel: m.channel });
    assert(still.levelUp && still.level === 1 && m.sent.length === 0, 'Standard: keine Meldung (nachschauen mit /lvl)');
    getConfig(m.guild.id).levels.announce = true;
    const r = await lv.addXp(m, 300, { channel: m.channel });
    assert(r.levelUp && r.level === 2 && m.sent.length === 1);
    getConfig(m.guild.id).levels.announce = false;
  });

  console.log('\n🎬 Clips');
  const clips = require('../src/modules/clips');
  await test('Clips erkennen (Video-Datei, Medal, Twitch-Clip) – normale Links nicht', () => {
    const msg = (content, att = []) => ({ content, attachments: new Collection(att.map((a, k) => [String(k), a])) });
    assert(clips.isClip(msg('', [{ name: 'clutch.mp4', contentType: 'video/mp4' }])));
    assert(clips.isClip(msg('https://medal.tv/games/valorant/clips/abc')));
    assert(clips.isClip(msg('https://clips.twitch.tv/Name')));
    assert(!clips.isClip(msg('https://example.org/text')));
    assert(!clips.isClip(msg('', [{ name: 'bild.png', contentType: 'image/png' }])));
  });

  console.log('\n🛠️  Dashboard-Eingaben');
  const { applyChanges } = require('../src/web/schema');
  const fg = {
    id: 'g-s',
    channels: { cache: new Collection([['111', { id: '111', type: ChannelType.GuildText }], ['222', { id: '222', type: ChannelType.GuildVoice }], ['333', { id: '333', type: ChannelType.GuildCategory }]]) },
    roles: { cache: new Collection([['g-s', { id: 'g-s' }], ['900', { id: '900' }]]) },
  };
  await test('Gültige Werte werden übernommen', () => {
    const c = getConfig('g-s');
    const r = applyChanges(c, { 'welcome.channel': '111', 'automod.spam.maxMessages': 8, 'tempvoice.hubs': [{ id: '222', category: '333', nameTemplate: '🎮 {name}', limit: 4 }], 'levels.rewards': { 10: '900' }, 'automod.links.allow': ['https://www.MeineSeite.de/x'] }, fg, { isOwner: false });
    assert.deepStrictEqual(r.errors, {});
    assert.strictEqual(c.welcome.channel, '111');
    assert.strictEqual(c.tempvoice.hubs[0].limit, 4);
    assert.deepStrictEqual(c.automod.links.allow, ['meineseite.de']);
  });
  await test('Wochen-Posts, Level-Formel und -Stil über das Dashboard', () => {
    const c = getConfig('g-s');
    const good = applyChanges(c, { 'posts.animal.enabled': true, 'posts.animal.channel': '111', 'posts.animal.weekday': 3, 'posts.animal.time': '18:30', 'posts.animal.source': 'cats', 'posts.leaderboard.time': '09:05', 'levels.formula': 'mee6', 'levels.style': 'text' }, fg, { isOwner: false });
    assert.deepStrictEqual(good.errors, {});
    assert.strictEqual(c.posts.animal.weekday, 3);
    const bad = applyChanges(c, { 'posts.animal.time': '25:00', 'posts.animal.weekday': 7, 'posts.animal.channel': '222', 'levels.formula': 'xyz', 'posts.animal.lastRun': 'x' }, fg, { isOwner: false });
    assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['levels.formula', 'posts.animal.channel', 'posts.animal.lastRun', 'posts.animal.time', 'posts.animal.weekday']);
    c.levels.formula = 'etc';
  });
  await test('Ungültige Werte, falsche Kanaltypen und Fremd-Schlüssel werden abgelehnt', () => {
    const c = getConfig('g-s');
    const r = applyChanges(c, { 'welcome.channel': '222', 'automod.spam.maxMessages': 999, 'tempvoice.hubs': [{ id: '111' }], 'lockdown.active': true, 'antinuke.enabled': false, 'automod.links.allow': ['kein domain'] }, fg, { isOwner: false });
    for (const k of ['welcome.channel', 'automod.spam.maxMessages', 'tempvoice.hubs', 'lockdown.active', 'antinuke.enabled', 'automod.links.allow']) assert(r.errors[k], `${k} hätte abgelehnt werden müssen`);
    assert.strictEqual(c.antinuke.enabled, true);
    assert.strictEqual(c.lockdown.active, false);
  });

  console.log('\n🌐 Web-Server (Dashboard-API)');
  let webGuild;
  await test('Statusseite, Login-Schutz, Einstellungen speichern', async () => {
    process.env.PORT = '3987';
    process.env.DISCORD_CLIENT_SECRET = 'test';
    const guild = {
      ...fg, name: 'Testserver', ownerId: 'owner', memberCount: 3, iconURL: () => null,
      members: { cache: new Collection(), fetch: async () => ({ permissions: { has: () => true } }) },
    };
    for (const c of guild.channels.cache.values()) Object.assign(c, { name: 'k' + c.id, parentId: null, rawPosition: 0, isThread: () => false });
    for (const r of guild.roles.cache.values()) Object.assign(r, { name: 'r', position: 1, managed: false, editable: true, color: 0 });
    const client = { isReady: () => true, user: { id: 'bot', tag: 'Bot#1' }, application: { id: 'bot' }, ws: { ping: 42 }, guilds: { cache: new Collection([['g-s', guild]]) }, users: { fetch: async () => ({ id: 'u', tag: 'u' }) }, options: { intents: { has: () => false } } };
    guild.client = client;
    webGuild = guild;
    require('../src/web/server').start(client);
    await new Promise(r => setTimeout(r, 300));
    const base = 'http://127.0.0.1:3987';
    const health = await (await fetch(base + '/health')).json();
    assert.strictEqual(health.status, 'online');
    const page = await (await fetch(base + '/')).text();
    assert(page.includes('Mit Discord anmelden'));
    assert.strictEqual((await fetch(base + '/api/me')).status, 401);
    const sid = 'a'.repeat(64);
    store.set('sessions', sid, { userId: 'u', username: 'Test', guilds: [{ id: 'g-s', name: 'Testserver' }], exp: Date.now() + 60_000 });
    const H = { cookie: `sid=${sid}`, 'content-type': 'application/json' };
    const me = await (await fetch(base + '/api/me', { headers: H })).json();
    assert.strictEqual(me.guilds[0].botPresent, true);
    const gd = await (await fetch(base + '/api/guild/g-s', { headers: H })).json();
    assert.strictEqual(gd.guild.name, 'Testserver');
    assert(!('backup' in gd.config.lockdown), 'interne Daten nicht ausgeben');
    const noCsrf = await fetch(base + '/api/guild/g-s/config', { method: 'PATCH', headers: H, body: JSON.stringify({ changes: { 'levels.enabled': false } }) });
    assert.strictEqual(noCsrf.status, 403);
    const okRes = await (await fetch(base + '/api/guild/g-s/config', { method: 'PATCH', headers: { ...H, 'x-requested-with': 'dashboard' }, body: JSON.stringify({ changes: { 'levels.enabled': false } }) })).json();
    assert.deepStrictEqual(okRes.applied, ['levels.enabled']);
    assert.strictEqual(getConfig('g-s').levels.enabled, false);
  });

  await test('Mitglieder-API: Liste, Details, Rolle geben, Level setzen, Rollen-Grenze', async () => {
    const base = 'http://127.0.0.1:3987';
    const g = webGuild;
    let actorCmp = 1; // höchste Rolle der angemeldeten Person im Vergleich zur Zielrolle
    const actor = { id: 'u', permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => actorCmp } }, user: { id: 'u', tag: 'u#1' } };
    const target = {
      id: '555', displayName: 'Lea', guild: g, joinedTimestamp: Date.now() - 5000, communicationDisabledUntilTimestamp: null, premiumSinceTimestamp: null, displayColor: 0,
      user: { id: '555', username: 'lea', bot: false, createdTimestamp: 1 }, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
      roles: { cache: new Collection(), add: async r => target.roles.cache.set(r.id, r), remove: async r => target.roles.cache.delete(r.id), highest: { comparePositionTo: () => -1 } },
      permissions: { has: () => false }, voice: {}, manageable: true,
    };
    g.members.cache.set('555', target);
    g.members.fetch = async arg => (arg === 'u' ? actor : g.members.cache.get(typeof arg === 'string' ? arg : arg?.user));
    const sid = 'b'.repeat(64);
    store.set('sessions', sid, { userId: 'u', username: 'Mod', guilds: [{ id: 'g-s', name: 'Testserver' }], exp: Date.now() + 60_000 });
    const H = { cookie: `sid=${sid}`, 'content-type': 'application/json' }, HX = { ...H, 'x-requested-with': 'dashboard' };
    const list = await (await fetch(base + '/api/guild/g-s/members', { headers: H })).json();
    assert(list.members.some(m => m.id === '555' && m.name === 'Lea'));
    const d = await (await fetch(base + '/api/guild/g-s/members/555', { headers: H })).json();
    assert.strictEqual(d.level, 0); assert.strictEqual(d.xpNeed, 100);
    const act = body => fetch(base + '/api/guild/g-s/members/555/action', { method: 'POST', headers: HX, body: JSON.stringify(body) });
    assert.strictEqual((await fetch(base + '/api/guild/g-s/members/555/action', { method: 'POST', headers: H, body: '{"type":"roleAdd","roleId":"900"}' })).status, 403, 'ohne Header abgelehnt');
    const add = await (await act({ type: 'roleAdd', roleId: '900' })).json();
    assert.deepStrictEqual(add.member.roles, ['900']);
    const lvl = await (await act({ type: 'level', value: 10 })).json();
    assert.strictEqual(lvl.member.level, 10); assert.strictEqual(lvl.member.xp, 10_000);
    actorCmp = -1;
    const deny = await act({ type: 'roleRemove', roleId: '900' });
    assert.strictEqual(deny.status, 400);
    assert.match((await deny.json()).error, /über deiner höchsten Rolle/);
    assert(target.roles.cache.has('900'), 'Rolle bleibt');
    g.members.cache.delete('555');
  });

  await test('Passwort-Login: richtig, falsch, Sperre nach 5 Fehlversuchen, Passwortwechsel', async () => {
    const base = 'http://127.0.0.1:3987';
    process.env.DASHBOARD_PASSWORD = 'test-123456';
    const methods = await (await fetch(base + '/auth/methods')).json();
    assert.deepStrictEqual(methods, { discord: true, password: true });
    const login = pw => fetch(base + '/login/password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'dashboard' }, body: JSON.stringify({ password: pw }) });
    assert.strictEqual((await fetch(base + '/login/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"test-123456"}' })).status, 403, 'ohne Header abgelehnt');
    const good = await login('test-123456');
    assert.strictEqual(good.status, 200);
    const sid = good.headers.getSetCookie().map(c => /^sid=([a-f0-9]{64})/.exec(c)?.[1]).find(Boolean);
    assert(sid, 'Sitzungs-Cookie fehlt');
    const H = { cookie: `sid=${sid}` };
    const me = await (await fetch(base + '/api/me', { headers: H })).json();
    assert.strictEqual(me.user.password, true);
    assert.deepStrictEqual(me.guilds.map(g => g.id), ['g-s'], 'Passwort-Sitzung sieht alle Bot-Server');
    assert.strictEqual((await (await fetch(base + '/api/guild/g-s', { headers: H })).json()).isOwner, true);
    process.env.DASHBOARD_PASSWORD = 'neues-passwort';
    assert.strictEqual((await fetch(base + '/api/me', { headers: H })).status, 401, 'alte Sitzung nach Passwortwechsel ungültig');
    for (let n = 1; n <= 5; n++) {
      const r = await login('falsch');
      assert.strictEqual(r.status, 401);
      if (n === 5) assert.match((await r.json()).error, /Gesperrt/);
    }
    assert.strictEqual((await login('neues-passwort')).status, 429, 'nach 5 Fehlversuchen gesperrt – auch mit richtigem Passwort');
    const legacy = await fetch(base + '/dashboard/?guildId=1213218593244712990', { redirect: 'manual' });
    assert.strictEqual(legacy.headers.get('location'), '/?guildId=1213218593244712990');
    delete process.env.DASHBOARD_PASSWORD;
  });

  console.log('\n🎵 Musik');
  await test('ffmpeg → Opus → Discord-Audio-Ressource funktioniert', async () => {
    const { spawn } = require('child_process');
    const { createAudioResource, StreamType } = require('@discordjs/voice');
    const ff = spawn(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=0.8,bass=g=12', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1']);
    const res = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus });
    let packets = 0;
    await new Promise((resolve, reject) => {
      res.playStream.on('data', () => { packets++; });
      res.playStream.on('end', resolve);
      res.playStream.on('error', reject);
      setTimeout(resolve, 8000);
    });
    assert(packets >= 90, `nur ${packets} Opus-Pakete (erwartet ~100 für 2 Sek.)`);
  });
  await test('yt-dlp-Ausgabe: mehrere JSON-Zeilen und Zusatztext brechen nicht ab', () => {
    const { parseJson } = require('../src/modules/music/ytdlp');
    const warn = console.warn; console.warn = () => {};
    try {
      const big = JSON.stringify({ title: 'Song', url: 'https://a/b', formats: Array(500).fill({ x: 1 }) });
      assert.strictEqual(parseJson(big)[0].title, 'Song');
      const multi = parseJson(`${big}\n${JSON.stringify({ title: 'Zwei' })}\n`);
      assert.strictEqual(multi.length, 2);
      assert.strictEqual(parseJson(`[info] irgendwas\n${big}\nnoch was`)[0].url, 'https://a/b');
      assert.throws(() => parseJson('nur Text'), /keine lesbaren/);
    } finally { console.warn = warn; }
  });
  await test('Alle Audio-Filter sind gültige ffmpeg-Filter', async () => {
    const { spawnSync } = require('child_process');
    const { FILTERS } = require('../src/modules/music/player');
    for (const [name, f] of Object.entries(FILTERS)) {
      if (!f.af) continue;
      const r = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.3', '-af', `${f.af},volume=1`, '-f', 'null', '-']);
      assert.strictEqual(r.status, 0, `Filter ${name}: ${r.stderr}`);
    }
  });

  await test('Musik-Notbremse: kaputte Songs → höchstens 3 Meldungen, dann Stopp (kein Spam)', async () => {
    const { GuildPlayer } = require('../src/modules/music/player');
    const p = new GuildPlayer({ id: 'g-spam', channels: { cache: new Collection() } });
    const said = [];
    p.textChannel = { send: async m => { said.push(m.content); return { delete: async () => {} }; } };
    p.startTrack = async () => { throw new Error('ffmpeg fehlt'); };
    p.queue = [1, 2, 3, 4, 5].map(n => ({ title: `Song ${n}`, url: 'x' }));
    await p.playNext();
    assert.strictEqual(said.length, 3, said.join(' | '));
    assert.match(said[2], /Musik gestoppt/);
    assert.strictEqual(p.queue.length, 0);
    // Sofortiger Abbruch ohne Fehlertext zählt als Fehler und schaltet die Wiederholung nicht in eine Schleife
    const q = new GuildPlayer({ id: 'g-spam2', channels: { cache: new Collection() } });
    const said2 = [];
    q.textChannel = { send: async m => { said2.push(m.content); return { delete: async () => {} }; } };
    let starts = 0;
    q.startTrack = async () => { starts++; q.startedAt = Date.now(); };
    q.sendNowPlaying = async () => {};
    q.loop = 'queue';
    q.current = { title: 'Kaputt', url: 'x', direct: true };
    q.startedAt = Date.now();
    for (let n = 0; n < 6 && q.current; n++) await q.onIdle();
    assert.strictEqual(starts, 0, 'kaputter Song wird bei Wiederholung nicht endlos neu gestartet');
    assert.strictEqual(q.queue.length, 0, 'und nicht wieder hinten angehängt');
    assert(said2.some(t => /ging nicht/.test(t) && /sofort abgebrochen/.test(t)), said2.join(' | '));
    p.player.stop(true); q.player.stop(true);
  });

  console.log('\n🖼️  Bildkarten');
  const cards = require('../src/lib/cards');
  await test('Willkommens- und Rangkarte rendern', async () => {
    assert(cards.available(), '@napi-rs/canvas nicht verfügbar');
    const user = { id: '1', username: 'Bastian', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
    const member = { id: '1', user, displayName: 'Bastian', guild: { name: 'Mein Server', memberCount: 128 } };
    const out = process.env.CARD_OUT || os.tmpdir();
    const w = await cards.welcomeCard(member);
    const r = await cards.rankCard(member, { level: 12, xpIn: 640, xpNeed: 1420, rank: 3, totalXp: 14320 });
    fs.writeFileSync(path.join(out, 'beispiel-willkommen.png'), w);
    fs.writeFileSync(path.join(out, 'beispiel-rang.png'), r);
    assert(w.length > 5000 && r.length > 5000);
  });
  await test('Bestenliste als Bild (Top 10)', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ name: `Spieler ${i + 1}`, avatar: null, level: 33 - i * 2, xp: 114451 - i * 9000 }));
    const png = await cards.leaderboardCard(entries, { subtitle: 'BESTENLISTE' });
    fs.writeFileSync(path.join(process.env.CARD_OUT || os.tmpdir(), 'beispiel-bestenliste.png'), png);
    assert(png.length > 10000 && png.subarray(1, 4).toString() === 'PNG');
  });

  console.log('\n📅 Wochen-Posts');
  const autoposts = require('../src/modules/autoposts');
  await test('Fällig genau einmal ab Wochentag + Uhrzeit (deutsche Zeit)', () => {
    const p = { enabled: true, channel: 'c', weekday: 0, time: '18:00', lastRun: null };
    const sun = (h, m = 0) => ({ weekday: 0, minutes: h * 60 + m, day: '2026-10-18' });
    assert(!autoposts.isDue(p, sun(17, 59)));
    assert(autoposts.isDue(p, sun(18, 0)));
    assert(autoposts.isDue(p, sun(23, 0)), 'auch nach Neustart später am Tag');
    assert(!autoposts.isDue({ ...p, lastRun: '2026-10-18' }, sun(19)), 'nicht doppelt');
    assert(!autoposts.isDue(p, { ...sun(19), weekday: 1 }));
    assert(!autoposts.isDue({ ...p, channel: null }, sun(19)));
    const de = autoposts.nowParts(new Date('2026-10-18T16:00:00Z'));
    assert.deepStrictEqual([de.weekday, de.minutes], [0, 18 * 60], 'Sommerzeit: 16 Uhr UTC = 18 Uhr in Berlin');
    const winter = autoposts.nowParts(new Date('2026-12-06T17:00:00Z'));
    assert.strictEqual(winter.minutes, 18 * 60, 'Winterzeit: 17 Uhr UTC = 18 Uhr in Berlin');
  });

  console.log('\n🧩 Funktionen vom alten Bot');
  await test('Zählspiel: richtig, doppelt, falsch, Rekord, Neustart bei Fehler', async () => {
    const counting = require('../src/modules/counting');
    assert.strictEqual(counting.parseNumber('42 juhu'), 42);
    assert.strictEqual(counting.parseNumber('hallo 3'), null);
    const cfg = getConfig('g-count').counting;
    Object.assign(cfg, { enabled: true, channel: 'cnt', current: 0, lastUser: null, record: 0, resetOnFail: true });
    const sent = [], reacts = [];
    const msg = (author, content) => ({ guild: { id: 'g-count' }, channel: { id: 'cnt', send: async m => { sent.push(m.content || m); } }, author: { id: author }, content, react: async e => { reacts.push(e); } });
    await counting.onMessage(msg('a', '1'));
    await counting.onMessage(msg('b', '2'));
    assert.deepStrictEqual([cfg.current, cfg.record, reacts.join('')], [2, 2, '✅✅']);
    await counting.onMessage(msg('b', '3'));
    assert.strictEqual(reacts.at(-1), '❌'); assert.match(sent.at(-1), /zweimal hintereinander/);
    assert.strictEqual(cfg.current, 0, 'zurück auf 0');
    await counting.onMessage(msg('a', '5'));
    assert.match(sent.at(-1), /richtig wäre \*\*1\*\*/);
    assert.strictEqual(cfg.record, 2, 'Rekord bleibt');
    assert(await counting.onMessage(msg('a', 'nur reden')), 'Text im Kanal stört nicht');
    assert.strictEqual(reacts.length, 4);
  });
  await test('Musik-Filter erkennt Schreibweisen, lässt Harmloses durch', () => {
    const mf = require('../src/modules/music/filter');
    const cfg = { enabled: true, terms: ['landser', 'sieg heil', '/\\bkill\\s+all\\b/'], useBadwords: true };
    assert.strictEqual(mf.normalize('L4nds3r'), 'landser');
    for (const t of ['Landser - Lied', 'L4nds3r', 'l-a-n-d-s-e-r', 'S i e g H e i l', 'KILL ALL']) assert(mf.check([t], cfg), t);
    for (const t of ['Blink-182 - All The Small Things', 'Lofi Beats', 'Skill all day']) assert(!mf.check([t], cfg), t);
    assert(mf.check(['Mein Song', 'Kanal Doofi'], cfg, ['doofi']), 'Wortfilter der Moderation gilt mit');
    assert(!mf.check(['Landser'], { ...cfg, enabled: false }));
  });
  await test('Gratis-Spiele: posten, nicht doppelt, abgelaufene löschen', async () => {
    const fgm = require('../src/modules/freegames');
    const raw = { id: 3820, title: 'GetHigh.EXE (Epic Games) Giveaway', worth: '$1.99', end_date: '2026-11-02 23:59:00', platforms: 'PC, Epic Games Store', open_giveaway_url: 'https://www.gamerpower.com/open/x', image: 'https://www.gamerpower.com/x.jpg', description: 'Spiel' };
    const g1 = fgm.normalizeGame(raw);
    assert.deepStrictEqual([g1.title, g1.platform, g1.worth, g1.endsAt], ['GetHigh.EXE', 'Epic Games', '$1.99', Date.UTC(2026, 10, 2, 23, 59)]);
    const g2 = fgm.normalizeGame({ ...raw, id: 3821, title: 'Portal (Steam) Giveaway', platforms: 'PC, Steam', end_date: 'N/A' });
    const posted = [], deleted = [];
    const ch = { id: 'fg', isTextBased: () => true, send: async p => { posted.push(p); return { id: 'm' + posted.length }; }, messages: { delete: async id => { deleted.push(id); } } };
    const guild = { id: 'g-fg', channels: { cache: new Collection([['fg', ch]]) } };
    Object.assign(getConfig('g-fg').freegames, { enabled: true, channel: 'fg', deleteExpired: true });
    const now = Date.UTC(2026, 9, 20);
    assert.deepStrictEqual(await fgm.runGuild(guild, [g1, g2], now), { posted: 2, removed: 0 });
    assert.strictEqual(posted[0].embeds[0].data.title, 'GetHigh.EXE');
    assert.deepStrictEqual(await fgm.runGuild(guild, [g1, g2], now + 3_600_000), { posted: 0, removed: 0 }, 'nicht doppelt');
    const r = await fgm.runGuild(guild, [g2], Date.UTC(2026, 10, 3));
    assert.deepStrictEqual(r, { posted: 0, removed: 1 }); assert.deepStrictEqual(deleted, ['m1']);
  });
  await test('Notfall-Alarm: nur echte Webhooks, Personen werden angepingt', async () => {
    const alertM = require('../src/modules/alert');
    assert(alertM.WEBHOOK_RE.test('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-1234'));
    assert(!alertM.WEBHOOK_RE.test('https://evil.example/api/webhooks/1/x'));
    Object.assign(getConfig('g-al').alert, { enabled: true, webhook: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-1234', mentions: ['111111111111111111'] });
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
    try {
      const n = await alertM.send({ guilds: { cache: new Collection([['g-al', { id: 'g-al' }], ['g-other', { id: 'g-other' }]]) } }, 'Test');
      assert.strictEqual(n, 1);
      assert.match(calls[0].body.content, /<@111111111111111111> Test/);
      assert.deepStrictEqual(calls[0].body.allowed_mentions.users, ['111111111111111111']);
    } finally { global.fetch = realFetch; }
  });
  await test('Backups: sichern, ändern, zurückspielen (+ Sicherung davor), Anzahl begrenzt', () => {
    const bk = require('../src/modules/backups');
    store.set('levels', 'g-bk:u1', { xp: 500 });
    getConfig('g-bk').levels.multiplier = 2; saveConfig('g-bk');
    const first = bk.create('g-bk', 'manuell');
    store.set('levels', 'g-bk:u1', { xp: 9999 }); store.set('levels', 'g-bk:u2', { xp: 1 });
    getConfig('g-bk').levels.multiplier = 5; saveConfig('g-bk');
    bk.restore('g-bk', first.id);
    assert.strictEqual(store.get('levels', 'g-bk:u1').xp, 500);
    assert(!store.get('levels', 'g-bk:u2'), 'später Hinzugekommenes ist weg');
    assert.strictEqual(getConfig('g-bk').levels.multiplier, 2, 'Einstellungen zurück');
    assert(bk.list('g-bk').some(b => b.reason === 'vor Wiederherstellung'));
    getConfig('g-bk').backups.keep = 2;
    for (let i = 0; i < 4; i++) { store.delete('backups', `g-bk:${Date.now()}`); bk.create('g-bk', 'manuell'); }
    assert(bk.list('g-bk').filter(b => b.reason !== 'vor Wiederherstellung').length <= 2);
  });
  await test('Bestenliste täglich / alle N Tage', () => {
    const ap = require('../src/modules/autoposts');
    const p = { enabled: true, channel: 'c', weekday: 0, time: '12:00', everyDays: 1, lastRun: '2026-10-19' };
    const at = (day, h) => ({ weekday: 2, minutes: h * 60, day });
    assert(ap.isDue(p, at('2026-10-20', 12)), 'täglich: heute fällig');
    assert(!ap.isDue(p, at('2026-10-20', 11)), 'erst ab 12 Uhr');
    assert(!ap.isDue({ ...p, lastRun: '2026-10-20' }, at('2026-10-20', 13)), 'nur einmal am Tag');
    assert(!ap.isDue({ ...p, everyDays: 3, lastRun: '2026-10-18' }, at('2026-10-20', 13)), 'alle 3 Tage: noch nicht');
    assert(ap.isDue({ ...p, everyDays: 3, lastRun: '2026-10-17' }, at('2026-10-20', 13)), 'alle 3 Tage: jetzt');
    assert(!ap.isDue({ ...p, everyDays: 7 }, at('2026-10-20', 13)), 'wöchentlich nur am Wochentag');
  });
  await test('Server-Tag-Boost und PlayStation-Erkennung', () => {
    const lvm = require('../src/modules/leveling');
    const plat = require('../src/lib/platforms');
    const cfg = { tagBoost: { enabled: true, percent: 25 } };
    const mem = gid => ({ guild: { id: 'g-tag' }, user: { primaryGuild: { identityEnabled: true, identityGuildId: gid } } });
    assert.strictEqual(lvm.tagBoost(mem('g-tag'), cfg), 1.25);
    assert.strictEqual(lvm.tagBoost(mem('fremd'), cfg), 1, 'fremder Server-Tag zählt nicht');
    assert.strictEqual(lvm.tagBoost(mem('g-tag'), { tagBoost: { enabled: false, percent: 25 } }), 1);
    plat.onRaw({ t: 'PRESENCE_UPDATE', d: { user: { id: 'ps' }, activities: [{ name: 'EA FC', platform: 'ps5' }] } });
    assert(plat.onPlayStation('ps'));
    plat.onRaw({ t: 'PRESENCE_UPDATE', d: { user: { id: 'ps' }, activities: [{ name: 'Spotify' }] } });
    assert(!plat.onPlayStation('ps'));
  });
  await test('Dashboard prüft Webhook, Filter-Ausdrücke und neue Felder', () => {
    const c = getConfig('g-s');
    const ok = applyChanges(c, { 'alert.webhook': 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'music.filter.terms': ['Landser', '/sieg\\s*heil/'], 'posts.leaderboard.everyDays': 1, 'levels.msgXp.max': 25, 'counting.channel': '111' }, fg, { isOwner: false });
    assert.deepStrictEqual(ok.errors, {});
    const bad = applyChanges(c, { 'alert.webhook': 'https://example.com/hook', 'music.filter.terms': ['/[/'], 'counting.current': 99, 'backups.keep': 0 }, fg, { isOwner: false });
    assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['alert.webhook', 'backups.keep', 'counting.current', 'music.filter.terms']);
  });

  console.log('\n🔄 /nb – Übernahme vom alten Bot');
  const migrate = require('../src/modules/migrate');
  const mkMsg = ({ content = '', labels = [], embeds = [], mention = null }) => ({
    content, embeds, attachments: new Collection(),
    components: labels.length ? [{ components: labels.map(l => ({ type: 2, label: l, customId: 'x:' + l })) }] : [],
    mentions: { users: new Collection(mention ? [[mention, { id: mention, bot: false }]] : []) },
  });
  const mgGuild = () => {
    const sent = [];
    const ch = (id, name, type = ChannelType.GuildText) => [id, { id, name, type, parentId: null, toString: () => `#${name}`, send: async m => { sent.push([name, m]); return { id: 'n' + sent.length }; } }];
    return {
      sent, id: 'g-mg', client: { user: { id: 'bot' } },
      channels: { cache: new Collection([ch('100000000000000001', 'willkommen'), ch('100000000000000002', 'tschüss'), ch('100000000000000003', 'level'), ch('100000000000000004', 'zählen'), ch('100000000000000005', 'Join to create', ChannelType.GuildVoice)]) },
      roles: { cache: new Collection([['g-mg', { id: 'g-mg', name: '@everyone' }], ['200000000000000001', { id: '200000000000000001', name: 'Gamer', managed: false, toString: () => '@Gamer' }], ['200000000000000002', { id: '200000000000000002', name: 'Neu', managed: false, toString: () => '@Neu' }]]) },
    };
  };
  await test('Nachrichten des alten Bots erkennen (Temp-Voice-Panel, Rollen-Buttons, Level-Up)', () => {
    const g = mgGuild();
    assert.strictEqual(migrate.classify(mkMsg({ labels: ['Umbenennen', 'User-Limit', 'Sperren', 'Kicken'] }), g).kind, 'tempvoicePanel');
    const rp = migrate.classify(mkMsg({ labels: ['🎮 Gamer', 'Neu'], embeds: [{ title: 'Wähle deine Rollen' }] }), g);
    assert.deepStrictEqual([rp.kind, rp.roles.map(r => r.role.name).join(',')], ['rolePanel', 'Gamer,Neu']);
    const lu = migrate.classify(mkMsg({ content: '<@123456789012345678> hat **Level 12** erreicht! 🎉', mention: '123456789012345678' }), g);
    assert.deepStrictEqual([lu.kind, lu.userId, lu.level], ['levelUp', '123456789012345678', 12]);
    assert.strictEqual(migrate.classify(mkMsg({ content: 'Guten Morgen' }), g).kind, null);
  });
  await test('Uhrzeit und Rhythmus aus alten Posts ableiten', () => {
    const daily = [17, 18, 19, 20].map(d => Date.UTC(2026, 9, d, 10, 0, 40)); // 12:00 Berliner Sommerzeit
    const ds = migrate.scheduleFrom(daily);
    assert.deepStrictEqual([ds.time, ds.everyDays], ['12:00', 1], 'täglich – Wochentag spielt dann keine Rolle');
    const weekly = [3, 10, 17].map(d => Date.UTC(2026, 9, d, 19, 43));
    assert.deepStrictEqual(migrate.scheduleFrom(weekly), { weekday: 6, time: '21:40', everyDays: 7 });
  });
  await test('Plan aus altem Dashboard: übernehmen, XP nur nach oben, Texte aufgeräumt', async () => {
    const g = mgGuild();
    store.set('levels', 'g-mg:300000000000000001', { xp: 99_999, msgs: 5 }); // schon mit neuem Bot verdient – darf nicht sinken
    const x = {
      root: 'https://alt.invalid', animals: [], levelroles: [],
      config: {
        welcome_channel_id: '100000000000000001', welcome_message: 'Wilkommen {user} auf ETC. ', welcome_autorole_id: '200000000000000002',
        leave_channel_id: '100000000000000002', leave_message: 'BYE BYE {user}', level_up_channel_id: '100000000000000003',
        weekly_leaderboard_enable: '1', weekly_leaderboard_channel_id: '100000000000000003', leaderboard_interval_days: '1', weekly_leaderboard_time: '12:00',
        xp_min_msg: '15', xp_max_msg: '25', xp_voice_pc: '5', xp_voice_playstation: '10', xp_server_tag_boost_enable: '1', xp_server_tag_boost_percent: '25',
        counting_channel_id: '100000000000000004', counting_current_num: '41', temp_voice_creator_channel_id: '100000000000000005', temp_voice_prefix: '╟🔊 Voice von',
        emergency_webhook_url: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', emergency_owner_id: '400000000000000001',
      },
      members: [{ id: '300000000000000001', xp: 5000, messageCount: 50, voiceSeconds: 600 }, { id: '300000000000000002', xp: 114451, messageCount: 10, voiceSeconds: 869_940 }],
      badwords: [{ word: 'Doof', is_regex: 0 }], musicfilter: [{ begriff: 'landser', is_regex: 0 }, { begriff: 'sieg\\s*heil', is_regex: 1 }],
    };
    const d = { botId: 'old', botTag: 'Alt#1', channels: {}, panels: [], rolePanels: [], verifyPanels: [], levels: new Map(), schedule: {}, counting: null, scanned: 4 };
    const plan = migrate.buildPlan(g, d, x);
    const report = await migrate.apply(g, plan, { by: 'u' });
    assert.deepStrictEqual(report.failed, []);
    const c = getConfig('g-mg');
    assert.strictEqual(c.welcome.message, 'Willkommen {user} auf ETC.', 'Tippfehler korrigiert');
    assert.deepStrictEqual(c.welcome.autoRoles, ['200000000000000002']);
    assert.strictEqual(c.goodbye.message, 'BYE BYE **{username}**');
    assert.deepStrictEqual([c.posts.leaderboard.everyDays, c.posts.leaderboard.time], [1, '12:00']);
    assert.deepStrictEqual([c.levels.msgXp, c.levels.voice.perMinute, c.levels.voice.psPerMinute, c.levels.tagBoost.percent], [{ min: 15, max: 25 }, 5, 10, 25]);
    assert.deepStrictEqual([c.counting.channel, c.counting.current], ['100000000000000004', 41]);
    assert.strictEqual(c.tempvoice.hubs[0].nameTemplate, '╟🔊 Voice von {name}');
    assert.deepStrictEqual([c.alert.enabled, c.alert.mentions], [true, ['400000000000000001']]);
    assert(c.automod.badwords.words.includes('doof'));
    assert.deepStrictEqual(c.music.filter.terms, ['landser', '/sieg\\s*heil/']);
    assert.strictEqual(lv.getData('g-mg', '300000000000000001').xp, 99_999, 'höhere neue XP bleiben');
    assert.deepStrictEqual([lv.getData('g-mg', '300000000000000002').xp, lv.getData('g-mg', '300000000000000002').voiceMin], [114451, 14499]);
    assert(g.sent.some(([n, m]) => n === 'zählen' && /Nächste Zahl: \*\*42\*\*/.test(m)));
    assert(require('../src/modules/backups').list('g-mg').some(b => b.reason === 'vor /nb'), 'vorher gesichert');
    assert(store.get('migrations', 'g-mg').done.length >= 8);
  });
  await test('/nb nur für den Bot-Besitzer', async () => {
    const client = { application: { fetch: async () => ({ owner: { id: 'owner1' } }) } };
    assert(await migrate.isBotOwner({ id: 'owner1' }, client));
    assert(!(await migrate.isBotOwner({ id: 'jemand' }, client)));
    process.env.OWNER_IDS = 'jemand';
    assert(await migrate.isBotOwner({ id: 'jemand' }, client), 'OWNER_IDS erlaubt zusätzliche Personen');
    delete process.env.OWNER_IDS;
    const team = { application: { fetch: async () => ({ owner: { members: new Collection([['t1', {}]]) } }) } };
    assert(await migrate.isBotOwner({ id: 't1' }, team), 'Team-Mitglied');
  });

  await test('Ruhemodus: zählt XP still, postet keine Level-Ups', async () => {
    const posted = [];
    const ch = { isTextBased: () => true, send: async m => { posted.push(m); } };
    const av = () => 'https://cdn.discordapp.com/embed/avatars/0.png';
    const member = { id: 'q1', user: { id: 'q1', bot: false, username: 'q', displayAvatarURL: av }, displayName: 'q', displayAvatarURL: av, guild: { id: 'g-quiet', channels: { cache: new Collection() } }, roles: { cache: new Collection() } };
    getConfig('g-quiet').quiet = true;
    getConfig('g-quiet').levels.announce = true;
    const r = await lv.addXp(member, 500, { channel: ch });
    assert(r.levelUp && posted.length === 0, 'kein Post im Ruhemodus');
    getConfig('g-quiet').quiet = false;
    await lv.addXp(member, 1000, { channel: ch });
    assert.strictEqual(posted.length, 1, 'danach wieder Level-Up-Meldung');
  });

  console.log('\n🎲 Events, Fun, Prefix, Ticket-Archiv');
  await test('Events verstehen deutsche Zeitangaben (Sommer- und Winterzeit)', () => {
    const ev = require('../src/modules/events');
    const now = Date.UTC(2026, 9, 20, 13, 0); // 15:00 in Berlin
    assert.strictEqual(ev.parseWhen('heute 20:00', now), Date.UTC(2026, 9, 20, 18, 0));
    assert.strictEqual(ev.parseWhen('morgen 18:30', now), Date.UTC(2026, 9, 21, 16, 30));
    assert.strictEqual(ev.parseWhen('24.10. 20 Uhr', now), Date.UTC(2026, 9, 24, 18, 0));
    assert.strictEqual(ev.parseWhen('05.12.2026 20:00', now), Date.UTC(2026, 11, 5, 19, 0), 'Winterzeit');
    assert.strictEqual(ev.parseWhen('irgendwann', now), null);
  });
  await test('Event-Zusagen: dabei ↔ abgesagt, Erinnerung genau einmal', async () => {
    const ev = require('../src/modules/events');
    const sent = [];
    const ch = { id: 'evc', send: async m => { sent.push(m.content); return { id: 'm1' }; }, messages: { edit: async () => {} } };
    const g = { id: 'g-ev', channels: { cache: new Collection([['evc', ch]]) } };
    const e = await ev.create({ ...ch, guild: g }, { id: 'host' }, { name: 'Spieleabend', at: Date.now() + 10 * 60_000 });
    let upd;
    const click = (user, action) => ev.onButton({ guild: g, user: { id: user }, update: async p => { upd = p; }, reply: async () => {} }, action, e.id);
    await click('a', 'yes'); await click('b', 'yes'); await click('a', 'no');
    const saved = store.get('events', `g-ev:${e.id}`);
    assert.deepStrictEqual([saved.going, saved.notGoing], [['host', 'b'], ['a']]);
    assert.match(upd.embeds[0].data.fields[1].name, /Dabei \(2\)/);
    const client = { guilds: { cache: new Collection([['g-ev', g]]) } };
    await ev.processTimers(client); await ev.processTimers(client);
    assert.strictEqual(sent.filter(t => /startet/.test(t || '')).length, 1, 'eine Erinnerung');
  });
  await test('Prefix-Befehle: nur mit Zeichen, Hinweis ohne Sprachkanal', async () => {
    const pre = require('../src/modules/prefix');
    const replies = [];
    const m = content => ({ content, guild: { id: 'g-pre' }, member: { voice: { channel: null } }, reply: async r => { replies.push(r.content); } });
    assert.strictEqual(await pre.onMessage(m('hallo !createvoice')), false);
    assert.strictEqual(await pre.onMessage(m('!unbekannt')), false);
    assert.strictEqual(await pre.onMessage(m('!createvoice Zocken')), true);
    assert.match(replies[0], /Geh zuerst in einen Sprachkanal/);
    getConfig('g-pre').prefix.enabled = false;
    assert.strictEqual(await pre.onMessage(m('!createvoice')), false);
  });
  await test('Ticket-Archiv leeren löscht nur archivierte Tickets', async () => {
    const tk = require('../src/modules/tickets');
    const deleted = [];
    const mk = (id, parentId) => [id, { id, parentId, type: ChannelType.GuildText, delete: async () => { deleted.push(id); } }];
    const g = { id: 'g-arch', channels: { cache: new Collection([mk('a1', 'cat'), mk('a2', 'cat'), mk('mgmt', 'cat'), mk('other', 'x')]) } };
    Object.assign(getConfig('g-arch').tickets, { archiveCategory: 'cat', archiveChannel: 'mgmt' });
    assert.strictEqual(await tk.purgeArchive(g), 2);
    assert.deepStrictEqual(deleted, ['a1', 'a2']);
  });

  await test('Laptop-Wächter: Temperatur, Akku, Musik-Stopp bei Hitze', async () => {
    const hm = require('../src/modules/health');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-'));
    const w = (f, v) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), String(v)); };
    w('hwmon/hwmon0/name', 'coretemp'); w('hwmon/hwmon0/temp1_input', 72000); w('hwmon/hwmon0/temp1_label', 'Package id 0');
    w('hwmon/hwmon1/name', 'nvme'); w('hwmon/hwmon1/temp1_input', 95000); // SSD zählt nicht als CPU
    w('power_supply/BAT0/capacity', 77); w('power_supply/BAT0/status', 'Charging');
    const s = hm.snapshot(root);
    assert.deepStrictEqual([s.temp, s.level, s.battery.percent], [72, 'ok', 77]);
    const { players } = require('../src/modules/music/player');
    let destroyed = 0;
    players.set('fake', { destroy: () => { destroyed++; } });
    const client = { guilds: { cache: new Collection() } };
    w('hwmon/hwmon0/temp1_input', 93000);
    assert.strictEqual((await hm.check(client, { root })).level, 'heiß');
    assert.strictEqual(destroyed, 1, 'Musik gestoppt'); assert(hm.tooHot());
    w('hwmon/hwmon0/temp1_input', 60000);
    await hm.check(client, { root });
    assert(!hm.tooHot(), 'abgekühlt');
    players.delete('fake');
  });

  await test('Tunnel-Adresse wird erkannt und dem Besitzer per DM geschickt', async () => {
    const http = require('http');
    const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(req.url === '/quicktunnel' ? '{"hostname":"rot-schwarz-test.trycloudflare.com"}' : '{}'); });
    const realFetch = global.fetch; // /health der Tunnel-Adresse: muss „unser“ Bot sein
    global.fetch = async (u, o) => (String(u).endsWith('trycloudflare.com/health') ? { ok: true, json: async () => ({ bot: 'ETC. Bot.#4740' }) } : realFetch(u, o));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    process.env.TUNNEL_METRICS = `127.0.0.1:${srv.address().port}`;
    delete require.cache[require.resolve('../src/modules/tunnel')];
    const tunnel = require('../src/modules/tunnel');
    const dms = [];
    const fremd = { user: { tag: 'Anderer Bot#1' }, application: { fetch: async () => ({ owner: { id: 'owner' } }) }, users: { fetch: async id => ({ id, send: async t => { dms.push(t); } }) } };
    assert.strictEqual(await tunnel.poll(fremd), null, 'Adresse eines anderen Bots wird ignoriert');
    const client = { ...fremd, user: { tag: 'ETC. Bot.#4740' } };
    const url = await tunnel.poll(client);
    await tunnel.poll(client);
    srv.close(); delete process.env.TUNNEL_METRICS; global.fetch = realFetch;
    assert.strictEqual(url, 'https://rot-schwarz-test.trycloudflare.com');
    assert.strictEqual(dms.length, 1, 'nur einmal pro neuer Adresse');
    assert.match(dms[0], /rot-schwarz-test\.trycloudflare\.com/);
    assert.strictEqual(process.env.DASHBOARD_URL, url);
    delete process.env.DASHBOARD_URL;
  });

  await test('Lockdown-Alarm: Tondatei ok (Opus, ~16 s), Standard-Grund, Warnung + Entwarnung im Haupt-Chat', async () => {
    const ld = require('../src/modules/lockdown');
    assert(fs.statSync(ld.ALARM_SOUND).size > 50_000, 'Tondatei fehlt');
    const { spawnSync } = require('child_process');
    const probe = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', ld.ALARM_SOUND, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    assert(/opus/.test(probe) && /Duration: 00:00:[12][0-9]/.test(probe), 'Opus, 10–29 Sekunden');
    const g = fakeGuild();
    g.id = 'g-alarm';
    const posts = [];
    const sysPosts = [];
    g.systemChannel = { id: 'sys', isTextBased: () => true, send: async m => { sysPosts.push(m.embeds[0].data); } };
    g.channels.cache.get('allgemein').send = async m => { posts.push(m.embeds[0].data); };
    g.members = { me: { id: 'bot' } };
    getConfig('g-alarm').lockdownAlarm.voice = false; // Sprachkanäle gibt es im Test nicht
    await ld.start(g, { by: { id: 'u', tag: 'u' } });
    assert.strictEqual(getConfig('g-alarm').lockdown.reason, 'Auf Befehl von Basti');
    assert(posts.some(p => p.title === '🚨 LOCKDOWN AKTIV' && /Auf Befehl von Basti/.test(p.description)));
    await ld.end(g, { by: { id: 'u', tag: 'u' } });
    assert(posts.some(p => p.title === '✅ Entwarnung'));
    assert.strictEqual(sysPosts.length, 0, 'Warnung landet im Chat, nicht im System-Kanal');
  });

  console.log('\n🎨 Rot-Schwarz-Theme');
  await test('Lockdown-Warnung geht in den Haupt-Chat, nicht in den versteckten System-/Log-Kanal', () => {
    const { alarmChannel } = require('../src/modules/lockdown');
    const { PermissionsBitField: PB, ChannelType: CT } = require('discord.js');
    const role = (id, perms = 0n) => ({ id, managed: false, permissions: new PB(perms) });
    const roles = [role('g-chat'), role('mitglied'), role('admin', PB.Flags.Administrator)];
    const ch = (id, name, viewers) => ({ id, name, type: CT.GuildText, isTextBased: () => true, permissionsFor: r => ({ has: () => viewers.includes(r.id) }) });
    const logs = ch('logs', '╟𝐋𝐨𝐠𝐬', ['admin']), regeln = ch('regeln', '╙ℹ️𝐑𝐞𝐠𝐞𝐥𝐧', ['g-chat', 'mitglied', 'admin']), chat = ch('chat', '╟💬𝐄𝐓𝐂-𝐂𝐡𝐚𝐭', ['mitglied', 'admin']);
    const g = { id: 'g-chat', systemChannelId: 'logs', systemChannel: logs, members: {}, roles: { cache: new Map(roles.map(r => [r.id, r])) }, channels: { cache: new Map([logs, regeln, chat].map(c => [c.id, c])) } };
    assert.strictEqual(alarmChannel(g, getConfig('g-chat')).id, 'chat');
    g.channels.cache.delete('chat');
    assert.strictEqual(alarmChannel(g, getConfig('g-chat')).id, 'regeln', 'ohne Chat: ein Kanal, den Mitglieder sehen');
    assert.strictEqual(alarmChannel(g, { ...getConfig('g-chat'), lockdownAlarm: { chatChannel: 'logs' } }).id, 'logs', 'eingestellter Kanal gewinnt');
  });
  await test('Keine blauen/grünen Buttons und Embed-Farben (außer frei wählbaren Rollen-Buttons)', () => {
    const { COLORS } = require('../src/lib/embeds');
    for (const [k, c] of Object.entries(COLORS)) {
      const r = c >> 16, g = (c >> 8) & 255, b = c & 255;
      assert(r > g && r > b, `Farbe ${k} ist nicht rot/orange`);
    }
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
    const offenders = walk(path.join(__dirname, '..', 'src')).filter(f => !f.endsWith('rolepanels.js') && /ButtonStyle\.(Primary|Success)/.test(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders, []);
  });

  console.log(`\n${fail ? '❌' : '✅'} ${pass} bestanden, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})();
