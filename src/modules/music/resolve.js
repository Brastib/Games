'use strict';
/**
 * Macht aus einem Link, einer Suche oder einer Datei abspielbare Songs.
 * YouTube (auch Playlists), SoundCloud, Twitch, Bandcamp, Vimeo, Radio-Streams, MP3-Links, Discord-Anhänge.
 * Spotify-Links: Titel wird gelesen und auf YouTube gesucht (Spotify selbst erlaubt kein Streaming).
 */
const ytdlp = require('./ytdlp');

const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm|mp4)(\?|$)/i;
const isUrl = s => /^https?:\/\//i.test(s.trim());

function sourceOf(url) {
  if (/youtu\.?be/i.test(url)) return 'YouTube';
  if (/soundcloud/i.test(url)) return 'SoundCloud';
  if (/twitch/i.test(url)) return 'Twitch';
  if (/spotify/i.test(url)) return 'Spotify → YouTube';
  if (/bandcamp/i.test(url)) return 'Bandcamp';
  return 'Link';
}

async function spotifyTitle(url) {
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Spotify-Link konnte nicht gelesen werden.');
  const d = await res.json();
  return d.title;
}

/**
 * @returns {Promise<{tracks: object[], playlist: string|null}>}
 */
async function resolve(query, requester, attachment = null) {
  if (attachment) {
    return { tracks: [{ title: attachment.name, url: attachment.url, direct: true, duration: 0, requester, source: 'Datei' }], playlist: null };
  }
  query = query.trim();
  if (isUrl(query) && /open\.spotify\.com\/(intl-\w+\/)?(playlist|album|artist)/i.test(query)) {
    throw new Error('Spotify-Playlists und Alben kann ich nicht lesen (Spotify erlaubt das nicht). Einzelne Songs gehen, oder nimm eine YouTube-Playlist.');
  }
  if (isUrl(query) && /open\.spotify\.com/i.test(query)) {
    const title = await spotifyTitle(query);
    const r = await resolve(title, requester);
    r.tracks.forEach(t => { t.source = 'Spotify → YouTube'; });
    return r;
  }
  if (isUrl(query) && AUDIO_EXT.test(query) && !/youtu|soundcloud/i.test(query)) {
    const name = decodeURIComponent(query.split('/').pop().split('?')[0]) || 'Audio';
    return { tracks: [{ title: name, url: query, direct: true, duration: 0, requester, source: 'Datei' }], playlist: null };
  }
  const d = await ytdlp.info(isUrl(query) ? query : `ytsearch1:${query}`);
  if (d._type === 'playlist' && Array.isArray(d.entries)) {
    const entries = d.entries.filter(e => e && (e.url || e.id));
    if (!entries.length) throw new Error('Nichts gefunden.');
    const mk = e => ({
      title: e.title || 'Unbekannter Titel',
      url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      duration: e.duration || 0, thumbnail: e.thumbnails?.at(-1)?.url || null, requester,
      source: sourceOf(e.url || 'youtube'),
    });
    if (!isUrl(query)) return { tracks: [mk(entries[0])], playlist: null };
    return { tracks: entries.map(mk), playlist: d.title || 'Playlist' };
  }
  return {
    tracks: [{ title: d.title || query, url: d.webpage_url || query, duration: d.duration || 0, thumbnail: d.thumbnail || null, isLive: !!d.is_live, requester, source: sourceOf(d.webpage_url || query) }],
    playlist: null,
  };
}

/** Vorschläge für die Autovervollständigung (YouTube-Suchvorschläge, sehr schnell) */
async function suggest(q) {
  if (!q || q.length < 2 || isUrl(q)) return [];
  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(1500) });
    const d = await res.json();
    return (d[1] || []).slice(0, 10);
  } catch {
    return [];
  }
}

/** Songtext über lrclib.net (kostenlos, ohne Schlüssel) */
async function lyrics(title) {
  const clean = title.replace(/\(.*?\)|\[.*?\]|official|video|audio|lyrics?|hd|4k|mv/gi, ' ').replace(/\s+/g, ' ').trim();
  const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(clean)}`, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'discord-bot (github.com)' } });
  if (!res.ok) return null;
  const list = await res.json();
  const hit = list.find(x => x.plainLyrics);
  return hit ? { title: hit.trackName, artist: hit.artistName, text: hit.plainLyrics } : null;
}

module.exports = { resolve, suggest, lyrics, isUrl };
