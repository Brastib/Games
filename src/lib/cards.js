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

// ---------------- Banner über Panels ----------------
/*
 * Große StandBy-Uhr im Hintergrund mit leuchtendem Ring, „ETC.“ in Chrom-Rot (Orbitron), Titel mittig.
 * Animiert (GIF): Der Sekundenzeiger dreht sich endlos und zieht eine Radar-Spur hinter sich her, Funken pulsieren.
 * Ohne ffmpeg gibt es ein Standbild. Fertige GIFs liegen im Cache (DATA_DIR/banner-cache), weil das Rendern ~10 s dauert.
 */
const BANNER_VERSION = 3;
const BW = 1200, BH = 400;

function seeded(n) { let s = n; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

function bannerLayers({ title, kicker }) {
  const cx = BW / 2, cy = BH / 2, R = 300, rnd = seeded(7);
  // Hintergrund: Rubin-Schein, feines Korn, leuchtender Ring, Striche, gedämpfte Zeiger auf 10:10
  const bg = C.createCanvas(BW, BH), b = bg.getContext('2d');
  const g = b.createRadialGradient(cx, cy - 20, 10, cx, cy, 760);
  g.addColorStop(0, '#3d0a12'); g.addColorStop(0.42, '#16070a'); g.addColorStop(1, '#070708');
  b.fillStyle = g; b.fillRect(0, 0, BW, BH);
  const img = b.getImageData(0, 0, BW, BH), px = img.data;
  for (let i = 0; i < px.length; i += 4) { const n = (rnd() - 0.5) * 9; px[i] += n; px[i + 1] += n; px[i + 2] += n; }
  b.putImageData(img, 0, 0);
  b.save(); b.strokeStyle = 'rgba(200,16,46,0.35)'; b.lineWidth = 2; b.shadowColor = 'rgba(224,52,79,0.6)'; b.shadowBlur = 18;
  b.beginPath(); b.arc(cx, cy, R + 14, 0, Math.PI * 2); b.stroke(); b.restore();
  b.save(); b.lineCap = 'round';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2, big = i % 5 === 0, q = i % 15 === 0, r2 = R - (big ? R * 0.17 : R * 0.08);
    b.globalAlpha = q ? 0.85 : big ? 0.5 : 0.28;
    b.strokeStyle = q ? ACCENT : big ? '#8a2230' : '#4a141d'; b.lineWidth = big ? R * 0.04 : R * 0.018;
    b.shadowColor = 'rgba(224,52,79,0.8)'; b.shadowBlur = q ? 16 : 0;
    b.beginPath(); b.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R); b.lineTo(cx + Math.sin(a) * r2, cy - Math.cos(a) * r2); b.stroke();
  }
  b.restore();
  b.save(); b.globalAlpha = 0.22; b.lineCap = 'round'; b.strokeStyle = ACCENT;
  for (const [deg, len, w] of [[305, R * 0.5, R * 0.075], [60, R * 0.78, R * 0.05]]) {
    const a = (deg * Math.PI) / 180; b.lineWidth = w;
    b.beginPath(); b.moveTo(cx, cy); b.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len); b.stroke();
  }
  b.restore();

  // Vordergrund: Schatten hinter dem Text, „ETC.“, Untertitel, Titel, Leuchtlinie, Vignette
  const fg = C.createCanvas(BW, BH), f = fg.getContext('2d');
  const shade = f.createRadialGradient(cx, 210, 20, cx, 210, 420);
  shade.addColorStop(0, 'rgba(7,7,8,0.55)'); shade.addColorStop(1, 'rgba(7,7,8,0)');
  f.fillStyle = shade; f.fillRect(0, 0, BW, BH);
  f.textAlign = 'center'; f.textBaseline = 'middle'; f.font = '62px "Orbitron"';
  const ey = 88, eg = f.createLinearGradient(0, ey - 32, 0, ey + 32);
  eg.addColorStop(0, '#ffd0d6'); eg.addColorStop(0.35, '#ff5a6e'); eg.addColorStop(1, '#a50d26');
  f.save(); f.shadowColor = 'rgba(224,52,79,0.9)'; f.shadowBlur = 40; f.fillStyle = eg; f.fillText('ETC.', cx, ey); f.restore();
  f.fillStyle = eg; f.fillText('ETC.', cx, ey);
  // „ETC. ·“ am Anfang des Untertitels weglassen – steht ja schon darüber
  const k = String(kicker || '').replace(/^\s*ETC\.?\s*[·|-]\s*/i, '').toUpperCase();
  f.letterSpacing = '9px'; f.fillStyle = ROSE;
  f.font = fitText(f, k, BW - 200, 22, 'Poppins ExtraBold');
  if (k) f.fillText(k, cx + 4, 172);
  const t = String(title || '').toUpperCase();
  f.letterSpacing = '2px'; f.textAlign = 'left'; f.textBaseline = 'alphabetic';
  f.font = fitText(f, t, BW - 260, 96, 'Poppins ExtraBold');
  const ty = 268, wg = f.createLinearGradient(0, ty - 72, 0, ty);
  wg.addColorStop(0, '#ffffff'); wg.addColorStop(1, '#d9d2d3');
  let x = cx - f.measureText(t).width / 2;
  for (const part of t.split(/(-)/)) {
    f.save();
    if (part === '-') { f.fillStyle = '#ff3b55'; f.shadowColor = 'rgba(255,59,85,0.9)'; f.shadowBlur = 24; }
    else { f.fillStyle = wg; f.shadowColor = 'rgba(0,0,0,0.7)'; f.shadowBlur = 18; f.shadowOffsetY = 4; }
    f.fillText(part, x, ty); f.restore(); x += f.measureText(part).width;
  }
  const lg = f.createLinearGradient(cx - 140, 0, cx + 140, 0);
  lg.addColorStop(0, 'rgba(200,16,46,0)'); lg.addColorStop(0.5, 'rgba(255,59,85,1)'); lg.addColorStop(1, 'rgba(200,16,46,0)');
  f.save(); f.shadowColor = 'rgba(255,59,85,0.9)'; f.shadowBlur = 14; f.fillStyle = lg; f.fillRect(cx - 140, 296, 280, 3); f.restore();
  const v = f.createRadialGradient(cx, cy, BH * 0.45, cx, cy, BW * 0.72);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.6)');
  f.fillStyle = v; f.fillRect(0, 0, BW, BH);

  const sparks = Array.from({ length: 34 }, () => ({ x: rnd() * BW, y: rnd() * BH, r: 0.8 + rnd() * 2.2, a: 0.08 + rnd() * 0.25, p: rnd() * Math.PI * 2 }));
  return { bg, fg, sparks, cx, cy, R };
}

