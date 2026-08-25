/**
 * bench-agg.js — panonun ağır sorgusu ne kadar sürüyor, ve bunun ne kadarı
 * benim eklediğim adım-yayma?
 *
 * "Site yavaş" tek başına bir teşhis değil: gecikme üç yerden gelebilir —
 * Render'ın uykudan uyanması, Postgres'in sorguyu çalıştırması, ya da sorgunun
 * kendisinin pahalılaşması. Bu betik ortadakini ölçer ve üçüncüsünü A/B yapar:
 * ŞU ANKİ CTE ile adım-yayma ÖNCESİ CTE aynı veriye karşı yan yana koşuyor.
 *
 *   DATABASE_URL=... node scripts/bench-agg.js [artistId...]
 */
const { artistLatestAggCTE } = require('../lib/agg-sql');
const { Pool } = require('pg');

// Adım-yayma öncesi aritmetik (877870d). Kıyas için birebir kopya.
function oldAggCTE(songFilter) {
  return `
      agg_scope AS (
        SELECT DISTINCT COALESCE(s.canonical_id, s.id) AS canonical_id
        FROM songs s LEFT JOIN albums a ON s.album_id = a.id
        WHERE ${songFilter}
      ),
      agg_cs AS (
        SELECT COALESCE(s2.canonical_id, s2.id) AS canonical_id, ss.recorded_date,
               MAX(ss.stream_count) AS stream_count
        FROM stream_stats ss JOIN songs s2 ON s2.id = ss.song_id
        WHERE COALESCE(s2.canonical_id, s2.id) IN (SELECT canonical_id FROM agg_scope)
        GROUP BY 1, 2
      ),
      agg_runmax AS (
        SELECT canonical_id, recorded_date, stream_count,
               MAX(stream_count) OVER (
                 PARTITION BY canonical_id ORDER BY recorded_date
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cumulative
        FROM agg_cs
      ),
      agg_gains AS (
        SELECT canonical_id, recorded_date, cumulative,
               (cumulative - LAG(cumulative) OVER w)
                 / NULLIF(recorded_date - LAG(recorded_date) OVER w, 0) AS daily_gain,
               (stream_count - LAG(stream_count) OVER w)::bigint AS real_change,
               ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY recorded_date DESC) AS rn
        FROM agg_runmax
        WINDOW w AS (PARTITION BY canonical_id ORDER BY recorded_date)
      ),
      agg_days AS (
        SELECT recorded_date, COUNT(*) AS heads FROM agg_gains
        WHERE daily_gain IS NOT NULL GROUP BY recorded_date
      ),
      agg_day AS (
        SELECT recorded_date FROM agg_days
        WHERE heads >= GREATEST((SELECT MAX(heads) FROM agg_days) / 4, 1)
        ORDER BY recorded_date DESC LIMIT 1
      ),
      agg AS (
        SELECT canonical_id,
               MAX(cumulative) FILTER (WHERE rn = 1) AS cumulative,
               MAX(daily_gain) FILTER (
                 WHERE recorded_date = (SELECT recorded_date FROM agg_day)
               ) AS day_gain
        FROM agg_gains GROUP BY canonical_id
      )`;
}

const BUCKET = `(
  CASE WHEN $2 = '31TPClRtHm23RisEBtV3X7'
    THEN s.primary_artist IS NULL OR s.primary_artist NOT IN (
           SELECT 'spotify:artist:' || artist_id FROM tracked_artists
            WHERE artist_id <> '31TPClRtHm23RisEBtV3X7')
    ELSE s.primary_artist = $1
         OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2)
  END)`;

const FILTER = `s.canonical_id IS NULL AND ${BUCKET}
      AND s.id NOT IN (SELECT song_id FROM hidden_songs)`;

const body = (cte) => `
  WITH ${cte(FILTER)}
  SELECT COALESCE(SUM(dsc.cumulative), 0)::bigint AS total,
         COALESCE(SUM(dsc.day_gain), 0)::bigint   AS daily,
         COUNT(*)::int                            AS heads
  FROM agg dsc
  JOIN songs s ON s.id = dsc.canonical_id
  JOIN albums a ON s.album_id = a.id
  WHERE ${FILTER}`;

async function timeIt(pool, sql, params, n = 3) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    await pool.query(sql, params);
    ms.push(Date.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { min: ms[0], med: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL yok.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const artists = ids.length ? ids : ['31TPClRtHm23RisEBtV3X7', '4kYSro6naA4h99UJvo89HB'];

  console.log('\n=== agg CTE — su anki vs adim-yayma oncesi  (3 kosu, ms)\n');
  for (const id of artists) {
    const p = [`spotify:artist:${id}`, id];
    const yeni = await timeIt(pool, body(artistLatestAggCTE), p);
    const eski = await timeIt(pool, body(oldAggCTE), p);
    const fark = yeni.med - eski.med;
    console.log(`  ${id}`);
    console.log(`     su anki : min ${yeni.min}  med ${yeni.med}  max ${yeni.max}`);
    console.log(`     oncesi  : min ${eski.min}  med ${eski.med}  max ${eski.max}`);
    console.log(`     → adim-yayma medyanda ${fark >= 0 ? '+' : ''}${fark} ms\n`);
  }

  // Tablo boyutu: sorgunun neyi taradigi.
  const boyut = await pool.query(`
    SELECT (SELECT COUNT(*) FROM stream_stats)::bigint AS satir,
           (SELECT COUNT(*) FROM songs)::bigint        AS sarki,
           pg_size_pretty(pg_total_relation_size('stream_stats')) AS boyut`);
  const b = boyut.rows[0];
  console.log(`  stream_stats: ${Number(b.satir).toLocaleString('en-US')} satir, ${b.boyut} · songs: ${Number(b.sarki).toLocaleString('en-US')}`);

  // En pahali dugum hangisi?
  const plan = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${body(artistLatestAggCTE)}`,
    [`spotify:artist:${artists[0]}`, artists[0]]
  );
  const root = plan.rows[0]['QUERY PLAN'][0];
  console.log(`\n  plan: ${root['Execution Time'].toFixed(0)} ms calisma, ${root['Planning Time'].toFixed(0)} ms planlama`);
  const dugumler = [];
  (function gez(n, d) {
    dugumler.push({ tip: n['Node Type'], rel: n['Relation Name'] || '', ms: n['Actual Total Time'], satir: n['Actual Rows'], d });
    (n.Plans || []).forEach(c => gez(c, d + 1));
  })(root.Plan, 0);
  dugumler.sort((x, y) => y.ms - x.ms);
  console.log('  en pahali dugumler:');
  for (const n of dugumler.slice(0, 6)) {
    console.log(`     ${String(n.ms.toFixed(0)).padStart(7)} ms  ${String(n.satir).padStart(9)} satir  ${n.tip}${n.rel ? ' ' + n.rel : ''}`);
  }

  await pool.end();
}

main().catch(e => { console.error('[bench] HATA:', e.message); process.exit(1); });
