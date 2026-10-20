'use strict';
/**
 * Linkschutz.
 * Modi:
 *   smart  – Normale Links erlaubt. Blockiert werden Phishing (Liste + Erkennung), IP-Logger,
 *            Kurz-Links, IP-Adressen, verdächtige Endungen, Punycode-Fälschungen und eigene Sperrliste.
 *   strict – Nur Domains aus der Erlaubt-Liste (GIFs, YouTube, Discord … plus eigene Einträge).
 *   off    – Kein Linkschutz.
 * GIFs aus dem Discord-GIF-Menü (Tenor, Giphy, Klipy) und hochgeladene Dateien gehen immer durch.
 */
const { DEFAULT_ALLOW } = require('./config');

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'`|]+)/gi;
// Domains ohne http:// – nur mit häufig missbrauchten oder gängigen Endungen, um Fehlalarme wie "z.B." zu vermeiden
const BARE_RE = /(?:^|[\s(<>"'])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|ru|xyz|top|click|gift|gifts|io|me|gg|link|site|online|shop|store|app|live|pro|info|biz|cc|co|de|tk|ml|ga|cf|gq|ly|su|icu|sbs|cfd|zip|mov|fun|vip|club|space|website|ws|to)(?:\/[^\s<>"']*)?)(?=$|[\s)<>"'.,!?])/gi;

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|discord\.me|discord\.io|invite\.gg|disboard\.org\/server\/join)\/([a-z0-9-]{2,32})/gi;

const SHORTENERS = new Set([
  'bit.ly', 'bitly.com', 'tinyurl.com', 'goo.gl', 'is.gd', 'v.gd', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ow.ly', 't.ly',
  's.id', 'tiny.cc', 'rebrand.ly', 'bit.do', 'adf.ly', 'shorte.st', 'bc.vc', 'ouo.io', 'urlz.fr', 'clck.ru', 'qr.ae',
  'lnkd.in', 'buff.ly', 'shorturl.asia', 'u.to', 'linktr.ee.ru', 'tny.im', 'x.gd', 'surl.li', 'l.ead.me',
]);
const IP_LOGGERS = new Set([
  'grabify.link', 'iplogger.org', 'iplogger.com', 'iplogger.ru', 'iplogger.co', 'iplogger.info', '2no.co', 'yip.su',
  'ipgrabber.ru', 'ipgraber.ru', 'blasze.com', 'blasze.tk', 'ps3cfw.com', 'lovebird.guru', 'trulove.guru',
  'dateing.club', 'shrekis.life', 'headshot.monster', 'gaming-at-my.best', 'progaming.monster', 'yourmy.monster',
  'imageshare.best', 'screenshot.best', 'gamingfun.me', 'catsnthing.com', 'catsnthings.fun', 'curiouscat.club',
  'joinmy.site', 'fortnitechat.site', 'fortnight.space', 'freegiftcards.co', 'stopify.co', 'leancoding.co',
  'grabify.org', 'iplis.ru', 'bmwforum.co', 'minecräft.com', 'xn--minecrft-5za.com',
]);
const BAD_TLDS = new Set(['tk', 'ml', 'ga', 'cf', 'gq', 'zip', 'mov', 'click', 'cam', 'sbs', 'cfd', 'icu', 'buzz', 'monster', 'rest', 'bond', 'top', 'work', 'su']);
const MULTI_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'com.br', 'com.tr', 'co.jp', 'com.mx', 'co.nz', 'com.ar', 'co.za', 'com.pl', 'com.cn', 'co.in', 'co.kr']);

