-- Migration 014: admin-managed hidden songs.
-- Lets a bad/duplicate track be hidden from every dashboard listing from the
-- admin panel, instead of hardcoding ids in server.js (HIDDEN_TRACK_IDS).
-- The static list is still merged in, so this is purely additive.
-- Apply manually against Neon (Render won't auto-run migrations).

CREATE TABLE IF NOT EXISTS hidden_songs (
  song_id    TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
