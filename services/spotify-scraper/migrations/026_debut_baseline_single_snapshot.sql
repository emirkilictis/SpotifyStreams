-- Migration 026: count debut streams for brand-new releases even on their very first snapshot.
--
-- Migration 023 introduced debut baselines, but required `c2 > c1` (i.e. at least TWO
-- snapshots to have been recorded). On a song's release day or debut snapshot (when rn = 1
-- and rn = 2 does not exist yet), its daily gain fell to NULL / 0.
--
-- For any track whose album release date is within the debut window (-1..7 days of its first
-- snapshot) and has only 1 snapshot so far (`d2 IS NULL` and `c1 > 0`), insert the synthetic
-- 0 baseline on (d1 - 1). This ensures its initial reading counts as its debut daily gain immediately.

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
          SELECT COALESCE(xs.canonical_id, xs.id) AS song_id,
                 xss.recorded_date,
                 MAX(xss.stream_count) AS stream_count
          FROM stream_stats xss
          JOIN songs xs ON xs.id = xss.song_id
          JOIN songs ps ON ps.id = COALESCE(xs.canonical_id, xs.id)
          JOIN albums pa ON pa.id = ps.album_id
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
      AND (
        (f.d2 IS NOT NULL
         AND f.c2 > f.c1
         AND f.c1 <= 3 * ((f.c2 - f.c1)::numeric / (f.d2 - f.d1))
                       * (GREATEST(f.d1 - da.release_date, 0) + 1))
        OR (f.d2 IS NULL AND f.c1 > 0)
      )
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