// Offizielle Domains bekannter Marken – ähnlich aussehende Domains sind fast immer Phishing.
const BRANDS = {
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.gift', 'discord.new', 'discordstatus.com', 'discord.co', 'discord.dev', 'discordmerch.com'],
  steamcommunity: ['steamcommunity.com'],
  steampowered: ['steampowered.com'],
  roblox: ['roblox.com'],
  epicgames: ['epicgames.com'],
  paypal: ['paypal.com', 'paypal.me', 'paypal.de'],
  instagram: ['instagram.com'],
  twitch: ['twitch.tv'],
  youtube: ['youtube.com'],
  minecraft: ['minecraft.net'],
  riotgames: ['riotgames.com'],
  opensea: ['opensea.io'],
  binance: ['binance.com'],
  microsoft: ['microsoft.com'],
};
// Nur bei diesen Marken wird auf "fast gleich geschrieben" geprüft (häufigste Phishing-Ziele)
const LOOKALIKE = ['discord', 'steamcommunity', 'steampowered', 'roblox', 'epicgames', 'paypal', 'opensea', 'binance', 'instagram'];
// Echte Seiten, die zufällig ähnlich geschrieben sind
const NEAR_MISS_OK = new Set(['discogs.com', 'discord.me', 'dsc.gg', 'roblox.de', 'openseas.org']);
const SCAM_WORDS = ['nitro', 'gift', 'free', 'claim', 'airdrop', 'promo', 'verify', 'verification', 'login', 'auth', 'giveaway', 'bonus', 'reward', 'drop', 'skins', 'trade', 'boost', 'wallet', 'crypto', 'mint', 'steam', 'discord', 'cs2', 'csgo'];

let phishingDomains = new Set();
let phishingLoadedAt = 0;
const sbCache = new Map(); // Google Safe Browsing Ergebnisse

function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function extractUrls(text) {
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(URL_RE)) found.add(m[1].replace(/[)\].,!?>]+$/, ''));
  for (const m of text.matchAll(BARE_RE)) {
    const v = m[1].replace(/[)\].,!?>]+$/, '');
    if (![...found].some(f => f.includes(v))) found.add(v);
  }
  return [...found];
}

function extractInvites(text) {
  if (!text) return [];
  return [...text.matchAll(INVITE_RE)].map(m => m[1]);
}

/** Liefert { host, userinfo } oder null */
function parseHost(raw) {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return { host: u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''), userinfo: !!(u.username || u.password), path: u.pathname + u.search };
  } catch {
    return null;
  }
}

