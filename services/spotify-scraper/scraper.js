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
  '0R03f3Axt495bkgGhivLEe', // What Goes Around...Comes Around - Radio Edit
  '6D7DBoDFoJ76VLVtDwa7CR', // LoveStoned/I Think She Knows - Don Zee Remix
  '3zTU04mYmOmGiBBYW1Afj0', // LoveStoned/I Think She Knows - Don Zee Remix - Radio Edit
  '72Y2HKafWKIILRju52I2Fo', // LoveStoned/I Think She Knows Interlude - Femi Fem & T-Money Funketeria Mix - Extended
  '7l8B8DGCVfuz4IU2sH0XFr', // LoveStoned/I Think She Knows Interlude - Femi Fem & T-Money Funketeria Mix - Radio Edit
  '0ICPCqK5g3zagynFkt1jDX', // LoveStoned/I Think She Knows - Matrix & Futurebound Extended Remix
  '7x94lS0k2NFInyHEO1DAyg'  // SexyBack (feat. Missy Elliott & Timbaland) - DJ Wayne Williams Ol' Skool Remix
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

async function processAlbum(page, client, album, stats) {
  const tracks = await fetchAlbumTracks(page, album.id);
  let kept = 0;
  for (const track of tracks) {
    // Skip blacklisted tracks
    if (BLACKLISTED_TRACK_IDS.has(track.id)) {
      console.log(`           [skip blacklist] "${track.title}" (${track.id})`);
      continue;
    }
    // Unconditionally skip any tracks where Justin Timberlake is not one of the artists
    if (!track.artistUris?.includes(ARTIST_URI)) continue;
    if (isCoverOrTribute(track.title)) {
      console.log(`           [skip cover] "${track.title}"`);
      continue;
    }
    let isFeaturedTrack = album.is_featured;
    if (track.artistUris && track.artistUris.length > 0) {
      const isLead = track.artistUris[0] === ARTIST_URI;
      const titleLower = track.title.toLowerCase();
      const albumLower = album.title.toLowerCase();
      
      if (isLead || albumLower.includes('trolls') || titleLower.includes('the other side') || titleLower.includes('love never felt so good')) {
        isFeaturedTrack = false;
      } else {
        isFeaturedTrack = true;
      }
    }

    await upsertSong(client, {
      id:             track.id,
      title:          track.title,
      album_id:       album.id,
      duration_ms:    track.duration_ms,
      track_number:   track.track_number,
      is_featured:    isFeaturedTrack,
      primary_artist: album.primary_artist ?? null,
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

async function run() {
  const need = ['SP_DC', 'DATABASE_URL'];
  for (const k of need) if (!process.env[k]) { console.error(`[scraper] HATA: ${k} eksik.`); process.exit(1); }

  console.log('[scraper] Browser başlatılıyor (playcount için)...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);

  try {
    const pool   = getPool();
    const client = await pool.connect();

    try {
      // Canary Update Check
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

      console.log('[scraper] Puppeteer ile tüm albümler keşfediliyor...');
      const { albums: discoveredAlbums, own_count, feat_count } = await discoverAllAlbumsPuppeteer(page, ARTIST_ID);
      console.log(`[scraper]   Keşfedilen: ${own_count} own + ${feat_count} featured = ${discoveredAlbums.length} unique albüm.`);

      // 1. Save all discovered albums to DB
      for (const a of discoveredAlbums) {
        await upsertAlbum(client, a);
      }

      // 2. Fetch optimized list of albums to scrape (new albums + albums containing canonical songs)
      const scrapeQuery = `
        SELECT a.id, a.title, a.release_date,
               COALESCE(bool_or(s.is_featured), false) as is_featured
        FROM albums a
        LEFT JOIN songs s ON s.album_id = a.id
        WHERE s.canonical_id IS NULL OR s.id IS NULL
        GROUP BY a.id, a.title, a.release_date
      `;
      const dbRes = await client.query(scrapeQuery);
      const albumsToScrape = dbRes.rows;
      console.log(`[scraper] Taranacak ${albumsToScrape.length} albüm belirlendi (Kanona ait ve yeni keşfedilenler).`);

      const stats  = { tracksProcessed: 0, streamsUpdated: 0 };
      for (let i = 0; i < albumsToScrape.length; i++) {
        const a = albumsToScrape[i];
        const discovered = discoveredAlbums.find(x => x.id === a.id);
        const isFeatured = discovered ? discovered.is_featured : a.is_featured;

        const tag = isFeatured ? 'feat' : 'own ';
        console.log(`[${tag} ${i+1}/${albumsToScrape.length}] "${a.title}"`);
        try {
          const n = await processAlbum(page, client, { ...a, is_featured: isFeatured }, stats);
          console.log(`           ${n} track`);
        } catch (err) { console.warn('  Hata:', err.message); }
        await sleep(DELAY_MS);
      }
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
