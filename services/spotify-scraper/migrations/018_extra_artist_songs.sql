-- Migration 018: Create extra_artist_songs table for mapping songs to multiple tracked artists.
CREATE TABLE IF NOT EXISTS extra_artist_songs (
  artist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  PRIMARY KEY (artist_id, song_id)
);

-- Seed with existing hardcoded extra track mappings:
INSERT INTO extra_artist_songs (artist_id, song_id) VALUES
  -- Felix (4UIOuc84ExWojcUzFGtb8W)
  ('4UIOuc84ExWojcUzFGtb8W', '1Iu7bqGwYVB6OGq4uLt2ak'),
  ('4UIOuc84ExWojcUzFGtb8W', '3VMeAc0SlgLaS9RzA8TSxH'),
  ('4UIOuc84ExWojcUzFGtb8W', '0bxB5Jie9fGKTIibfYVfei'),
  ('4UIOuc84ExWojcUzFGtb8W', '3B1kVUGFALavXUt8s9L65V'),
  
  -- I.N (1odvXbzhdzNajv6un9x5Mc)
  ('1odvXbzhdzNajv6un9x5Mc', '3B1kVUGFALavXUt8s9L65V'),
  ('1odvXbzhdzNajv6un9x5Mc', '5gXUFmE5AKFiInKyHVVEnL'),
  ('1odvXbzhdzNajv6un9x5Mc', '1J0qupz0gVGSB5jcRY35tL'),
  ('1odvXbzhdzNajv6un9x5Mc', '4fdxYCWRK0YXkxepMKsCDG'),
  ('1odvXbzhdzNajv6un9x5Mc', '0tXaDUdlhJHC3NyO843wTi'),
  ('1odvXbzhdzNajv6un9x5Mc', '7xUu5XhIGzuZspFp5v3VqG'),
  
  -- Changbin (3XSid6KaiKoMAVZs2ug3yw)
  ('3XSid6KaiKoMAVZs2ug3yw', '1Iu7bqGwYVB6OGq4uLt2ak'),
  ('3XSid6KaiKoMAVZs2ug3yw', '786A4mxiKmPGHA7z7dPA9K'),
  ('3XSid6KaiKoMAVZs2ug3yw', '1J0qupz0gVGSB5jcRY35tL'),
  ('3XSid6KaiKoMAVZs2ug3yw', '56uBQujWiOiFMFg1R3TZUJ'),
  ('3XSid6KaiKoMAVZs2ug3yw', '1Z6NmeYIfN4e8TuEYLFTKL'),
  ('3XSid6KaiKoMAVZs2ug3yw', '0bxB5Jie9fGKTIibfYVfei'),
  ('3XSid6KaiKoMAVZs2ug3yw', '56ZpFy1kLsXwtbHWX1CgJ4'),
  
  -- Bangchan (5jRUIqBSxmsBPNiEwKUjgZ)
  ('5jRUIqBSxmsBPNiEwKUjgZ', '3vGSv4l4czTve9jZoYeIWk'),
  ('5jRUIqBSxmsBPNiEwKUjgZ', '0hLvtmoexLKl14LrzxOYRt'),
  ('5jRUIqBSxmsBPNiEwKUjgZ', '0XABJLloqjHsF4mY4tGIOH'),
  ('5jRUIqBSxmsBPNiEwKUjgZ', '1J0qupz0gVGSB5jcRY35tL'),
  ('5jRUIqBSxmsBPNiEwKUjgZ', '1Z6NmeYIfN4e8TuEYLFTKL'),
  ('5jRUIqBSxmsBPNiEwKUjgZ', '0bxB5Jie9fGKTIibfYVfei'),
  ('5jRUIqBSxmsBPNiEwKUjgZ', '56ZpFy1kLsXwtbHWX1CgJ4'),
  
  -- HAN (46YvTuKiPBUu5KP9818J2F)
  ('46YvTuKiPBUu5KP9818J2F', '3czfvJgfEDfBT5OKA5qAU5'),
  ('46YvTuKiPBUu5KP9818J2F', '7jcpg7osgYWffx9LmLEoZ4'),
  ('46YvTuKiPBUu5KP9818J2F', '4atsZkGtoHHPugKK5wzAE1'),
  ('46YvTuKiPBUu5KP9818J2F', '1ifB8sqR8gd09DSEloo4Du'),
  ('46YvTuKiPBUu5KP9818J2F', '56ZpFy1kLsXwtbHWX1CgJ4'),
  
  -- Lee Know (04jivE3Ek7Xu8WSGVmEqUn)
  ('04jivE3Ek7Xu8WSGVmEqUn', '0hLvtmoexLKl14LrzxOYRt'),
  ('04jivE3Ek7Xu8WSGVmEqUn', '0nuXhivBOFDiriWCpdyU93'),
  
  -- Hyunjin (0ymFDpsRImjK673AGgFBcg)
  ('0ymFDpsRImjK673AGgFBcg', '1SrsEuRiRoopW2pZDaHgVA'),
  ('0ymFDpsRImjK673AGgFBcg', '07x9Jr01lqjlFycZsfKBae'),
  ('0ymFDpsRImjK673AGgFBcg', '1BwFLLe233S6HR1ravS3yi'),
  
  -- Seungmin (2nTtulf6WM0raQcIbzYJuf)
  ('2nTtulf6WM0raQcIbzYJuf', '4FopzmRUfn8Ob8xlYVZqe8'),
  ('2nTtulf6WM0raQcIbzYJuf', '16Xt6aWyMW5Ugb3nfsInJ3'),
  ('2nTtulf6WM0raQcIbzYJuf', '1KC5Y3kIiHvEDdinY0OcRL'),
  ('2nTtulf6WM0raQcIbzYJuf', '56uBQujWiOiFMFg1R3TZUJ'),
  ('2nTtulf6WM0raQcIbzYJuf', '5kFGqKqHzVVMMI7V7uoID1'),
  ('2nTtulf6WM0raQcIbzYJuf', '0bxB5Jie9fGKTIibfYVfei'),
  
  -- Cardi B (4kYSro6naA4h99UJvo89HB)
  ('4kYSro6naA4h99UJvo89HB', '4wFjTWCunQFKtukqrNijEt'),
  ('4kYSro6naA4h99UJvo89HB', '1YNQscOx6OqBQjxgJVhEeW'),
  ('4kYSro6naA4h99UJvo89HB', '6FluOWqqqg99zqIinlUHyZ'),
  ('4kYSro6naA4h99UJvo89HB', '2hpjjSJQJJOqtp3DWNLbVb')
ON CONFLICT (artist_id, song_id) DO NOTHING;
