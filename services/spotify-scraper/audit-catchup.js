/**
 * audit-catchup.js — bir günün günlük kazancının ne kadarı O GÜN kazanıldı,
 * ne kadarı donmuş bir değerin geri gelmesi? HİÇBİR ŞEY YAZMAZ.
 *
 *   node audit-catchup.js --artist=31TPClRtHm23RisEBtV3X7
 *
 * Donmuş bir şarkı gerçek değerine döndüğünde, günlerdir biriken artışın tamamı
 * tek güne düşer: tarih boşluğu olmadığı için daily_gain'in gün farkına bölme
 * kuralı devreye girmez. Toplam doğrudur, ama o günün günlüğü şişer.
 *
 * İki kaynağı ayırıyor:
 *   KIRPMA  — stream_drop_corrections'ta bugün yazılmış bir düzeltme var ve
 *             değer o düzeltmenin öncesine dönmüş. Geri gelen fark bu.
 *   DONMA   — düzeltme yok ama şarkı önceki günlerde hiç kıpırdamamış; bugünkü
 *             kazanç o durgun günlerin birikimi.
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const arg = (n, d) => {
  const h = process.argv.slice(2).find(a => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const fmt = n => Number(n || 0).toLocaleString('en-US');

const SQL = `
  WITH kova AS (
    SELECT s.id, s.canonical_id FROM songs s
    WHERE s.id NOT IN (SELECT song_id FROM hidden_songs)
      AND CASE WHEN $1 = '31TPClRtHm23RisEBtV3X7'
        THEN s.primary_artist IS NULL OR s.primary_artist NOT IN (
               SELECT 'spotify:artist:' || artist_id FROM tracked_artists
                WHERE artist_id <> '31TPClRtHm23RisEBtV3X7')
        ELSE s.primary_artist = 'spotify:artist:' || $1
             OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $1)
      END
  ),
  gun AS (
    SELECT COALESCE(k.canonical_id, k.id) AS head, x.recorded_date,
           MAX(x.stream_count) AS sc
    FROM kova k JOIN stream_stats x ON x.song_id = k.id
    GROUP BY 1, 2
  ),
  runmax AS (
    SELECT head, recorded_date,
           MAX(sc) OVER (PARTITION BY head ORDER BY recorded_date
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum
    FROM gun
  ),
  kazanc AS (
    SELECT head, recorded_date, cum,
           cum - LAG(cum) OVER w AS fark,
           -- Bugünden önceki 4 günde hiç hareket etmemiş mi?
           cum - LAG(cum, 5) OVER w AS onceki5,
           LAG(cum) OVER w - LAG(cum, 5) OVER w AS oncekiDortGun,
           ROW_NUMBER() OVER (PARTITION BY head ORDER BY recorded_date DESC) AS rn
    FROM runmax WINDOW w AS (PARTITION BY head ORDER BY recorded_date)
  )
  SELECT k.head, s.title, k.recorded_date::text AS d, k.fark::bigint,
         k.oncekiDortGun::bigint AS onceki_dort_gun,
         c.old_count::bigint, c.new_count::bigint, k.cum::bigint
  FROM kazanc k
  JOIN songs s ON s.id = k.head
  -- Bas basina TEK satir. Duz bir LEFT JOIN, ayni basa bugun birden fazla
  -- duzeltme yazilmissa o basi o kadar kez sayiyor ve toplami sisiriyor.
  LEFT JOIN (
    SELECT head_id, MAX(old_count) AS old_count, MIN(new_count) AS new_count
    FROM stream_drop_corrections WHERE applied_on = CURRENT_DATE
    GROUP BY head_id
  ) c ON c.head_id = k.head
  WHERE k.rn = 1 AND k.fark > 0
  ORDER BY k.fark DESC`;

async function main() {
  const artist = arg('artist', '31TPClRtHm23RisEBtV3X7').replace('spotify:artist:', '');
  const client = await getPool().connect();
  try {
    const rows = (await client.query(SQL, [artist])).rows;
    if (!rows.length) { console.log('[catchup] Kazanç satırı yok.'); return; }

    let toplam = 0, kirpma = 0, donma = 0;
    const kirpmaSatir = [], donmaSatir = [];
    for (const r of rows) {
      const fark = Number(r.fark);
      toplam += fark;
      // KIRPMA: bugün bir düzeltme yazılmış ve değer düzeltme öncesine dönmüş.
      if (r.old_count && Number(r.cum) >= Number(r.old_count)) {
        const geri = Math.min(Number(r.old_count) - Number(r.new_count), fark);
        if (geri > 0) { kirpma += geri; kirpmaSatir.push([geri, r.title]); continue; }
      }
      // DONMA: önceki dört gün hiç hareket yok ama bugün var.
      if (Number(r.onceki_dort_gun) === 0 && fark > 0) {
        donma += fark; donmaSatir.push([fark, r.title]);
      }
    }
    console.log(`\n=== ${artist} — ${rows[0].d} günlük kazancının kaynağı\n`);
    console.log(`  toplam günlük        : ${fmt(toplam)}`);
    console.log(`  bunun kırpma geri dönüşü : ${fmt(kirpma)}   (${kirpmaSatir.length} şarkı)`);
    console.log(`  bunun donma birikimi     : ${fmt(donma)}   (${donmaSatir.length} şarkı)`);
    console.log(`  → O GÜN gerçekten kazanılan: ${fmt(toplam - kirpma - donma)}`);
    const bas = (t, arr) => {
      if (!arr.length) return;
      console.log(`\n--- ${t}`);
      arr.sort((a, b) => b[0] - a[0]).slice(0, 15)
         .forEach(([v, t2]) => console.log(`  ${fmt(v).padStart(12)}  ${t2}`));
    };
    bas('kırpma geri dönüşü', kirpmaSatir);
    bas('donma birikimi', donmaSatir);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(e => { console.error('[catchup] HATA:', e.message); process.exit(1); });
