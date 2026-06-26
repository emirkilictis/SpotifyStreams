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
  const hasPrior  = lastRes.rows.length > 0;     // any earlier snapshot for this song?
  const lastCount = lastRes.rows[0]?.stream_count
    ? parseInt(lastRes.rows[0].stream_count, 10) : 0;

  // Skip stale writes: only record if Spotify actually increased the count
  if (lastCount > 0 && streamCount <= lastCount) {
    return false;
  }

  // First-EVER snapshot → stamp yesterday so a new artist added before Spotify's
  // daily rollover gets a baseline instead of a double-day spike (see the batch
  // version for the full rationale).
  await client.query(
    `INSERT INTO stream_stats (song_id, stream_count, recorded_date, recorded_at)
     VALUES ($1, $2,
             (((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date - $3::int),
             NOW())
     ON CONFLICT (song_id, recorded_date) DO UPDATE
       SET stream_count = GREATEST(EXCLUDED.stream_count, stream_stats.stream_count),
           recorded_at  = NOW()`,
    [songId, streamCount, hasPrior ? 0 : 1]
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

/**
 * Batched song upsert — one multi-row INSERT instead of N round-trips. Same
 * ON CONFLICT rules as upsertSong (so own>featured protection is identical).
 * Dedupes by id within the batch (a single INSERT can't hit one conflict twice).
 */
async function upsertSongsBatch(client, songs) {
  if (!songs || !songs.length) return;
  const byId = new Map();
  for (const s of songs) byId.set(s.id, s); // last write wins, like sequential upserts
  const rows = [...byId.values()];
  const cols = 8;
  const values = [];
  const params = [];
  rows.forEach((s, i) => {
    const b = i * cols;
    values.push(`($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8})`);
    params.push(s.id, s.title, s.album_id, s.duration_ms, s.track_number,
                s.is_featured ?? false, s.primary_artist ?? null, s.is_solo ?? true);
  });
  await client.query(
    `INSERT INTO songs (id, title, album_id, duration_ms, track_number, is_featured, primary_artist, is_solo)
     VALUES ${values.join(', ')}
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
    params
  );
}

/**
 * Batched stream-stat upsert. Preserves the exact stale-skip rule of
 * upsertStreamStat (only write when Spotify's count actually increased) but in
 * 2 round-trips per album instead of 2 per track: one SELECT for the latest
 * counts, one multi-row INSERT for the non-stale rows. Returns rows written.
 */
async function upsertStreamStatsBatch(client, items) {
  if (!items || !items.length) return 0;
  // Collapse to one entry per song (max count) so the INSERT never hits the same
  // (song_id, today) conflict twice.
  const byId = new Map();
  for (const it of items) {
    if (!(it.streamCount > 0)) continue;
    const prev = byId.get(it.songId);
    if (prev === undefined || it.streamCount > prev) byId.set(it.songId, it.streamCount);
  }
  if (!byId.size) return 0;
  const ids = [...byId.keys()];
  const lastRes = await client.query(
    `SELECT DISTINCT ON (song_id) song_id, stream_count
     FROM stream_stats WHERE song_id = ANY($1)
     ORDER BY song_id, recorded_date DESC`,
    [ids]
  );
  const last = new Map();
  for (const r of lastRes.rows) last.set(r.song_id, parseInt(r.stream_count, 10) || 0);

  const values = [];
  const params = [];
  let p = 0;
  for (const [songId, streamCount] of byId) {
    const hasPrior  = last.has(songId);          // any earlier snapshot for this song?
    const lastCount = last.get(songId) || 0;
    if (lastCount > 0 && streamCount <= lastCount) continue; // stale → skip (same rule)
    // First-EVER snapshot → stamp YESTERDAY, not today. A brand-new artist scraped
    // before Spotify's daily rollover shows the PREVIOUS day's playcounts; stamping
    // those today and then today's real values tomorrow produced a double-day spike
    // (we had to re-date Christina by hand). Back-dating the first row makes it a
    // baseline (no day-1 gain) so the next scrape computes a correct 1-day gain.
    // Safe regardless of when the artist is added — if added after rollover the only
    // effect is a 0 gain on day 1.
    values.push(`($${++p}, $${++p}, $${++p})`);
    params.push(songId, streamCount, hasPrior ? 0 : 1);
  }
  if (!values.length) return 0;
  await client.query(
    `INSERT INTO stream_stats (song_id, stream_count, recorded_date, recorded_at)
     SELECT v.song_id::text, v.stream_count::bigint,
            (((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date - v.first_snap::int),
            NOW()
     FROM (VALUES ${values.join(', ')}) AS v(song_id, stream_count, first_snap)
     ON CONFLICT (song_id, recorded_date) DO UPDATE
       SET stream_count = GREATEST(EXCLUDED.stream_count, stream_stats.stream_count),
           recorded_at  = NOW()`,
    params
  );
  return values.length;
}

/**
 * Scraper status update — tracks if scraper is 'idle', 'scraping', or 'deduping'.
 */
async function setScraperStatus(client, status) {
  await client.query(
    `INSERT INTO scraper_status (id, status, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           updated_at = NOW()`,
    [status]
  );
}

async function closePool() {
  if (pool) await pool.end();
}

module.exports = { getPool, upsertAlbum, upsertSong, upsertSongsBatch, upsertStreamStat, upsertStreamStatsBatch, upsertArtistStat, setScraperStatus, closePool };
