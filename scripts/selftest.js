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
        assert(/^[-_a-z0-9]{1,32}$/.test(o.name), `Ungültiger Name: ${o.name}`);
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
  await test('Level-Up wird gemeldet', async () => {
    const m = fakeMember('u5');
    const r = await lv.addXp(m, 150, { channel: m.channel });
    assert(r.levelUp && r.level === 1 && m.sent.length === 1);
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
  await test('Statusseite, Login-Schutz, Einstellungen speichern', async () => {
    process.env.PORT = '3987';
    process.env.DISCORD_CLIENT_SECRET = 'test';
    const guild = {
      ...fg, name: 'Testserver', ownerId: 'owner', memberCount: 3, iconURL: () => null,
      members: { cache: new Collection(), fetch: async () => ({ permissions: { has: () => true } }) },
    };
    for (const c of guild.channels.cache.values()) Object.assign(c, { name: 'k' + c.id, parentId: null, rawPosition: 0, isThread: () => false });
    for (const r of guild.roles.cache.values()) Object.assign(r, { name: 'r', position: 1, managed: false, editable: true, color: 0 });
    const client = { isReady: () => true, user: { id: 'bot', tag: 'Bot#1' }, application: { id: 'bot' }, ws: { ping: 42 }, guilds: { cache: new Collection([['g-s', guild]]) }, users: { fetch: async () => ({ id: 'u', tag: 'u' }) } };
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
  await test('Alle Audio-Filter sind gültige ffmpeg-Filter', async () => {
    const { spawnSync } = require('child_process');
    const { FILTERS } = require('../src/modules/music/player');
    for (const [name, f] of Object.entries(FILTERS)) {
      if (!f.af) continue;
      const r = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.3', '-af', `${f.af},volume=1`, '-f', 'null', '-']);
      assert.strictEqual(r.status, 0, `Filter ${name}: ${r.stderr}`);
    }
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

  console.log('\n🎨 Rot-Schwarz-Theme');
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
