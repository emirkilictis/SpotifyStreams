const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ARTIST_URI = 'spotify:artist:31TPClRtHm23RisEBtV3X7';

async function main() {
  try {
    console.log("Detecting bad songs from compilation/appears_on albums...");
    
    // In our scraper, bad songs are added because they belong to compilation albums (appears_on) 
    // where is_featured = true for the album, but the track itself is not featuring JT.
    // If the track is in an album where is_featured = true, but JT is NOT in the artist list, 
    // it shouldn't have been stored in the DB, or should be cleaned up.
    // Let's check how many songs are in the songs table.
    
    const countBefore = await pool.query('SELECT COUNT(*) FROM songs;');
    console.log("Songs count before cleanup:", countBefore.rows[0].count);

    // Let's find songs that were inserted from appears_on albums (is_featured = true)
    // but do not actually belong to JT's own albums, AND their primary_artist is not JT,
    // AND they are marked is_featured = true.
    // Actually, JTs own studio albums have is_featured = false.
    // Compilation albums we scraped have is_featured = true.
    // Let's check:
    // If a song has is_featured = true, we want to keep it ONLY if JT is actually on the song.
    // Since we don't store the artistUris list in the songs table (we only have s.primary_artist, which might be null,
    // and is_featured = true), wait! The scraper.js code does this:
    // `if (album.is_featured && !track.artistUris?.includes(ARTIST_URI)) continue;`
    // Wait, why did the scraper process those tracks then?
    // Ah! Let's check line 47 in scraper.js:
    // `if (album.is_featured && !track.artistUris?.includes(ARTIST_URI)) continue;`
    // But when we ran scraper.js, wait, were the albums loaded with is_featured = true?
    // Let's check how albumsToScrape was selected:
    // `const dbRes = await client.query(scrapeQuery);`
    // Let's see what scrapeQuery does in scraper.js:
    /*
      SELECT a.id, a.title, a.release_date,
             COALESCE(bool_or(s.is_featured), false) as is_featured
      FROM albums a
      LEFT JOIN songs s ON s.album_id = a.id
      WHERE s.canonical_id IS NULL OR s.id IS NULL
      GROUP BY a.id, a.title, a.release_date
    */
    // Wait! For a newly discovered album `a` that doesn't have any songs in the DB yet,
    // `s.id IS NULL` is true, so it selects it.
    // BUT since there are no songs, `bool_or(s.is_featured)` evaluates to NULL, and `COALESCE(..., false)` evaluates to `false`!
    // So for ALL newly discovered albums, `is_featured` was selected as `false`!
    // Which means `album.is_featured` was passed as `false` to `processAlbum`!
    // And inside `processAlbum`:
    // `if (album.is_featured && !track.artistUris?.includes(ARTIST_URI)) continue;`
    // Since `album.is_featured` was `false`, it did NOT check if JT was in `artistUris`!
    // Thus, it processed every single track on the appears_on compilation albums as if they were JT's own tracks!
    // This is the bug! That's why Ed Sheeran, Coldplay, and hundreds of other non-JT tracks were added to the DB!
    
    // Let's delete all songs from appears_on albums where JT is not on them.
    // But wait, how do we know if JT is on them? We didn't save artistUris in the DB.
    // Wait, can we delete all tracks that are not JT tracks?
    // If a track's album is a compilation (e.g. not the 6 studio albums, nor Trolls soundtracks which are own, etc.),
    // and is not a JT song, can we clean them up?
    // Let's identify JT's own albums. They are:
    // 1. FutureSex/LoveSounds Deluxe ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp')
    // 2. Justified ('6QPkyl04rXwTGlGlcYaRoW')
    // 3. The 20/20 Experience Part 1 ('0O82niJ0NpcptYRxogeEZu')
    // 4. The 20/20 Experience Part 2 ('5lYzReGzcSNF0Gx47wm6qU')
    // 5. Man of the Woods ('01l3jTY261V3CESZR4dABz')
    // 6. Everything I Thought It Was ('716B2iWcwoKolCXrqwLGQh')
    // Let's check Trolls soundtracks:
    // '0N273wQ4t1JNzP1rQp1t0C' (Trolls Holiday), etc.
    // What if we delete all songs where the album title doesn't contain 'Justified', 'FutureSex', '20/20 Experience', 'Man of the Woods', 'Everything I Thought It Was', 'Trolls', 'Book of Love'?
    // Wait, there are actual features JT has on other artist's songs (e.g., "Ayo Technology" on 50 Cent's album, "Love Sex Magic" on Ciara's album, "Holy Grail" on Jay-Z's album).
    // We want to keep those features! But we want to delete all the other tracks on those albums (like other songs on Jay-Z's album, other songs on Ciara's album, other songs on 50 Cent's album).
    // How can we identify them?
    // We can query the Spotify Web API or mock it, or look at the songs.
    // Since we know the exact list of JT's own songs and features, let's write a script to identify them or check how many tracks we should have.
    // The user said: "260 ŞARKI OLMALI" (There should be 260 songs).
    // Let's find how many songs are JTs own or real features.
    
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();
