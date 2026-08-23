/**
 * audit-live-vs-stored.js — bizdeki değerleri Spotify'ın CANLI değeriyle
 * karşılaştırır. HİÇBİR ŞEY YAZMAZ.
 *
 *   node audit-live-vs-stored.js --artist=Justin --top=50
 *
 * "Toplam şişmiş mi?" sorusunun tek kesin cevabı bu: teori değil, satır satır
 * fark. Dashboard bir grubu üyelerinin MAX'i olarak sayıyor, o yüzden her grup
 * için MAX'i TAŞIYAN üyenin kendi sayfası okunuyor — grup değeri onun değeri.
 *
 * ŞİŞİK = bizdeki > Spotify. Sebebi ya çalınmış bir okuma (başka şarkının
 * sayısı bu satıra yazılmış) ya da Spotify'ın geri aldığı stream'ler.
 * GERİDE = bizdeki < Spotify; bu kayıp değil, sadece henüz yazılmamış.
 */
const { launchBrowser, fetchTrackPlaycount } = require('./spotify');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const arg = (n, d) => {
  const h = process.argv.slice(2).find(a => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const fmt = n => Number(n || 0).toLocaleString('en-US');

// Bir sanatçının kovası (JT hariç, server.js'teki artistBucketMatchSQL ile aynı).
// JT catch-all: izlenen başka hiçbir sanatçıya ait olmayan her şey.
const HEADS_SQL = `
  WITH kova AS (
    SELECT s.id, s.canonical_id
    FROM songs s
    WHERE s.id NOT IN (SELECT song_id FROM hidden_songs)
      AND CASE WHEN $1 = '31TPClRtHm23RisEBtV3X7'
        THEN s.primary_artist IS NULL OR s.primary_artist NOT IN (
               SELECT 'spotify:artist:' || artist_id FROM tracked_artists
                WHERE artist_id <> '31TPClRtHm23RisEBtV3X7')
        ELSE s.primary_artist = 'spotify:artist:' || $1
             OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $1)
      END
  ),
  grup AS (
    SELECT COALESCE(k.canonical_id, k.id) AS head,
           x.song_id, MAX(x.stream_count) AS val
    FROM kova k JOIN stream_stats x ON x.song_id = k.id
    GROUP BY 1, 2
  ),
  -- Grubun değeri = üyelerin MAX'i; onu TAŞIYAN üyeyi seç.
  en_yuksek AS (
    SELECT DISTINCT ON (head) head, song_id, val
    FROM grup ORDER BY head, val DESC
  )
  SELECT e.head, e.song_id, e.val::bigint, s.title
  FROM en_yuksek e
  JOIN songs s ON s.id = e.song_id
  WHERE s.id IN (SELECT id FROM kova WHERE canonical_id IS NULL)
     OR e.head IN (SELECT id FROM kova WHERE canonical_id IS NULL)
  ORDER BY e.val DESC LIMIT $2`;

async function main() {
  const who = arg('artist', 'Justin');
  const top = Number(arg('top', 50));
  const client = await getPool().connect();
  let browser, page;
  try {
    const a = (await client.query(
      `SELECT artist_id, name FROM tracked_artists
        WHERE artist_id = $1 OR name ILIKE '%' || $1 || '%' ORDER BY name LIMIT 1`,
      [who.replace('spotify:artist:', '')])).rows[0];
    if (!a) { console.log(`[audit] "${who}" eşleşmedi.`); return; }
    console.log(`\n=== ${a.name} — en büyük ${top} grup, canlı karşılaştırma\n`);

    const rows = (await client.query(HEADS_SQL, [a.artist_id, top])).rows;
    ({ browser, page } = await launchBrowser(process.env.SP_DC));

    let sisik = 0, sisikTop = 0, geride = 0, gerideTop = 0, okunamadi = 0;
    for (const r of rows) {
      const liveVal = await fetchTrackPlaycount(page, r.song_id);
      if (liveVal === null) { okunamadi++; console.log(`  ${'okunamadı'.padStart(14)}  ${r.title}`); continue; }
      const d = Number(r.val) - liveVal;
      if (d > 1000) {
        sisik++; sisikTop += d;
        console.log(`  ŞİŞİK  +${fmt(d).padStart(12)}   bizde ${fmt(r.val).padStart(14)}  Spotify ${fmt(liveVal).padStart(14)}  ${r.title}  (${r.song_id})`);
      } else if (d < -1000) {
        geride++; gerideTop += -d;
      }
    }
    console.log(`\n--- ${rows.length} grup okundu`);
    console.log(`  ŞİŞİK  : ${sisik} grup, toplam +${fmt(sisikTop)}`);
    console.log(`  geride : ${geride} grup, toplam ${fmt(gerideTop)} (kayıp değil, henüz yazılmamış)`);
    console.log(`  okunamadı: ${okunamadi}`);
    console.log(`\n  → net sapma: ${sisikTop - gerideTop > 0 ? '+' : ''}${fmt(sisikTop - gerideTop)}`);
  } finally {
    client.release();
    if (browser) await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error('[audit] HATA:', e.message); process.exit(1); });
