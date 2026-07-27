/**
 * audit-kworb.js — reconcile one artist's bucket against kworb.net and REPORT.
 *
 * Usage:
 *   node audit-kworb.js <artistId> [--no-resolve]
 *
 * This is the read-only twin of reconcile-kworb.js: same classification (both
 * import kworb.js), but it only prints — including ready-to-paste lines — and
 * writes nothing. Reach for it when you want to eyeball an artist; reach for
 * `node reconcile-kworb.js --artists=<id>` when you want the gap actually closed.
 *
 * See kworb.js for why an artist lands below kworb in the first place.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool, closePool } = require('./db');
const { fetchKworbSongs, loadOurBucket, classify, resolveTracks } = require('./kworb');

const artistId = process.argv[2];
const RESOLVE = !process.argv.includes('--no-resolve');
if (!artistId || /^--/.test(artistId)) {
  console.error('Usage: node audit-kworb.js <artistId> [--no-resolve]');
  process.exit(1);
}
const fmtM = (n) => (Number(n) / 1e6).toFixed(1).padStart(8) + 'M';

(async () => {
  const pool = getPool();
  const client = await pool.connect();
  let kworb, ours;
  try {
    [kworb, ours] = await Promise.all([fetchKworbSongs(artistId), loadOurBucket(client, artistId)]);
  } finally {
    client.release();
  }
  const { ok, otherBucket, missing, noId } = classify(kworb.tracks, ours);

  console.log(`\n=== kworb audit: ${artistId} ===`);
  console.log(`kworb total : ${(kworb.headerStreams / 1e9).toFixed(3)}B  (${kworb.tracks.length} tracks)`);
  console.log(`our bucket  : ${(ours.ourTotal / 1e9).toFixed(3)}B  (${ours.ourCount} songs incl. extra_artist_songs pins)`);
  console.log(`matched OK  : ${ok.length} tracks`);

  const sum = (arr) => arr.reduce((a, b) => a + b.streams, 0);
  console.log(`\n--- [1] OTHER BUCKET: in our DB under another artist → extra_artist_songs (${(sum(otherBucket) / 1e6).toFixed(1)}M) ---`);
  otherBucket.sort((a, b) => b.streams - a.streams);
  for (const t of otherBucket) {
    const owner = ours.names.get(t.owner) || t.owner || 'untracked';
    console.log(`  ${fmtM(t.streams)}  '${t.trackId}', // ${t.title}  [now in: ${owner}${t.ownerTracked ? '' : ' — UNTRACKED, auto-link skips it'}]`);
  }

  missing.sort((a, b) => b.streams - a.streams);
  console.log(`\n--- [2] MISSING: never scraped → extra_scrape_albums pin (${(sum(missing) / 1e6).toFixed(1)}M) ---`);
  let albums = new Map();
  if (RESOLVE && missing.length) {
    console.log(`    (resolving ${missing.length} album ids via Spotify session…)`);
    const { launchBrowser } = require('./spotify');
    const { browser, page } = await launchBrowser(process.env.SP_DC);
    try {
      albums = await resolveTracks(page, missing.map((t) => t.trackId));
    } finally {
      await browser.close();
    }
  }
  const seenAlbum = new Set();
  for (const t of missing) {
    const a = albums.get(t.trackId);
    if (a && !seenAlbum.has(a.albumId)) {
      seenAlbum.add(a.albumId);
      const credited = a.artistUris.includes(ours.artistUri) ? '' : '  ⚠ artist NOT credited on Spotify';
      console.log(`  ${fmtM(t.streams)}  { id: '${a.albumId}', title: ${JSON.stringify(a.albumName)}, release_date: '${a.release}', is_featured: true }, // ${t.title}${credited}`);
    } else if (a) {
      console.log(`  ${fmtM(t.streams)}  (same album as above: ${a.albumName}) — ${t.title}`);
    } else {
      console.log(`  ${fmtM(t.streams)}  trackId=${t.trackId}  ${t.title}  [album unresolved]`);
    }
  }

  if (noId.length) console.log(`\n--- [3] kworb rows with no Spotify link (manual check): ${noId.length} ---`);
  const gap = sum(otherBucket) + sum(missing);
  console.log(`\nRecoverable gap (other-bucket + missing): ${(gap / 1e6).toFixed(1)}M`);
  console.log(`Fix it automatically: node reconcile-kworb.js --artists=${artistId} --force`);
  console.log(`Note: kworb is NOT ground truth — you likely also have edition/"Beat" tracks it folds into parents, which offset part of any residual.\n`);

  await closePool();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
