-- Migration 001: Initial schema

CREATE TABLE IF NOT EXISTS albums (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  release_date DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS songs (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  album_id     TEXT REFERENCES albums(id) ON DELETE SET NULL,
  duration_ms  INTEGER,
  track_number INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stream_stats (
  id            BIGSERIAL PRIMARY KEY,
  song_id       TEXT        NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  stream_count  BIGINT      NOT NULL,
  recorded_date DATE        NOT NULL DEFAULT CURRENT_DATE,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stream_stats_song_recorded
  ON stream_stats (song_id, recorded_date DESC);

-- Aynı gün için tek kayıt garantisi (upsert hedefi)
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_stats_song_day
  ON stream_stats (song_id, recorded_date);
