-- Migration 013: Single source of truth for the tracked-artist roster.
-- Holds the *presentational* config (name, image, accent, order, flags) so the
-- picker / dropdown / hero / OG can be data-driven and managed from the admin
-- panel. The per-artist BUCKET rules (which songs count) deliberately stay in
-- code (artistBucketMatchSQL) — they're kworb-tuned and risky to generalise.
-- Apply manually against Neon (Render won't auto-run migrations).

CREATE TABLE IF NOT EXISTS tracked_artists (
  artist_id    TEXT PRIMARY KEY,            -- Spotify artist id (no 'spotify:artist:' prefix)
  name         TEXT NOT NULL,
  image_url    TEXT,                        -- hero + OG image (local path or Spotify CDN)
  accent       TEXT,                        -- theme accent colour (hex)
  sort_order   INT  NOT NULL DEFAULT 100,   -- picker / dropdown order
  album_only   BOOLEAN NOT NULL DEFAULT FALSE, -- no songs list, milestones only (Gaga/Billie/Ariana)
  locked       BOOLEAN NOT NULL DEFAULT FALSE, -- gated behind a passcode (JC)
  active       BOOLEAN NOT NULL DEFAULT TRUE,  -- show on the site at all
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracked_artists_order
  ON tracked_artists (active, sort_order, name);

-- Seed with the current hardcoded roster (exact values, so behaviour is unchanged).
INSERT INTO tracked_artists (artist_id, name, image_url, accent, sort_order, album_only, locked) VALUES
  ('31TPClRtHm23RisEBtV3X7', 'Justin Timberlake', '/images/jt.jpg',                                                  '#1ed760',  1, FALSE, FALSE),
  ('5L1lO4eRHmJ7a0Q6csE5cT', 'LISA',              'https://i.scdn.co/image/ab6761610000e5eb5cd3b3af8b72e32be78571ec', '#ffd700',  2, FALSE, FALSE),
  ('2dIgFjalVxs4ThymZ67YCE', 'Stray Kids',        'https://i.scdn.co/image/ab6761610000e5ebf9887d2c9288f0e50a3fd69f', '#e2e2e7',  3, FALSE, FALSE),
  ('4UIOuc84ExWojcUzFGtb8W', 'Felix',             'https://i.scdn.co/image/ab6761610000e5eb51e1a166ae0cc73d8ec19909', '#ffb703',  4, FALSE, FALSE),
  ('2W8yFh0Ga6Yf3jiayVxwkE', 'Dove Cameron',      'https://i.scdn.co/image/ab6761610000e5eb0c5fcd837c1420d97f500ef9', '#b794f6',  5, FALSE, FALSE),
  ('1HY2Jd0NmPuamShAr6KMms', 'Lady Gaga',         'https://i.scdn.co/image/ab6761610000e5ebaadc18cac8d48124357c38e6', '#ff52a2',  6, TRUE,  FALSE),
  ('6qqNVTkY8uBg9cP3Jd7DAH', 'Billie Eilish',     'https://i.scdn.co/image/ab6761610000e5eb4a21b4760d2ecb7b0dcdc8da', '#bad80a',  7, TRUE,  FALSE),
  ('66CXWjxzNUsdJxJ2JdwvnR', 'Ariana Grande',     'https://i.scdn.co/image/ab6761610000e5eb766397ec42a573a53eb5fb87', '#b39ddb',  8, TRUE,  FALSE),
  ('6Ff53KvcvAj5U7Z1vojB5o', '*NSYNC',            'https://i.scdn.co/image/ab6761610000e5eb9414ef07d0ca697726912df1', '#3498db',  9, FALSE, FALSE),
  ('3LHYvj5ZejV1NLqncEObSJ', 'Vaelis',            'https://i.scdn.co/image/ab6761610000e5eb05e2f96f53a2810f5dcdd6c1', '#8b5cf6', 10, FALSE, FALSE),
  ('3p3U04w2DaiBzuYMZnYr00', 'JC Chasez',         'https://i.scdn.co/image/ab6761610000e5eb784d1c3b5bb30c5db83c8fe2', '#e74c3c', 11, FALSE, TRUE)
ON CONFLICT (artist_id) DO NOTHING;
