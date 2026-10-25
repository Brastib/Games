'use strict';
/**
 * Bild-Karten (Willkommen, Rang, Bestenliste) mit @napi-rs/canvas.
 * Ist das Paket nicht verfügbar, gibt jede Funktion null zurück und der Bot nutzt normale Embeds.
 */
const path = require('path');
const { COLORS } = require('./embeds');

let C = null;
try {
  C = require('@napi-rs/canvas');
  const dir = path.join(__dirname, '..', '..', 'assets', 'fonts');
  C.GlobalFonts.registerFromPath(path.join(dir, 'Poppins-Regular.ttf'), 'Poppins');
  C.GlobalFonts.registerFromPath(path.join(dir, 'Poppins-Bold.ttf'), 'Poppins Bold');
  C.GlobalFonts.registerFromPath(path.join(dir, 'Poppins-ExtraBold.ttf'), 'Poppins ExtraBold');
  C.GlobalFonts.registerFromPath(path.join(dir, 'Orbitron-Black.ttf'), 'Orbitron');
  C.GlobalFonts.registerFromPath(path.join(dir, 'Inter-Medium.ttf'), 'Inter Medium');
  C.GlobalFonts.registerFromPath(path.join(dir, 'Inter-SemiBold.ttf'), 'Inter SemiBold');
} catch (e) {
  console.warn('[karten] Bild-Karten deaktiviert:', e.message);
  C = null;
}

const hex = n => '#' + n.toString(16).padStart(6, '0');
// Rubin statt Neon: Rot nur für Akzente und große Schrift, kleine Schrift hell (gut lesbar auf Schwarz)
const ACCENT = hex(COLORS.brand);   // #c8102e – Balken, Ringe, Flächen
const RED_TEXT = '#e0344f';         // große Zahlen/Titel in Rot
const ROSE = '#f28b96';             // hervorgehobene kleine Werte, Beschriftungen
const TEXT = '#f4f1f1';             // Haupttext
const DIM = '#a8a3a5';              // Nebentext (früher Dunkelrot – kaum lesbar)
const TRACK = '#232022';            // leerer Balken
const BG = '#0b0b0c', TILE = '#170b0d', TILE_ALT = '#121214', LINE = '#2a1316';
const TICK = '#5c1420', TICK_FAINT = '#2a0a10'; // Zifferblatt-Deko

async function loadAvatar(user) {
  try {
    const res = await fetch(user.displayAvatarURL({ extension: 'png', size: 256 }), { signal: AbortSignal.timeout(8000) });
    return await C.loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

function fitText(ctx, text, maxWidth, size, font) {
  let s = size;
  do { ctx.font = `${s}px "${font}"`; s -= 2; } while (ctx.measureText(text).width > maxWidth && s > 14);
  return ctx.font;
}

function background(ctx, w, h, { ticks = true } = {}) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  if (!ticks) return;
  // Zifferblatt-Striche als Deko rechts (wie die StandBy-Uhr)
  const cx = w - 30, cy = h / 2, r = h * 0.62;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const big = i % 5 === 0;
    ctx.strokeStyle = big ? TICK : TICK_FAINT;
    ctx.lineWidth = big ? 5 : 3;
    ctx.lineCap = 'round';
    const r2 = r - (big ? 26 : 16);
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r); ctx.lineTo(cx + Math.sin(a) * r2, cy - Math.cos(a) * r2); ctx.stroke();
  }
}

function avatarCircle(ctx, img, x, y, r) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r + 8, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.fillStyle = BG; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
  if (img) ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  else { ctx.fillStyle = TRACK; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
  ctx.restore();
}

async function welcomeCard(member, { title = 'WILLKOMMEN', subtitle } = {}) {
  if (!C) return null;
  const w = 1024, h = 340;
  const canvas = C.createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  background(ctx, w, h);
  avatarCircle(ctx, await loadAvatar(member.user), 180, h / 2, 110);
  ctx.fillStyle = ROSE;
  ctx.font = '30px "Poppins ExtraBold"';
  ctx.fillText(title, 340, 120);
  ctx.fillStyle = TEXT;
  const name = member.displayName || member.user.username;
  ctx.font = fitText(ctx, name, w - 420, 66, 'Poppins ExtraBold');
  ctx.fillText(name, 336, 195);
  ctx.fillStyle = DIM;
  ctx.font = fitText(ctx, subtitle || `Mitglied #${member.guild.memberCount} auf ${member.guild.name}`, w - 380, 28, 'Poppins');
  ctx.fillText(subtitle || `Mitglied #${member.guild.memberCount} auf ${member.guild.name}`, 340, 245);
  return canvas.encode('png');
}

