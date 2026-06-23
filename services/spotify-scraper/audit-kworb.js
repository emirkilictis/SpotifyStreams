/**
 * audit-kworb.js — reconcile one artist's bucket against kworb.net.
 *
 * Usage:
 *   node audit-kworb.js <artistId> [--no-resolve]
 *
 * Why this exists: every full-disc artist tends to land below kworb for two
 * MECHANICAL reasons (never dedup — our kept tracks match kworb 1:1):
 *   1. a collab has exactly one primary_artist, so when the co-credited artist
 *      is also tracked, the track sits in THEIR bucket. kworb shows a collab on
 *      every artist's page. Fix: add the track id to <ARTIST>_EXTRA_TRACK_IDS
 *      in web-dashboard/server.js (it keeps its lead bucket too — no double sub).
 *   2. a guest feature whose lead artist we DON'T track never appears in this
 *      artist's appears-on, so it was never scraped. Fix: pin the album id in
 *      this artist's extraAlbums block in scraper.js.
 *
 * This script does the hour of detective work in one command: it matches kworb
 * by Spotify TRACK ID (not fuzzy titles), buckets every kworb track into
 * OK / OTHER-BUCKET / MISSING, and prints ready-to-paste code for the last two.
 * For MISSING tracks it resolves the album id via your Spotify session so the
 * extraAlbums lines are copy-paste ready (skip with --no-resolve).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool, closePool } = require('./db');

const artistId = process.argv[2];
const RESOLVE = !process.argv.includes('--no-resolve');
if (!artistId || /^--/.test(artistId)) {
  console.error('Usage: node audit-kworb.js <artistId> [--no-resolve]');
  process.exit(1);
}
const ARTIST_URI = `spotify:artist:${artistId}`;
const fmtM = (n) => (Number(n) / 1e6).toFixed(1).padStart(8) + 'M';

// kworb and we often store the SAME recording under different track ids (a song
// reappears on a deluxe/regional edition with a fresh id). So an id miss does
// NOT mean missing — fall back to a normalized-title match against our bucket.
// Keep the "- Remix / - Instrumental / - Cardi B Version" suffix: those are
// DISTINCT tracks (own id, own streams) and must stay separate. Only strip the
// (feat …)/(with …) credit noise that kworb and Spotify format differently.
const normTitle = (t) => t.toLowerCase()
  .replace(/\(feat[^)]*\)/g, '').replace(/\(with[^)]*\)/g, '')
  .replace(/\bfeat\.?\b[^-]*/g, '')
  .replace(/[^a-z0-9]/g, '');

// --- 1. kworb -------------------------------------------------------------
async function fetchKworb(id) {
  const url = `https://kworb.net/spotify/artist/${id}_songs.html`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`kworb HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const rows = html.match(/<tr>([\s\S]*?)<\/tr>/g) || [];
  const tracks = [];
  let headerStreams = null;
  for (const r of rows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 2) continue;
    const rawTitle = cells[0].replace(/<[^>]+>/g, '').trim()
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    const streams = parseInt(cells[1].replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(streams)) continue;
    if (rawTitle === 'Streams') { headerStreams = streams; continue; }
    if (rawTitle === 'Daily' || rawTitle === 'Tracks') continue;
    const idMatch = cells[0].match(/track\/([A-Za-z0-9]{22})/);
    const isFeat = rawTitle.startsWith('* ');
    tracks.push({ trackId: idMatch ? idMatch[1] : null, title: rawTitle.replace(/^\*\s*/, ''), streams, isFeat });
  }
  return { tracks, headerStreams };
}

// --- 2. our DB ------------------------------------------------------------
async function fetchOurs() {
  const pool = getPool();
  const c = await pool.connect();
  try {
    // map every song id -> { primary_artist, canonical_id }
    const songs = await c.query(`SELECT id, primary_artist, canonical_id FROM songs`);
    const byId = new Map();
    for (const s of songs.rows) byId.set(s.id, s);
    // names for nicer output
    const names = new Map();
    const ta = await c.query(`SELECT artist_id, name FROM tracked_artists`);
    for (const a of ta.rows) names.set(`spotify:artist:${a.artist_id}`, a.name);
    // this artist's primary bucket: each song's title + canonical cumulative.
    // Used for the total AND for the normalized-title fallback (same recording,
    // different edition id).
    const bucket = await c.query(
      `SELECT s.title, dsc.cumulative::bigint AS cum
       FROM (SELECT DISTINCT ON (canonical_id) canonical_id, cumulative
             FROM daily_streams_canonical ORDER BY canonical_id, recorded_date DESC) dsc
       JOIN songs s ON s.id = dsc.canonical_id
       WHERE s.primary_artist = $1`, [ARTIST_URI]);
    const bucketTitles = new Set();
    let ourTotal = 0;
    for (const r of bucket.rows) { bucketTitles.add(normTitle(r.title)); ourTotal += Number(r.cum); }
    return { byId, names, bucketTitles, ourTotal, ourCount: bucket.rows.length };
  } finally {
    c.release();
  }
}

// --- 3. resolve album ids for missing tracks (Spotify session) ------------
async function resolveAlbums(trackIds) {
  const out = new Map();
  if (!trackIds.length) return out;
  const { launchBrowser } = require('./spotify');
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  try {
    for (const trackId of trackIds) {
      let tr = null;
      const handler = async (res) => {
        try {
          if (!res.url().includes('pathfinder/v2')) return;
          const b = await res.json().catch(() => null);
          const t = b?.data?.trackUnion;
          if (t && t.uri === `spotify:track:${trackId}` && !tr) tr = t;
        } catch {}
      };
      page.on('response', handler);
      try {
        await page.goto(`https://open.spotify.com/track/${trackId}`, { waitUntil: 'networkidle2', timeout: 40000 });
        for (let i = 0; i < 24 && !tr; i++) await new Promise((r) => setTimeout(r, 500));
      } catch {}
      page.off('response', handler);
      const ao = tr?.albumOfTrack;
      if (ao?.uri) out.set(trackId, { albumId: ao.uri.split(':')[2], albumName: ao.name, release: ao.date?.isoString?.slice(0, 10) });
    }
  } finally {
    await browser.close();
  }
  return out;
}

