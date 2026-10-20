'use strict';
/**
 * Dashboard-Adresse über den Cloudflare-Schnelltunnel (läuft neben dem Bot auf dem Laptop).
 * Die kostenlose Adresse ändert sich bei jedem Neustart des Tunnels. Der Bot fragt sie jede Minute beim Tunnel ab
 * (cloudflared --metrics → /quicktunnel) und schickt eine neue Adresse per DM an den Besitzer des Bots.
 */
const store = require('../lib/store');

const METRICS = process.env.TUNNEL_METRICS || '127.0.0.1:20241';
let current = null;

async function poll(client) {
  const res = await fetch(`http://${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  const host = res?.ok ? (await res.json().catch(() => ({}))).hostname : null;
  if (!host) return null;
  const url = `https://${host}`;
  if (url === current) return url;
  current = url;
  process.env.DASHBOARD_URL = url; // für Discord-Login-Links
  if (store.get('meta', 'tunnelUrl') !== url) {
    store.set('meta', 'tunnelUrl', url);
    console.log(`[tunnel] Dashboard ist erreichbar unter ${url}`);
    await notifyOwner(client, url).catch(() => {});
  }
  return url;
}

async function notifyOwner(client, url) {
  const app = await client.application.fetch().catch(() => client.application);
  const owners = app?.owner?.members ? [...app.owner.members.keys()] : app?.owner ? [app.owner.id] : [];
  for (const id of [...owners, ...(process.env.OWNER_IDS || '').split(/[\s,]+/).filter(Boolean)]) {
    const user = await client.users.fetch(id).catch(() => null);
    await user?.send(`🌐 **Neue Dashboard-Adresse:** ${url}\n-# Die Adresse ändert sich, wenn der Laptop neu startet – ich schicke dir dann die neue. Auch per \`/dashboard\`.`).catch(() => {});
  }
}

function start(client) {
  poll(client).catch(() => {});
  setInterval(() => poll(client).catch(() => {}), 60_000).unref();
}

const url = () => current || store.get('meta', 'tunnelUrl') || null;

module.exports = { start, poll, url };
