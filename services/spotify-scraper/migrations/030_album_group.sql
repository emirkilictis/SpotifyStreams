-- Persist Spotify's own discography bucket so album charts can reject
-- compilations without relying only on title heuristics.

ALTER TABLE albums
  ADD COLUMN IF NOT EXISTS album_group TEXT;

CREATE INDEX IF NOT EXISTS idx_albums_album_group
  ON albums (album_group);

-- Immediate backfill for the unambiguous legacy rows. The scraper fills the
-- exact album/single/compilation value for every own-discography release on
-- subsequent runs.
UPDATE albums
SET album_group = 'compilation'
WHERE album_group IS NULL
  AND LOWER(title) ~
      '(soundtrack|original cast|greatest[[:space:]]+hits|best[[:space:]]+of|(^|[^a-z])the best([^a-z]|$)|(^|[^a-z])hits([^a-z]|$)|collection|collector|essentials?|essenciais|ícones[[:space:]]+pop|playlist|compilation|karaoke|various artists|now that''s what i call|sing-along|decade of|number ones|ladies & gentlemen|twenty five|(^|[^a-z])celebration([^a-z]|$)|ghv2|(^|[^a-z])tour([^a-z]|$)|setlist|(^|[^a-z0-9])skz[- ]?replay([^a-z0-9]|$)|(^|[^a-z0-9])skz20(20|21)([^a-z0-9]|$)|(^|[^a-z0-9])nkotbsb([^a-z0-9]|$))';
