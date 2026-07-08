/**
 * repair-mistimed-snapshots.js — one-off cleanup for the "frozen daily gain" incident
 * (2026-07-08): a handful of stream_stats rows were written with a recorded_date many
 * days earlier than their real recorded_at (a leaked/mistimed transaction wrote a
 * fresh playcount but stamped it under an old date). Since daily_streams_canonical
 * takes a running MAX per canonical_id across all edition/alias copies, one such
 * mistimed row poisons that old date with today's value and flatlines daily_gain for
 * every day since — this hit Britney's Toxic/Gimme More/Baby One More Time/Womanizer
 * (all editions of the same tracks on a shared compilation album) plus assorted deep
 * cuts on Janet Jackson, Vaelis, Taylor Swift, Christina Aguilera and cupcakke.
 *
 * Fix: delete the mistimed rows. They're minor edition/compilation copies, not the
 * primary canonical driver for these songs (which is scraped correctly every day), so
 * removing them just lets canonical_streams' MAX for that date fall back to whatever
 * correct data exists — no real history is lost, only the poisoned duplicate.
 *
 * Usage: node repair-mistimed-snapshots.js [--apply]   (dry-run without --apply)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool, closePool } = require('./db');

const APPLY = process.argv.includes('--apply');
const LAG_THRESHOLD_DAYS = 3;

(async () => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT ss.id, ss.song_id, s.title, s.primary_artist,
              ss.recorded_date::text AS recorded_date, ss.recorded_at::text AS recorded_at,
              ss.stream_count,
              ((ss.recorded_at AT TIME ZONE 'Europe/Istanbul')::date - ss.recorded_date) AS lag_days
       FROM stream_stats ss
       JOIN songs s ON s.id = ss.song_id
       WHERE ((ss.recorded_at AT TIME ZONE 'Europe/Istanbul')::date - ss.recorded_date) > $1
       ORDER BY lag_days DESC`,
      [LAG_THRESHOLD_DAYS]
    );

    console.log(`Found ${res.rows.length} mistimed row(s) (lag > ${LAG_THRESHOLD_DAYS} days):\n`);
    for (const r of res.rows) {
      console.log(`  [${r.lag_days}d lag] ${r.title} (${r.primary_artist}) — id=${r.id} song=${r.song_id} date=${r.recorded_date} recorded_at=${r.recorded_at} count=${r.stream_count}`);
    }

    if (!res.rows.length) {
      console.log('\nNothing to repair.');
      return;
    }

    if (!APPLY) {
      console.log(`\nDry run only — re-run with --apply to delete these ${res.rows.length} row(s).`);
      return;
    }

    const ids = res.rows.map(r => r.id);
    const del = await client.query(`DELETE FROM stream_stats WHERE id = ANY($1::int[])`, [ids]);
    console.log(`\nDeleted ${del.rowCount} row(s).`);
  } finally {
    client.release();
    await closePool();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
