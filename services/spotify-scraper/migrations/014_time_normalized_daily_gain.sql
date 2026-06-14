-- Migration 014: Enforce time-normalized daily gain calculations
-- This prevents scraper runs at irregular hours (e.g. morning vs. evening)
-- from causing artificial spikes or drops in daily playcount statistics.

-- 1) Recreate canonical_streams view with recorded_at timestamp
CREATE OR REPLACE VIEW canonical_streams AS
SELECT
  COALESCE(s.canonical_id, s.id) AS song_id,
  ss.recorded_date,
  MAX(ss.stream_count)            AS stream_count,
  MAX(ss.recorded_at)             AS recorded_at
FROM stream_stats ss
JOIN songs s ON s.id = ss.song_id
GROUP BY COALESCE(s.canonical_id, s.id), ss.recorded_date;

-- 2) Recreate daily_streams view with time-based normalization
CREATE OR REPLACE VIEW daily_streams AS
WITH running_max AS (
  SELECT
    ss.song_id,
    s.title,
    s.is_featured,
    COALESCE(s.canonical_id, s.id) AS canonical_id,
    ss.recorded_date,
    ss.recorded_at,
    MAX(ss.stream_count) OVER (
      PARTITION BY ss.song_id 
      ORDER BY ss.recorded_date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative
  FROM stream_stats ss
  JOIN songs s ON s.id = ss.song_id
)
SELECT
  song_id,
  title,
  is_featured,
  canonical_id,
  recorded_date,
  cumulative,
  ROUND(
    (cumulative - LAG(cumulative) OVER (PARTITION BY song_id ORDER BY recorded_date))::numeric /
    NULLIF(
      GREATEST(
        EXTRACT(EPOCH FROM (recorded_at - LAG(recorded_at) OVER (PARTITION BY song_id ORDER BY recorded_date))) / 86400.0,
        0.5
      ),
      0
    )::numeric
  )::bigint AS daily_gain
FROM running_max;

-- 3) Recreate daily_streams_canonical view with time-based normalization
CREATE OR REPLACE VIEW daily_streams_canonical AS
WITH running_max AS (
  SELECT
    song_id AS canonical_id,
    recorded_date,
    recorded_at,
    MAX(stream_count) OVER (
      PARTITION BY song_id 
      ORDER BY recorded_date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative
  FROM canonical_streams
)
SELECT
  canonical_id,
  recorded_date,
  cumulative,
  ROUND(
    (cumulative - LAG(cumulative) OVER (PARTITION BY canonical_id ORDER BY recorded_date))::numeric /
    NULLIF(
      GREATEST(
        EXTRACT(EPOCH FROM (recorded_at - LAG(recorded_at) OVER (PARTITION BY canonical_id ORDER BY recorded_date))) / 86400.0,
        0.5
      ),
      0
    )::numeric
  )::bigint AS daily_gain
FROM running_max;
