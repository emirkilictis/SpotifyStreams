-- Migration 006: Fix multiple counting of streams for canonical songs
-- Uses MAX (from canonical_streams) instead of SUM (from daily_streams) to prevent duplicate playcounts from re-releases

CREATE OR REPLACE VIEW daily_streams_canonical AS
SELECT
  song_id AS canonical_id,
  recorded_date,
  stream_count AS cumulative,
  (stream_count - LAG(stream_count) OVER (
    PARTITION BY song_id ORDER BY recorded_date
  ))::bigint AS daily_gain
FROM canonical_streams;
