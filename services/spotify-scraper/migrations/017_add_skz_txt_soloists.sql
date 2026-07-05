-- Migration 017: Add Stray Kids members + TXT's Yeonjun as tracked artists.
-- image_url left NULL — fill in via Admin > Artists (paste the Spotify CDN
-- profile image URL) once added; this environment couldn't fetch it directly.
-- Apply manually against Neon (Render won't auto-run migrations).

INSERT INTO tracked_artists (artist_id, name, image_url, accent, sort_order, album_only, locked) VALUES
  ('2Mo2yHjmrDRZW7yRuJwR2w', 'Yeonjun',  NULL, '#38bdf8', 100, FALSE, FALSE),
  ('3XSid6KaiKoMAVZs2ug3yw', 'Changbin', NULL, '#f97316', 101, FALSE, FALSE),
  ('46YvTuKiPBUu5KP9818J2F', 'HAN',      NULL, '#22d3ee', 102, FALSE, FALSE),
  ('5jRUIqBSxmsBPNiEwKUjgZ', 'Bangchan', NULL, '#14b8a6', 103, FALSE, FALSE),
  ('1odvXbzhdzNajv6un9x5Mc', 'I.N',      NULL, '#84cc16', 104, FALSE, FALSE),
  ('04jivE3Ek7Xu8WSGVmEqUn', 'Lee Know', NULL, '#eab308', 105, FALSE, FALSE),
  ('0ymFDpsRImjK673AGgFBcg', 'Hyunjin',  NULL, '#f43f5e', 106, FALSE, FALSE)
ON CONFLICT (artist_id) DO NOTHING;
