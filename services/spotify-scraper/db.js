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
    `INSERT INTO songs (id, title, album_id, duration_ms, track_number, is_featured, primary_artist, is_solo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
       SET title          = EXCLUDED.title,
           duration_ms    = EXCLUDED.duration_ms,
           track_number   = CASE WHEN songs.is_featured THEN EXCLUDED.track_number ELSE songs.track_number END,
           album_id       = CASE WHEN songs.is_featured AND NOT EXCLUDED.is_featured THEN EXCLUDED.album_id
                                 WHEN songs.is_featured THEN songs.album_id
                                 ELSE songs.album_id END,
           is_featured    = songs.is_featured AND EXCLUDED.is_featured,
           primary_artist = CASE WHEN songs.is_featured AND NOT EXCLUDED.is_featured THEN EXCLUDED.primary_artist
                                 ELSE songs.primary_artist END,
           is_solo        = EXCLUDED.is_solo`,
    [song.id, song.title, song.album_id, song.duration_ms, song.track_number,
     song.is_featured ?? false, song.primary_artist ?? null, song.is_solo ?? true]
  );
}

/**
 * Stream stat upsert — aynı gün için tek kayıt (unique index: song_id + DATE(recorded_at)).
 *
 * Stale-snapshot koruması: Spotify playcountları her gün güncellemeyebilir.
 * Eğer yeni gelen playcount, veritabanındaki son kaydedilen değerden büyük DEĞİLSE,
 * o gün için satır YAZILMAZ. Bu sayede "bugün − dün" farkı (daily_gain) her zaman
 * gerçek bir artışı yansıtır; sahte 0-gain günleri ve sonraki 2x spike'lar önlenir.
 *
 * Returns true if a row was written, false if skipped (stale).
 */
async function upsertStreamStat(client, songId, streamCount) {
  // Check if this playcount is actually newer than what we already have
  const lastRes = await client.query(
    `SELECT stream_count FROM stream_stats
     WHERE song_id = $1
     ORDER BY recorded_date DESC LIMIT 1`,
    [songId]
  );
  const lastCount = lastRes.rows[0]?.stream_count
    ? parseInt(lastRes.rows[0].stream_count, 10) : 0;

  // Skip stale writes: only record if Spotify actually increased the count
  if (lastCount > 0 && streamCount <= lastCount) {
    return false;
  }

  await client.query(
    `INSERT INTO stream_stats (song_id, stream_count, recorded_date, recorded_at)
     VALUES ($1, $2, ((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date, NOW())
     ON CONFLICT (song_id, recorded_date) DO UPDATE
       SET stream_count = GREATEST(EXCLUDED.stream_count, stream_stats.stream_count),
           recorded_at  = NOW()`,
    [songId, streamCount]
  );
  return true;
}

/**
 * Artist stat upsert — bir sanatçı için günlük snapshot (monthly listeners, followers, world rank).
 * stream_stats'tan farklı: monthly listeners hem artar hem azalır, bu yüzden GREATEST kullanmaz, üzerine yazar.
 */
async function upsertArtistStat(client, s) {
  await client.query(
    `INSERT INTO artist_stats (artist_id, artist_name, monthly_listeners, followers, world_rank, recorded_date, recorded_at)
     VALUES ($1, $2, $3, $4, $5, ((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date, NOW())
     ON CONFLICT (artist_id, recorded_date) DO UPDATE
       SET artist_name       = COALESCE(EXCLUDED.artist_name, artist_stats.artist_name),
           monthly_listeners = EXCLUDED.monthly_listeners,
           followers         = EXCLUDED.followers,
           world_rank        = EXCLUDED.world_rank,
           recorded_at       = NOW()`,
    [s.artist_id, s.name ?? null, s.monthly_listeners ?? null, s.followers ?? null, s.world_rank ?? null]
  );
}

async function closePool() {
  if (pool) await pool.end();
}

module.exports = { getPool, upsertAlbum, upsertSong, upsertStreamStat, upsertArtistStat, closePool };
