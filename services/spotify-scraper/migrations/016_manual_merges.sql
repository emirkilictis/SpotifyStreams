-- Migration 016: admin-managed manual merge / split rules.
-- Lets the admin panel override the automatic deduper:
--   * a MERGE rule  (canonical_id set)  forces alias_id -> canonical_id, even if
--     the deduper would not have linked them (e.g. same stream count but the
--     durations are further apart than the tolerance, or different albums).
--   * a SPLIT rule  (canonical_id NULL) pins alias_id independent — the deduper
--     will never fold it into another canonical (like the hardcoded NEVER_MERGE).
-- dedup.js resets all canonical_id's on every run, so these rules are re-applied
-- each time; without the table the manual fix would be undone by the next scrape.
-- Apply manually against Neon (Render won't auto-run migrations).

CREATE TABLE IF NOT EXISTS manual_merges (
  alias_id     TEXT PRIMARY KEY,        -- the song being merged away / pinned
  canonical_id TEXT,                    -- target canonical; NULL = keep separate (split)
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
