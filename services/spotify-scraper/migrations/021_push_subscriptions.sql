-- Web push: who gets told when a new stream day lands.
--
-- One row per browser (the endpoint URL the push service hands us is the
-- identity — it is already unique per browser+site), plus the artists that
-- browser asked to follow. Deleting the subscription cascades the follows.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_artist_follows (
  endpoint   TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
  artist_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (endpoint, artist_id)
);

CREATE INDEX IF NOT EXISTS idx_push_follows_artist ON push_artist_follows (artist_id);

-- The ledger that makes dispatch idempotent: one row per artist per stream day
-- that has already been announced. The dispatcher can therefore be called by
-- anything, as often as it likes (the hourly scrape, a cron ping, an admin
-- button) and nobody is notified twice for the same day.
CREATE TABLE IF NOT EXISTS push_sent_days (
  artist_id   TEXT NOT NULL,
  stream_date DATE NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipients  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artist_id, stream_date)
);
