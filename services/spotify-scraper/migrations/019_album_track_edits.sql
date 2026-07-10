-- Migration 019: admin-editable album tracklist overrides (display-only).
--
-- Two DB-driven mechanisms so the admin panel can adjust album tracklists
-- without a code change/redeploy. Neither touches canonical_id or any total —
-- they only change which album a track DISPLAYS under (pin) or hide a track from
-- album tracklists while keeping it in the artist's overall total (album-hide).

-- Pin a song into an album's display tracklist (e.g. a standalone remix single
-- into its parent album). PK is song_id: a song shows under exactly one pinned
-- display album.
CREATE TABLE IF NOT EXISTS album_track_pins (
  song_id  TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  note     TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Hide a song from album tracklists / album totals ONLY (it stays in the flat
-- song list and the artist's overall total). DB-backed version of the old
-- hardcoded HIDDEN_ALBUM_TRACK_IDS list; seeded with those ids below.
CREATE TABLE IF NOT EXISTS album_hidden_tracks (
  song_id TEXT PRIMARY KEY,
  note    TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO album_hidden_tracks (song_id, note) VALUES
  ('1FaU6P6WJF8irbZ1MXo9ky', 'Pose - Main Version (FSLS Deluxe)'),
  ('2rXovB7Zco7nc3nTHXKJoh', 'My Love (feat. T.I.) - Instrumental'),
  ('5CORNAMvxPl6uCikCsq1Ei', 'What Goes Around...Comes Around - Instrumental'),
  ('6233Z1W8t9Wn1f1gZqHhQ5', 'Suit & Tie - Radio Edit (frozen copy, replaced by live)')
ON CONFLICT (song_id) DO NOTHING;
