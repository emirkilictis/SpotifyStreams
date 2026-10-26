-- Profile display settings never modify recordings or their stream history.
CREATE TABLE IF NOT EXISTS album_profile_settings (
  artist_id TEXT NOT NULL REFERENCES tracked_artists(artist_id) ON DELETE CASCADE,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'auto' CHECK (visibility IN ('auto','show','hide')),
  sort_order INTEGER CHECK (sort_order BETWEEN 0 AND 9999),
  release_type TEXT NOT NULL DEFAULT 'auto' CHECK (release_type IN ('auto','album','ep','single')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artist_id, album_id)
);
-- Additional membership preserves standalone singles and canonical recordings.
CREATE TABLE IF NOT EXISTS album_extra_tracks (
  artist_id TEXT NOT NULL REFERENCES tracked_artists(artist_id) ON DELETE CASCADE,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  track_number INTEGER,
  PRIMARY KEY (artist_id, album_id, song_id)
);
CREATE INDEX IF NOT EXISTS album_extra_tracks_album ON album_extra_tracks(album_id);
ALTER TABLE playlist_imports ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'playlist'
  CHECK (source_type IN ('playlist','album'));
