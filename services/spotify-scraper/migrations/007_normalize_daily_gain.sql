-- Migration 007: Normalize daily stream gains by day difference
-- Prevents inflated numbers when there are gaps of multiple days between scraper runs.

-- 1) Update daily_streams view
CREATE OR REPLACE VIEW daily_streams AS
SELECT
  ss.song_id,
  s.title,
  s.is_featured,
  COALESCE(s.canonical_id, s.id) AS canonical_id,
  ss.recorded_date,
  ss.stream_count                                                                AS cumulative,
  ((ss.stream_count - LAG(ss.stream_count) OVER (
    PARTITION BY ss.song_id ORDER BY ss.recorded_date
  )) / NULLIF(ss.recorded_date - LAG(ss.recorded_date) OVER (
    PARTITION BY ss.song_id ORDER BY ss.recorded_date
  ), 0))::bigint                                                                 AS daily_gain
FROM stream_stats ss
JOIN songs s ON s.id = ss.song_id;

-- 2) Update daily_streams_canonical view
CREATE OR REPLACE VIEW daily_streams_canonical AS
SELECT
  song_id AS canonical_id,
  recorded_date,
  stream_count AS cumulative,
  ((stream_count - LAG(stream_count) OVER (
    PARTITION BY song_id ORDER BY recorded_date
  )) / NULLIF(recorded_date - LAG(recorded_date) OVER (
    PARTITION BY song_id ORDER BY recorded_date
  ), 0))::bigint AS daily_gain
FROM canonical_streams;
