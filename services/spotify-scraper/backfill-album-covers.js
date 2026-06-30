/**
 * backfill-album-covers.js — fill albums.image_url where it's NULL/empty.
 *
 * Feature / appears-on albums (TROLLS, Shock Value, Magna Carta…) often land in
 * the catalogue without a cover, so the song-share card falls back to the artist
 * photo. This one-off reads the cover straight from each album's open.spotify.com
 * og:image meta (cheap, no GraphQL) and writes it back.
 *
 * Usage:
 *   node backfill-album-covers.js            # backfill every missing cover
 *   node backfill-album-covers.js --dry-run  # list what WOULD change, write nothing
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool, closePool } = require('./db');
const { launchBrowser } = require('./spotify');

const DRY = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;

// Read the cover from the album page's intercepted albumUnion GraphQL response
// (same source the scraper uses: albumUnion.coverArt.sources[]). The open.spotify
// og:image meta is unreliable on a logged-in session, so we grab the API payload.
async function albumCover(page, albumId) {
  let cover = null;
  const handler = async (res) => {
    try {
      if (!res.url().includes('pathfinder/v2')) return;
      const body = await res.json().catch(() => null);
      const al = body?.data?.albumUnion;
      if (al?.uri === `spotify:album:${albumId}` && al?.coverArt?.sources?.length && !cover) {
        // pick the largest source (last is usually the biggest)
        const sources = al.coverArt.sources;
        cover = sources[sources.length - 1].url || sources[0].url;
      }
    } catch {}
  };
  page.on('response', handler);
  try {
    await page.goto(`https://open.spotify.com/album/${albumId}`, {
      waitUntil: 'networkidle2', timeout: 15000,
    });
  } catch (e) { /* response may already be intercepted despite a late asset timeout */ }
  for (let i = 0; i < 12; i++) {
    if (cover) break;
    await new Promise(r => setTimeout(r, 500));
  }
  page.off('response', handler);
  return cover;
}

(async () => {
  const pool = getPool();
  const client = await pool.connect();
  let targets;
  try {
    const res = await client.query(`
      SELECT a.id, a.title
      FROM albums a
      WHERE (a.image_url IS NULL OR a.image_url = '')
        AND a.id IN (SELECT DISTINCT album_id FROM songs WHERE album_id IS NOT NULL)
      ORDER BY a.title
    `);
    targets = Number.isFinite(LIMIT) ? res.rows.slice(0, LIMIT) : res.rows;
  } finally {
    client.release();
  }

  console.log(`[backfill] ${targets.length} album(s) missing a cover${DRY ? ' (dry-run)' : ''}.`);
  if (!targets.length) { await closePool(); process.exit(0); }

  const { browser, page } = await launchBrowser(process.env.SP_DC);
  let ok = 0, miss = 0;
  try {
    for (const al of targets) {
      const url = await albumCover(page, al.id);
      if (!url) {
        miss++;
        console.warn(`  ✗ ${al.title} (${al.id}) — no cover in albumUnion`);
        continue;
      }
      // Normalise to the 640px (b273) variant for crisp cards if Spotify served a small one.
      const big = url.replace(/ab67616d0000[0-9a-f]{4}/, 'ab67616d0000b273');
      if (DRY) {
        console.log(`  • ${al.title} → ${big}`);
      } else {
        await pool.query('UPDATE albums SET image_url = $1 WHERE id = $2', [big, al.id]);
        console.log(`  ✓ ${al.title}`);
      }
      ok++;
    }
  } finally {
    await browser.close();
    await closePool();
  }
  console.log(`[backfill] done — ${ok} filled, ${miss} unresolved.`);
  process.exit(0);
})().catch(e => { console.error('[backfill] fatal:', e); process.exit(1); });
