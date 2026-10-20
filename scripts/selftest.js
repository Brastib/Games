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
    for (const f of fs.readdirSync(path.join(__dirname, '../src/modules'))) require(`../src/modules/${f}`);
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
  await test('Level-Formel wie MEE6', () => {
    assert.strictEqual(lv.levelFromXp(0).level, 0);
    assert.strictEqual(lv.levelFromXp(100).level, 1);
    assert.strictEqual(lv.levelFromXp(lv.xpForLevel(10)).level, 10);
    assert.strictEqual(lv.levelFromXp(lv.xpForLevel(10) - 1).level, 9);
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

  console.log(`\n${fail ? '❌' : '✅'} ${pass} bestanden, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})();
