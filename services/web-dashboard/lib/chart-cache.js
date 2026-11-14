'use strict';
/**
 * chart_daily_streams is a materialized COPY of daily_streams_canonical, keyed
 * by canonical head. It is only right while two things hold: its rows carry the
 * newest readings, and its keys are the heads songs.canonical_id names today.
 * Nothing in Postgres keeps either true — a dedup, an admin merge, a repair or a
 * refresh that did not run all leave the copy describing a catalogue that no
 * longer exists, and a reader that trusts it silently drops songs.
 *
 * That is what happened twice in November 2026. The refresh had grown to ~2
 * minutes, hit the role's 2-minute statement_timeout and was logged as
 * "skipped"; the dedup before it had moved 85 heads; and the dashboard's
 * freshness test only COUNTED heads owned by the artist, so it never looked at
 * pinned collabs and one head too many cancelled one missing. JT's headline
 * lost "4 Minutes" (577M) and three FSLS tracks, Cardi "Bet You Wanna" (225M).
 *
 * Everything that decides "is the copy usable" or "rebuild the copy" lives here
 * so the dashboard and the scraper cannot drift apart on the answer.
 */

// How many heads of `headsSql` (a query returning one column, `id`, of canonical
// head ids) the copy gets wrong. Both counts must be 0 to read the copy.
//
//   heads_behind  the copy's newest row for the head is not the head's newest
//                 live reading: a missing key (the head moved), an older day, a
//                 day that no longer exists (a re-dated scan), or the same day
//                 with a smaller total (a later scan of that day).
//   alias_keys    a song that is now an ALIAS still has rows under its own id:
//                 the copy was built before a merge or a head move, so that
//                 family's history is split across two keys.
//
// The expected value mirrors the view exactly. A normal head's cumulative is a
// running maximum over every reading of every copy, so it can never be below any
// copy's newest reading. An AI head keeps the day's LAST reading, raw (the view's
// ai_latest), and hides totals under 1,000.
//
// Every lookup is one index probe per song: ~50 ms for the largest catalogue.
function chartCacheDriftSQL(headsSql) {
  return `
    WITH drift_heads AS MATERIALIZED (${headsSql}),
    drift_family AS MATERIALIZED (
      SELECT h.id AS head, h.id FROM drift_heads h
      UNION ALL
      SELECT h.id AS head, m.id FROM drift_heads h JOIN songs m ON m.canonical_id = h.id
    ),
    drift_ai AS MATERIALIZED (
      SELECT f.head, BOOL_OR(COALESCE('ai' = ANY(ta.categories), false)) AS is_ai
      FROM drift_family f
      JOIN songs m ON m.id = f.id
      LEFT JOIN tracked_artists ta ON 'spotify:artist:' || ta.artist_id = m.primary_artist
      GROUP BY f.head
    ),
    drift_live AS MATERIALIZED (
      SELECT DISTINCT ON (f.head)
             f.head,
             x.recorded_date AS d,
             x.stream_count AS last_count,
             MAX(x.stream_count) OVER (PARTITION BY f.head) AS max_count
      FROM drift_family f
      CROSS JOIN LATERAL (
        SELECT ss.recorded_date, ss.stream_count, ss.recorded_at
        FROM stream_stats ss
        WHERE ss.song_id = f.id
        ORDER BY ss.recorded_date DESC
        LIMIT 1
      ) x
      ORDER BY f.head, x.recorded_date DESC, x.recorded_at DESC, f.id DESC
    )
    SELECT
      (SELECT COUNT(*)
         FROM drift_live l
         JOIN drift_ai ai ON ai.head = l.head
         LEFT JOIN LATERAL (
           SELECT c.recorded_date, c.cumulative
           FROM chart_daily_streams c
           WHERE c.canonical_id = l.head
           ORDER BY c.recorded_date DESC
           LIMIT 1
         ) c ON TRUE
        WHERE c.recorded_date IS DISTINCT FROM l.d
           OR CASE WHEN ai.is_ai
                   THEN c.cumulative IS DISTINCT FROM
                        (CASE WHEN l.last_count < 1000 THEN NULL ELSE l.last_count END)
                   ELSE c.cumulative IS NULL OR c.cumulative < l.max_count
              END)::int AS heads_behind,
      (SELECT COUNT(*)
         FROM drift_family f
        WHERE f.id <> f.head
          AND EXISTS (SELECT 1 FROM chart_daily_streams c WHERE c.canonical_id = f.id))::int AS alias_keys`;
}

// Every canonical head in the catalogue — the scope the scraper checks.
const ALL_HEADS_SQL = `SELECT id FROM songs WHERE canonical_id IS NULL`;

async function chartCacheDrift(client, headsSql = ALL_HEADS_SQL, params = []) {
  const { rows } = await client.query(chartCacheDriftSQL(headsSql), params);
  const row = rows[0] || {};
  return { headsBehind: Number(row.heads_behind) || 0, aliasKeys: Number(row.alias_keys) || 0 };
}

// The refresh recomputes every head's whole history and gets slower each day.
// It crossed the role default of 2 minutes on 2026-11-14 and from then on would
// have failed on every run, so it runs with its own generous limit — on a
// dedicated client, because the setting is session-wide.
const REFRESH_TIMEOUT = '20min';

async function refreshChartCache(client) {
  const started = Date.now();
  await client.query(`SET statement_timeout = '${REFRESH_TIMEOUT}'`);
  try {
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY chart_daily_streams');
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
  }
  return Date.now() - started;
}

// Refresh only when the copy is wrong. Cheap enough to run every hour, so a
// refresh that failed, an admin merge at noon or a repair script heals within
// the hour instead of waiting for the next day's scrape.
async function ensureChartCacheFresh(client, log = console.log) {
  const before = await chartCacheDrift(client);
  if (!before.headsBehind && !before.aliasKeys) {
    log('[chart-cache] in sync with the live catalogue; no refresh needed.');
    return { refreshed: false, before, after: before };
  }
  log(`[chart-cache] out of sync: ${before.headsBehind} head(s) behind, ${before.aliasKeys} alias key(s). Refreshing...`);
  const ms = await refreshChartCache(client);
  const after = await chartCacheDrift(client);
  log(`[chart-cache] refreshed in ${(ms / 1000).toFixed(1)}s; now ${after.headsBehind} head(s) behind, ${after.aliasKeys} alias key(s).`);
  return { refreshed: true, before, after };
}

module.exports = {
  chartCacheDriftSQL,
  chartCacheDrift,
  refreshChartCache,
  ensureChartCacheFresh,
  ALL_HEADS_SQL,
};
