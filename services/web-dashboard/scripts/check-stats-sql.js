/**
 * check-stats-sql.js — /api/stats'ın headline sorgusunu GERÇEK veritabanına
 * karşı çalıştırır ve eski/yeni daily'yi yan yana basar. Hiçbir şey yazmaz.
 *
 *   DATABASE_URL=... node scripts/check-stats-sql.js <artist_id>
 *
 * NEDEN. Yanlış bir headline buradaki aritmetikten geliyor, ama bu aritmetik
 * 4000 satırlık server.js'in içinde bir template string'di: doğru çalıştığını
 * görmenin tek yolu sayfayı açmaktı, ve sayfa passcode istiyor. CTE artık
 * lib/agg-sql.js'te, yani dashboard'un servis ettiği sorgunun TA KENDİSİ
 * buradan çalıştırılabiliyor.
 *
 * Basılan iki sayı:
 *   eski (daily_gain) — her başın EN SON kazancının toplamı. Donmuş bir baş
 *                       son kazancını sonsuza kadar her güne tekrar ekler.
 *   yeni (day_gain)   — yalnızca headline gününde kazanılan. Donmuş baş 0 verir.
 */
const { artistLatestAggCTE } = require('../lib/agg-sql');
const { Pool } = require('pg');

const artistId = (process.argv[2] || '31TPClRtHm23RisEBtV3X7').replace('spotify:artist:', '');
const fmt = n => Number(n || 0).toLocaleString('en-US');

// Kova, server.js'teki artistBucketMatchSQL ile aynı olmalı — yoksa ölçtüğün
// sayı sayfanın gösterdiği sayı olmaz.
//
// JT'ninki bir CATCH-ALL: izlenen başka hiçbir sanatçıya ait olmayan her şey.
// Burada bir süre "primary_artist = JT" yazıyordu ve bu, JT'nin en büyük
// feature'larını dışarıda bırakıyordu — Holy Grail JAY-Z'nin, Give It To Me
// Timbaland'ın primary_artist'ine sahip. O yüzden bu betik 6,497,788 derken
// doğru kovayla bakan audit 9,903,258 diyordu, ve tam o şarkılar için yapılan
// bir düzeltme burada hiç kıpırdamıyormuş gibi görünüyordu.
const BUCKET = `(
  CASE WHEN $2 = '31TPClRtHm23RisEBtV3X7'
    THEN s.primary_artist IS NULL OR s.primary_artist NOT IN (
           SELECT 'spotify:artist:' || artist_id FROM tracked_artists
            WHERE artist_id <> '31TPClRtHm23RisEBtV3X7')
    ELSE s.primary_artist = $1
         OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2)
  END)`;

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL yok.'); process.exit(1); }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const filter = `s.canonical_id IS NULL AND ${BUCKET}
      AND s.id NOT IN (SELECT song_id FROM hidden_songs)`;
  const sql = `
    WITH ${artistLatestAggCTE(filter)}
    SELECT
      COALESCE(SUM(dsc.cumulative), 0)::bigint      AS total_streams,
      COALESCE(SUM(dsc.day_gain), 0)::bigint        AS daily_gain_yeni,
      COALESCE(SUM(dsc.daily_gain), 0)::bigint      AS daily_gain_eski,
      COALESCE(SUM(dsc.day_gain) FILTER (WHERE NOT s.is_featured), 0)::bigint AS lead_daily_gain,
      COALESCE(SUM(dsc.day_gain) FILTER (WHERE s.is_featured), 0)::bigint     AS feat_daily_gain,
      (
        SELECT COALESCE(ROUND(AVG(pd.day_gain)), 0)::bigint
        FROM (
          SELECT recorded_date, SUM(daily_gain) AS day_gain
          FROM agg_gains GROUP BY recorded_date ORDER BY recorded_date DESC LIMIT 7
        ) pd
      ) AS daily_avg_7d,
      COUNT(*)::int AS total_songs,
      (SELECT recorded_date FROM agg_day)::text AS last_update
    FROM agg dsc
    JOIN songs s ON s.id = dsc.canonical_id
    JOIN albums a ON s.album_id = a.id
    WHERE ${filter}`;

  const uri = `spotify:artist:${artistId}`;

  const t0 = Date.now();
  const r = await pool.query(sql, [uri, artistId]);
  const ms = Date.now() - t0;
  const x = r.rows[0];
  console.log(`\n=== /api/stats headline — ${artistId}  (${ms}ms)\n`);
  console.log(`  headline günü : ${x.last_update}`);
  console.log(`  toplam        : ${fmt(x.total_streams)}   (${x.total_songs} baş)`);
  console.log(`  daily YENİ    : ${fmt(x.daily_gain_yeni)}   (lead ${fmt(x.lead_daily_gain)} · feat ${fmt(x.feat_daily_gain)})`);
  console.log(`  daily eski    : ${fmt(x.daily_gain_eski)}`);
  console.log(`  7 gün ort.    : ${fmt(x.daily_avg_7d)}`);
  const yeni = Number(x.daily_gain_yeni), eski = Number(x.daily_gain_eski), ort = Number(x.daily_avg_7d);
  const yakin = (v) => ort > 0 && Math.abs(v - ort) <= ort * 0.6;
  console.log(`\n  → yeni sayı 7 gün ortalamasına ${yakin(yeni) ? 'YAKIN' : 'UZAK'}, ` +
              `eski sayı ${yakin(eski) ? 'YAKIN' : 'UZAK'}.`);
  // İkinci argüman bir baş id'siyse, o başın son günlerini SORGUNUN KENDİSİNDEN
  // bas. Donmuş bir şarkının sıçraması gerçekten günlere bölünüyor mu sorusunun
  // tek dürüst cevabı bu — toplamdan geri hesaplamak değil.
  // Argüman bir baş id'si ya da bir baslik parcasi olabilir. Parca verilince
  // bas id'sini once cozer — bir sarkinin hangi id'de toplandigi dedup'a gore
  // degisebiliyor, ve yanlis id'ye bakmak tam da olcumu bos cikaran sey.
  const arg = process.argv[3];
  if (arg) {
    let head = arg, label = arg;
    if (!/^[A-Za-z0-9]{22}$/.test(arg)) {
      const hit = await pool.query(
        `SELECT COALESCE(canonical_id, id) AS head, title
           FROM songs
          WHERE LOWER(title) LIKE '%' || LOWER($1) || '%'
            AND id NOT IN (SELECT song_id FROM hidden_songs)
          ORDER BY stream_count DESC NULLS LAST LIMIT 1`, [arg]);
      if (!hit.rows.length) { console.log(`\n[!] "${arg}" hicbir sarkiyla eslesmedi.`); await pool.end(); return; }
      head = hit.rows[0].head; label = `${hit.rows[0].title} (${head})`;
    }
    const r2 = await pool.query(`
      WITH ${artistLatestAggCTE(filter)}
      SELECT recorded_date::text AS d, cumulative::bigint, daily_gain::bigint
      FROM agg_gains WHERE canonical_id = $3
      ORDER BY recorded_date DESC LIMIT 12`, [uri, artistId, head]);
    console.log(`\n--- ${label} — sorgunun verdigi gunluk degerler`);
    if (!r2.rows.length) console.log('  (bu bas sanatcinin kovasinda yok — filtre disinda kaliyor)');
    for (const x of r2.rows.slice().reverse()) {
      console.log(`  ${x.d}  ${fmt(x.cumulative).padStart(14)}  daily_gain ${x.daily_gain === null ? 'NULL' : fmt(x.daily_gain)}`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error('[check] HATA:', e.message); process.exit(1); });
