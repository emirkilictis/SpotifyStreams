-- Browser work runs in Actions; the admin panel reviews its persisted result.
CREATE TABLE IF NOT EXISTS playlist_imports (
  id UUID PRIMARY KEY,
  artist_id TEXT NOT NULL REFERENCES tracked_artists(artist_id),
  playlist_id TEXT NOT NULL,
  requested_role TEXT NOT NULL CHECK (requested_role IN ('admin', 'secadmin')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'reading', 'ready', 'applied', 'failed')),
  tracks JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS playlist_imports_recent ON playlist_imports(created_at DESC);
-- Explicit track pins also let the daily scraper retain title-only features.
-- Membership uses extra_artist_songs, the existing administrator override.
