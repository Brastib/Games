'use strict';
/**
 * yt-dlp: liest YouTube-, SoundCloud-, Twitch-, Bandcamp- und viele weitere Links aus.
 * Das Programm wird beim ersten Gebrauch automatisch heruntergeladen (ohne Python, Einzeldatei).
 * Optional: YTDLP_COOKIES (Base64 einer cookies.txt), falls YouTube Server-IPs blockiert.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const BIN_DIR = path.join(process.cwd(), 'bin');
let binPath = process.env.YTDLP_PATH || null;
let ready = null;
let cookieFile = null;

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function onPath() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}

async function download(target) {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`;
  console.log(`[musik] Lade yt-dlp herunter: ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
}

/** Stellt sicher, dass yt-dlp vorhanden ist. Gibt den Pfad zurück. */
function ensure() {
  if (ready) return ready;
  ready = (async () => {
    if (binPath && fs.existsSync(binPath)) return binPath;
    // Eigene, aktuelle Version bevorzugen – ein yt-dlp vom System ist oft veraltet (YouTube ändert ständig etwas)
    const local = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    const fresh = fs.existsSync(local) && Date.now() - fs.statSync(local).mtimeMs < 7 * 86_400_000;
    try {
      if (!fresh) await download(local);
      binPath = local;
    } catch (e) {
      const sys = onPath();
      if (!sys && !fs.existsSync(local)) throw e;
      binPath = fs.existsSync(local) ? local : sys; // notfalls ältere eigene oder System-Version
      console.warn(`[musik] yt-dlp-Download fehlgeschlagen (${e.message}) – nutze ${binPath}`);
    }
    return binPath;
  })().catch(e => { ready = null; throw e; });
  return ready;
}

function cookieArgs() {
  if (!process.env.YTDLP_COOKIES) return [];
  if (!cookieFile) {
    cookieFile = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(cookieFile, Buffer.from(process.env.YTDLP_COOKIES, 'base64'));
  }
  return ['--cookies', cookieFile];
}

/** Ab yt-dlp 2025.11 gibt es --js-runtimes; ältere Versionen würden mit „no such option“ abbrechen */
const jsSupport = new Map();
function jsRuntimeArgs(bin) {
  if (!jsSupport.has(bin)) {
    const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout?.trim() || '';
    jsSupport.set(bin, /^\d{4}\.\d{2}\.\d{2}/.test(v) && v >= '2025.11.01');
  }
  return jsSupport.get(bin) ? ['--js-runtimes', `node:${process.execPath}`] : [];
}

function run(args, timeout = 45_000) {
  return ensure().then(bin => new Promise((resolve, reject) => {
    // YouTube verlangt inzwischen eine JavaScript-Laufzeit für seine Prüfaufgaben – sonst fehlen die Audio-Formate.
    // Wir nehmen das Node, mit dem der Bot selbst läuft.
    execFile(bin, ['--no-warnings', '--ignore-config', ...jsRuntimeArgs(bin), ...cookieArgs(), ...args], { maxBuffer: 64 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) {
        const msg = String(stderr || error.message);
        if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(msg)) return reject(new Error('Dieses Video ist altersbeschränkt.'));
        if (/not a bot|Sign in to confirm/i.test(msg)) return reject(new Error('YouTube blockiert gerade diesen Server („Bist du ein Bot?“). Lösung: YTDLP_COOKIES setzen (siehe README) oder einen anderen Link (SoundCloud, direkte MP3) nutzen.'));
        if (/Private video|Video unavailable|This video is unavailable/i.test(msg)) return reject(new Error('Dieses Video ist privat oder nicht verfügbar.'));
        if (/Unable to (connect|download)|timed out|Network is unreachable|Temporary failure/i.test(msg)) return reject(new Error('Die Quelle ist gerade nicht erreichbar. Bitte später nochmal versuchen.'));
        if (/Requested format is not available/i.test(msg)) { const e = new Error('YouTube liefert für dieses Video gerade kein passendes Audio-Format.'); e.formatMissing = true; return reject(e); }
        return reject(new Error(msg.split('\n').find(l => l.includes('ERROR')) || msg.slice(0, 300)));
      }
      resolve(stdout);
    });
  }));
}

/** Infos zu Link oder Suche (Playlists flach, max. 200 Einträge) */
async function info(query) {
  const out = await run(['-J', '--flat-playlist', '--playlist-end', '200', '--default-search', 'ytsearch', query]);
  return JSON.parse(out);
}

/** Direkte Audio-Adresse + nötige Header für ffmpeg */
async function streamInfo(url) {
  const out = await run(['-j', '--no-playlist', '-f', 'bestaudio[acodec=opus]/bestaudio/best', url])
    // Zweiter Versuch: irgendein Format mit Ton (notfalls Video+Ton, ffmpeg nimmt nur den Ton)
    .catch(e => (e.formatMissing ? run(['-j', '--no-playlist', '-f', 'ba*/b*', '-S', 'acodec,abr', url]) : Promise.reject(e)));
  const d = JSON.parse(out);
  return { url: d.url, headers: d.http_headers || {}, isLive: !!d.is_live, duration: d.duration || 0, title: d.title, thumbnail: d.thumbnail };
}

module.exports = { ensure, info, streamInfo, run, jsRuntimeArgs, get path() { return binPath; } };
