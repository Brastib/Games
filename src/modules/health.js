'use strict';
/**
 * Laptop-Wächter: prüft alle 2 Minuten CPU-Temperatur, Akku und Auslastung.
 * Linux liest die Sensoren aus /sys (hwmon + thermal). Gibt es keine Sensoren (Windows, Cloud), wird nur die Last angezeigt.
 *
 * Ab TEMP_WARN (Standard 80 °C) kommt eine Warnung (Log + Notfall-Alarm, höchstens alle 30 Minuten).
 * Ab TEMP_CRIT (Standard 90 °C) stoppt der Bot zusätzlich überall die Musik (ffmpeg/yt-dlp sind das Rechenintensivste)
 * und spielt erst wieder, wenn es unter TEMP_WARN ist. Der Laptop selbst drosselt und schaltet bei echter Überhitzung ab.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const WARN = Number(process.env.TEMP_WARN) || 80;
const CRIT = Number(process.env.TEMP_CRIT) || 90;
const CHECK_EVERY = 2 * 60_000;
const ALERT_EVERY = 30 * 60_000;
const CPU_SENSORS = /coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp|soc_thermal|acpitz|thinkpad|dell_smm|asus/i;

const read = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
const dirs = (d, re) => { try { return fs.readdirSync(d).filter(n => re.test(n)).map(n => path.join(d, n)); } catch { return []; } };

/** Alle Temperatur-Sensoren in °C */
function readTemps(root = '/sys/class') {
  const out = [];
  for (const d of dirs(path.join(root, 'hwmon'), /^hwmon\d+$/)) {
    const name = read(path.join(d, 'name')) || 'hwmon';
    for (const f of dirs(d, /^temp\d+_input$/)) {
      const c = Number(read(f)) / 1000;
      if (c > 5 && c < 130) out.push({ source: name, label: read(f.replace('_input', '_label')) || name, c });
    }
  }
  for (const z of dirs(path.join(root, 'thermal'), /^thermal_zone\d+$/)) {
    const c = Number(read(path.join(z, 'temp'))) / 1000;
    if (c > 5 && c < 130) out.push({ source: read(path.join(z, 'type')) || 'thermal', label: 'zone', c });
  }
  return out;
}

function readBattery(root = '/sys/class') {
  const b = dirs(path.join(root, 'power_supply'), /^BAT\d+$/)[0];
  if (!b) return null;
  const percent = Number(read(path.join(b, 'capacity')));
  return Number.isFinite(percent) ? { percent, status: read(path.join(b, 'status')) || 'Unknown' } : null;
}

function snapshot(root) {
  const temps = readTemps(root);
  const cpu = temps.filter(t => CPU_SENSORS.test(t.source));
  const pick = (cpu.length ? cpu : temps).sort((a, b) => b.c - a.c)[0] || null;
  const temp = pick ? Math.round(pick.c) : null;
  return {
    temp, sensor: pick ? `${pick.source}${pick.label && pick.label !== pick.source ? ` (${pick.label})` : ''}` : null,
    level: temp == null ? 'unbekannt' : temp >= CRIT ? 'heiß' : temp >= WARN ? 'warm' : 'ok',
    battery: readBattery(root),
    load: Math.round(os.loadavg()[0] * 100) / 100, cpus: os.cpus().length,
    memUsed: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    at: Date.now(),
  };
}

let last = null, lastAlert = 0, musicPaused = false;

function stopMusic() {
  const { players } = require('./music/player');
  let n = 0;
  for (const p of players.values()) { try { p.destroy('Laptop zu heiß'); n++; } catch { /* egal */ } }
  return n;
}

async function check(client, { root } = {}) {
  const s = snapshot(root);
  const prev = last?.level;
  last = s;
  if (s.temp == null) return s;
  const alert = require('./alert');
  if (s.level === 'heiß') {
    const stopped = stopMusic();
    musicPaused = true;
    console.warn(`[wächter] 🔥 ${s.temp} °C (${s.sensor}) – Musik gestoppt (${stopped} Player).`);
    if (prev !== 'heiß' || Date.now() - lastAlert > ALERT_EVERY) {
      lastAlert = Date.now();
      await alert.send(client, `🔥 **Laptop ist ${s.temp} °C heiß!** Musik wurde gestoppt. Bitte Lüftung prüfen (nicht auf Decke/Bett, Lüfter frei, evtl. Kühlpad).`).catch(() => {});
    }
  } else if (s.level === 'warm') {
    if (prev === 'ok' || prev == null || Date.now() - lastAlert > ALERT_EVERY) {
      lastAlert = Date.now();
      console.warn(`[wächter] 🌡️ ${s.temp} °C (${s.sensor}) – wird warm.`);
      await alert.send(client, `🌡️ Laptop wird warm: **${s.temp} °C**. Ab ${CRIT} °C stoppe ich die Musik.`).catch(() => {});
    }
  } else if (musicPaused || prev === 'heiß' || prev === 'warm') {
    musicPaused = false;
    console.log(`[wächter] ✅ ${s.temp} °C – wieder normal.`);
    if (prev === 'heiß') await alert.send(client, `✅ Laptop wieder abgekühlt: **${s.temp} °C**. Musik geht wieder.`).catch(() => {});
  }
  return s;
}

function start(client) {
  check(client).catch(() => {});
  setInterval(() => check(client).catch(e => console.error('[wächter]', e)), CHECK_EVERY).unref();
}

/** Für /health und das Dashboard */
const status = () => last || snapshot();
const tooHot = () => last?.level === 'heiß';

module.exports = { WARN, CRIT, readTemps, readBattery, snapshot, check, start, status, tooHot };
