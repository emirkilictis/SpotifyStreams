/**
 * Main scraper — Justin Timberlake stream count crawler.
 *
 * Hibrit strateji:
 *   - Album listesi (own + tüm appears_on) → resmi Spotify API (client_credentials)
 *   - Track playcount → web player pathfinder (sp_dc cookie + headless Chrome)
 */

require('dotenv').config({ path: '../../.env' });

const { launchBrowser, fetchAlbumTracks, fetchTrackPlaycount, fetchArtistAvatar } = require('./spotify');
const { discoverAllAlbumsPuppeteer } = require('./discover');
const { getPool, upsertAlbum, upsertSong, upsertSongsBatch, upsertStreamStat, upsertStreamStatsBatch, upsertArtistStat, setScraperStatus, reconcileStreamDrops, closePool } = require('./db');
const { dedupCanonical } = require('./dedup');

// Auto-backfill any active artist still missing a profile photo (e.g. a freshly
// added roster member) — no manual CDN-URL pasting needed. Called both on the
// early-exit paths (most hourly runs, since Spotify only rolls over once a day)
// and after a full scrape, so a newly added artist doesn't have to wait for the
// next day's data rollover before getting a photo.
// Spotify serves one avatar at three sizes and encodes which one in the id
// prefix, with the hash identical across all three. So a thumbnail already in
// the DB can be upgraded to 640px by rewriting the prefix — no page load, no
// network cost. This repairs the artists that were saved while fetchArtistAvatar
// was picking the wrong source (see the comment there).
const AVATAR_SMALL_PREFIXES = ['ab6761610000f178', 'ab67616100005174']; // 160, 320
const AVATAR_LARGE_PREFIX = 'ab6761610000e5eb';                          // 640

function upgradeAvatarUrl(url) {
  if (!url || !url.includes('i.scdn.co')) return null;
  const small = AVATAR_SMALL_PREFIXES.find(p => url.includes(p));
  return small ? url.replace(small, AVATAR_LARGE_PREFIX) : null;
}

async function backfillMissingArtistPhotos(page, client) {
  try {
    const missing = await client.query(
      `SELECT artist_id, name FROM tracked_artists WHERE active = true AND (image_url IS NULL OR image_url = '')`
    );
    for (const art of missing.rows) {
      const url = await fetchArtistAvatar(page, art.artist_id);
      if (url) {
        await client.query('UPDATE tracked_artists SET image_url = $1 WHERE artist_id = $2', [url, art.artist_id]);
        console.log(`[scraper] 📷 Fetched profile photo for ${art.name}.`);
      } else {
        console.warn(`[scraper] 📷 Could not find a profile photo for ${art.name} yet.`);
      }
    }

    // Self-healing pass for anyone still on a thumbnail. Costs one UPDATE and
    // becomes a no-op once every row is on the large variant.
    const stored = await client.query(
      `SELECT artist_id, name, image_url FROM tracked_artists
        WHERE image_url LIKE '%i.scdn.co%'
          AND (image_url LIKE '%${AVATAR_SMALL_PREFIXES[0]}%' OR image_url LIKE '%${AVATAR_SMALL_PREFIXES[1]}%')`
    );
    for (const art of stored.rows) {
      const better = upgradeAvatarUrl(art.image_url);
      if (!better) continue;
      await client.query('UPDATE tracked_artists SET image_url = $1 WHERE artist_id = $2', [better, art.artist_id]);
      console.log(`[scraper] 📷 Upgraded ${art.name}'s photo to 640px.`);
    }
  } catch (avatarErr) {
    console.warn('[scraper] Artist photo backfill failed:', avatarErr.message);
  }
}

const ARTIST_ID  = '31TPClRtHm23RisEBtV3X7';   // Justin Timberlake
const ARTIST_URI = `spotify:artist:${ARTIST_ID}`;
// Inter-album throttle. Lowered from 400ms → 175ms (still polite to Spotify's
// internal endpoint); override with SCRAPE_DELAY_MS without a redeploy if we
// ever see rate-limiting.
const DELAY_MS   = Number(process.env.SCRAPE_DELAY_MS) || 175;

// Wall-clock budget for scraping artists. The GitHub Actions job is capped at
// 45 min; a hard cancel marks the run FAILED and can interrupt the dedup step.
// Instead we stop *starting* new artists once this budget elapses, then exit
// cleanly (dedup + exit 0). The per-artist resume (artistHasTodaysData) means
// the next hourly run finishes whatever was deferred. Tunable via env so a
// future GHA-timeout change doesn't require a code edit.
const RUN_START       = Date.now();
const SCRAPE_BUDGET_MS = Number(process.env.SCRAPE_BUDGET_MS) || 35 * 60 * 1000;

// Two-tier cadence: dormant, low-traffic FEATURED albums (an artist's old guest
// spots) don't need a fresh snapshot every single day. We scrape them at most
// once every COLD_STALE_DAYS; everything that actually moves the headline numbers
// stays daily. An album is always-daily ("hot") when ANY of:
//   - it's an OWN album/single (is_featured = false) — the primary catalogue,
//   - it was released within HOT_RECENT_DAYS (still ramping),
//   - it has no snapshot yet (must baseline it),
//   - its latest-day total gain >= HOT_GAIN_THRESHOLD (a popular feature).
// Set SCRAPE_COLD_STALE_DAYS=0 to disable and scrape everything daily (old behaviour).
const COLD_STALE_DAYS      = Number(process.env.SCRAPE_COLD_STALE_DAYS ?? 3);
const HOT_RECENT_DAYS      = Number(process.env.SCRAPE_HOT_RECENT_DAYS ?? 365);
const HOT_GAIN_THRESHOLD   = Number(process.env.SCRAPE_HOT_GAIN_THRESHOLD ?? 20000);

