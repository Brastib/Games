'use strict';
/**
 * Bild-Karten (Willkommen & Rang) mit @napi-rs/canvas.
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
} catch (e) {
  console.warn('[karten] Bild-Karten deaktiviert:', e.message);
  C = null;
}

const hex = n => '#' + n.toString(16).padStart(6, '0');
// StandBy-Farben (aus dem Nachtmodus der iPhone-Uhr)
const ACCENT = hex(COLORS.brand);   // #fd0000
const DIM = '#8c0000';
const TRACK = '#1f1f1f';

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
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  if (!ticks) return;
  // Zifferblatt-Striche als Deko rechts (wie die StandBy-Uhr)
  const cx = w - 30, cy = h / 2, r = h * 0.62;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const big = i % 5 === 0;
    ctx.strokeStyle = big ? DIM : '#2a0000';
    ctx.lineWidth = big ? 5 : 3;
    ctx.lineCap = 'round';
    const r2 = r - (big ? 26 : 16);
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r); ctx.lineTo(cx + Math.sin(a) * r2, cy - Math.cos(a) * r2); ctx.stroke();
  }
}

function avatarCircle(ctx, img, x, y, r) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r + 8, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.fillStyle = '#000000'; ctx.fill();
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
  ctx.fillStyle = DIM;
  ctx.font = '30px "Poppins ExtraBold"';
  ctx.fillText(title, 340, 120);
  ctx.fillStyle = ACCENT;
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
  part(String(level), '56px "Poppins ExtraBold"', ACCENT, 10);
  part('LEVEL', '22px "Poppins ExtraBold"', DIM, 34);
  part(`#${rank}`, '56px "Poppins ExtraBold"', ACCENT, 10);
  part('RANG', '22px "Poppins ExtraBold"', DIM, 0);
  // Name links, so breit wie Platz ist
  const name = member.displayName || member.user.username;
  ctx.fillStyle = ACCENT;
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

module.exports = { welcomeCard, rankCard, available: () => !!C };
