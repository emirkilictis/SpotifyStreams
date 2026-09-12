-- Migration 023: count a new release's debut streams on the day we first saw it.
--
-- A song's FIRST snapshot has no earlier row to diff against, so its daily_gain
-- was NULL and everything it earned before that snapshot belonged to no day.
-- For old catalogue that is right: a song first read today at 900M did not earn
-- 900M today. For a brand-new release it throws away its biggest day.
--
-- LISA's "SaWaDiKa" (album release_date 2026-09-02) was first read on
-- 2026-09-05 at 3,913,030 and then gained ~2.6-2.9M a day, so its song page
-- showed nothing for the debut. kworb's global chart puts the debut on
-- 2026-09-04 at 2,787,349, and our playcount gains run ~1.35x the chart
-- figure on every later day (2,083,002 -> 2,901,653; 1,901,776 -> 2,595,557):
-- 2,787,349 x 1.35 ~= 3.76M, i.e. that first reading IS the debut day.
--
-- So for a head that qualifies, add a synthetic 0 reading the day before its
-- first real one. The first real row then diffs against 0 like any other day.
-- Deliberately NOT spread back to release_date: Spotify's release_date can sit
-- days before the real drop (here 09-02 vs a 09-04 chart debut), and spreading
-- would halve the debut.
--
-- A head qualifies only when all hold:
--   * its album's release_date is known and the first snapshot is within
--     -1..7 days of it (old catalogue, or a new artist's back catalogue, never
--     qualifies);
--   * it is still growing (second reading above the first);
--   * the first reading is plausible as fresh streams: at most 3x the next
--     per-day gain for each day since release. This is the guard against a
--     reissue whose new track id inherits a linked playcount of hundreds of
--     millions. On 2026-09-13, 68 heads qualified across all history — the
--     largest real ratio 2.79 — including six of LISA's donated-history
--     debuts (Rockstar 7,782,173 on 2024-06-29, New Woman 7,646,273, Moonlit
--     Floor 6,049,492, ...) that had the same blank first day. The one head in
--     the window it rejected was an AI track that read 1,009 then gained 2/day.
--
-- canonical_streams (raw per-day MAX) is untouched: raw drop detection, the
-- health page and Trending Now read it and must keep seeing only scraped data.
-- Trending in particular would otherwise flag every new release on its debut.
--
-- KEEP IN SYNC with debutBaselineSQL() in services/web-dashboard/lib/agg-sql.js,
-- which applies the same rule to the song list, albums, the headline and Time
-- Machine. The two disagreeing is how site numbers stop matching each other.
--
-- Both branches are plain subqueries, not one shared CTE: a CTE referenced
-- twice is materialised, which would stop the song page's
-- `WHERE canonical_id = $1` from being pushed down and make every song history
-- scan the whole table.
--
-- Rollback: re-run the daily_streams_canonical block of
-- 015_revert_to_calendar_daily_gain.sql. Same columns and types, so
-- CREATE OR REPLACE works in both directions.

CREATE OR REPLACE VIEW daily_streams_canonical AS
WITH running_max AS (
  SELECT
    b.song_id AS canonical_id,
    b.recorded_date,
    MAX(b.stream_count) OVER (
      PARTITION BY b.song_id
      ORDER BY b.recorded_date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative
  FROM (
    SELECT song_id, recorded_date, stream_count FROM canonical_streams
    UNION ALL
    SELECT f.song_id, (f.d1 - 1) AS recorded_date, 0::bigint AS stream_count
    FROM (
      SELECT song_id,
             MIN(recorded_date) FILTER (WHERE rn = 1) AS d1,
             MAX(stream_count)  FILTER (WHERE rn = 1) AS c1,
             MIN(recorded_date) FILTER (WHERE rn = 2) AS d2,
             MAX(stream_count)  FILTER (WHERE rn = 2) AS c2
      FROM (
        SELECT song_id, recorded_date, stream_count,
               ROW_NUMBER() OVER (PARTITION BY song_id ORDER BY recorded_date) AS rn
        FROM (
          -- The same per-head, per-day MAX that canonical_streams computes,
          -- built straight from stream_stats so the release-date bound below
          -- applies BEFORE grouping. Filtering the canonical_streams view
          -- instead still grouped all ~800K rows first.
          SELECT COALESCE(xs.canonical_id, xs.id) AS song_id,
                 xss.recorded_date,
                 MAX(xss.stream_count) AS stream_count
          FROM stream_stats xss
          JOIN songs xs ON xs.id = xss.song_id
          JOIN songs ps ON ps.id = COALESCE(xs.canonical_id, xs.id)
          JOIN albums pa ON pa.id = ps.album_id
          -- Speed-up only; changes no result. A head qualifies only if its
          -- first snapshot is <= 7 days after release, and the earliest
          -- snapshot we hold is 2024-06-29, so nothing released before
          -- 2024-06-22 can ever qualify. That leaves ~1.3K of ~9K heads and
          -- ~107K of ~800K rows to sort. Without it, a whole-view COUNT went
          -- 1.6s -> 8.7s in testing.
          -- A literal on purpose: MIN(recorded_date) is a ~300ms seq scan (no
          -- index on the column) and would run on EVERY query, the song page
          -- included. If older history is ever backfilled, lower it — a stale
          -- bound only leaves those debuts blank, as they were before.
          WHERE pa.release_date >= DATE '2024-06-22'
          GROUP BY 1, 2
        ) pre
      ) o
      WHERE rn <= 2
      GROUP BY song_id
    ) f
    JOIN songs ds ON ds.id = f.song_id
    JOIN albums da ON da.id = ds.album_id
    WHERE da.release_date IS NOT NULL
      AND f.d1 - da.release_date BETWEEN -1 AND 7
      AND f.c2 > f.c1
      AND f.c1 <= 3 * ((f.c2 - f.c1)::numeric / (f.d2 - f.d1))
                    * (GREATEST(f.d1 - da.release_date, 0) + 1)
  ) b
)
SELECT
  canonical_id,
  recorded_date,
  cumulative,
  (cumulative - LAG(cumulative) OVER (PARTITION BY canonical_id ORDER BY recorded_date))
    / NULLIF(recorded_date - LAG(recorded_date) OVER (PARTITION BY canonical_id ORDER BY recorded_date), 0)
    AS daily_gain
FROM running_max;
