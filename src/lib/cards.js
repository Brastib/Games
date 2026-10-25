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

/**
 * Banner über Panels (Rollen, Regeln, Tickets …): links Untertitel + großer Titel, rechts die StandBy-Uhr mit „ETC.“ darin.
 * Ein „-“ im Titel wird rot. 1200 × 400 (3:1), so zeigt Discord es oben im Panel.
 */
function bannerCard({ title, kicker = 'ETC.' } = {}) {
  if (!C) return null;
  const w = 1200, h = 400, R = 158, cx = w - 220, cy = h / 2;
  const canvas = C.createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(cx, cy, 20, cx, cy, 760);
  g.addColorStop(0, '#3a0b12'); g.addColorStop(0.45, '#160709'); g.addColorStop(1, BG);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // Uhr: 60 Striche, 12/3/6/9 in Rubin
  ctx.lineCap = 'round';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2, big = i % 5 === 0, quarter = i % 15 === 0, r2 = R - (big ? 30 : 14);
    ctx.strokeStyle = quarter ? ACCENT : big ? '#7a1f2a' : '#3d1219';
    ctx.lineWidth = big ? 7 : 4;
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R); ctx.lineTo(cx + Math.sin(a) * r2, cy - Math.cos(a) * r2); ctx.stroke();
  }
  // „ETC.“ in der Uhr: Orbitron, Verlauf hell → Rubin, leichtes Leuchten
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let size = 110;
  do { ctx.font = `${size}px "Orbitron"`; size -= 2; } while (ctx.measureText('ETC.').width > R * 1.22 && size > 30);
  const tg = ctx.createLinearGradient(0, cy - size / 2, 0, cy + size / 2);
  tg.addColorStop(0, '#ff6b7d'); tg.addColorStop(1, ACCENT);
  ctx.save(); ctx.shadowColor = 'rgba(224,52,79,0.6)'; ctx.shadowBlur = 34; ctx.fillStyle = tg; ctx.fillText('ETC.', cx, cy + 4); ctx.restore();
  ctx.fillStyle = tg; ctx.fillText('ETC.', cx, cy + 4);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  // Links: Untertitel (gesperrt) + Titel
  const maxW = cx - R - 110;
  ctx.fillStyle = ROSE; ctx.letterSpacing = '8px';
  ctx.font = fitText(ctx, String(kicker).toUpperCase(), maxW, 24, 'Poppins ExtraBold');
  ctx.fillText(String(kicker).toUpperCase(), 64, 222);
  ctx.letterSpacing = '1px';
  const t = String(title || '').toUpperCase();
  ctx.font = fitText(ctx, t, maxW, 86, 'Poppins ExtraBold');
  let x = 60;
  for (const part of t.split(/(-)/)) { ctx.fillStyle = part === '-' ? RED_TEXT : TEXT; ctx.fillText(part, x, 314); x += ctx.measureText(part).width; }
  ctx.letterSpacing = '0px';
  return canvas.encode('png');
}

module.exports = { welcomeCard, rankCard, leaderboardCard, recapCard, bannerCard, available: () => !!C };