// --- main -----------------------------------------------------------------
(async () => {
  const [{ tracks, headerStreams }, ours] = await Promise.all([fetchKworb(artistId), fetchOurs()]);
  const ok = [], otherBucket = [], missing = [], noId = [];
  for (const t of tracks) {
    const row = t.trackId ? ours.byId.get(t.trackId) : null;
    if (row && row.primary_artist === ARTIST_URI) { ok.push(t); continue; }
    if (row) { otherBucket.push({ ...t, owner: row.primary_artist }); continue; }
    // id miss: same recording may live under a different edition id → title match
    if (ours.bucketTitles.has(normTitle(t.title))) { ok.push(t); continue; }
    if (!t.trackId) { noId.push(t); continue; }
    missing.push(t);
  }

  console.log(`\n=== kworb audit: ${artistId} ===`);
  console.log(`kworb total : ${(headerStreams / 1e9).toFixed(3)}B  (${tracks.length} tracks)`);
  console.log(`our bucket  : ${(ours.ourTotal / 1e9).toFixed(3)}B  (${ours.ourCount} primary-bucket songs)`);
  console.log(`matched OK  : ${ok.length} tracks`);

  const sum = (arr) => arr.reduce((a, b) => a + b.streams, 0);
  console.log(`\n--- [1] OTHER BUCKET: in our DB under another artist → add to <ARTIST>_EXTRA_TRACK_IDS in server.js (${(sum(otherBucket) / 1e6).toFixed(1)}M) ---`);
  otherBucket.sort((a, b) => b.streams - a.streams);
  for (const t of otherBucket) console.log(`  ${fmtM(t.streams)}  '${t.trackId}', // ${t.title}  [now in: ${ours.names.get(t.owner) || t.owner}]`);

  missing.sort((a, b) => b.streams - a.streams);
  console.log(`\n--- [2] MISSING: never scraped → pin album in this artist's extraAlbums in scraper.js (${(sum(missing) / 1e6).toFixed(1)}M) ---`);
  let albums = new Map();
  if (RESOLVE && missing.length) {
    console.log(`    (resolving ${missing.length} album ids via Spotify session…)`);
    albums = await resolveAlbums(missing.map((t) => t.trackId));
  }
  const seenAlbum = new Set();
  for (const t of missing) {
    const a = albums.get(t.trackId);
    if (a && !seenAlbum.has(a.albumId)) {
      seenAlbum.add(a.albumId);
      console.log(`  ${fmtM(t.streams)}  { id: '${a.albumId}', title: ${JSON.stringify(a.albumName)}, release_date: '${a.release}', is_featured: true }, // ${t.title}`);
    } else if (a) {
      console.log(`  ${fmtM(t.streams)}  (same album as above: ${a.albumName}) — ${t.title}`);
    } else {
      console.log(`  ${fmtM(t.streams)}  trackId=${t.trackId}  ${t.title}  [album unresolved]`);
    }
  }

  if (noId.length) console.log(`\n--- [3] kworb rows with no Spotify link (manual check): ${noId.length} ---`);
  const gap = sum(otherBucket) + sum(missing);
  console.log(`\nRecoverable gap (other-bucket + missing): ${(gap / 1e6).toFixed(1)}M`);
  console.log(`Note: kworb is NOT ground truth — you likely also have edition/"Beat" tracks it folds into parents, which offset part of any residual.\n`);

  await closePool();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