const BLACKLISTED_TRACK_IDS = new Set([
  '3K7xYRXPFDVyen7cZF5Zk2', // Get Back Up Again (Anna Kendrick)
  '1w1kzejjmiMhdWAOecgo4l', // They Don't Know (Ariana Grande)
  '2jXTBrywc6ruxaUXW84Xhr', // Hello (Zooey Deschanel)
  '6lk31ijUSG5exPmV34zFkL', // Crazy Train (Rachel Bloom)
  '04753LTNIuoQaQ4ATBcHzY', // Barracuda (Rachel Bloom)
  '6k2fcdMZRetgikCiVJULVq', // Rock N Roll Rules (HAIM & Ludwig Göransson)
  '2zWc9ii8uDntk6srjMKTGY', // I Fall to Pieces (Red Velvet)
  '15bDEMeqO9hJwl1WZ14gOI', // Rainbows, Unicorns, Everything Nice (12s line)
  '5KY96BqBigL83cqvk4vkcl', // 4 Minutes (Bob Sinclar Mix) - Mixed (Vic Latino mix)
  '1UCg9jhY1LWMjHsCLDgRtt', // Love Train (The O'Jays - Coronation Party)
  '5aiRiMlnRanT4kfLG3xGGg', // Love Train (The O'Jays - Coronation Street Party)
  '4YZN2rN374Z8XQYDyW9gIr', // Love Train (The O'Jays - Ultimate Coronation Party)
  '4nBOd04LBaaA6WpBbTbP6N', // Love Train (The O'Jays - Coronation Party Songs)
  '62LTRRvoFOIHsmev1CuhZY', // Love Train (The O'Jays - King's Coronation Party)
  '6fS0rs4tiEgBMEB2Ln586G', // LoveStoned / I Think She Knows - Radio Edit
  '6D7DBoDFoJ76VLVtDwa7CR', // LoveStoned/I Think She Knows - Don Zee Remix
  '3zTU04mYmOmGiBBYW1Afj0', // LoveStoned/I Think She Knows - Don Zee Remix - Radio Edit
  '72Y2HKafWKIILRju52I2Fo', // LoveStoned/I Think She Knows Interlude - Femi Fem & T-Money Funketeria Mix - Extended
  '7l8B8DGCVfuz4IU2sH0XFr', // LoveStoned/I Think She Knows Interlude - Femi Fem & T-Money Funketeria Mix - Radio Edit
  '0ICPCqK5g3zagynFkt1jDX', // LoveStoned/I Think She Knows - Matrix & Futurebound Extended Remix
  '7x94lS0k2NFInyHEO1DAyg', // SexyBack (feat. Missy Elliott & Timbaland) - DJ Wayne Williams Ol' Skool Remix
  '3SUQYLuMqCW7lkMAZ1Bhev', // I'm Coming Out / Mo' Money Mo' Problems
  '75e1EYhLzB3mQZQBcRmklN', // The Sound Of Silence
  '6K30Ls73FHoHL5cFGTvJM5', // I'm Not Yours - Live (not Lisa song)
  '2RUihOx5NV6IStincNs2kV', // 秘境 (Kick Back) - Live (not Lisa song)
  '30nku7BzuqrLBNBoXyaR7T'  // Ayo Technology - Radio Edit
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ARTIST_SEARCH_NAMES = {
  '31TPClRtHm23RisEBtV3X7': ['justin timberlake'],
  '5L1lO4eRHmJ7a0Q6csE5cT': ['lisa'],
  '1HY2Jd0NmPuamShAr6KMms': ['lady gaga'],
  '6qqNVTkY8uBg9cP3Jd7DAH': ['billie eilish'],
  '1Xylc3o4UrD53lo9CvFvVg': ['zara larsson'],
  '66CXWjxzNUsdJxJ2JdwvnR': ['ariana grande'],
  '6Ff53KvcvAj5U7Z1vojB5o': ['nsync', '*nsync'],
  '3p3U04w2DaiBzuYMZnYr00': ['jc chasez', 'chasez'],
  '3LHYvj5ZejV1NLqncEObSJ': ['vaelis'],
  '2dIgFjalVxs4ThymZ67YCE': ['stray kids'],
  '4UIOuc84ExWojcUzFGtb8W': ['felix'],
  '2W8yFh0Ga6Yf3jiayVxwkE': ['dove cameron', 'dove'],
  '4qwGe91Bz9K2T8jXTZ815W': ['janet jackson', 'janet'],
  '26dSoYclwsYLMAKD3tpOr4': ['britney spears', 'britney'],
  '64M6ah0SkkRsnPGtGiRAbb': ['bebe rexha'],
  '0hCNtLu0JehylgoiP8L4Gh': ['nicki minaj', 'nicki'],
  '1l7ZsJRRS8wlW3WfJfPfNS': ['christina aguilera', 'christina']
};

function isCoverOrTribute(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  
  // Exclude actual Justin Timberlake song "Under Cover", Stray Kids' "Cover Me", or official "DM-FK" remix
  if (lower.includes('under cover') || lower.includes('cover me') || lower.includes('dm-fk')) return false;

  // General tribute, karaoke, lullaby, choir, arrangement or cover patterns
  if (lower.includes('tribute') || 
      lower.includes('karaoke') || 
      lower.includes('lullaby') || 
      lower.includes('arr. for') || 
      lower.includes('arranged for') || 
      lower.includes('for choir') || 
      lower.includes('orchestral instrumental') ||
      /\bcovers?\b/i.test(lower)) {
    return true;
  }
  return false;
}

async function processAlbum(page, client, album, artistUri, stats, backdateFirst = false) {
  const tracks = await fetchAlbumTracks(page, album.id);
  let kept = 0;
  // Collect rows and flush in two batched writes at the end of the album instead
  // of 2 awaited round-trips per track — the dominant cost against Neon's latency.
  const songRows = [];
  const streamRows = [];
  for (const track of tracks) {
    // Kara liste, JT tek sanatciyken yazildi ve IKI ayri isi birden yapiyor:
    //   1. Baskasinin sarkisini JT'nin CATCH-ALL kovasindan uzak tutmak
    //      (TROLLS soundtrack'indeki Anna Kendrick, Zooey Deschanel, Red
    //      Velvet, The O'Jays... — JT kovasi "baska hicbir sanatciya ait
    //      olmayan her sey" oldugu icin bunlar ona yaziliyordu).
    //   2. JT'nin KENDI sarkilarindan bilerek disarida birakilanlar
    //      (LoveStoned radio edit'leri, SexyBack DJ remix'i) — kuratorluk.
    //
    // Birinci is, o sanatci ARTIK TAKIP EDILIYORSA gecersiz: Ariana eklendikten
    // sonra "They Don't Know" (114.9M) hala eleniyordu, cunku liste kuresel
    // calisiyordu. Kendi kovasi varken sarkisi kataloguna hic girmiyordu.
    //
    // Bu yuzden kontrol artik kapsamli: JT taramasinda liste aynen gecerli
    // (her iki is de korunur), baska bir sanatcinin taramasinda ise Spotify o
    // sanatciyi sarkida kredilendiriyorsa liste onu engellemiyor.
    if (BLACKLISTED_TRACK_IDS.has(track.id)) {
      const jtTaramasi = artistUri === 'spotify:artist:31TPClRtHm23RisEBtV3X7';
      const buSanatciKredili = !!track.artistUris?.includes(artistUri);
      if (jtTaramasi || !buSanatciKredili) {
        console.log(`           [skip blacklist] "${track.title}" (${track.id})`);
        continue;
      }
      console.log(`           [blacklist bypass] "${track.title}" — Spotify bu sanatçıyı kredilendiriyor`);
    }
    const artistId = artistUri.split(':')[2];
    const searchNames = ARTIST_SEARCH_NAMES[artistId] || [];
    const titleLower = track.title.toLowerCase();
    const matchesSearchName = searchNames.some(name => titleLower.includes(name));

    // Unconditionally skip any tracks where target artist is not one of the artists,
    // UNLESS the track title contains the target artist's name (which handles missing metadata for remixes)
    if (!track.artistUris?.includes(artistUri) && !matchesSearchName) continue;
    if (isCoverOrTribute(track.title)) {
      console.log(`           [skip cover] "${track.title}"`);
      continue;
    }
    let isFeaturedTrack = album.is_featured;
    if (track.artistUris && track.artistUris.length > 0) {
      const isLead = track.artistUris[0] === artistUri;
      const titleLower = track.title.toLowerCase();
      const albumLower = album.title.toLowerCase();
      
      if (isLead || albumLower.includes('trolls') || titleLower.includes('the other side') || titleLower.includes('love never felt so good')) {
        isFeaturedTrack = false;
      } else {
        isFeaturedTrack = true;
      }
    }

    let trackTitle = track.title;
    if (track.id === '1JmPASoql4lnXimD5ICqRP') {
      trackTitle = 'Not a Bad Thing - Radio Edit';
    }

    let isSolo = !isFeaturedTrack;
    if (track.artistUris && track.artistUris.length > 1) {
      isSolo = false;
    }

    songRows.push({
      id:             track.id,
      title:          trackTitle,
      album_id:       album.id,
      duration_ms:    track.duration_ms,
      track_number:   track.track_number,
      is_featured:    isFeaturedTrack,
      primary_artist: artistUri,
      is_solo:        isSolo,
    });
    if (track.playCount > 0) {
      streamRows.push({ songId: track.id, streamCount: track.playCount });
    }
    stats.tracksProcessed++;
    kept++;
  }

  // Two round-trips for the whole album (songs must land before their stream
  // stats — stream_stats.song_id references songs.id).
  await upsertSongsBatch(client, songRows);
  const written = await upsertStreamStatsBatch(client, streamRows, backdateFirst);
  stats.streamsUpdated += written;
  return kept;
}

async function scrapeArtist(page, client, artistId, stats, allTrackedArtistIds = [], isForce = false, albumOnly = false) {
  const artistUri = `spotify:artist:${artistId}`;
  // Back-date the first-ever snapshot to "yesterday" ONLY for a brand-new artist
  // (zero prior snapshots) — that prevents the new-artist double-day spike. For an
  // established artist, a newly-discovered edition of an existing song must NOT be
  // back-dated: stamping today's playcount on yesterday zeroes the song's daily
  // gain via the canonical MAX (this broke LISA "Goals").
  const artistIsNew = !(await client.query(
    `SELECT 1 FROM stream_stats ss JOIN songs s ON s.id = ss.song_id
     WHERE s.primary_artist = $1 LIMIT 1`, [artistUri]
  )).rows.length;
  console.log(`\n[scraper] Discovering albums for artist: ${artistId}...${artistIsNew ? ' (new artist → baseline back-date)' : ''}`);
  let { albums: discoveredAlbums, own_count, feat_count, stats: artistStats } = await discoverAllAlbumsPuppeteer(page, artistId, { includeAppearsOn: !albumOnly });

  // Persist artist-level stats (monthly listeners, followers, world rank) as a daily snapshot.
  if (artistStats && artistStats.monthly_listeners != null) {
    await upsertArtistStat(client, artistStats);
    console.log(`[scraper] ${artistStats.name ?? artistId}: ${artistStats.monthly_listeners.toLocaleString('en-US')} monthly listeners.`);
  }

  // Lady Gaga filters: Mayhem and The Fame Monster (EP or Deluxe/Standard) only
  if (artistId === '1HY2Jd0NmPuamShAr6KMms') {
    discoveredAlbums = discoveredAlbums.filter(a => {
      const title = a.title.toLowerCase();
      return title.includes('mayhem') || title.includes('fame monster') || a.id === '5C7E6m8S9vJ36z0Z39O64L';
    });
    console.log(`[scraper] Lady Gaga filtered to Mayhem & The Fame Monster: ${discoveredAlbums.length} albums.`);
  }

  // Billie Eilish is now a full-discography artist (album_only turned off in the
  // roster), so we no longer cap her to studio albums — her singles and
  // appears-on features flow through discovery like any other named artist.
  // (isCoverAlbum already strips tribute/karaoke junk upstream in discover.js.)

  // Ariana Grande filters: official studio albums & singles
  if (artistId === '66CXWjxzNUsdJxJ2JdwvnR') {
    discoveredAlbums = discoveredAlbums.filter(a => {
      const title = a.title.toLowerCase();
      return title.includes('yours truly') ||
             title.includes('my everything') ||
             title.includes('dangerous woman') ||
             title.includes('sweetener') ||
             title.includes('thank u, next') ||
             title.includes('positions') ||
             title.includes('eternal sunshine') ||
             title.includes('hate that i made you love me');
    });
    console.log(`[scraper] Ariana Grande filtered to studio albums & singles: ${discoveredAlbums.length} albums.`);
  }

  // 1. Save all discovered albums to DB
  for (const a of discoveredAlbums) {
    await upsertAlbum(client, a);
  }

  // 2. Determine albums to scrape: combine newly discovered albums with existing
  // database albums containing canonical songs for this artist.
  //
  // JT is the dashboard's only catch-all bucket ("everything not claimed by a named
  // artist"), so only JT re-scrapes every collab/orphan album in the DB. The exclusion
  // list is built dynamically from the live roster (allTrackedArtistIds) so newly added
  // artists are excluded automatically — tighter than the old hardcoded list, which was
  // missing Janet/Nicki/Britney/Bebe/George. Named artists (incl. Britney/Bebe/Nicki)
  // use the exact-match query below: their features already carry their own primary_artist,
  // so exact-match re-scrapes them, and targeted extraAlbums pins cover any gaps — far
  // cheaper than running a full catch-all pass per artist.
  const isCatchAll = artistId === '31TPClRtHm23RisEBtV3X7';
  const activeIds = allTrackedArtistIds && allTrackedArtistIds.length > 0
    ? allTrackedArtistIds
    : [
        '31TPClRtHm23RisEBtV3X7', '5L1lO4eRHmJ7a0Q6csE5cT', '1HY2Jd0NmPuamShAr6KMms',
        '6qqNVTkY8uBg9cP3Jd7DAH', '66CXWjxzNUsdJxJ2JdwvnR', '6Ff53KvcvAj5U7Z1vojB5o',
        '3p3U04w2DaiBzuYMZnYr00', '3LHYvj5ZejV1NLqncEObSJ', '2dIgFjalVxs4ThymZ67YCE',
        '4UIOuc84ExWojcUzFGtb8W', '2W8yFh0Ga6Yf3jiayVxwkE', '4qwGe91Bz9K2T8jXTZ815W',
        '26dSoYclwsYLMAKD3tpOr4', '64M6ah0SkkRsnPGtGiRAbb', '0hCNtLu0JehylgoiP8L4Gh'
      ];
  const otherTrackedUris = activeIds
    .filter(id => id !== artistId)
    .map(id => `spotify:artist:${id}`);

  const dbAlbumsRes = isCatchAll
    ? await client.query(`
        SELECT a.id, a.title, a.release_date,
               COALESCE(bool_or(s.is_featured), false) as is_featured
        FROM albums a
        JOIN songs s ON s.album_id = a.id
        WHERE s.canonical_id IS NULL
          AND (s.primary_artist IS NULL OR s.primary_artist <> ALL($1))
        GROUP BY a.id, a.title, a.release_date
      `, [otherTrackedUris])
    : await client.query(`
        SELECT a.id, a.title, a.release_date,
               COALESCE(bool_or(s.is_featured), false) as is_featured
        FROM albums a
        JOIN songs s ON s.album_id = a.id
        WHERE s.primary_artist = $1 AND s.canonical_id IS NULL
        GROUP BY a.id, a.title, a.release_date
      `, [artistUri]);

  const albumMap = new Map();
  
  // First, populate with database albums
  for (const dbA of dbAlbumsRes.rows) {
    albumMap.set(dbA.id, {
      id: dbA.id,
      title: dbA.title,
      release_date: dbA.release_date,
      is_featured: dbA.is_featured
    });
  }
  
  // Then, add/overwrite with discovered albums
  for (const discA of discoveredAlbums) {
    albumMap.set(discA.id, {
      id: discA.id,
      title: discA.title,
      release_date: discA.release_date,
      is_featured: discA.is_featured
    });
  }
  
  // For JT, manually ensure specific albums containing manual or featured tracks are scraped:
  // - "Not a Bad Thing" Single (32dGD25hfIVdhugEXoVu2s)
  // - "FutureSex/LoveSounds (Deluxe Edition)" (51lCQxAHpJHuqvvK0z12zp) containing "Pose"
  // - "Timeless" by Sergio Mendes (4sceISkCvRuDbd74AtKeEH) containing "Loose Ends"
  if (artistId === '31TPClRtHm23RisEBtV3X7') {
    const extraAlbums = [
      { id: '32dGD25hfIVdhugEXoVu2s', title: 'Not a Bad Thing (Single)', release_date: '2014-02-24', is_featured: false },
      { id: '51lCQxAHpJHuqvvK0z12zp', title: 'FutureSex/LoveSounds (Deluxe Edition)', release_date: '2006-09-11', is_featured: false },
      { id: '4sceISkCvRuDbd74AtKeEH', title: 'Timeless', release_date: '2005-12-31', is_featured: true },
      // Live "Suit & Tie - Radio Edit" single — the 20/20 Deluxe copy was delisted (froze 2026-05-26)
      { id: '5jlQrOtSuTXojcvBCpivyo', title: 'Suit & Tie (feat. JAY-Z) [Radio Edit]', release_date: '2013-01-15', is_featured: false },
      // Appears-on / collab albums where JT is FEATURED (primary_artist = the other act, not JT),
      // so the DB-album query (primary_artist = JT) never picks them up and appears-on discovery
      // stopped surfacing them on 2026-05-26 — freezing these tracks. Pin them so every run
      // re-scrapes the JT-featuring track. processAlbum keeps only the JT track and upsertSong
      // preserves its real primary_artist (the track stays featured).
      { id: '0OTjYdGtP7AbwOwbYsGhyi', title: 'Magna Carta... Holy Grail', release_date: '2013-07-04', is_featured: true }, // Holy Grail (JAY-Z)
      { id: '6uBfBmim3xlzDgtVJvolW2', title: 'Blow Your Pants Off', release_date: '2012-06-08', is_featured: true },       // History of Rap (Jimmy Fallon)
      { id: '4gjttixmMAKMzzfrfGmDGr', title: 'Eardrum', release_date: '2007-08-21', is_featured: true },                   // The Nature (Talib Kweli)
      { id: '2Zl1vsJhhpUFpHciAtQ9CR', title: 'Falling Down', release_date: '2007-09-17', is_featured: true },              // Falling Down (Duran Duran)
      { id: '6YxdIqf8tAzHHCdXJYJ0Tg', title: 'Big', release_date: '2007-01-01', is_featured: true },                       // Get Out
      { id: '4jBrWs7QoGFvXjYjb3UaOL', title: 'Role Model', release_date: '2011-01-01', is_featured: true },                // Role Model
      { id: '7fmbEgU1UvE1yZN6h4FrFh', title: 'Fascinated', release_date: '2011-01-01', is_featured: true },                // Fascinated
      { id: '0VZHk1bVRMTmdxavCL2j4N', title: "Ain't No Doubt About It", release_date: '2010-01-01', is_featured: true },   // Ain't No Doubt About It
      // Collab albums that replace manually-seeded fake-ID rows (those had placeholder
      // album+track IDs and could never be scraped, so they froze on 2026-05-26). Pinning
      // the real albums lets the real JT track update; the fake rows are deleted from the DB.
      { id: '40o8Zo70JUsrMtBaQruBZg', title: "Can't Believe It Remix (feat. Justin Timberlake)", release_date: '2008-11-11', is_featured: true }, // Can't Believe It Remix (T-Pain)
      { id: '4QhiPwSJKMHBk0EL67zBaT', title: 'TROLLS Holiday In Harmony', release_date: '2021-11-26', is_featured: false },                       // Together Now (x2) + Signed, Sealed, Delivered
      { id: '4fGULwsdNS4FqG2xZfMmCo', title: 'Last Train to Paris', release_date: '2010-12-14', is_featured: true },                              // Shades (Diddy - Dirty Money)
      { id: '0RIAq5yp636U2iTB0K2Tb6', title: 'We Broke The Rules', release_date: '2001-07-24', is_featured: true }                                // Gone (*NSYNC)
    ];

    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }

  // For Billie Eilish, manually ensure dont smile at me is scraped
  if (artistId === '6qqNVTkY8uBg9cP3Jd7DAH') {
    const extraAlbums = [
      { id: '5YCdlD3eREt72lTZxNL7id', title: 'dont smile at me', release_date: '2017-08-11', is_featured: false, image_url: 'https://i.scdn.co/image/ab67616d0000b2739c05fec02bd9b81ee1246b2f' }
    ];

    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }

  // For Ariana Grande, manually ensure the standard albums/singles are scraped
  if (artistId === '66CXWjxzNUsdJxJ2JdwvnR') {
    const extraAlbums = [
      { id: '1x159B5VzbDWAGBik5cr1z', title: 'hate that i made you love me', release_date: '2026-05-29', is_featured: false, image_url: 'https://i.scdn.co/image/ab67616d0000b273b622d42c30697e1e1414343c' },
      { id: '2fYhqwDWXjbpjaIJPEfKFw', title: 'thank u, next', release_date: '2019-02-08', is_featured: false, image_url: 'https://i.scdn.co/image/ab67616d0000b27356ac7b86e090f307e218e9c8' },
      { id: '3tx8gQqWbGwqIGZHqDNrGe', title: 'Sweetener', release_date: '2018-08-17', is_featured: false, image_url: 'https://i.scdn.co/image/ab67616d0000b273c3af0c2355c24ed7023cd394' }
    ];

    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }

  // For Britney Spears, manually ensure featured / missing albums are scraped
  if (artistId === '26dSoYclwsYLMAKD3tpOr4') {
    const extraAlbums = [
      { id: '09IChrkzmFo9ZZroCRYujr', title: "Tom's Diner", release_date: '2015-06-12', is_featured: true }, // Tom's Diner (Giorgio Moroder)
      { id: '7Fy8ImgNfxQoVxD8GU2zsn', title: '#willpower', release_date: '2013-04-19', is_featured: true }, // Scream & Shout Hit-Boy Remix (#willpower)
      { id: '574xhx2X0G9MkqACxqi4cg', title: 'Greatest Hits: My Prerogative', release_date: '2004-11-08', is_featured: false } // Overprotected Darkchild Remix Edit & Toxic Armand Remix Edit
    ];

    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }

  // For Bebe Rexha, manually ensure featured / missing albums are scraped
  if (artistId === '64M6ah0SkkRsnPGtGiRAbb') {
    const extraAlbums = [
      { id: '1S18T2TzC03H2y4jJ3U1n4', title: 'Listen', release_date: '2014-11-21', is_featured: true }, // Hey Mama & Yesterday (David Guetta)
      { id: '2eSgXcemb8czlGvqHPSp7j', title: 'Take Me Home (feat. Bebe Rexha)', release_date: '2013-07-15', is_featured: true }, // Take Me Home (Cash Cash)
      { id: '7skmxw0M4VQMZwY4lICAHl', title: "That's How You Know", release_date: '2015-07-17', is_featured: true }, // That's How You Know (Nico & Vinz)
      { id: '0kd0OCzyoqrr0c9n66xjgi', title: 'If Only I (feat. Bebe Rexha)', release_date: '2023-06-23', is_featured: true }, // If Only I (Loud Luxury)
      { id: '5uOBHR89JOzaZxuVZdhWWp', title: 'Heart Still Beating', release_date: '2023-10-27', is_featured: true }, // Heart Still Beating (Nathan Dawe)
      { id: '4EUf4YyNjuXypWY6W5wEDm', title: 'This Is Not A Drill', release_date: '2014-11-21', is_featured: true }, // This Is Not A Drill (Pitbull)
      { id: '3magxZAvx6F9hKyUQmFy3s', title: 'Battle Cry', release_date: '2014-04-14', is_featured: true }, // Battle Cry (Havana Brown)
      { id: '0ZZSo8nObNWR7fTyRZARez', title: 'Dare You - Acoustic Version', release_date: '2014-01-24', is_featured: true }, // Dare You Acoustic (Hardwell)
      // Found via audit-kworb.js — remix/continuous-mix editions never surfaced
      // in appears-on, ~45.1M total. Distinct tracks (own id, own streams).
      { id: '3lLAW5J5IKH4SbENkAgRJT', title: 'Hey Mama (feat. Nicki Minaj, Bebe Rexha & Afrojack) [Boaz van de Beatz Remix]', release_date: '2015-06-05', is_featured: true }, // ~25.0M
      { id: '7ukJ6QbV792h7V7aqZ8P8u', title: "That's How You Know (feat. Kid Ink & Bebe Rexha)", release_date: '2016-02-16', is_featured: true }, // Fucked up HEYHEY Remix ~8.2M
      { id: '6vtJly9TCcV7BLzgtOdD8N', title: 'Family (feat. Bebe Rexha, Ty Dolla $ign & A Boogie Wit da Hoodie) [David Guetta Downtempo Dance Remix]', release_date: '2021-12-24', is_featured: true }, // ~3.7M
      { id: '7bpWEp24oHgUs08ImjakfU', title: 'Listen Again', release_date: '2015-11-27', is_featured: true }, // 3 continuous-mix tracks ~5.5M combined
      { id: '3Wmuoz86nQpKQYHLA3S7qH', title: "That's How You Know (feat. Kid Ink & Bebe Rexha) [Remixes]", release_date: '2015-10-09', is_featured: true }, // Wideboys + Danny Lee remixes ~1.5M
      { id: '4FwF3viwUJiAzgSNohUI02', title: 'Happiest Season (Music from and Inspired by the Film)', release_date: '2020-11-06', is_featured: true } // Blame It on Christmas ~1.3M
    ];

    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }

  // For Zara Larsson, the Swedish-market "Poster Girl (Swedish Summer Edition)"
  // is not returned by the discography query, so its exclusive Carola cover
  // "Säg Mig Var Du Står" (her biggest uncaptured track, ~53M) never gets
  // scraped. Its other 20 tracks are alt-edition duplicates that dedup merges.
  if (artistId === '1Xylc3o4UrD53lo9CvFvVg') {
    const extraAlbums = [
      { id: '6xkO0VLObgUL8o0ztpW0hT', title: 'Poster Girl (Swedish Summer Edition)', release_date: '2021-07-09', is_featured: false } // Säg Mig Var Du Står (Carola cover)
    ];

    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }


  // For Cardi B, several guest features sit on lead artists who are NOT tracked
  // (Blueface, J Balvin/Jennifer Lopez, etc.), so their albums never appear in
  // Cardi's appears-on and the tracks were never scraped. Pin them directly so
  // they land in her bucket (primary_artist = Cardi). The track-level filter
  // still drops every non-Cardi track on these foreign albums.
  if (artistId === '4kYSro6naA4h99UJvo89HB') {
    const extraAlbums = [
      { id: '1bLGOKqe1vcQtUv6q5Mz0h', title: 'Famous Cryp (Reloaded)', release_date: '2020-07-17', is_featured: true }, // Thotiana (Remix) ~126M
      { id: '1fT1s4VMXc9xGIamDyFz9S', title: 'Dinero', release_date: '2018-05-17', is_featured: true },                  // Dinero ~102M
      { id: '5hzbgBTxfikktf9cOvggGF', title: 'El Hombre', release_date: '2018-11-02', is_featured: true },               // Mi Mami ~26M
      { id: '0Y6JN2SuCzSvumQzxNy2YK', title: 'Highly Intoxicated', release_date: '2017-09-18', is_featured: true },      // Kamasutra (feat. Cardi B) ~0.8M
      // Each of these is its own distinct track (own id, own stream count) — they
      // are not duplicates of the originals, so they count separately like kworb.
      { id: '4fkqsStkuqsVD2Dgl2kL1J', title: 'Girls Like You (feat. Cardi B) [St. Vincent Remix]', release_date: '2018-08-10', is_featured: true }, // ~7.4M
      { id: '75qv2xhOcSTAsSttZMGV53', title: 'Dinero (CADE Remix)', release_date: '2018-06-29', is_featured: true },                                // ~3.0M
      { id: '64jRBkgz4v6fdFtp9XyoSv', title: 'Girls Like You (feat. Cardi B) [TOKiMONSTA Remix]', release_date: '2018-08-02', is_featured: true },  // ~1.2M
      { id: '3mAaCQNqRARBgzS3BFWwH0', title: 'Red Pill Blues + (Deluxe)', release_date: '2018-11-21', is_featured: true },                          // Girls Like You - CRAY Remix ~0.9M
    ];
    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }

  // Christina Aguilera guest features / duets whose lead is not tracked
  // (Alejandro Fernández, Tony Bennett, A Great Big World, etc.) — never in her
  // appears-on, so never scraped. Found via audit-kworb.js (track-id + value
  // reconciliation). Same pattern: the track-level filter drops every
  // non-Christina track on these foreign/compilation albums.
  if (artistId === '1l7ZsJRRS8wlW3WfJfPfNS') {
    const extraAlbums = [
      { id: '6Z2y84TfIgaWdmSYTZMJj0', title: 'Baladas Románticas', release_date: '2020-02-28', is_featured: true },        // Hoy Tengo Ganas De Ti ~236M
      { id: '4bePJNQoFZ2FhPHgBPmvbv', title: 'Viva Duets', release_date: '2012-10-22', is_featured: true },                 // Steppin' Out with My Baby ~5.5M
      { id: '3ssspRe42CXkhPxdc12xcp', title: "CeeLo's Magic Moment", release_date: '2012-10-29', is_featured: true },       // Baby It's Cold Outside ~3.2M
      { id: '0jYO6ZMmUnhM8oID5ZFsnp', title: 'Tell Me (feat. Christina Aguilera)', release_date: '2007-02-03', is_featured: true }, // Tell Me - Mixshow ~1.4M
      { id: '3TdbZH4OnoGoMgil9f1YzK', title: 'Mi Reflejo', release_date: '2000-01-01', is_featured: true },                 // Ven Conmigo (Solamente Tú) - Karaoke ~1.2M
      { id: '3O8cHCGgo6phxKJD6j1jnt', title: 'Platinum Christmas', release_date: '2000-11-07', is_featured: true },         // Silent Night / Noche de Paz ~0.5M
      // Distinct Moves Like Jagger remixes (own id, own streams) — count separately.
      { id: '17np2VFSo8AMt6LQpiq1dr', title: 'Moves Like Jagger', release_date: '2011-01-01', is_featured: true },          // - Remix ~6.4M
      { id: '4rUY6MIb73CqjT1iS7HlQk', title: 'Marathon 2013', release_date: '2013-01-01', is_featured: true },             // - Soul Seekerz Radio Edit ~3.6M
      { id: '0c6pUHCUuyssK8u63qKG29', title: 'Moves Like Jagger', release_date: '2011-01-01', is_featured: true },          // - Michael Carrera Darkroom Remix ~0.5M
    ];
    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }

  // Melanie Martinez — the "Dollhouse (The Remixes)" EP never surfaced in her
  // appears-on, so its four official remixes (each its own track id + stream
  // count, ~12.1M total) were never scraped. Found via audit-kworb.js. They are
  // distinct recordings, not duplicates of Dollhouse, so they count separately
  // like kworb. The track-level filter keeps only her tracks on the album.
  if (artistId === '63yrD80RY3RNEM2YDpUpO8') {
    const extraAlbums = [
      { id: '64ZcJOwakn1tWxDFRIE4M3', title: 'Dollhouse (The Remixes)', release_date: '2014-07-24', is_featured: true }, // Jai Wolf / Kiely Rich / One Love / Treasure Fingers remixes ~12.1M
    ];
    for (const extra of extraAlbums) {
      if (!albumMap.has(extra.id)) {
        await upsertAlbum(client, extra);
        albumMap.set(extra.id, extra);
      }
    }
  }


  // DB-driven album pins (migration 020) — the generic, self-service version of
  // every hardcoded `extraAlbums` block above. reconcile-kworb.js writes here
  // whenever it finds a kworb track we never scraped because its LEAD artist
  // isn't tracked (so it never shows up in this artist's appears-on). Adding a
  // gap-closing album no longer needs a code edit or a deploy: the row lands in
  // extra_scrape_albums and the next run of this artist picks it up. As with the
  // hardcoded pins, processAlbum's track-level filter keeps only this artist's
  // tracks off a foreign album.
  try {
    const pinnedRes = await client.query(
      `SELECT album_id AS id, title, release_date, is_featured
         FROM extra_scrape_albums WHERE artist_id = $1`,
      [artistId]
    );
    let added = 0;
    for (const pin of pinnedRes.rows) {
      if (albumMap.has(pin.id)) continue;
      const album = {
        id: pin.id,
        title: pin.title || pin.id,
        release_date: pin.release_date,
        is_featured: pin.is_featured ?? true,
      };
      await upsertAlbum(client, album);
      albumMap.set(album.id, album);
      added++;
    }
    if (added) console.log(`[scraper] ${artistId}: +${added} pinned album(s) from extra_scrape_albums.`);
  } catch (err) {
    // A missing table (migration not applied yet) must not break the scrape.
    console.warn(`[scraper] extra_scrape_albums lookup skipped: ${err.message}`);
  }

  let albumsToScrape = Array.from(albumMap.values());

  // Album-only artists track ONLY their own discography — drop every featured/
  // appears-on album from the scrape set (discovery already skipped fetching them;
  // this also removes any featured albums still coming from the DB query). Their
  // existing feature songs stay in the catalogue at their last value (frozen),
  // they just stop being re-scraped. Makes the cold-skip block below a no-op.
  if (albumOnly) {
    const before = albumsToScrape.length;
    albumsToScrape = albumsToScrape.filter(a => !a.is_featured);
    if (before !== albumsToScrape.length) {
      console.log(`[scraper] album-only ${artistId}: own discography only, skipped ${before - albumsToScrape.length} featured album(s).`);
    }
  }

  // Two-tier cadence: skip dormant low-traffic featured albums that were scraped
  // within the last COLD_STALE_DAYS. Applied ONLY to album-only artists (Taylor,
  // Gaga, Nicki) — full-disc artists (JT and the rest) always scrape everything
  // daily so their numbers are never even slightly stale. Force runs and
  // SCRAPE_COLD_STALE_DAYS=0 also scrape everything (old behaviour).
  if (albumOnly && !isForce && COLD_STALE_DAYS > 0 && albumsToScrape.length) {
    const ids = albumsToScrape.map(a => a.id);
    let lastMap = new Map();
    try {
      const lastRes = await client.query(`
        SELECT s.album_id AS id,
               MAX(l.recorded_date) AS last_date,
               COALESCE(SUM(l.daily_gain), 0)::bigint AS last_gain
        FROM songs s
        JOIN LATERAL (
          SELECT recorded_date, daily_gain
          FROM daily_streams_canonical d
          WHERE d.canonical_id = s.id
          ORDER BY d.recorded_date DESC
          LIMIT 1
        ) l ON true
        WHERE s.album_id = ANY($1)
        GROUP BY s.album_id
      `, [ids]);
      for (const r of lastRes.rows) lastMap.set(r.id, { last: r.last_date, gain: Number(r.last_gain) });
    } catch (err) {
      console.warn(`[scraper] cold-skip lookup failed (${err.message}); scraping all albums.`);
      lastMap = null;
    }

    if (lastMap) {
      const staleCutoff = Date.now() - COLD_STALE_DAYS * 86400000;
      const recentCutoff = Date.now() - HOT_RECENT_DAYS * 86400000;
      let skipped = 0;
      const ms = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : NaN; };
      albumsToScrape = albumsToScrape.filter(a => {
        if (!a.is_featured) return true;                       // own catalogue → always
        const rel = ms(a.release_date);
        if (Number.isFinite(rel) && rel >= recentCutoff) return true; // recent → always
        const info = lastMap.get(a.id);
        if (!info || !info.last) return true;                  // never scraped → baseline
        if (info.gain >= HOT_GAIN_THRESHOLD) return true;      // popular feature → always
        const last = ms(info.last);
        if (!Number.isFinite(last) || last < staleCutoff) return true; // stale/unknown → refresh
        skipped++;
        return false;                                          // cold & fresh → skip today
      });
      if (skipped) console.log(`[scraper] cold-skip: deferring ${skipped} dormant featured album(s) (refreshed within ${COLD_STALE_DAYS}d).`);
    }
  }

  console.log(`[scraper] Scraping ${albumsToScrape.length} albums for ${artistId}...`);

  for (let i = 0; i < albumsToScrape.length; i++) {
    const a = albumsToScrape[i];
    const isFeatured = a.is_featured ?? false;

    const tag = isFeatured ? 'feat' : 'own ';
    console.log(`[${tag} ${i+1}/${albumsToScrape.length}] "${a.title}"`);
    try {
      const n = await processAlbum(page, client, { ...a, is_featured: isFeatured }, artistUri, stats, artistIsNew);
      console.log(`           ${n} track`);
    } catch (err) { console.warn('  Hata:', err.message); }
    await sleep(DELAY_MS);
  }
}

// Returns true if this artist already has a full snapshot for today. Used both for
// idempotency (don't re-scrape an artist already done) and to RESUME a run that was
// cut short mid-list (e.g. GHA timeout) on the next hourly invocation.
// "Full" = today's row count is at least the most recent previous day's count, so an
// artist that was interrupted mid-scrape (fewer rows today) is correctly re-scraped.
// NOTE: "today" MUST be the Istanbul calendar date, matching how upsertStreamStat stamps
// recorded_date ((NOW() AT TIME ZONE 'Europe/Istanbul')::date). The DB session runs in
// GMT, so CURRENT_DATE lags Istanbul by a day during 21:00–24:00 UTC (00:00–03:00 local).
// Using CURRENT_DATE there made the idempotency/resume/canary-bailout logic evaluate the
// wrong day vs. the rows actually being written, letting a pre-rollover run record a
// new-day snapshot that just duplicated yesterday — collapsing every daily gain to 0.
// Same verdict as artistHasTodaysData, for the WHOLE roster in one pass.
//
// The per-artist version ran once per artist — 46 counting scans over
// stream_stats on every hourly run, including the ~23 runs a day that turn out
// to have nothing to do. That was the scraper's biggest share of Neon compute.
// The date expression and the today>0 && today>=prev rule are copied verbatim:
// this is the gate that decides whether a run writes a new day, so it must give
// the same answer, only cheaper.
async function artistsWithTodaysData(client, artistUris) {
  if (!artistUris.length) return new Set();
  const res = await client.query(
    `WITH bounds AS (
       SELECT ((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date AS today
     ),
     mine AS (
       SELECT s.primary_artist AS artist, ss.recorded_date
       FROM stream_stats ss
       JOIN songs s ON s.id = ss.song_id
       WHERE s.primary_artist = ANY($1::text[])
     ),
     prev AS (
       SELECT m.artist, MAX(m.recorded_date) AS prev_date
       FROM mine m CROSS JOIN bounds b
       WHERE m.recorded_date < b.today
       GROUP BY m.artist
     )
     SELECT
       m.artist,
       COUNT(*) FILTER (WHERE m.recorded_date = b.today)     AS today_cnt,
       COUNT(*) FILTER (WHERE m.recorded_date = p.prev_date) AS prev_cnt
     FROM mine m
     CROSS JOIN bounds b
     LEFT JOIN prev p ON p.artist = m.artist
     GROUP BY m.artist`,
    [artistUris]
  );
  const done = new Set();
  for (const row of res.rows) {
    const today = parseInt(row.today_cnt ?? 0, 10);
    const prev = parseInt(row.prev_cnt ?? 0, 10);
    if (today > 0 && today >= prev) done.add(row.artist);
  }
  return done;
}

async function artistHasTodaysData(client, artistUri) {
  const res = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE ss.recorded_date = ((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date) AS today_cnt,
       COUNT(*) FILTER (WHERE ss.recorded_date = (
         SELECT MAX(ss2.recorded_date)
         FROM stream_stats ss2
         JOIN songs s2 ON s2.id = ss2.song_id
         WHERE s2.primary_artist = $1 AND ss2.recorded_date < ((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date
       )) AS prev_cnt
     FROM stream_stats ss
     JOIN songs s ON s.id = ss.song_id
     WHERE s.primary_artist = $1`,
    [artistUri]
  );
  const today = parseInt(res.rows[0]?.today_cnt ?? 0, 10);
  const prev  = parseInt(res.rows[0]?.prev_cnt ?? 0, 10);
  return today > 0 && today >= prev;
}

async function run() {
  const need = ['SP_DC', 'DATABASE_URL'];
  for (const k of need) if (!process.env[k]) { console.error(`[scraper] HATA: ${k} eksik.`); process.exit(1); }

  console.log('[scraper] Browser başlatılıyor (playcount için)...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);

  try {
    const pool   = getPool();
    const client = await pool.connect();
    // Safety net for the dedup BEGIN/COMMIT below: a hard GHA cancel (job timeout)
    // can SIGKILL this process mid-transaction, skipping our JS-level ROLLBACK.
    // If Neon's pooler ever hands that abandoned "idle in transaction" backend to a
    // later, unrelated session, every write on it inherits a frozen NOW() from the
    // old BEGIN — writes silently land on a stale date (see incident: Britney/Janet/
    // Vaelis/Taylor/Christina tracks stuck at 0 daily gain for days on a poisoned
    // recorded_date). This makes Postgres itself kill any transaction left idle this
    // long, so an abandoned one can never survive to be reused.
    await client.query("SET idle_in_transaction_session_timeout = '120000'");

    try {
      await setScraperStatus(client, 'scraping');
      // Canary Update Check — detect Spotify's daily playcount rollover using JT's
      // "Mirrors". This is a GLOBAL gate (Spotify refreshes all artists together), but
      // it no longer exits the process: a run cut short mid-list (e.g. GHA timeout)
      // leaves later artists without today's data while the canary already shows the new
      // number, which used to make every subsequent run skip everything. Instead we set a
      // flag and let the per-artist resume logic below decide who still needs scraping.
      const isForce = process.argv.includes('--force') || process.env.FORCE_SCRAPE === 'true';
      let spotifyUpdatedToday = true; // assume yes when forced or when the check can't run
      if (isForce) {
        console.log('[scraper] Force flag detected. Bypassing canary update check...');
      } else {
        const CHECK_SONG_ID = '4rHZZAmHpZrA3iH5zx8frV'; // Mirrors
        const CHECK_ALBUM_ID = '0O82niJ0NpcptYRxogeEZu'; // The 20/20 Experience (Deluxe Version)

        console.log('[scraper] Checking if Spotify has updated playcounts today...');
        const dbRes = await client.query(
          'SELECT MAX(stream_count) as max_streams FROM stream_stats WHERE song_id = $1',
          [CHECK_SONG_ID]
        );
        const dbMax = dbRes.rows[0]?.max_streams ? parseInt(dbRes.rows[0].max_streams, 10) : 0;
        console.log(`[scraper] DB max streams for Mirrors: ${dbMax}`);

        if (dbMax > 0) {
          console.log(`[scraper] Fetching playcounts for check album: ${CHECK_ALBUM_ID}`);
          const checkTracks = await fetchAlbumTracks(page, CHECK_ALBUM_ID);
          const mirrorsTrack = checkTracks.find(t => t.id === CHECK_SONG_ID);

          if (!mirrorsTrack) {
            console.warn('[scraper] Check song not found on the fetched album page. Proceeding with full scrape.');
          } else {
            const spotifyPlayCount = mirrorsTrack.playCount;
            console.log(`[scraper] Spotify current playcount for Mirrors: ${spotifyPlayCount}`);
            spotifyUpdatedToday = spotifyPlayCount > dbMax;
            if (spotifyUpdatedToday) {
              console.log(`[scraper] New data detected! (Spotify: ${spotifyPlayCount} > DB: ${dbMax}).`);
            } else {
              console.log(`[scraper] Canary shows no fresh global update (Spotify: ${spotifyPlayCount} <= DB: ${dbMax}). Will only scrape artists still missing today's snapshot.`);
            }
          }
        } else {
          console.log('[scraper] No streams found in DB for check song. Bypassing check.');
        }
      }

      const stats  = { tracksProcessed: 0, streamsUpdated: 0 };
      const failedArtists = [];

      const artistFilterArg = process.argv.find(arg => arg.startsWith('--artists='));
      let artistsToRun = [];
      let allTrackedArtistIds = [];
      try {
        const dbRes = await client.query(
          'SELECT artist_id as id, name, album_only FROM tracked_artists WHERE active = true ORDER BY sort_order, name'
        );
        if (dbRes.rows.length) {
          artistsToRun = dbRes.rows;
          allTrackedArtistIds = dbRes.rows.map(a => a.id);
          console.log(`[scraper] Loaded ${artistsToRun.length} active artists from database.`);
        }
      } catch (err) {
        console.warn(`[scraper] Failed to load active artists from database: ${err.message}. Using fallback.`);
      }

      if (!artistsToRun.length) {
        artistsToRun = [
          { id: '31TPClRtHm23RisEBtV3X7', name: 'Justin Timberlake', album_only: false },
          { id: '5L1lO4eRHmJ7a0Q6csE5cT', name: 'LISA', album_only: false },
          { id: '1HY2Jd0NmPuamShAr6KMms', name: 'Lady Gaga', album_only: true },
          { id: '6qqNVTkY8uBg9cP3Jd7DAH', name: 'Billie Eilish', album_only: false },
          { id: '66CXWjxzNUsdJxJ2JdwvnR', name: 'Ariana Grande', album_only: true },
          { id: '6Ff53KvcvAj5U7Z1vojB5o', name: '*NSYNC', album_only: false },
          { id: '3p3U04w2DaiBzuYMZnYr00', name: 'JC Chasez', album_only: false },
          { id: '3LHYvj5ZejV1NLqncEObSJ', name: 'Vaelis', album_only: false },
          { id: '2dIgFjalVxs4ThymZ67YCE', name: 'Stray Kids', album_only: false },
          { id: '4UIOuc84ExWojcUzFGtb8W', name: 'Felix', album_only: false },
          { id: '2W8yFh0Ga6Yf3jiayVxwkE', name: 'Dove Cameron', album_only: false },
          { id: '4qwGe91Bz9K2T8jXTZ815W', name: 'Janet Jackson', album_only: false }
        ];
        allTrackedArtistIds = artistsToRun.map(a => a.id);
      } else if (!allTrackedArtistIds.length) {
        allTrackedArtistIds = artistsToRun.map(a => a.id);
      }

      if (artistFilterArg) {
        const allowedIds = artistFilterArg.split('=')[1].split(',');
        artistsToRun = artistsToRun.filter(a => allowedIds.includes(a.id));
        console.log(`[scraper] Filtering run to artists: ${artistsToRun.map(a => a.name).join(', ')}`);
      }

      // Per-artist resume: skip artists already captured today; only the ones still
      // missing today's data get scraped. This lets the next hourly run finish a run
      // that was cut short (e.g. by the GHA timeout) without re-doing completed artists.
      let pendingArtists = artistsToRun;
      if (!isForce) {
        pendingArtists = [];
        const captured = await artistsWithTodaysData(
          client, artistsToRun.map(a => `spotify:artist:${a.id}`)
        );
        for (const artist of artistsToRun) {
          if (captured.has(`spotify:artist:${artist.id}`)) {
            console.log(`[scraper] ${artist.name}: already captured today, skipping.`);
          } else {
            pendingArtists.push(artist);
          }
        }

        if (pendingArtists.length === 0) {
          console.log('[scraper] All artists already have today\'s data. Nothing to do. Exiting gracefully.');
          await backfillMissingArtistPhotos(page, client);
          await setScraperStatus(client, 'idle');
          client.release();
          await closePool();
          await browser.close();
          process.exit(0);
        }

        // If Spotify hasn't rolled over today AND no artist has been captured yet, there
        // is nothing new to grab — bail rather than record stale (yesterday's) numbers.
        // (If some artists ARE already done, the pending ones are leftovers from a partial
        // run since the canary's last positive detection, so we scrape them.)
        if (!spotifyUpdatedToday && pendingArtists.length === artistsToRun.length) {
          console.log('[scraper] No fresh update and no artist captured yet today. Exiting gracefully.');
          await backfillMissingArtistPhotos(page, client);
          await setScraperStatus(client, 'idle');
          client.release();
          await closePool();
          await browser.close();
          process.exit(0);
        }
      }

      let attempted = 0;
      for (let i = 0; i < pendingArtists.length; i++) {
        const artist = pendingArtists[i];
        // Soft time budget: don't START a new artist once we're past the budget.
        // Heavy appears-on artists (Taylor/Zara/Olivia) can take 10+ min each, so
        // we leave headroom under the GHA cap for the in-flight artist + dedup.
        // Forced runs ignore the budget (manual/admin full re-scrapes run to end).
        if (!isForce && Date.now() - RUN_START > SCRAPE_BUDGET_MS) {
          const deferred = pendingArtists.slice(i).map(a => a.name);
          console.log(`[scraper] ⏱️ Time budget (${Math.round(SCRAPE_BUDGET_MS / 60000)}m) reached — deferring ${deferred.length} artist(s) to the next run: ${deferred.join(', ')}`);
          break;
        }
        // One bad artist must not sink the whole run. A wrong ID (or an artist
        // Spotify removed) used to throw straight out of the loop: every later
        // artist was skipped, the photo backfill never ran, and the job went red
        // every hour forever even though the other 43 artists were captured fine.
        // Isolate the failure, keep going, and report it at the end.
        attempted++;
        try {
          await scrapeArtist(page, client, artist.id, stats, allTrackedArtistIds, isForce, !!artist.album_only);
        } catch (artistErr) {
          failedArtists.push({
            id: artist.id,
            name: artist.name,
            message: artistErr.message,
            permanent: !!artistErr.artistNotFound,
          });
          console.error(`[scraper] ⚠️ ${artist.name} (${artist.id}) atlandı: ${artistErr.message}`);
        }
      }

      console.log(`\n[scraper] ✅ ${stats.tracksProcessed} track işlendi, ${stats.streamsUpdated} stream güncellendi.`);

      if (failedArtists.length) {
        console.error(`[scraper] ⚠️ ${failedArtists.length}/${attempted} sanatçı başarısız:`);
        for (const f of failedArtists) {
          console.error(`  - ${f.name} (${f.id}): ${f.message}${f.permanent ? '  → tracked_artists.active = false yap' : ''}`);
        }
        // Fail the job only when NOTHING succeeded — that means a systemic problem
        // (dead sp_dc cookie, Spotify blocking us), which is worth a red X. A run
        // that captured most of the roster is a success with a warning; marking it
        // red trains us to ignore the alert.
        if (failedArtists.length === attempted) {
          process.exitCode = 1;
        }
      }

      await backfillMissingArtistPhotos(page, client);

      // Spotify sometimes takes streams back (Britney "Gimme More", 2026-08-18,
      // −3.13M). The writer's stale-skip refuses to record a lower count, so a
      // removal used to leave the track frozen at its old number and the artist
      // total permanently inflated. Confirmed drops are corrected here, after
      // the catalogue is in, before dedup rebuilds the canonical mapping.
      try {
        // Kırpmanın kanıtı ŞARKININ KENDİ sayfası olmak zorunda. Buraya kadar
        // gelen gözlemler albüm sayfasından okundu ve albüm sayfası günlerce
        // eski kalabiliyor — eski bir sayfa, yükselmiş bir şarkıyı düşmüş gibi
        // gösterip iki gün üst üste "teyit" üretiyor. "Give It To Me" böyle
        // 1,189,826 kaybetti (2026-08-24). Aday başlar birkaç tane olduğu için
        // bu, koşuya birkaç sayfa açmaktan fazlasına mal olmuyor.
        await reconcileStreamDrops(client, {
          verify: async (songIds) => {
            const out = new Map();
            for (const id of songIds) {
              try { out.set(id, await fetchTrackPlaycount(page, id)); }
              catch (e) { console.warn(`[drops] ${id} canlı okunamadı: ${e.message}`); out.set(id, null); }
            }
            return out;
          },
        });
      } catch (dropErr) {
        console.error('[scraper] Drop reconciliation failed (skipped):', dropErr.message);
      }
    } finally {
      try {
        console.log('[scraper] Running database deduplication step (transactional)...');
        await setScraperStatus(client, 'deduping');
        // Wrap in a transaction so the canonical_id reset + re-merge swap atomically.
        // Without this, dedup's first step (UPDATE songs SET canonical_id = NULL) is
        // autocommitted and visible to the dashboard mid-run → every duplicate counts
        // separately → JT briefly shows ~60B. Inside a transaction, readers see the old
        // clean mappings until COMMIT, then the new ones — 18.24B → 18.25B, never 60B.
        // A crash now ROLLBACKs to the last clean state instead of leaving a half-merged
        // catalog committed. Mirrors the admin dedup path (server.js).
        await client.query('BEGIN');
        await dedupCanonical(client);
        await client.query('COMMIT');
      } catch (dedupErr) {
        try { await client.query('ROLLBACK'); } catch {}
        console.error('[scraper] Deduplication step failed (rolled back):', dedupErr.message);
      }
      try {
        await setScraperStatus(client, 'idle');
      } catch (statusErr) {
        console.error('[scraper] Failed to set idle status:', statusErr.message);
      }
      client.release();
    }
    await closePool();
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error('[scraper] HATA:', err.message); process.exit(1); });
