-- Migration 008: Add is_solo column to songs
-- Differentiates between solo tracks and lead collaborations

ALTER TABLE songs ADD COLUMN IF NOT EXISTS is_solo BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing featured tracks cannot be solo tracks
UPDATE songs SET is_solo = FALSE WHERE is_featured = TRUE;
