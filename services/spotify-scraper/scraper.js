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
const { getPool, upsertAlbum, upsertSong, upsertStreamStat, closePool } = require('./db');
const { dedupCanonical } = require('./dedup');

const ARTIST_ID  = '31TPClRtHm23RisEBtV3X7';   // Justin Timberlake
const ARTIST_URI = `spotify:artist:${ARTIST_ID}`;
const DELAY_MS   = 800;

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

function isCoverOrTribute(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  
  // Exclude actual Justin Timberlake song "Under Cover"
  if (lower.includes('under cover')) return false;

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
    // Unconditionally skip any tracks where target artist is not one of the artists
    if (!track.artistUris?.includes(artistUri)) continue;
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
  let { albums: discoveredAlbums, own_count, feat_count } = await discoverAllAlbumsPuppeteer(page, artistId);
  
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
             title.includes('happier than ever') ||
             title.includes('when we all fall asleep') ||
             title.includes('smile at me') ||
             title.includes('guitar songs');
    });
    console.log(`[scraper] Billie Eilish filtered to official albums: ${discoveredAlbums.length} albums.`);
  }

  // Ariana Grande filters: official studio albums only
  if (artistId === '66CXWjxzNUsdJxJ2JdwvnR') {
    discoveredAlbums = discoveredAlbums.filter(a => {
      const title = a.title.toLowerCase();
      return title.includes('yours truly') ||
             title.includes('my everything') ||
             title.includes('dangerous woman') ||
             title.includes('sweetener') ||
             title.includes('thank u, next') ||
             title.includes('positions') ||
             title.includes('eternal sunshine');
    });
    console.log(`[scraper] Ariana Grande filtered to studio albums: ${discoveredAlbums.length} albums.`);
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
      { id: '4sceISkCvRuDbd74AtKeEH', title: 'Timeless', release_date: '2005-12-31', is_featured: true }
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
      { id: '5YCdlD3eREt72lTZxNL7id', title: 'dont smile at me', release_date: '2017-08-11', is_featured: false }
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

async function run() {
  const need = ['SP_DC', 'DATABASE_URL'];
  for (const k of need) if (!process.env[k]) { console.error(`[scraper] HATA: ${k} eksik.`); process.exit(1); }

  console.log('[scraper] Browser başlatılıyor (playcount için)...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);

  try {
    const pool   = getPool();
    const client = await pool.connect();

    try {
      // Canary Update Check (only run check for Mirrors for JT first, to skip if no updates)
      const isForce = process.argv.includes('--force') || process.env.FORCE_SCRAPE === 'true';
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
            
            if (spotifyPlayCount <= dbMax) {
              console.log(`[scraper] No update detected yet. (Spotify: ${spotifyPlayCount} <= DB: ${dbMax}). Exiting gracefully.`);
              client.release();
              await closePool();
              await browser.close();
              process.exit(0);
            }
            console.log(`[scraper] New data detected! (Spotify: ${spotifyPlayCount} > DB: ${dbMax}). Proceeding with full scrape.`);
          }
        } else {
          console.log('[scraper] No streams found in DB for check song. Bypassing check.');
        }
      }

      const stats  = { tracksProcessed: 0, streamsUpdated: 0 };
      
      // Scrape Justin Timberlake
      await scrapeArtist(page, client, '31TPClRtHm23RisEBtV3X7', stats);
      
      // Scrape LISA
      await scrapeArtist(page, client, '5L1lO4eRHmJ7a0Q6csE5cT', stats);
      
      // Scrape Lady Gaga
      await scrapeArtist(page, client, '1HY2Jd0NmPuamShAr6KMms', stats);
      
      // Scrape Billie Eilish
      await scrapeArtist(page, client, '6qqNVTkY8uBg9cP3Jd7DAH', stats);
      
      // Scrape Ariana Grande
      await scrapeArtist(page, client, '66CXWjxzNUsdJxJ2JdwvnR', stats);

      await dedupCanonical(client);

      console.log(`\n[scraper] ✅ ${stats.tracksProcessed} track işlendi, ${stats.streamsUpdated} stream güncellendi.`);
    } finally {
      client.release();
    }
    await closePool();
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error('[scraper] HATA:', err.message); process.exit(1); });
