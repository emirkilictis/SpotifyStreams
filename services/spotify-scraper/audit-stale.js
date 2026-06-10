/**
 * Audit tool — find "frozen" tracks: songs that stopped updating while the rest of
 * the artist's catalog kept being scraped. These are almost always region-blocked,
 * delisted, or deleted on Spotify (their source album no longer returns them), so
 * they show stale numbers and no day-over-day trend on the dashboard.
 *
 * Method: per artist, compute the "scrape frontier" = the most recent date ANY of
 * that artist's tracks was recorded. Any track whose last recorded date lags the
 * frontier by more than THRESHOLD days is flagged.
 *
 * Usage:
 *   node audit-stale.js            # all artists, default 3-day threshold
 *   node audit-stale.js --days=5   # custom threshold
 *   node audit-stale.js --artist=31TPClRtHm23RisEBtV3X7
 */

require('dotenv').config({ path: '../../.env' });
const { getPool, closePool } = require('./db');

const ARTISTS = {
  '31TPClRtHm23RisEBtV3X7': 'Justin Timberlake',
  '5L1lO4eRHmJ7a0Q6csE5cT': 'LISA',
  '1HY2Jd0NmPuamShAr6KMms': 'Lady Gaga',
  '6qqNVTkY8uBg9cP3Jd7DAH': 'Billie Eilish',
  '66CXWjxzNUsdJxJ2JdwvnR': 'Ariana Grande',
  '6Ff53KvcvAj5U7Z1vojB5o': '*NSYNC',
  '3p3U04w2DaiBzuYMZnYr00': 'JC Chasez',
  '3LHYvj5ZejV1NLqncEObSJ': 'Vaelis',
  '2dIgFjalVxs4ThymZ67YCE': 'Stray Kids',
  '4UIOuc84ExWojcUzFGtb8W': 'Felix',
};

async function run() {
  const daysArg = process.argv.find(a => a.startsWith('--days='));
  const artistArg = process.argv.find(a => a.startsWith('--artist='));
  const threshold = daysArg ? parseInt(daysArg.split('=')[1], 10) : 3;
  const onlyArtist = artistArg ? artistArg.split('=')[1] : null;

  const pool = getPool();
  const client = await pool.connect();
  try {
    const ids = onlyArtist ? [onlyArtist] : Object.keys(ARTISTS);
    for (const id of ids) {
      const uri = `spotify:artist:${id}`;
      const f = await client.query(
        `SELECT MAX(st.recorded_date) d
         FROM stream_stats st JOIN songs s ON s.id = st.song_id
         WHERE s.primary_artist = $1`, [uri]);
      const frontier = f.rows[0].d;
      if (!frontier) { console.log(`\n${ARTISTS[id] || id}: no data.`); continue; }

      const r = await client.query(
        `SELECT s.id, s.title, a.title AS album,
                MAX(st.recorded_date) AS last_date,
                COUNT(st.*) AS days
         FROM songs s
         JOIN albums a ON a.id = s.album_id
         LEFT JOIN stream_stats st ON st.song_id = s.id
         WHERE s.primary_artist = $1
         GROUP BY s.id, s.title, a.title
         HAVING MAX(st.recorded_date) IS NULL
             OR MAX(st.recorded_date) < $2::date - $3::int
         ORDER BY MAX(st.recorded_date) ASC NULLS FIRST`,
        [uri, frontier, threshold]);

      const name = ARTISTS[id] || id;
      console.log(`\n=== ${name} — frontier ${frontier.toISOString().slice(0, 10)} — ${r.rowCount} frozen track(s) (>${threshold}d behind) ===`);
      for (const x of r.rows) {
        const last = x.last_date ? x.last_date.toISOString().slice(0, 10) : 'NEVER';
        console.log(`  last=${last} days=${x.days} | "${x.title}" | ${x.album} | ${x.id}`);
      }
    }
  } finally {
    client.release();
    await closePool();
  }
}

run().catch(e => { console.error('[audit] ERROR:', e.message); process.exit(1); });
