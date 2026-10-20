'use strict';
/**
 * Musik-Filter: sperrt Titel mit verbotenen Begriffen, bevor sie in die Warteschlange kommen.
 * Geprüft werden Suchbegriff, Titel und Kanal. Schreibweisen wie „L4nds3r“, „l-a-n-d-s-e-r“ oder „S i e g H e i l“
 * werden erkannt, weil Text und Begriff vor dem Vergleich vereinheitlicht werden.
 */
const LEET = { 4: 'a', '@': 'a', 3: 'e', 1: 'i', '!': 'i', '|': 'i', 0: 'o', 5: 's', $: 's', 7: 't', 8: 'b', 9: 'g' };

/** Kleinbuchstaben, Akzente weg, Leetspeak → Buchstaben, alles außer a–z entfernen */
function normalize(text) {
  return String(text || '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[43!|0$5789@1]/g, c => LEET[c]).replace(/[^a-z]/g, '');
}

/** Liefert den gefundenen Begriff oder null */
function check(texts, cfg, badwords = []) {
  if (!cfg?.enabled) return null;
  const raw = texts.filter(Boolean).join(' \n ');
  const flat = normalize(raw);
  // Einträge: "wort" oder "/regulärer ausdruck/"
  for (const term of [...(cfg.terms || []), ...(cfg.useBadwords ? badwords : [])]) {
    const t = String(term || '').trim();
    const re = /^\/(.+)\/$/.exec(t);
    if (re) {
      try { if (new RegExp(re[1], 'iu').test(raw)) return t; } catch { /* ungültiger Ausdruck wird übersprungen */ }
      continue;
    }
    const n = normalize(t);
    if (n.length >= 3 && flat.includes(n)) return t;
  }
  return null;
}

module.exports = { normalize, check };
