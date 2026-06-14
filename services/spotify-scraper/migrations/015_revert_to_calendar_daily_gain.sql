-- Migration 015: Revert to calendar-date daily gain calculations
-- Spotify updates playcounts exactly once per calendar day in discrete steps.
-- Time-based normalization incorrectly scales up/down these discrete gains.
-- The calendar-date difference method is mathematically correct for daily steps.

DROP VIEW IF EXISTS daily_streams_canonical;
DROP VIEW IF EXISTS daily_streams;

-- 1) Recreate daily_streams view with calendar-date difference
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

-- 2) Recreate daily_streams_canonical view with calendar-date difference
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
