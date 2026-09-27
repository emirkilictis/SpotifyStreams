-- Migration 028: canonical AI totals use the last observation, not the daily maximum.
--
-- Normal catalogues intentionally retain MAX as protection against stale album
-- pages. AI catalogues are different: Spotify regularly removes streams, so a
-- lower value can be the newest truthful value. When multiple physical copies
-- of one canonical recording are read on the same chart day, recorded_at decides
-- which observation wins.

CREATE OR REPLACE VIEW daily_streams_canonical AS
WITH owners AS (
  SELECT COALESCE(s.canonical_id, s.id) AS song_id,
         BOOL_OR(COALESCE('ai' = ANY(ta.categories), false)) AS is_ai
  FROM songs s
  LEFT JOIN tracked_artists ta ON 'spotify:artist:' || ta.artist_id = s.primary_artist
  GROUP BY 1
),
ai_latest AS (
  SELECT DISTINCT ON (COALESCE(s.canonical_id, s.id), ss.recorded_date)
         COALESCE(s.canonical_id, s.id) AS song_id,
         ss.recorded_date,
         ss.stream_count
  FROM stream_stats ss
  JOIN songs s ON s.id = ss.song_id
  JOIN owners o ON o.song_id = COALESCE(s.canonical_id, s.id) AND o.is_ai
  ORDER BY COALESCE(s.canonical_id, s.id), ss.recorded_date,
           ss.recorded_at DESC, s.id DESC
),
source_rows AS (
  SELECT cs.song_id, cs.recorded_date, cs.stream_count, false AS is_ai
  FROM canonical_streams cs
  JOIN owners o ON o.song_id = cs.song_id AND NOT o.is_ai
  UNION ALL
  SELECT al.song_id, al.recorded_date, al.stream_count, true AS is_ai
  FROM ai_latest al
),
first_two AS (
  SELECT song_id,
         MIN(recorded_date) FILTER (WHERE rn = 1) AS d1,
         MAX(stream_count)  FILTER (WHERE rn = 1) AS c1,
         MIN(recorded_date) FILTER (WHERE rn = 2) AS d2,
         MAX(stream_count)  FILTER (WHERE rn = 2) AS c2
  FROM (
    SELECT song_id, recorded_date, stream_count,
           ROW_NUMBER() OVER (PARTITION BY song_id ORDER BY recorded_date) AS rn
    FROM source_rows
  ) ordered
  WHERE rn <= 2
  GROUP BY song_id
),
with_debut AS (
  SELECT song_id, recorded_date, stream_count, is_ai FROM source_rows
  UNION ALL
  SELECT f.song_id, f.d1 - 1, 0::bigint, o.is_ai
  FROM first_two f
  JOIN songs s ON s.id = f.song_id
  JOIN albums a ON a.id = s.album_id
  JOIN owners o ON o.song_id = f.song_id
  WHERE a.release_date IS NOT NULL
    AND f.d1 - a.release_date BETWEEN -1 AND 7
    AND (
      (f.d2 IS NOT NULL
       AND f.c2 > f.c1
       AND f.c1 <= 3 * ((f.c2 - f.c1)::numeric / (f.d2 - f.d1))
                     * (GREATEST(f.d1 - a.release_date, 0) + 1))
      OR (f.d2 IS NULL AND f.c1 > 0)
    )
),
running AS (
  SELECT song_id AS canonical_id,
         recorded_date,
         CASE WHEN is_ai THEN stream_count
              ELSE MAX(stream_count) OVER (
                PARTITION BY song_id ORDER BY recorded_date
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              )
         END AS cumulative,
         is_ai
  FROM with_debut
)
SELECT canonical_id,
       recorded_date,
       CASE WHEN is_ai AND cumulative < 1000 THEN NULL ELSE cumulative END AS cumulative,
       (cumulative - LAG(cumulative) OVER (
          PARTITION BY canonical_id ORDER BY recorded_date
        )) / NULLIF(recorded_date - LAG(recorded_date) OVER (
          PARTITION BY canonical_id ORDER BY recorded_date
        ), 0) AS daily_gain
FROM running;
