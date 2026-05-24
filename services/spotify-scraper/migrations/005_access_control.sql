-- Migration 005: Access control for fans

CREATE TABLE IF NOT EXISTS access_codes (
  code       TEXT PRIMARY KEY,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert a default fan code for the user
INSERT INTO access_codes (code, name)
VALUES ('timberlake_fan', 'Default Fan')
ON CONFLICT (code) DO NOTHING;
