/**
 * Main scraper — Justin Timberlake stream count crawler.
 *
 * Hibrit strateji:
 *   - Album listesi (own + tüm appears_on) → resmi Spotify API (client_credentials)
 *   - Track playcount → web player pathfinder (sp_dc cookie + headless Chrome)
 */

require('dotenv').config({ path: '../../.env' });

const { launchBrowser, fetchAlbumTracks } = require('./spotify');
const { discoverAllAlbumsPuppeteer } = require('./discover');
const { getPool, upsertAlbum, upsertSong, upsertStreamStat, upsertArtistStat, closePool } = require('./db');
const { dedupCanonical } = require('./dedup');

const ARTIST_ID  = '31TPClRtHm23RisEBtV3X7';   // Justin Timberlake
const ARTIST_URI = `spotify:artist:${ARTIST_ID}`;
const DELAY_MS   = 400;

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
  '66CXWjxzNUsdJxJ2JdwvnR': ['ariana grande'],
  '6Ff53KvcvAj5U7Z1vojB5o': ['nsync', '*nsync'],
  '3p3U04w2DaiBzuYMZnYr00': ['jc chasez', 'chasez'],
  '3LHYvj5ZejV1NLqncEObSJ': ['vaelis']
};

function isCoverOrTribute(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  
  // Exclude actual Justin Timberlake song "Under Cover" or official "DM-FK" remix
  if (lower.includes('under cover') || lower.includes('dm-fk')) return false;

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

async function processAlbum(page, client, album, artistUri, stats) {
  const tracks = await fetchAlbumTracks(page, album.id);
  let kept = 0;
  for (const track of tracks) {
    // Skip blacklisted tracks
    if (BLACKLISTED_TRACK_IDS.has(track.id)) {
      console.log(`           [skip blacklist] "${track.title}" (${track.id})`);
      continue;
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

    await upsertSong(client, {
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
      await upsertStreamStat(client, track.id, track.playCount);
      stats.streamsUpdated++;
    }
    stats.tracksProcessed++;
    kept++;
  }
  return kept;
}

async function scrapeArtist(page, client, artistId, stats) {
  const artistUri = `spotify:artist:${artistId}`;
  console.log(`\n[scraper] Discovering albums for artist: ${artistId}...`);
  let { albums: discoveredAlbums, own_count, feat_count, stats: artistStats } = await discoverAllAlbumsPuppeteer(page, artistId);

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

  // Billie Eilish filters: official studio albums and EPs
  if (artistId === '6qqNVTkY8uBg9cP3Jd7DAH') {
    discoveredAlbums = discoveredAlbums.filter(a => {
      const title = a.title.toLowerCase();
      return title.includes('hit me hard and soft') ||
             (title.includes('happier than ever') && !title.includes('edit')) ||
             title.includes('when we all fall asleep') ||
             title.includes('smile at me') ||
             title.includes('guitar songs');
    });
    console.log(`[scraper] Billie Eilish filtered to official albums: ${discoveredAlbums.length} albums.`);
  }

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

  // 2. Determine albums to scrape: combine newly discovered albums with existing database albums containing canonical songs for this artist
  const dbAlbumsRes = await client.query(`
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
      { id: '5jlQrOtSuTXojcvBCpivyo', title: 'Suit & Tie (feat. JAY-Z) [Radio Edit]', release_date: '2013-01-15', is_featured: false }
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

  const albumsToScrape = Array.from(albumMap.values());
  
  console.log(`[scraper] Scraping ${albumsToScrape.length} albums for ${artistId}...`);

  for (let i = 0; i < albumsToScrape.length; i++) {
    const a = albumsToScrape[i];
    const isFeatured = a.is_featured ?? false;

    const tag = isFeatured ? 'feat' : 'own ';
    console.log(`[${tag} ${i+1}/${albumsToScrape.length}] "${a.title}"`);
    try {
      const n = await processAlbum(page, client, { ...a, is_featured: isFeatured }, artistUri, stats);
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
async function artistHasTodaysData(client, artistUri) {
  const res = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE ss.recorded_date = (NOW() AT TIME ZONE 'Europe/Istanbul')::date) AS today_cnt,
       COUNT(*) FILTER (WHERE ss.recorded_date = (
         SELECT MAX(ss2.recorded_date)
         FROM stream_stats ss2
         JOIN songs s2 ON s2.id = ss2.song_id
         WHERE s2.primary_artist = $1 AND ss2.recorded_date < (NOW() AT TIME ZONE 'Europe/Istanbul')::date
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

    try {
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

      const artistFilterArg = process.argv.find(arg => arg.startsWith('--artists='));
      let artistsToRun = [
        { id: '31TPClRtHm23RisEBtV3X7', name: 'Justin Timberlake' },
        { id: '5L1lO4eRHmJ7a0Q6csE5cT', name: 'LISA' },
        { id: '1HY2Jd0NmPuamShAr6KMms', name: 'Lady Gaga' },
        { id: '6qqNVTkY8uBg9cP3Jd7DAH', name: 'Billie Eilish' },
        { id: '66CXWjxzNUsdJxJ2JdwvnR', name: 'Ariana Grande' },
        { id: '6Ff53KvcvAj5U7Z1vojB5o', name: '*NSYNC' },
        { id: '3p3U04w2DaiBzuYMZnYr00', name: 'JC Chasez' },
        { id: '3LHYvj5ZejV1NLqncEObSJ', name: 'Vaelis' }
      ];

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
        for (const artist of artistsToRun) {
          if (await artistHasTodaysData(client, `spotify:artist:${artist.id}`)) {
            console.log(`[scraper] ${artist.name}: already captured today, skipping.`);
          } else {
            pendingArtists.push(artist);
          }
        }

        if (pendingArtists.length === 0) {
          console.log('[scraper] All artists already have today\'s data. Nothing to do. Exiting gracefully.');
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
          client.release();
          await closePool();
          await browser.close();
          process.exit(0);
        }
      }

      for (const artist of pendingArtists) {
        await scrapeArtist(page, client, artist.id, stats);
      }

      console.log(`\n[scraper] ✅ ${stats.tracksProcessed} track işlendi, ${stats.streamsUpdated} stream güncellendi.`);
    } finally {
      try {
        console.log('[scraper] Running database deduplication step...');
        await dedupCanonical(client);
      } catch (dedupErr) {
        console.error('[scraper] Deduplication step failed:', dedupErr.message);
      }
      client.release();
    }
    await closePool();
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error('[scraper] HATA:', err.message); process.exit(1); });
