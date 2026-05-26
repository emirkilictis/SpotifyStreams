const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

/**
 * Album upsert — varsa güncelle, yoksa ekle.
 */
async function upsertAlbum(client, album) {
  await client.query(
    `INSERT INTO albums (id, title, release_date, image_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET title        = EXCLUDED.title,
           release_date = EXCLUDED.release_date,
           image_url    = COALESCE(EXCLUDED.image_url, albums.image_url)`,
    [album.id, album.title, album.release_date, album.image_url || null]
  );
}

/**
 * Song upsert.
 */
async function upsertSong(client, song) {
  // Önemli: bir şarkı önce own olarak kaydedildiyse, sonradan compilation'dan
  // gelen featured kaydı OVERWRITE etmemeli. Bu yüzden:
  //  - Yeni kayıt → her zaman ekle
  //  - Mevcut own (is_featured=false) → güncelleme YAPMA
  //  - Mevcut featured → ancak title/duration güncellenebilir, album değişmez
  await client.query(
    `INSERT INTO songs (id, title, album_id, duration_ms, track_number, is_featured, primary_artist)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
       SET title          = EXCLUDED.title,
           duration_ms    = EXCLUDED.duration_ms,
           track_number   = CASE WHEN songs.is_featured THEN EXCLUDED.track_number ELSE songs.track_number END,
           album_id       = CASE WHEN songs.is_featured AND NOT EXCLUDED.is_featured THEN EXCLUDED.album_id
                                 WHEN songs.is_featured THEN songs.album_id
                                 ELSE songs.album_id END,
           is_featured    = songs.is_featured AND EXCLUDED.is_featured,
           primary_artist = CASE WHEN songs.is_featured AND NOT EXCLUDED.is_featured THEN EXCLUDED.primary_artist
                                 ELSE songs.primary_artist END`,
    [song.id, song.title, song.album_id, song.duration_ms, song.track_number,
     song.is_featured ?? false, song.primary_artist ?? null]
  );
}

/**
 * Stream stat upsert — aynı gün için tek kayıt (unique index: song_id + DATE(recorded_at)).
 * Güncelleme: stream_count daha büyükse yazar (Spotify sayacı asla geri gitmiyor).
 */
async function upsertStreamStat(client, songId, streamCount) {
  await client.query(
    `INSERT INTO stream_stats (song_id, stream_count, recorded_date, recorded_at)
     VALUES ($1, $2, CURRENT_DATE, NOW())
     ON CONFLICT (song_id, recorded_date) DO UPDATE
       SET stream_count = GREATEST(EXCLUDED.stream_count, stream_stats.stream_count),
           recorded_at  = NOW()`,
    [songId, streamCount]
  );
}

async function closePool() {
  if (pool) await pool.end();
}

module.exports = { getPool, upsertAlbum, upsertSong, upsertStreamStat, closePool };
