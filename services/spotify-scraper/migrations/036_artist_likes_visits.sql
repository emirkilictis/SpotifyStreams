-- Migration 036: public like counts + admin-only profile visit counts.
--
-- Likes: the site has no accounts, so a "voter" is a random id the browser
-- keeps in localStorage. One row per (artist, voter) makes a like idempotent
-- (liking twice from the same browser counts once) and an unlike a DELETE.
-- ip_hash (HMAC, never the raw IP) lets the server cap how many distinct
-- voters a single network can add per artist, so clearing localStorage in a
-- loop doesn't inflate a count.
CREATE TABLE IF NOT EXISTS artist_like_votes (
  artist_id  TEXT        NOT NULL,
  voter_id   TEXT        NOT NULL,
  ip_hash    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id, voter_id)
);
CREATE INDEX IF NOT EXISTS artist_like_votes_ip
  ON artist_like_votes (artist_id, ip_hash);

-- Visits: one row per artist per day. The server buffers increments in
-- memory and flushes them in one statement, so a profile open is not a DB
-- write of its own.
CREATE TABLE IF NOT EXISTS artist_visits (
  artist_id  TEXT    NOT NULL,
  visit_date DATE    NOT NULL,
  visits     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artist_id, visit_date)
);
