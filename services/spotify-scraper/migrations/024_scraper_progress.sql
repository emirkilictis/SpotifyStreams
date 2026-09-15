-- Migration 024: which artist the scrape is on.
--
-- scraper_status only said "scraping", so a 20-30 minute daily run gave no way
-- to tell where it was. The scraper now writes the artist it is working on and
-- how far through the roster it is (db.js setScraperProgress); the admin Status
-- tab and the site's sync banner show "Scraping Taylor Swift (12/64)".
--
-- Additive only. Code on both sides tolerates the columns being absent.
-- Apply directly (migrate.js re-runs every migration and fails on 003):
--   SET lock_timeout = '3s'; then this file.

ALTER TABLE scraper_status
  ADD COLUMN IF NOT EXISTS current_artist_id   TEXT,
  ADD COLUMN IF NOT EXISTS current_artist_name TEXT,
  ADD COLUMN IF NOT EXISTS progress_done       INT,
  ADD COLUMN IF NOT EXISTS progress_total      INT;
