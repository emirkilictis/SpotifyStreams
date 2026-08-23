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

// JT dışındaki her sanatçının kovası server.js'teki artistBucketMatchSQL ile
// aynı: kendi primary_artist'i + extra_artist_songs'ta ona pinlenenler.
const BUCKET = `(s.primary_artist = $1
  OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2))`;

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
  // JT'nin kovası bir "geri kalan her şey" kuralı (izlenen HER sanatçıyı dışlar),
  // buradaki basit kural onu tarif etmiyor. Sorgunun kendisi yine de aynı, ama
  // JT için basılan sayılar sayfadakiyle birebir olmaz.
  if (artistId === '31TPClRtHm23RisEBtV3X7') {
    console.log('\n[not] JT catch-all kovası burada yaklaşık — sayılar sayfadakiyle birebir değil, sorgu aynı.');
  }
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
  await pool.end();
}

main().catch(e => { console.error('[check] HATA:', e.message); process.exit(1); });
