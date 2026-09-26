-- Migration 027: AI Artist Raw Streams, Negative Daily Gains & Under-1k Rule
--
-- For AI-tagged artists ('ai' = ANY(categories)), Spotify frequently purges/deletes bot streams.
-- Standard catalogs use running MAX (cumulative never falls) and clamp daily gains >= 0.
-- For AI artists:
--   1) Cumulative stream count uses raw reading, not running max (falls when Spotify deletes streams).
--   2) When a stream count drops, daily gain is negative.
--   3) When cumulative stream count is under 1,000, cumulative is NULL (total streams suppressed,
--      matching Spotify's '< 1,000' display).

CREATE OR REPLACE VIEW daily_streams_canonical AS
WITH running_max AS (
  SELECT
    b.song_id AS canonical_id,
    b.recorded_date,
    CASE
      WHEN b.is_ai THEN b.stream_count
      ELSE MAX(b.stream_count) OVER (
        PARTITION BY b.song_id
        ORDER BY b.recorded_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
    END AS cumulative,
    b.is_ai
  FROM (
    SELECT cs.song_id, cs.recorded_date, cs.stream_count,
           COALESCE('ai' = ANY(ta.categories), false) AS is_ai
    FROM canonical_streams cs
    JOIN songs s ON s.id = cs.song_id
    LEFT JOIN tracked_artists ta ON 'spotify:artist:' || ta.artist_id = s.primary_artist
    UNION ALL
    SELECT f.song_id, (f.d1 - 1) AS recorded_date, 0::bigint AS stream_count, false AS is_ai
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
  CASE
    WHEN is_ai AND cumulative < 1000 THEN NULL
    ELSE cumulative
  END AS cumulative,
  (cumulative - LAG(cumulative) OVER (PARTITION BY canonical_id ORDER BY recorded_date))
    / NULLIF(recorded_date - LAG(recorded_date) OVER (PARTITION BY canonical_id ORDER BY recorded_date), 0)
    AS daily_gain
FROM running_max;
