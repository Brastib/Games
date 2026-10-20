'use strict';
/**
 * Notfall-Alarm über einen Discord-Webhook (kommt auch an, wenn der Bot selbst keine Verbindung hat).
 * Meldet: keine Verbindung zu Discord seit über 2 Minuten, Absturz, und nach einem unerwarteten Ende „wieder online“.
 * Grenze: Ist der ganze Server/Hoster weg, kann der Bot nichts mehr senden – dafür den E-Mail-Alarm von cron-job.org nutzen.
 */
const store = require('../lib/store');
const { getConfig } = require('../lib/config');

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{15,22}\/[\w-]{20,}$/;
const DOWN_AFTER = 2 * 60_000;
let downSince = null, alerted = false;

const human = ms => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} Std.` : `${Math.max(1, Math.round(ms / 60_000))} Min.`);

/** Schickt eine Nachricht an alle Server, auf denen der Alarm eingerichtet ist */
async function send(client, text, { onlyGuild = null } = {}) {
  let sent = 0;
  for (const g of client.guilds.cache.values()) {
    if (onlyGuild && g.id !== onlyGuild) continue;
    const a = getConfig(g.id).alert;
    if (!a.enabled || !WEBHOOK_RE.test(a.webhook || '')) continue;
    const ping = (a.mentions || []).map(id => `<@${id}>`).join(' ');
    const res = await fetch(a.webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ username: 'ETC. Bot · Alarm', content: `${ping} ${text}`.trim().slice(0, 2000), allowed_mentions: { users: a.mentions || [] } }),
    }).catch(() => null);
    if (res?.ok) sent++;
  }
  return sent;
}

/** Beim Start: War der Bot vorher unerwartet weg? Danach jede Minute ein Lebenszeichen speichern. */
async function onReady(client) {
  const last = store.get('meta', 'alive');
  if (last?.running && last.beat && Date.now() - last.beat > 3 * 60_000) {
    await send(client, `✅ **ETC. Bot ist wieder online.** Er war etwa ${human(Date.now() - last.beat)} weg (unerwartet beendet).`);
  }
  const beat = () => store.set('meta', 'alive', { running: true, beat: Date.now() });
  beat();
  setInterval(beat, 60_000).unref();
  setInterval(() => watch(client).catch(() => {}), 30_000).unref();
}

/** Sauberes Beenden (Neustart/Update beim Hoster) ist kein Alarm */
function onShutdown() { store.set('meta', 'alive', { running: false, beat: Date.now() }); }

function onDisconnect() { downSince ??= Date.now(); }
async function onConnected(client) {
  if (alerted) await send(client, `✅ **ETC. Bot hat wieder Verbindung zu Discord** (war ${human(Date.now() - downSince)} weg).`);
  downSince = null; alerted = false;
}
async function watch(client) {
  if (!downSince || alerted || Date.now() - downSince < DOWN_AFTER) return;
  alerted = true;
  const msgs = new Set(client.guilds.cache.map(g => getConfig(g.id).alert).filter(a => a.enabled).map(a => a.message));
  await send(client, `${[...msgs][0] || '🚨 **ETC. Bot ist offline!**'}\nKeine Verbindung zu Discord seit ${human(Date.now() - downSince)}.`);
}

async function onCrash(client, err) {
  await send(client, `💥 **ETC. Bot ist abgestürzt** und wird vom Hoster neu gestartet.\n\`${String(err?.message || err).slice(0, 300)}\``).catch(() => {});
}

module.exports = { WEBHOOK_RE, send, onReady, onShutdown, onDisconnect, onConnected, onCrash };
