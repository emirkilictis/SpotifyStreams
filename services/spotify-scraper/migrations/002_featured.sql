-- Migration 002: Featured tracks support

ALTER TABLE songs
  ADD COLUMN IF NOT EXISTS is_featured  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS primary_artist TEXT;  -- albümün ana sanatçısı (Spotify URI)

CREATE INDEX IF NOT EXISTS idx_songs_is_featured ON songs (is_featured);
