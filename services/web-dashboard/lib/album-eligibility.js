'use strict';

// Shared by the public album list and the administrator's visibility check.
function albumEligibilitySql() {
  return `          ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND (
            title ILIKE 'Justified%'
            OR title ILIKE 'FutureSex/LoveSounds%'
            OR title ILIKE 'The 20/20 Experience%'
            OR title ILIKE 'Man of the Woods%'
            OR title ILIKE 'Everything I Thought It Was%'
            OR id IN ('1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo')
          ))
          OR ($1 = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND (
            title ILIKE 'Alter Ego%'
            OR title ILIKE 'LALISA%'
            OR title ILIKE 'New Woman%'
            OR title ILIKE 'Moonlit Floor%'
            OR title ILIKE 'SG%'
            OR title ILIKE 'Born Again%'
            OR title ILIKE 'Goals%'
            OR title ILIKE 'FXCK UP THE WORLD%'
            OR title ILIKE 'Priceless%'
            OR title ILIKE 'Rockstar%'
            -- Keep the curated collaboration releases above, and discover new
            -- lead releases from their tracks. A title allowlist alone hid
            -- PRESS PLAY even after all six songs had been collected.
            OR EXISTS (
              SELECT 1 FROM songs ls
              WHERE ls.album_id = albums.id
                AND ls.primary_artist = $1
                AND ls.canonical_id IS NULL
                AND ls.is_featured IS NOT TRUE
            )
          ))
          OR ($1 = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND (
            title ILIKE 'Celebrity%'
            OR title ILIKE 'No Strings Attached%'
            OR title ILIKE 'The Winter Album%'
            OR title ILIKE 'Home For Christmas%'
            OR title ILIKE 'Home for Christmas%'
            OR title ILIKE '%N Sync%'
            OR title ILIKE '%*NSYNC%'
            OR title ILIKE 'The Essential *NSYNC%'
            OR title ILIKE 'The Collection%'
            OR title ILIKE 'Greatest Hits%'
          ))
          OR ($1 = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND (
            title ILIKE 'Schizophrenic%'
            OR title ILIKE 'Playing With Fire%'
          ))
          -- Vaelis: size rule instead of an id allowlist. The old hardcoded list
          -- carried a wrong deluxe id (5CUnnq…, no such album in the DB), so LOVE
          -- (Deluxe) never rendered, and every later release (Fantasy (Pack),
          -- Rewind) needed a redeploy to appear. Requiring 3+ of her OWN lead
          -- canonical songs keeps the single releases (Ice Cold, Now You Don't,
          -- Love, Imagine If I Cared — 1 song each) out of the album grid while
          -- new albums show up on their own.
          OR ($1 = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND (
            SELECT COUNT(*) FROM songs vs
            WHERE vs.album_id = albums.id
              AND vs.primary_artist = $1
              AND vs.canonical_id IS NULL
              AND vs.is_featured IS NOT TRUE
          ) >= 3)
          OR ($1 = 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND (
            title ILIKE '%fame monster%'
            OR title ILIKE '%mayhem%'
            OR id = '5C7E6m8S9vJ36z0Z39O64L'
          ))
          OR ($1 = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE')
          OR ($1 = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W')
          -- Generic fallback for any OTHER artist (incl. ones added later from the
          -- admin panel — Dove, Janet, etc.): show their albums automatically so
          -- there's no missing-tab bug, but skip compilations / "featured on"
          -- various-artists albums (Hits of 2024, Party Hits, …) by requiring the
          -- album to hold at least one of the artist's OWN lead (non-featured)
          -- canonical songs. The 8 explicitly-branched artists above are excluded
          -- from this clause, so their lists stay byte-for-byte unchanged.
          --
          -- Ariana USED to be branched here, with an allowlist of eight title
          -- patterns (Yours Truly / My Everything / Dangerous Woman / Sweetener /
          -- thank u, next / Positions / eternal sunshine / hate that i made you
          -- love me). That list was written when she was added and never revisited,
          -- so it silently hid everything that did not match a pattern: petal, all
          -- three Wicked soundtracks, One Wonderful Night, The Remix, The Best,
          -- Christmas Kisses, Christmas & Chill, k bye for now, yes and?, the boy
          -- is mine. 17 albums rendered out of 57. She uses the fallback now, which
          -- is the same rule every artist added from the admin panel already gets —
          -- an allowlist only ages into a bug as the catalogue grows.
          OR (
            $1 <> ALL(ARRAY[
              'spotify:artist:31TPClRtHm23RisEBtV3X7',
              'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT',
              'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o',
              'spotify:artist:3p3U04w2DaiBzuYMZnYr00',
              'spotify:artist:3LHYvj5ZejV1NLqncEObSJ',
              'spotify:artist:1HY2Jd0NmPuamShAr6KMms',
              'spotify:artist:2dIgFjalVxs4ThymZ67YCE',
              'spotify:artist:4UIOuc84ExWojcUzFGtb8W'
            ])
            AND EXISTS (
              SELECT 1 FROM songs hs
              WHERE hs.album_id = albums.id
                AND hs.primary_artist = $1
                AND hs.canonical_id IS NULL
                AND hs.is_featured IS NOT TRUE
            )
          )`;
}
module.exports = { albumEligibilitySql };
