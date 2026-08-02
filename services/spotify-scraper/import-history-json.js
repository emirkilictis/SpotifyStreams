/**
 * One-off backfill: load pre-tracking per-song history from a JSON file into
 * stream_stats.
 *
 * Built for LISA (services/spotify-scraper/data/lisa-solo-history.json), which
 * came from a fan-maintained spreadsheet of her solo-era discography. The file
 * format is deliberately dumb so any future donation can reuse this script:
 *
 *   { "<song_id>": [ ["YYYY-MM-DD", <cumulative>], ... ], ... }
 *
 * where the date is a SCRAPE date in our own convention (a scrape on the 24th
 * reports streams as of the 23rd), already converted by whatever produced the
 * file.
 *
 * Safety rules, in order of importance:
 *
 *  1. ON CONFLICT DO NOTHING. Rows we scraped ourselves are authoritative and
 *     are never touched, so re-running this is a no-op. That also means any
 *     error in the donated data inside our own coverage window is ignored for
 *     free — the LISA sheet had a +6M typo on Priceless on 2026-07-22 and a raw
 *     playcount dip on Moonlit Floor, both of which land in the overlap.
 *  2. Unknown song ids abort the run rather than silently creating orphans.
 *  3. Dry run by default. Pass --apply to write.
 *
 * IMPORTANT — this only backfills the SONGS in the file. If the donation covers
 * part of an artist's catalogue (LISA's did: no MONEY, no LALISA), every
 * aggregate over the backfilled window is incomplete, so the artist needs an
 * entry in ARTIST_HISTORY_COMPLETE_FROM in services/web-dashboard/server.js.
 * Without it the dashboard will happily report a total that's missing half the
 * discography.
 *
 * Usage:
 *   node import-history-json.js data/lisa-solo-history.json           # dry run
 *   node import-history-json.js data/lisa-solo-history.json --apply
 */

require('dotenv').config({ path: '../../.env' });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const BATCH = 500;

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('usage: node import-history-json.js <file.json> [--apply]');
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const songIds = Object.keys(payload);
  const rows = [];
  for (const songId of songIds) {
    for (const [date, cumulative] of payload[songId]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date for ${songId}: ${date}`);
      const n = Number(cumulative);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad count for ${songId} on ${date}: ${cumulative}`);
      rows.push([songId, Math.round(n), date]);
    }
  }
  console.log(`${file}: ${rows.length.toLocaleString()} rows across ${songIds.length} songs`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    // Every id must already exist — this script backfills history for tracked
    // songs, it does not introduce new ones.
    const known = await client.query('SELECT id, title FROM songs WHERE id = ANY($1)', [songIds]);
    const missing = songIds.filter(id => !known.rows.some(r => r.id === id));
    if (missing.length) {
      throw new Error(`unknown song ids (import aborted): ${missing.join(', ')}`);
    }

    const before = await client.query(
      `SELECT song_id, COUNT(*)::int AS n, MIN(recorded_date)::text AS min_date
         FROM stream_stats WHERE song_id = ANY($1) GROUP BY song_id`,
      [songIds]
    );
    const beforeBySong = new Map(before.rows.map(r => [r.song_id, r]));

    if (!apply) {
      console.log('\nDRY RUN — nothing written. Per song:');
      for (const id of songIds) {
        const t = known.rows.find(r => r.id === id).title;
        const b = beforeBySong.get(id);
        const incoming = payload[id];
        console.log(
          `  ${t.slice(0, 40).padEnd(40)} +${String(incoming.length).padStart(4)} rows ` +
          `(${incoming[0][0]} … ${incoming[incoming.length - 1][0]})  ` +
          `existing: ${b ? `${b.n} from ${b.min_date}` : 'none'}`
        );
      }
      console.log('\nRe-run with --apply to write.');
      return;
    }

    await client.query('BEGIN');
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = chunk
        .map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::date, $${j * 3 + 3}::date::timestamptz)`)
        .join(', ');
      const res = await client.query(
        `INSERT INTO stream_stats (song_id, stream_count, recorded_date, recorded_at)
         VALUES ${values}
         ON CONFLICT (song_id, recorded_date) DO NOTHING`,
        chunk.flat()
      );
      inserted += res.rowCount;
      process.stdout.write(`\r  inserted ${inserted.toLocaleString()} / ${rows.length.toLocaleString()}`);
    }
    await client.query('COMMIT');
    console.log('\n');

    const after = await client.query(
      `SELECT song_id, COUNT(*)::int AS n, MIN(recorded_date)::text AS min_date
         FROM stream_stats WHERE song_id = ANY($1) GROUP BY song_id`,
      [songIds]
    );
    for (const r of after.rows) {
      const t = known.rows.find(k => k.id === r.song_id).title;
      const b = beforeBySong.get(r.song_id);
      console.log(
        `  ${t.slice(0, 40).padEnd(40)} ${b ? b.n : 0} -> ${r.n} rows, ` +
        `history now starts ${r.min_date} (was ${b ? b.min_date : 'n/a'})`
      );
    }
    console.log(`\n${inserted.toLocaleString()} rows inserted, ${(rows.length - inserted).toLocaleString()} skipped as already present.`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* not in a transaction */ }
    console.error('\nImport failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
