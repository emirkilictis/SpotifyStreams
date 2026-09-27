-- Persist chart configuration that previously existed only in the live DB,
-- make the JC unlock effective on already-seeded databases, and support the
-- indexed album-first chart query.

ALTER TABLE tracked_artists
  ADD COLUMN IF NOT EXISTS categories TEXT[] NOT NULL DEFAULT '{}';

UPDATE tracked_artists
SET categories = COALESCE(categories, '{}'::text[]) || ARRAY['y2k']::text[]
WHERE artist_id IN (
  '31TPClRtHm23RisEBtV3X7', -- Justin Timberlake
  '6Ff53KvcvAj5U7Z1vojB5o', -- *NSYNC
  '5rSXSAkZ67PYJSvpUpkOr7', -- Backstreet Boys
  '26dSoYclwsYLMAKD3tpOr4', -- Britney Spears
  '1l7ZsJRRS8wlW3WfJfPfNS', -- Christina Aguilera
  '6vWDO969PvNqNYHIOW5v0m'  -- Beyonce
)
  AND NOT ('y2k' = ANY(COALESCE(categories, '{}'::text[])));

UPDATE tracked_artists
SET locked = FALSE
WHERE artist_id = '3p3U04w2DaiBzuYMZnYr00';

CREATE INDEX IF NOT EXISTS idx_songs_album_id
  ON songs (album_id);

CREATE INDEX IF NOT EXISTS idx_songs_primary_artist
  ON songs (primary_artist);
