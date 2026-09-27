-- Materialized daily source for the category charts.
--
-- daily_streams_canonical intentionally remains a live view for artist detail
-- pages, but a category chart can span 8K+ canonical songs. Re-running all of
-- its canonicalisation and window functions for every chart request takes tens
-- of seconds. The scraper refreshes this copy after its transactional dedup so
-- chart reads stay fast and see one coherent snapshot.

CREATE MATERIALIZED VIEW IF NOT EXISTS chart_daily_streams AS
SELECT canonical_id, recorded_date, cumulative, daily_gain
FROM daily_streams_canonical;

CREATE UNIQUE INDEX IF NOT EXISTS chart_daily_streams_song_day_idx
  ON chart_daily_streams (canonical_id, recorded_date);

CREATE INDEX IF NOT EXISTS chart_daily_streams_day_idx
  ON chart_daily_streams (recorded_date, canonical_id);
