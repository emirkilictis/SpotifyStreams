/**
 * backfill-artist-images.js — fill tracked_artists.image_url where it's NULL/empty.
 *
 * Newly added roster members (migration 017 and onward) start with no photo —
 * this pulls each one's profile picture straight from their open.spotify.com
 * artist page (same interception technique as backfill-album-covers.js) so
 * nobody has to paste CDN URLs by hand. The scraper also runs this
 * automatically each cycle for any active artist still missing a photo, so
 * this script is mainly for an on-demand/manual run.
 *
 * Usage:
 *   node backfill-artist-images.js            # backfill every missing photo
 *   node backfill-artist-images.js --dry-run  # list what WOULD change, write nothing
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool, closePool } = require('./db');
const { launchBrowser, fetchArtistAvatar } = require('./spotify');

const DRY = process.argv.includes('--dry-run');

(async () => {
  const pool = getPool();
  const client = await pool.connect();
  let targets;
  try {
    const res = await client.query(`
      SELECT artist_id, name
      FROM tracked_artists
      WHERE image_url IS NULL OR image_url = ''
      ORDER BY sort_order, name
    `);
    targets = res.rows;
  } finally {
    client.release();
  }

  console.log(`[backfill] ${targets.length} artist(s) missing a photo${DRY ? ' (dry-run)' : ''}.`);
  if (!targets.length) { await closePool(); process.exit(0); }

  const { browser, page } = await launchBrowser(process.env.SP_DC);
  let ok = 0, miss = 0;
  try {
    for (const art of targets) {
      const url = await fetchArtistAvatar(page, art.artist_id);
      if (!url) {
        miss++;
        console.warn(`  ✗ ${art.name} (${art.artist_id}) — no avatar in artistUnion`);
        continue;
      }
      if (DRY) {
        console.log(`  • ${art.name} → ${url}`);
      } else {
        await pool.query('UPDATE tracked_artists SET image_url = $1 WHERE artist_id = $2', [url, art.artist_id]);
        console.log(`  ✓ ${art.name}`);
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
