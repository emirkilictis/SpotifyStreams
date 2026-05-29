-- Migration 009: Fix negative daily gains by enforcing running maximum on cumulative stream counts.
-- This handles Spotify playcount reporting fluctuations and caching issues gracefully.

-- 1) Update daily_streams view
CREATE OR REPLACE VIEW daily_streams AS
WITH running_max AS (
  SELECT
    ss.song_id,
    s.title,
    s.is_featured,
    COALESCE(s.canonical_id, s.id) AS canonical_id,
    ss.recorded_date,
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
  ((cumulative - LAG(cumulative) OVER (
    PARTITION BY song_id ORDER BY recorded_date
  )) / NULLIF(recorded_date - LAG(recorded_date) OVER (
    PARTITION BY song_id ORDER BY recorded_date
  ), 0))::bigint AS daily_gain
FROM running_max;

-- 2) Update daily_streams_canonical view
CREATE OR REPLACE VIEW daily_streams_canonical AS
WITH running_max AS (
  SELECT
    song_id AS canonical_id,
    recorded_date,
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
  ((cumulative - LAG(cumulative) OVER (
    PARTITION BY canonical_id ORDER BY recorded_date
  )) / NULLIF(recorded_date - LAG(recorded_date) OVER (
    PARTITION BY canonical_id ORDER BY recorded_date
  ), 0))::bigint AS daily_gain
FROM running_max;
