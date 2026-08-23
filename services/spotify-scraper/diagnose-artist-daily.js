/**
 * diagnose-artist-daily.js — bir sanatçının günlük toplamı neden o kadar
 * çıkıyor, satır satır gösterir. HİÇBİR ŞEY YAZMAZ (yalnızca SELECT).
 *
 *   node diagnose-artist-daily.js --artist=<id|isim parçası>
 *   node diagnose-artist-daily.js --artist=Cardi --days=12 --top=25
 *
 * Dashboard'un headline daily'si, her canonical başın EN SON günlük kazancının
 * toplamı (server.js `artistLatestAggCTE` + /api/stats). Şişik bir gün üç
 * şeyden birinden geliyor olabilir ve rapor üçünü de ayrı ayrı gösterir:
 *
 *   1. Gerçekten büyük bir gün — günlük seri düz, sayı da öyle.
 *   2. Tek bir şarkının sıçraması — bir başın değeri bir günde katlanmış
 *      (çalınmış okuma / yanlış gruba bağlanmış üye). Sıçrayan satır listenin
 *      en üstünde durur.
 *   3. Takvim kayması — bir şarkının son iki snapshot'ı arasında birden fazla
 *      gün var; kazanç güne bölünse de "en son gün" toplamına tek seferde
 *      giriyor. Rapor bunları `gap` kolonuyla işaretler.
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const fmt = n => Number(n || 0).toLocaleString('en-US');

// Bir sanatçının "kovası", JT dışında, server.js'teki artistBucketMatchSQL ile
// aynı: kendi primary_artist'i + extra_artist_songs'ta ona pinlenenler.
const BUCKET = `
  s.canonical_id IS NULL
  AND (s.primary_artist = $1 OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2))
  AND s.id NOT IN (SELECT song_id FROM hidden_songs)`;

// Baş başına günlük seri. cumulative = running max (playcount düşemez),
// daily_gain gün farkına bölünür — ikisi de view'ların tanımıyla aynı.
const SERI = `
  kapsam AS (
    SELECT DISTINCT COALESCE(s.canonical_id, s.id) AS head
    FROM songs s WHERE ${BUCKET}
  ),
  gun AS (
    SELECT COALESCE(s2.canonical_id, s2.id) AS head, ss.recorded_date,
           MAX(ss.stream_count) AS stream_count
    FROM stream_stats ss
    JOIN songs s2 ON s2.id = ss.song_id
    WHERE COALESCE(s2.canonical_id, s2.id) IN (SELECT head FROM kapsam)
    GROUP BY 1, 2
  ),
  runmax AS (
    SELECT head, recorded_date, stream_count,
           MAX(stream_count) OVER (PARTITION BY head ORDER BY recorded_date
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
    FROM gun
  ),
  kazanc AS (
    SELECT head, recorded_date, cumulative,
           (cumulative - LAG(cumulative) OVER w) AS ham_fark,
           (recorded_date - LAG(recorded_date) OVER w) AS gap,
           (cumulative - LAG(cumulative) OVER w)
             / NULLIF(recorded_date - LAG(recorded_date) OVER w, 0) AS daily_gain,
           ROW_NUMBER() OVER (PARTITION BY head ORDER BY recorded_date DESC) AS rn
    FROM runmax
    WINDOW w AS (PARTITION BY head ORDER BY recorded_date)
  )`;

async function main() {
  const artistArg = arg('artist', null);
  const days = Number(arg('days', 12));
  const top = Number(arg('top', 25));
  if (!artistArg) { console.error('Kullanım: --artist=<id|isim parçası>'); process.exit(1); }

  const client = await getPool().connect();
  try {
    const who = await client.query(
      `SELECT artist_id, name, album_only, active FROM tracked_artists
        WHERE artist_id = $1 OR name ILIKE '%' || $1 || '%' ORDER BY name LIMIT 5`,
      [artistArg.replace('spotify:artist:', '')]
    );
    if (!who.rowCount) { console.log(`[tanı] "${artistArg}" eşleşmedi.`); return; }
    if (who.rowCount > 1) {
      console.log('[tanı] Birden fazla eşleşme, ilki alınıyor:', who.rows.map(r => r.name).join(', '));
    }
    const a = who.rows[0];
    const uri = `spotify:artist:${a.artist_id}`;
    console.log(`\n=== ${a.name} (${a.artist_id})  album_only=${a.album_only}  active=${a.active}\n`);

    // 1) Günlük seri: 82M tek bir günün olayı mı, yoksa seviye mi?
    const seri = await client.query(
      `WITH ${SERI}
       SELECT recorded_date::text AS d,
              SUM(daily_gain)::bigint AS gun_kazanc,
              COUNT(*) FILTER (WHERE daily_gain IS NOT NULL) AS hareketli,
              COUNT(*) FILTER (WHERE gap > 1) AS bosluklu
       FROM kazanc GROUP BY recorded_date ORDER BY recorded_date DESC LIMIT $3`,
      [uri, a.artist_id, days]
    );
    console.log('--- Günlük toplam (o güne yazılan kazançlar)');
    for (const r of seri.rows) {
      console.log(`  ${r.d}   ${fmt(r.gun_kazanc).padStart(15)}   ${r.hareketli} şarkı` +
        (Number(r.bosluklu) ? `   (${r.bosluklu} tanesi 1 günden uzun aralıkla)` : ''));
    }

    // 2) Dashboard'un gördüğü headline: her başın EN SON kazancının toplamı.
    const head = await client.query(
      `WITH ${SERI}
       SELECT COALESCE(SUM(cumulative) FILTER (WHERE rn = 1), 0)::bigint AS toplam,
              COALESCE(SUM(daily_gain) FILTER (WHERE rn = 1), 0)::bigint AS daily,
              COUNT(*) FILTER (WHERE rn = 1) AS bas_sayisi,
              MAX(recorded_date) FILTER (WHERE rn = 1)::text AS son_tarih
       FROM kazanc`,
      [uri, a.artist_id]
    );
    const h = head.rows[0];
    console.log(`\n--- Dashboard headline (her başın en son kazancı toplanır)`);
    console.log(`  toplam: ${fmt(h.toplam)}   daily: ${fmt(h.daily)}   baş: ${h.bas_sayisi}   en son tarih: ${h.son_tarih}`);

    // 3) O daily'yi kim taşıyor? Sıçrama varsa en üstte durur.
    const katki = await client.query(
      `WITH ${SERI}
       SELECT k.head, s.title, s.is_featured, k.recorded_date::text AS d,
              k.cumulative::bigint, k.daily_gain::bigint, k.ham_fark::bigint, k.gap,
              ROUND(100.0 * k.ham_fark / NULLIF(k.cumulative - k.ham_fark, 0), 2) AS yuzde_zipla
       FROM kazanc k JOIN songs s ON s.id = k.head
       WHERE k.rn = 1 AND k.daily_gain IS NOT NULL
       ORDER BY k.daily_gain DESC LIMIT $3`,
      [uri, a.artist_id, top]
    );
    console.log(`\n--- Daily'ye en çok katkı veren ${katki.rowCount} baş`);
    for (const r of katki.rows) {
      const bayrak = [];
      if (Number(r.gap) > 1) bayrak.push(`GAP ${r.gap}g`);
      if (Number(r.yuzde_zipla) >= 20) bayrak.push(`+%${r.yuzde_zipla} SIÇRAMA`);
      console.log(`  ${fmt(r.daily_gain).padStart(12)}  ${String(r.d)}  ${fmt(r.cumulative).padStart(14)}  ` +
        `${r.is_featured ? 'feat' : 'lead'}  ${r.title}  (${r.head})${bayrak.length ? '   << ' + bayrak.join(' · ') : ''}`);
    }

    // 4) Son 7 günde değeri bir anda katlanan başlar — audit-duplicate-heads'in
    //    C deseninin bu sanatçıya daraltılmış hâli, eşiksiz.
    const zipla = await client.query(
      `WITH ${SERI}
       SELECT k.head, s.title, k.recorded_date::text AS d, k.ham_fark::bigint,
              (k.cumulative - k.ham_fark)::bigint AS oncesi, k.cumulative::bigint
       FROM kazanc k JOIN songs s ON s.id = k.head
       WHERE k.recorded_date > CURRENT_DATE - 8
         AND k.ham_fark > 1000000
         AND k.ham_fark > (k.cumulative - k.ham_fark) * 0.20
       ORDER BY k.ham_fark DESC LIMIT 20`,
      [uri, a.artist_id]
    );
    console.log(`\n--- Son 7 günde %20+ sıçrayan başlar: ${zipla.rowCount}`);
    for (const r of zipla.rows) {
      console.log(`  ${r.d}  ${fmt(r.oncesi)} → ${fmt(r.cumulative)}  (+${fmt(r.ham_fark)})  ${r.title}  (${r.head})`);
    }
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(e => { console.error('[tanı] HATA:', e.message); process.exit(1); });
