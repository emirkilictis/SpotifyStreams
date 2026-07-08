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

// Late-update catch-up (see upsertStreamStatsBatch) only fills the missing day
// ONE AT A TIME (last_date + 1) when the gap is small — that's the common "Spotify's
// own refresh was a bit late" case. But a song that's structurally revisited less
// than daily (e.g. an edition track on a shared compilation album only rediscovered
// every few days via appears-on) never has a "small" gap: every visit advances the
// date by exactly 1 and it permanently trails further behind. Because
// daily_streams_canonical takes a running MAX per canonical_id across every edition,
// a fresh (large) count landing under an old date poisons that date's max and
// flatlines daily_gain for every day since — this is what froze Britney's Toxic/
// Gimme More/Baby One More Time/Womanizer (and assorted Janet Jackson/Vaelis/Taylor
// Swift/Christina Aguilera/cupcakke tracks) for 10+ days on 2026-07-08. Beyond this
// many days of gap, snap straight to today instead of creeping — one coarse-gain day
// is far safer than a permanently poisoned running max.
const CATCHUP_CAP_DAYS = 2;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Target date for a snapshot: fills the oldest missing day (priorDate + 1) when the
// gap since the last snapshot is small, otherwise snaps to today (see CATCHUP_CAP_DAYS).
function nextSnapshotDate(todayStr, priorDateStr) {
  if (!priorDateStr) return todayStr;
  const gapDays = Math.round((new Date(`${todayStr}T00:00:00Z`) - new Date(`${priorDateStr}T00:00:00Z`)) / 86400000);
  if (gapDays <= 0) return todayStr;
  return gapDays <= CATCHUP_CAP_DAYS ? addDays(priorDateStr, 1) : todayStr;
}

async function todayIstanbul(client) {
  const res = await client.query(
    `SELECT (((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date)::text AS today`
  );
  return res.rows[0].today;
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
 *
 * Same late-update catch-up as upsertStreamStatsBatch: lands on the oldest day
 * still missing since this artist's last snapshot when the gap is small (capped at
 * CATCHUP_CAP_DAYS), otherwise snaps to today instead of creeping indefinitely.
 */
async function upsertArtistStat(client, s) {
  const [today, priorRes] = await Promise.all([
    todayIstanbul(client),
    client.query(
      `SELECT recorded_date::text AS recorded_date FROM artist_stats
       WHERE artist_id = $1 ORDER BY recorded_date DESC LIMIT 1`,
      [s.artist_id]
    ),
  ]);
  const priorDate = priorRes.rows[0]?.recorded_date || null;
  const targetDate = nextSnapshotDate(today, priorDate);
  await client.query(
    `INSERT INTO artist_stats (artist_id, artist_name, monthly_listeners, followers, world_rank, recorded_date, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6::date, NOW())
     ON CONFLICT (artist_id, recorded_date) DO UPDATE
       SET artist_name       = COALESCE(EXCLUDED.artist_name, artist_stats.artist_name),
           monthly_listeners = EXCLUDED.monthly_listeners,
           followers         = EXCLUDED.followers,
           world_rank        = EXCLUDED.world_rank,
           recorded_at       = NOW()`,
    [s.artist_id, s.name ?? null, s.monthly_listeners ?? null, s.followers ?? null, s.world_rank ?? null, targetDate]
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
 *
 * Late-update catch-up: a song's row normally lands on "today" (the Istanbul
 * calendar date). But if Spotify's daily refresh itself arrives late — after
 * today's date has already rolled over past this song's last snapshot by more
 * than one day — stamping it "today" leaves a hole on the day the update
 * actually belongs to, and the calendar-diff daily_gain (see migration 015)
 * ends up averaging that jump over the gap, i.e. it looks halved. So instead
 * of always using today, we use the OLDEST day still missing since the song's
 * last snapshot (last_date + 1) — but only while the gap is small (see
 * CATCHUP_CAP_DAYS): a song that's structurally revisited less than daily (e.g.
 * an edition on a shared compilation album only rediscovered every few days)
 * would otherwise creep 1 day per visit forever, and daily_streams_canonical's
 * running MAX per canonical_id means a fresh count landing under a stale date
 * poisons that date's max and flatlines daily_gain from then on. Beyond the
 * cap we snap straight to today instead.
 */
async function upsertStreamStatsBatch(client, items, backdateFirst = false) {
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
  const [today, lastRes] = await Promise.all([
    todayIstanbul(client),
    client.query(
      `SELECT DISTINCT ON (song_id) song_id, stream_count, recorded_date::text AS recorded_date
       FROM stream_stats WHERE song_id = ANY($1)
       ORDER BY song_id, recorded_date DESC`,
      [ids]
    ),
  ]);
  const last = new Map();
  for (const r of lastRes.rows) {
    last.set(r.song_id, { count: parseInt(r.stream_count, 10) || 0, date: r.recorded_date });
  }

  const values = [];
  const params = [];
  let p = 0;
  for (const [songId, streamCount] of byId) {
    const prior     = last.get(songId);          // any earlier snapshot for this song?
    const hasPrior  = !!prior;
    if (hasPrior && streamCount <= prior.count) continue; // stale → skip (same rule)
    // First-EVER snapshot of a brand-new ARTIST → stamp YESTERDAY, not today, so a
    // new artist scraped before Spotify's daily rollover gets a baseline instead of
    // a double-day spike. Gated on backdateFirst (artist had zero prior snapshots):
    // back-dating a new EDITION of an existing song would put today's playcount on
    // yesterday and, through the canonical MAX, zero out that song's daily gain
    // (this is what killed LISA "Goals").
    const targetDate = hasPrior
      ? nextSnapshotDate(today, prior.date)
      : ((backdateFirst && !hasPrior) ? addDays(today, -1) : today);
    values.push(`($${++p}, $${++p}, $${++p}::date)`);
    params.push(songId, streamCount, targetDate);
  }
  if (!values.length) return 0;
  await client.query(
    `INSERT INTO stream_stats (song_id, stream_count, recorded_date, recorded_at)
     SELECT v.song_id::text, v.stream_count::bigint, v.target_date, NOW()
     FROM (VALUES ${values.join(', ')}) AS v(song_id, stream_count, target_date)
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