function registrable(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIX.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

function matchesList(host, list) {
  for (const d of list) {
    const dom = String(d).toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
    if (host === dom || host.endsWith('.' + dom)) return true;
  }
  return false;
}

function isOfficial(host) {
  for (const doms of Object.values(BRANDS)) if (matchesList(host, doms)) return true;
  return false;
}

/**
 * Bewertet einen Link.
 * @returns {{ block: boolean, reason?: string, phishing?: boolean, host?: string }}
 */
function classify(raw, linkCfg = { mode: 'smart', allow: [], block: [] }) {
  const parsed = parseHost(raw);
  if (!parsed) return { block: false };
  const { host, userinfo } = parsed;
  const reg = registrable(host);
  const tld = host.split('.').pop();
  const allow = [...DEFAULT_ALLOW, ...(linkCfg.allow || [])];

  if (matchesList(host, linkCfg.block || [])) return { block: true, reason: 'Domain steht auf der Sperrliste', host };
  if (phishingDomains.has(host) || phishingDomains.has(reg)) return { block: true, phishing: true, reason: 'Bekannte Betrugs-/Phishing-Seite', host };
  if (IP_LOGGERS.has(host) || IP_LOGGERS.has(reg)) return { block: true, phishing: true, reason: 'IP-Logger (spioniert deine IP-Adresse aus)', host };
  if (userinfo) return { block: true, phishing: true, reason: 'Getarnter Link (Trick mit @ in der Adresse)', host };

  if (matchesList(host, allow)) return { block: false, host };

  // Ab hier: Domain ist nicht erlaubt-gelistet
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[/.test(host)) {
    return { block: true, reason: 'Link auf eine nackte IP-Adresse', host };
  }
  if (host.split('.').some(l => l.startsWith('xn--'))) return { block: true, phishing: true, reason: 'Gefälschte Schriftzeichen in der Domain (Punycode)', host };
  if (SHORTENERS.has(host) || SHORTENERS.has(reg)) return { block: true, reason: 'Kurz-Link (Ziel ist versteckt)', host };

  // Ähnlich aussehende Marken-Domains (z. B. steamcommunlty.com, disc0rd.gift)
  if (!isOfficial(host)) {
    const label = reg.split('.')[0].replace(/[^a-z0-9]/g, '');
    const deLeet = label.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
    if (!NEAR_MISS_OK.has(reg)) {
      for (const brand of LOOKALIKE) {
        const limit = brand.length <= 6 ? 1 : brand.length <= 9 ? 2 : 3;
        const d1 = levenshtein(label, brand);
        const d2 = levenshtein(deLeet, brand);
        if ((d1 > 0 && d1 <= limit) || (d2 === 0 && label !== brand)) {
          return { block: true, phishing: true, reason: `Gefälschte ${brand}-Seite`, host };
        }
      }
    }
    const full = host.replace(/[^a-z0-9]/g, ' ');
    const brandHit = Object.keys(BRANDS).find(b => full.includes(b) || host.includes(b));
    const words = SCAM_WORDS.filter(w => host.includes(w));
    if ((brandHit && words.some(w => w !== brandHit)) || (host.includes('nitro') && words.length >= 2)) {
      return { block: true, phishing: true, reason: 'Typische Betrugs-Domain (Nitro/Steam/Gratis-Geschenk)', host };
    }
  }
  if (BAD_TLDS.has(tld)) return { block: true, reason: `Verdächtige Domain-Endung .${tld}`, host };

  if (linkCfg.mode === 'strict') return { block: true, reason: 'Domain ist nicht auf der Erlaubt-Liste', host };
  return { block: false, host, unknown: true };
}

/** Lädt öffentliche Phishing-Listen (alle 6 Stunden neu). */
async function loadPhishingLists() {
  const urls = (process.env.PHISHING_LISTS || [
    'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json',
    'https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.json',
  ].join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const next = new Set();
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.domains || [];
      for (const d of list) if (typeof d === 'string') next.add(d.toLowerCase().replace(/^www\./, ''));
    } catch (e) {
      console.warn(`[linkschutz] Liste nicht ladbar (${url}): ${e.message}`);
    }
  }
  // Offizielle Domains niemals sperren, falls eine Liste fehlerhaft ist
  for (const d of [...DEFAULT_ALLOW, ...Object.values(BRANDS).flat()]) next.delete(d);
  if (next.size) {
    phishingDomains = next;
    phishingLoadedAt = Date.now();
    console.log(`[linkschutz] ${next.size} bekannte Betrugs-Domains geladen.`);
  }
  return next.size;
}

/** Optional: Google Safe Browsing prüft unbekannte Domains (SAFE_BROWSING_KEY in der Umgebung). */
async function safeBrowsingCheck(urls) {
  const key = process.env.SAFE_BROWSING_KEY;
  if (!key || !urls.length) return null;
  const todo = urls.filter(u => !sbCache.has(u));
  if (todo.length) {
    try {
      const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          client: { clientId: 'discord-bot', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'],
            threatEntries: todo.map(url => ({ url: /^https?:/i.test(url) ? url : 'http://' + url })),
          },
        }),
      });
      const data = await res.json();
      const bad = new Set((data.matches || []).map(m => m.threat.url));
      for (const u of todo) sbCache.set(u, bad.has(/^https?:/i.test(u) ? u : 'http://' + u));
      if (sbCache.size > 5000) sbCache.clear();
    } catch (e) {
      console.warn('[linkschutz] Safe Browsing nicht erreichbar:', e.message);
      return null;
    }
  }
  return urls.find(u => sbCache.get(u)) || null;
}

function phishingCount() { return phishingDomains.size; }

module.exports = {
  extractUrls, extractInvites, classify, parseHost, loadPhishingLists, safeBrowsingCheck,
  phishingCount, levenshtein, registrable, matchesList,
  _setPhishing: set => { phishingDomains = new Set(set); },
  get phishingLoadedAt() { return phishingLoadedAt; },
};
