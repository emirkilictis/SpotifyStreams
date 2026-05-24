-- Migration 003: Canonical song deduplication
-- Aynı şarkının farklı release'lerini gruplar (compilation, deluxe, 12" mix vb.)

ALTER TABLE songs
  ADD COLUMN IF NOT EXISTS canonical_id TEXT REFERENCES songs(id);

CREATE INDEX IF NOT EXISTS idx_songs_canonical ON songs (canonical_id);

-- View: stream'lerin canonical'a göre toplandığı kanonikal görünüm
CREATE OR REPLACE VIEW canonical_streams AS
SELECT
  COALESCE(s.canonical_id, s.id) AS song_id,
  ss.recorded_date,
  MAX(ss.stream_count)            AS stream_count
FROM stream_stats ss
JOIN songs s ON s.id = ss.song_id
GROUP BY COALESCE(s.canonical_id, s.id), ss.recorded_date;
