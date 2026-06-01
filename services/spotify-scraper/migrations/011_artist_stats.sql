-- Migration 011: Artist-level stats (monthly listeners, followers, world rank)
-- Spotify's monthlyListeners is a rolling 28-day metric that can go up OR down,
-- so unlike stream_stats we do NOT clamp with GREATEST — we overwrite per day.

CREATE TABLE IF NOT EXISTS artist_stats (
  id                BIGSERIAL PRIMARY KEY,
  artist_id         TEXT        NOT NULL,
  artist_name       TEXT,
  monthly_listeners BIGINT,
  followers         BIGINT,
  world_rank        INTEGER,
  recorded_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artist_stats_artist_recorded
  ON artist_stats (artist_id, recorded_date DESC);

-- One snapshot per artist per day (upsert target)
CREATE UNIQUE INDEX IF NOT EXISTS idx_artist_stats_artist_day
  ON artist_stats (artist_id, recorded_date);
