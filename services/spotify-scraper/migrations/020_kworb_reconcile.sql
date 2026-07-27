-- 020 — self-healing kworb reconciliation (see reconcile-kworb.js)
--
-- Every newly added artist used to land BELOW kworb for two mechanical reasons,
-- each of which took a manual detective session to close:
--   1. a collab has exactly one primary_artist, so when the co-credited artist is
--      also tracked the track sits in THEIR bucket and never shows on this one
--      (kworb shows a collab on every credited artist's page);
--   2. a guest feature whose lead artist we DON'T track never appears in this
--      artist's Spotify "appears on", so it was never scraped at all.
--
-- (1) already had a DB-driven home: extra_artist_songs (migration 018).
-- (2) only had HARDCODED per-artist `extraAlbums` blocks inside scraper.js, so
--     every gap needed a code edit + deploy. extra_scrape_albums is the DB-driven
--     equivalent: scrapeArtist merges these into its album set for any artist.
-- kworb_audit records the outcome of each reconcile pass so the job can rate-limit
-- itself (skip artists checked recently, do never-checked ones first) and so the
-- admin Health tab can SHOW the remaining gap instead of it being noticed by eye.

CREATE TABLE IF NOT EXISTS extra_scrape_albums (
  artist_id    TEXT    NOT NULL,
  album_id     TEXT    NOT NULL,
  title        TEXT,
  release_date DATE,
  is_featured  BOOLEAN NOT NULL DEFAULT true,
  source       TEXT    NOT NULL DEFAULT 'kworb',
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artist_id, album_id)
);

CREATE INDEX IF NOT EXISTS idx_extra_scrape_albums_artist
  ON extra_scrape_albums (artist_id);

CREATE TABLE IF NOT EXISTS kworb_audit (
  artist_id     TEXT PRIMARY KEY,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kworb_total   BIGINT,
  our_total     BIGINT,
  kworb_tracks  INTEGER,
  our_tracks    INTEGER,
  gap           BIGINT,      -- kworb_total - our_total at check time (can be negative)
  -- Streams this pass just repaired. A pass MEASURES the gap before fixing it, so
  -- without this a fully repaired artist keeps reporting their old shortfall until
  -- the next check ~a day later. residual = gap - repaired_streams is what's really
  -- still missing, and that's what the Health tab flags on.
  repaired_streams BIGINT NOT NULL DEFAULT 0,
  linked_count  INTEGER NOT NULL DEFAULT 0,   -- rows written to extra_artist_songs this pass
  pinned_count  INTEGER NOT NULL DEFAULT 0,   -- albums written to extra_scrape_albums this pass
  unresolved    JSONB,       -- kworb tracks we could neither link nor pin (manual tail)
  error         TEXT
);
