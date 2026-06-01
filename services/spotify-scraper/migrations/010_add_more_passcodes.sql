-- Migration 010: Add more access codes
INSERT INTO access_codes (code, name)
VALUES 
  ('pussy', 'Pussy Pass'),
  ('dick', 'Dick Pass')
ON CONFLICT (code) DO NOTHING;
