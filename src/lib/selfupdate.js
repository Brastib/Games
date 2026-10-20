'use strict';
/**
 * Selbst-Update per Git (Installation auf dem Laptop): neueste Version holen, Pakete nur bei Bedarf neu installieren.
 * Danach beendet sich der Bot sauber und systemd startet ihn mit der neuen Version neu (Restart=always).
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const sh = (cmd, args, timeout = 180_000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { cwd: ROOT, timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, errOut) => (e ? reject(new Error(String(errOut || e.message).trim().split('\n').pop())) : resolve(String(out).trim()))));

async function run() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) throw new Error('Diese Installation läuft nicht über Git (z. B. Render aktualisiert sich selbst).');
  const branch = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  await sh('git', ['fetch', '-q', 'origin', branch]);
  const [head, remote] = await Promise.all([sh('git', ['rev-parse', 'HEAD']), sh('git', ['rev-parse', `origin/${branch}`])]);
  if (head === remote) return { changed: false, version: await sh('git', ['log', '-1', '--format=%h %s']) };
  const lockChanged = (await sh('git', ['diff', '--name-only', head, remote])).split('\n').includes('package-lock.json');
  await sh('git', ['pull', '-q', '--ff-only', 'origin', branch]);
  if (lockChanged) {
    await sh(path.join(path.dirname(process.execPath), 'npm'), ['ci', '--omit=dev', '--no-audit', '--no-fund'], 600_000);
    await sh(process.execPath, ['node_modules/ffmpeg-static/install.js']).catch(() => {});
  }
  return { changed: true, version: await sh('git', ['log', '-1', '--format=%h %s']) };
}

module.exports = { run };