/** Ein Bild: t = 0..1 ist eine volle Umdrehung des Sekundenzeigers. scale < 1 = kleiner (fürs GIF). */
function bannerFrame(L, t, scale = 1) {
  const { cx, cy, R } = L;
  const canvas = C.createCanvas(Math.round(BW * scale), Math.round(BH * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(L.bg, 0, 0);
  const ang = t * Math.PI * 2;
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R - 4, 0, Math.PI * 2); ctx.clip();
  const cg = ctx.createConicGradient(ang - Math.PI / 2 - Math.PI * 0.6, cx, cy); // Spur: 108° hinter dem Zeiger
  cg.addColorStop(0, 'rgba(200,16,46,0)'); cg.addColorStop(0.3, 'rgba(224,52,79,0.32)'); cg.addColorStop(0.3001, 'rgba(0,0,0,0)'); cg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = cg; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();
  ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = '#ff5a6e'; ctx.lineWidth = 4; ctx.shadowColor = 'rgba(255,59,85,1)'; ctx.shadowBlur = 20;
  const sx = Math.sin(ang), sy = -Math.cos(ang);
  ctx.beginPath(); ctx.moveTo(cx - sx * 46, cy - sy * 46); ctx.lineTo(cx + sx * (R - 8), cy + sy * (R - 8)); ctx.stroke();
  ctx.fillStyle = '#ff5a6e'; ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  for (const s of L.sparks) {
    ctx.globalAlpha = s.a * (0.6 + 0.4 * Math.sin(s.p + t * Math.PI * 2));
    ctx.fillStyle = '#ff8090'; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.drawImage(L.fg, 0, 0);
  return canvas;
}

/** Standbild (PNG) */
async function bannerCard(opts = {}) {
  if (!C) return null;
  return bannerFrame(bannerLayers(opts), 0.62).encode('png');
}

/** Animiertes Banner (GIF, 900 × 300, 60 Bilder, 4 s Endlosschleife). Ohne ffmpeg: null. */
async function bannerGif(opts = {}) {
  if (!C) return null;
  const crypto = require('crypto');
  const fs = require('fs');
  const dir = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'banner-cache');
  const file = path.join(dir, crypto.createHash('sha1').update(JSON.stringify([BANNER_VERSION, opts.title, opts.kicker])).digest('hex') + '.gif');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  let ff;
  try { ff = require('ffmpeg-static'); } catch { return null; }
  if (!ff || !fs.existsSync(ff)) return null;
  const L = bannerLayers(opts), N = 60, S = 0.75, w = BW * S, h = BH * S;
  const gif = await new Promise(resolve => {
    const p = require('child_process').spawn(ff, ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', '15', '-i', 'pipe:0',
      '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
      '-loop', '0', '-f', 'gif', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? Buffer.concat(chunks) : null));
    p.stdin.on('error', () => {});
    (async () => {
      for (let i = 0; i < N; i++) {
        const fr = bannerFrame(L, i / N, S);
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

module.exports = { welcomeCard, rankCard, leaderboardCard, recapCard, bannerCard, bannerGif, available: () => !!C };
