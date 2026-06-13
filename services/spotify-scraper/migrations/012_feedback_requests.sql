-- Migration 012: Visitor feedback / request form storage.
-- Apply manually against Neon (Render won't auto-run migrations).

CREATE TABLE IF NOT EXISTS feedback_requests (
  id          SERIAL PRIMARY KEY,
  message     TEXT NOT NULL,
  contact     TEXT,                -- optional: name / email / @ handle
  artist_id   TEXT,                -- which artist page they sent it from
  page_path   TEXT,                -- referer pathname for debugging
  ip_hash     TEXT,                -- sha256(ip + secret), for rate-limit / abuse
  user_agent  TEXT,
  status      TEXT NOT NULL DEFAULT 'new',  -- new / read / done / spam
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_requests_created_at
  ON feedback_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_requests_status
  ON feedback_requests (status, created_at DESC);
