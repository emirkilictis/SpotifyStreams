/**
 * Album discovery via official Spotify Web API (client_credentials).
 *
 * Web player token bu endpoint'te 429 dönüyor → developer app'in
 * client_id + client_secret'iyle temiz app-level token alıyoruz.
 * Bu token /artists/{id}/albums?include_groups=... endpoint'inde paginate eder.
 */

const axios = require('axios');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE  = 'https://api.spotify.com/v1';

/**
 * Spotify release_date precision farklı olabilir: "YYYY", "YYYY-MM", "YYYY-MM-DD".
 * Postgres DATE'e geçerli format için normalize et.
 */
function normalizeReleaseDate(d) {
  if (!d) return null;
  if (/^\d{4}$/.test(d))           return `${d}-01-01`;
  if (/^\d{4}-\d{2}$/.test(d))     return `${d}-01`;
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  return null;
}

async function getAppToken(clientId, clientSecret) {
  const res = await axios.post(TOKEN_URL,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    }
  );
  if (!res.data.access_token) throw new Error('App token alınamadı: ' + JSON.stringify(res.data));
  return res.data.access_token;
}

/**
 * Tek seferde tüm pages'i toplayarak artist'in album listesini döner.
 * @param {string} token  - app-level access token
 * @param {string} artistId
 * @param {string} includeGroups - "album,single,compilation" veya "appears_on" gibi
 * @param {string} market - default "US" (totalCount tutarlılığı için sabit)
 */
async function listArtistAlbums(token, artistId, includeGroups, market = 'US') {
  const all = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const res = await axios.get(`${API_BASE}/artists/${artistId}/albums`, {
      params: { include_groups: includeGroups, limit, offset, market },
      headers: { 'Authorization': 'Bearer ' + token },
      timeout: 15000,
    });
    const items = res.data.items ?? [];
    all.push(...items);
    if (items.length < limit || all.length >= (res.data.total ?? 0)) break;
    offset += limit;
    if (offset > 2000) break; // safety
  }
  return all;
}

const { fetchArtistAlbums, fetchArtistAppearsOn } = require('./spotify');

function isCoverAlbum(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return lower.includes('tribute') || 
         lower.includes('karaoke') || 
         lower.includes('lullaby') || 
         lower.includes('choir') ||
         lower.includes('singers') ||
         lower.includes('chamber') ||
         lower.includes('orchestral') ||
         lower.includes('hits done') ||
         lower.includes('tik toker') ||
         /\bcovers?\b/i.test(lower);
}

/**
 * Discovers all albums (own + appears_on) using Puppeteer interception instead of the official API.
 * This works without client ID/secret and avoids Premium Web API restrictions.
 */
async function discoverAllAlbumsPuppeteer(page, artistId, { includeAppearsOn = true } = {}) {
  const artistUri = `spotify:artist:${artistId}`;

  // 1) Own (album + single + compilation)
  const own = await fetchArtistAlbums(page, artistId);
  // Artist-level stats captured as a side-channel during the overview fetch above.
  const stats = page.lastArtistStats || null;
  // 2) Featured (appears_on) — skipped for album-only artists, who track only
  // their own discography (paginating appears-on is the heaviest discovery step).
  const feat = includeAppearsOn ? await fetchArtistAppearsOn(page, artistId) : [];

  const map = new Map(); // id → album
  for (const a of own) {
    if (isCoverAlbum(a.title)) continue;
    map.set(a.id, {
      id:             a.id,
      title:          a.title,
      release_date:   normalizeReleaseDate(a.release_date),
      primary_artist: artistUri,
      is_featured:    false,
      image_url:      a.image_url ?? null,
    });
  }
  for (const a of feat) {
    if (isCoverAlbum(a.title)) continue;
    if (map.has(a.id)) continue; // own override featured
    map.set(a.id, {
      id:             a.id,
      title:          a.title,
      release_date:   normalizeReleaseDate(a.release_date),
      primary_artist: a.primary_artist ?? null,
      is_featured:    true,
      image_url:      a.image_url ?? null,
    });
  }

  const own_count  = own.length;
  const feat_count = [...map.values()].filter(x => x.is_featured).length;
  return { albums: [...map.values()], own_count, feat_count, stats };
}

module.exports = { getAppToken, listArtistAlbums, discoverAllAlbumsPuppeteer };