async function rankCard(member, { level, xpIn, xpNeed, rank, totalXp }) {
  if (!C) return null;
  const w = 934, h = 282;
  const canvas = C.createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  background(ctx, w, h, { ticks: false });
  avatarCircle(ctx, await loadAvatar(member.user), 140, h / 2, 90);
  // Rang & Level rechts, von rechts nach links: [RANG #3]  [LEVEL 12]
  const baseY = 120;
  let x = w - 40;
  const part = (text, font, color, gap) => {
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = color;
    ctx.fillText(text, x - tw, baseY);
    x -= tw + gap;
  };
  part(String(level), '56px "Poppins ExtraBold"', RED_TEXT, 10);
  part('LEVEL', '22px "Poppins ExtraBold"', DIM, 34);
  part(`#${rank}`, '56px "Poppins ExtraBold"', RED_TEXT, 10);
  part('RANG', '22px "Poppins ExtraBold"', DIM, 0);
  // Name links, so breit wie Platz ist
  const name = member.displayName || member.user.username;
  ctx.fillStyle = TEXT;
  ctx.font = fitText(ctx, name, Math.max(120, x - 270 - 24), 44, 'Poppins ExtraBold');
  ctx.fillText(name, 270, baseY);
  // Fortschrittsbalken
  const bx = 270, by = 170, bw = w - bx - 40, bh = 36;
  ctx.fillStyle = TRACK;
  roundRect(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
  const p = Math.max(0.02, Math.min(1, xpIn / xpNeed));
  ctx.fillStyle = ACCENT;
  roundRect(ctx, bx, by, bw * p, bh, bh / 2); ctx.fill();
  ctx.fillStyle = DIM;
  ctx.font = '22px "Poppins Bold"';
  ctx.fillText(`${fmt(xpIn)} / ${fmt(xpNeed)} XP`, bx, by + bh + 34);
  ctx.textAlign = 'right';
  ctx.fillText(`Gesamt: ${fmt(totalXp)} XP`, w - 40, by + bh + 34);
  return canvas.encode('png');
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const fmt = n => (n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k' : String(n));

async function loadUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await C.loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

const MEDALS = ['#f5b301', '#c9d1dc', '#d9822b']; // Gold, Silber, Bronze
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon', 'etc-bot-256.png');

/**
 * Bestenliste als Bild (Top 10): Platz, Profilbild, Name, Level · XP, Balken im Verhältnis zum Ersten.
 * entries: [{ name, avatar (URL), level, xp }]
 */
async function leaderboardCard(entries, { title = 'ETC.', subtitle = 'BESTENLISTE' } = {}) {
  if (!C || !entries.length) return null;
  const S = 2; // doppelte Auflösung für scharfe Schrift
  const w = 600, rowH = 52, gap = 8, head = 78, pad = 16;
  const h = head + entries.length * (rowH + gap) + pad;
  const canvas = C.createCanvas(w * S, h * S);
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // Kopf: Bot-Icon + Titel
  const icon = await C.loadImage(ICON).catch(() => null);
  if (icon) {
    ctx.save(); ctx.beginPath(); ctx.arc(pad + 20, 38, 20, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(icon, pad, 18, 40, 40); ctx.restore();
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pad + 20, 38, 21, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = RED_TEXT;
  ctx.font = '26px "Poppins ExtraBold"';
  ctx.fillText(title, pad + 52, 47);
  const tw = ctx.measureText(title).width;
  ctx.fillStyle = DIM;
  ctx.font = '15px "Poppins ExtraBold"';
  ctx.fillText(subtitle, pad + 60 + tw, 46);
  ctx.fillStyle = LINE;
  ctx.fillRect(pad, head - 12, w - pad * 2, 2);

  const top = Math.max(1, entries[0].xp);
  const avatars = await Promise.all(entries.map(e => loadUrl(e.avatar)));
  entries.forEach((e, i) => {
    const y = head + i * (rowH + gap);
    const medal = MEDALS[i];
    ctx.fillStyle = i < 3 ? TILE : TILE_ALT;
    roundRect(ctx, pad, y, w - pad * 2, rowH, 10); ctx.fill();
    if (medal) { ctx.fillStyle = medal; roundRect(ctx, pad, y, 4, rowH, 2); ctx.fill(); }
    // Platz
    ctx.fillStyle = medal || ROSE;
    ctx.font = '17px "Poppins ExtraBold"';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), pad + 30, y + rowH / 2 + 6);
    ctx.textAlign = 'left';
    // Profilbild
    const ax = pad + 66, ay = y + rowH / 2, ar = 17;
    ctx.save(); ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.clip();
    if (avatars[i]) ctx.drawImage(avatars[i], ax - ar, ay - ar, ar * 2, ar * 2);
    else { ctx.fillStyle = TRACK; ctx.fillRect(ax - ar, ay - ar, ar * 2, ar * 2); }
    ctx.restore();
    if (medal) { ctx.strokeStyle = medal; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ax, ay, ar + 1.5, 0, Math.PI * 2); ctx.stroke(); }
    // Name + Level/XP
    ctx.fillStyle = TEXT;
    ctx.font = fitText(ctx, e.name, 250, 15, 'Poppins ExtraBold');
    ctx.fillText(e.name, ax + 28, y + 23);
    ctx.font = '11px "Poppins Bold"';
    const lvl = `Level ${e.level}  ·  `;
    ctx.fillStyle = DIM;
    ctx.fillText(lvl, ax + 28, y + 40);
    ctx.fillStyle = ROSE;
    ctx.fillText(`${e.xp.toLocaleString('de-DE')} XP`, ax + 28 + ctx.measureText(lvl).width, y + 40);
    // Balken im Verhältnis zum Ersten
    const bw = 150, bx = w - pad - 16 - bw, by = y + rowH / 2 - 3;
    ctx.fillStyle = TRACK; roundRect(ctx, bx, by, bw, 6, 3); ctx.fill();
    ctx.fillStyle = medal || ACCENT; roundRect(ctx, bx, by, Math.max(6, bw * (e.xp / top)), 6, 3); ctx.fill();
  });
  return canvas.encode('png');
}

/**
 * Wochen-Rückblick als Bild: Kopf wie die Bestenliste, darunter 4 Kacheln (2×2) und eine Summen-Zeile.
 * r: { range, totals, tiles: [{ label, name, avatar, value, runners[], empty }] }
 */
async function recapCard(r) {
  if (!C) return null;
  const S = 2;
  const w = 600, pad = 16, head = 78, gap = 12, tileH = 150;
  const tileW = (w - pad * 2 - gap) / 2;
  const h = head + tileH * 2 + gap + 46;
  const canvas = C.createCanvas(w * S, h * S);
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const icon = await C.loadImage(ICON).catch(() => null);
  if (icon) {
    ctx.save(); ctx.beginPath(); ctx.arc(pad + 20, 38, 20, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(icon, pad, 18, 40, 40); ctx.restore();
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pad + 20, 38, 21, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = RED_TEXT;
  ctx.font = '26px "Poppins ExtraBold"';
  ctx.fillText('ETC.', pad + 52, 47);
  const tw = ctx.measureText('ETC.').width;
  ctx.fillStyle = DIM;
  ctx.font = '15px "Poppins ExtraBold"';
  ctx.fillText('WOCHEN-RÜCKBLICK', pad + 60 + tw, 46);
  ctx.fillStyle = DIM;
  ctx.font = '12px "Poppins Bold"';
  ctx.textAlign = 'right';
  ctx.fillText(r.range, w - pad, 46);
  ctx.textAlign = 'left';
  ctx.fillStyle = LINE;
  ctx.fillRect(pad, head - 12, w - pad * 2, 2);

  const avatars = await Promise.all(r.tiles.map(t => (t.empty ? null : loadUrl(t.avatar))));
  r.tiles.slice(0, 4).forEach((t, i) => {
    const x = pad + (i % 2) * (tileW + gap), y = head + Math.floor(i / 2) * (tileH + gap);
    ctx.fillStyle = TILE;
    roundRect(ctx, x, y, tileW, tileH, 12); ctx.fill();
    ctx.fillStyle = ACCENT; roundRect(ctx, x, y, 4, tileH, 2); ctx.fill();
    ctx.fillStyle = ROSE;
    ctx.font = '11px "Poppins ExtraBold"';
    ctx.fillText(t.label, x + 16, y + 24);
    if (t.empty) {
      ctx.fillStyle = '#6e6a6b';
      ctx.font = '14px "Poppins Bold"';
      ctx.fillText('Diese Woche noch niemand', x + 16, y + 80);
      return;
    }
    const ax = x + 42, ay = y + 68, ar = 24;
    ctx.save(); ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.clip();
    if (avatars[i]) ctx.drawImage(avatars[i], ax - ar, ay - ar, ar * 2, ar * 2);
    else { ctx.fillStyle = TRACK; ctx.fillRect(ax - ar, ay - ar, ar * 2, ar * 2); }
    ctx.restore();
    ctx.strokeStyle = MEDALS[0]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ax, ay, ar + 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.font = fitText(ctx, t.name, tileW - 90, 16, 'Poppins ExtraBold');
    ctx.fillText(t.name, ax + 36, ay - 4);
    ctx.fillStyle = RED_TEXT;
    ctx.font = fitText(ctx, t.value, tileW - 90, 18, 'Poppins ExtraBold');
    ctx.fillText(t.value, ax + 36, ay + 18);
    ctx.fillStyle = DIM;
    (t.runners || []).forEach((line, n) => {
      ctx.font = fitText(ctx, `${n + 2}. ${line}`, tileW - 32, 11, 'Poppins Bold');
      ctx.fillText(`${n + 2}. ${line}`, x + 16, y + 116 + n * 16);
    });
  });

  ctx.fillStyle = DIM;
  ctx.font = fitText(ctx, r.totals, w - pad * 2, 12, 'Poppins Bold');
  ctx.textAlign = 'center';
  ctx.fillText(r.totals, w / 2, h - 18);
  ctx.textAlign = 'left';
  return canvas.encode('png');
}

// ---------------- Banner über Panels ----------------
/*
 * „Liquid Glass“ wie das iPhone im roten Nachtmodus: weicher Rot-Schwarz-Verlauf, „ETC.“ in einer Dynamic Island,
 * eine Glas-Kapsel mit rundem Knopf (rote Leuchtkante, Icon) und dem Titel, darunter ein leiser Hinweis.
 * Animiert (GIF): Ein Schimmer läuft über den Titel wie bei „Zum Ausschalten streichen“, die Knopfkante atmet.
 * Ohne ffmpeg gibt es ein Standbild. Fertige GIFs liegen im Cache (DATA_DIR/banner-cache).
 */
const BANNER_VERSION = 4;
const BW = 1200, BH = 400;

/** Icons im Stil von SF Symbols (24er-Raster, weiße Linien) */
function bannerIcon(ctx, name, cx, cy, size) {
  ctx.save(); ctx.translate(cx, cy); ctx.scale(size / 24, size / 24); ctx.translate(-12, -12);
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const dot = (x, y, r = 1.05) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
  ctx.beginPath();
  if (name === 'gamepad') {
    ctx.roundRect(2.2, 6.5, 19.6, 11.5, 5.75); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(6.2, 12.25); ctx.lineTo(10.2, 12.25); ctx.moveTo(8.2, 10.25); ctx.lineTo(8.2, 14.25); ctx.stroke();
    dot(15.3, 13.4); dot(17.6, 11.1);
  } else if (name === 'shield') {
    ctx.moveTo(12, 2.8); ctx.lineTo(19.5, 5.6); ctx.lineTo(19.5, 11.2); ctx.bezierCurveTo(19.5, 16, 16.2, 19.6, 12, 21.2);
    ctx.bezierCurveTo(7.8, 19.6, 4.5, 16, 4.5, 11.2); ctx.lineTo(4.5, 5.6); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8.8, 12); ctx.lineTo(11.1, 14.3); ctx.lineTo(15.4, 9.8); ctx.stroke();
  } else if (name === 'ticket') {
    ctx.moveTo(3, 7); ctx.lineTo(21, 7); ctx.lineTo(21, 10); ctx.arc(21, 12, 2, -Math.PI / 2, Math.PI / 2, true); ctx.lineTo(21, 17);
    ctx.lineTo(3, 17); ctx.lineTo(3, 14); ctx.arc(3, 12, 2, Math.PI / 2, -Math.PI / 2, true); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([1.6, 2.2]); ctx.beginPath(); ctx.moveTo(14, 8.6); ctx.lineTo(14, 15.6); ctx.stroke();
  } else if (name === 'help') {
    ctx.arc(12, 12, 9.2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9.4, 9.6); ctx.bezierCurveTo(9.4, 6.6, 14.8, 6.6, 14.8, 9.6); ctx.bezierCurveTo(14.8, 11.6, 12, 11.7, 12, 13.8); ctx.stroke();
    dot(12, 16.9, 1.2);
  } else { // Stern (allgemein)
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 4.2 : 9, a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx[i ? 'lineTo' : 'moveTo'](12 + Math.cos(a) * r, 12.6 + Math.sin(a) * r);
    }
    ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}

/** Passendes Icon und Hinweis zum Titel, falls nichts angegeben ist */
function bannerDefaults({ title = '', caption, kicker, icon } = {}) {
  const t = String(title);
  const guess = /spiel|game/i.test(t) ? 'gamepad' : /regel|rule|verif/i.test(t) ? 'shield' : /ticket|support/i.test(t) ? 'ticket' : /hilfe|help|befehl/i.test(t) ? 'help' : 'star';
  const cap = caption || kicker || (guess === 'gamepad' ? 'Selbst aussuchen – nur deine Spiele werden gepingt' : 'Tippe unten auf einen Knopf');
  return { title: t, caption: String(cap).replace(/^\s*ETC\.?\s*[·|-]\s*/i, ''), icon: icon || guess };
}

/** Ein Bild: t = 0..1 ist eine volle Schleife (Schimmer + Atmen). scale < 1 = kleiner (fürs GIF). */
function bannerFrame(opts, t, scale = 1) {
  const { title, caption, icon } = bannerDefaults(opts);
  const canvas = C.createCanvas(Math.round(BW * scale), Math.round(BH * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  // Hintergrund: weicher Rot-Schwarz-Verlauf + roter Schein hinter der Kapsel
  const bg = ctx.createLinearGradient(0, 0, BW * 0.6, BH * 1.4);
  bg.addColorStop(0, '#2c070a'); bg.addColorStop(0.55, '#170405'); bg.addColorStop(1, '#0c0203');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, BW, BH);
  const glow = ctx.createRadialGradient(BW / 2, 230, 10, BW / 2, 230, 520);
  glow.addColorStop(0, 'rgba(150,18,32,0.30)'); glow.addColorStop(1, 'rgba(150,18,32,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, BW, BH);
  // Dynamic Island mit „ETC.“
  const iw = 260, ih = 54, ix = (BW - iw) / 2, iy = 22;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 18; ctx.fillStyle = '#000'; rr(ix, iy, iw, ih, ih / 2); ctx.fill(); ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1.5; rr(ix + 0.75, iy + 0.75, iw - 1.5, ih - 1.5, ih / 2); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '26px "Orbitron"';
  ctx.save(); ctx.shadowColor = 'rgba(255,70,85,0.85)'; ctx.shadowBlur = 16; ctx.fillStyle = '#ff4d5e'; ctx.letterSpacing = '3px'; ctx.fillText('ETC.', BW / 2 + 2, iy + ih / 2 + 1); ctx.restore();
  // Glas-Kapsel: Schatten, getönte Füllung, Kante, Glanz oben
  const pw = 820, ph = 150, px = (BW - pw) / 2, py = 128, pr = ph / 2;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 16; ctx.fillStyle = 'rgba(30,6,8,0.9)'; rr(px, py, pw, ph, pr); ctx.fill(); ctx.restore();
  const fill = ctx.createLinearGradient(0, py, 0, py + ph);
  fill.addColorStop(0, 'rgba(118,50,57,0.52)'); fill.addColorStop(1, 'rgba(74,26,31,0.52)');
  ctx.fillStyle = fill; rr(px, py, pw, ph, pr); ctx.fill();
  const rim = ctx.createLinearGradient(0, py, 0, py + ph);
  rim.addColorStop(0, 'rgba(255,255,255,0.16)'); rim.addColorStop(0.5, 'rgba(255,255,255,0.04)'); rim.addColorStop(1, 'rgba(255,255,255,0.08)');
  ctx.strokeStyle = rim; ctx.lineWidth = 1.5; rr(px + 0.75, py + 0.75, pw - 1.5, ph - 1.5, pr); ctx.stroke();
  ctx.save(); rr(px, py, pw, ph, pr); ctx.clip();
  const sheen = ctx.createLinearGradient(0, py, 0, py + ph * 0.55);
  sheen.addColorStop(0, 'rgba(255,255,255,0.06)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen; ctx.fillRect(px, py, pw, ph * 0.55); ctx.restore();
  // Knopf mit roter Leuchtkante (unten rechts am hellsten, „atmet“ in der Animation)
  const kr = 62, kx = px + 12 + kr, ky = py + ph / 2;
  const kf = ctx.createRadialGradient(kx - 18, ky - 22, 4, kx, ky, kr);
  kf.addColorStop(0, '#4a171c'); kf.addColorStop(1, '#250a0d');
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6; ctx.fillStyle = kf; ctx.beginPath(); ctx.arc(kx, ky, kr, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  const pulse = 0.75 + 0.25 * Math.sin(t * Math.PI * 2);
  const kRim = ctx.createLinearGradient(kx - kr, ky - kr, kx + kr * 0.4, ky + kr);
  kRim.addColorStop(0, 'rgba(255,90,100,0.08)'); kRim.addColorStop(0.55, 'rgba(255,90,100,0.35)'); kRim.addColorStop(1, `rgba(255,95,105,${0.95 * pulse})`);
  ctx.save(); ctx.shadowColor = `rgba(255,60,75,${0.55 * pulse})`; ctx.shadowBlur = 14; ctx.strokeStyle = kRim; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(kx, ky, kr - 1.25, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  bannerIcon(ctx, icon, kx, ky, 72);
  // Titel: zartes Rosa-Weiß, Schimmer läuft durch (in ~70 % der Schleife, dann kurze Pause)
  const tx = kx + kr + (px + pw - (kx + kr)) / 2, ty = ky + 2;
  ctx.letterSpacing = '-0.3px';
  ctx.font = fitText(ctx, title, px + pw - (kx + kr) - 60, 56, 'Inter SemiBold');
  const tw = ctx.measureText(title).width;
  const tg = ctx.createLinearGradient(tx - tw / 2, 0, tx + tw / 2, 0);
  const pos = -0.3 + t * 1.9, base = '#ecc4c9';
  tg.addColorStop(0, base);
  for (const [o, c] of [[pos - 0.18, base], [pos, '#ffffff'], [pos + 0.18, base]]) if (o > 0 && o < 1) tg.addColorStop(o, c);
  tg.addColorStop(1, base);
  ctx.fillStyle = tg; ctx.fillText(title, tx, ty);
  // Hinweis darunter
  ctx.letterSpacing = '0px'; ctx.fillStyle = 'rgba(214,170,176,0.62)';
  ctx.font = fitText(ctx, caption, BW - 200, 23, 'Inter Medium');
  if (caption) ctx.fillText(caption, BW / 2, py + ph + 52);
  return canvas;
}

/** Standbild (PNG) */
async function bannerCard(opts = {}) {
  if (!C) return null;
  return bannerFrame(opts, 0.3).encode('png');
}

/** Animiertes Banner (GIF, 900 × 300, 48 Bilder, 3 s Endlosschleife). Ohne ffmpeg: null. */
async function bannerGif(opts = {}) {
  if (!C) return null;
  const crypto = require('crypto');
  const fs = require('fs');
  const dir = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'banner-cache');
  const file = path.join(dir, crypto.createHash('sha1').update(JSON.stringify([BANNER_VERSION, bannerDefaults(opts)])).digest('hex') + '.gif');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  let ff;
  try { ff = require('ffmpeg-static'); } catch { return null; }
  if (!ff || !fs.existsSync(ff)) return null;
  const N = 48, S = 0.75, w = BW * S, h = BH * S;
  const gif = await new Promise(resolve => {
    const p = require('child_process').spawn(ff, ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', '16', '-i', 'pipe:0',
      '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
      '-loop', '0', '-f', 'gif', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? Buffer.concat(chunks) : null));
    p.stdin.on('error', () => {});
    (async () => {
      for (let i = 0; i < N; i++) {
        const fr = bannerFrame(opts, i / N, S);
        const ok = p.stdin.write(Buffer.from(fr.getContext('2d').getImageData(0, 0, w, h).data.buffer));
        if (!ok) await new Promise(r => p.stdin.once('drain', r));
        if (i % 6 === 5) await new Promise(r => setTimeout(r, 0)); // Bot bleibt beim Rendern ansprechbar
      }
      p.stdin.end();
    })();
  });
  if (gif?.length) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, gif); }
  return gif;
}

module.exports = { welcomeCard, rankCard, leaderboardCard, recapCard, bannerCard, bannerGif, BANNER_VERSION, available: () => !!C };
