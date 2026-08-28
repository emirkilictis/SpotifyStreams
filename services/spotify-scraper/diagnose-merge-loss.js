/**
 * diagnose-merge-loss.js — birlestirme yuzunden toplama GIRMEYEN stream'ler.
 *
 * Bir grup uyelerinin MAX'i olarak sayiliyor. Iki uye ayni kaydin ayni
 * playcount'unu tasiyorsa bu dogru: tek sayilmalari gerekir. Ama uyelerin
 * FARKLI playcount'lari varsa bunlar Spotify'da ayri ayri dinlenmis ayri
 * kayitlardir ve kucuk olanin butun stream'leri toplama hic ulasmaz.
 *
 * Kworb bunlari ayri satir sayar ve cifte saymaz — cunku her track id'nin
 * kendi playcount'u var. Yani aradaki fark "tasarim" degil, kayip.
 *
 * Bu betik ikisini AYIRIR:
 *   esit uye    → ayni sayi, dogru birlestirilmis, kayip yok
 *   farkli uye  → ayri sayi, kucuk olan toplama girmiyor  ← kayip burada
 *
 *   DATABASE_URL=... node diagnose-merge-loss.js <artistId> [...]
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const fmt = n => Number(n || 0).toLocaleString('en-US');

const SQL = `
WITH kapsam AS (
  SELECT s.id, COALESCE(s.canonical_id, s.id) AS bas, s.title
  FROM songs s
  WHERE (s.primary_artist = $1 OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2))
    AND s.id NOT IN (SELECT song_id FROM hidden_songs)
),
son AS (
  SELECT DISTINCT ON (ss.song_id) ss.song_id, ss.stream_count
  FROM stream_stats ss
  WHERE ss.song_id IN (SELECT id FROM kapsam)
  ORDER BY ss.song_id, ss.recorded_date DESC
),
uye AS (
  SELECT k.bas, k.id, k.title, COALESCE(son.stream_count, 0)::bigint AS sayi
  FROM kapsam k LEFT JOIN son ON son.song_id = k.id
),
grup AS (
  SELECT bas, MAX(sayi) AS tepe, COUNT(*) AS uye_sayisi FROM uye GROUP BY bas
)
SELECT u.bas, g.tepe, g.uye_sayisi, u.id, u.title, u.sayi
FROM uye u JOIN grup g ON g.bas = u.bas
WHERE g.uye_sayisi > 1
ORDER BY g.tepe DESC, u.sayi DESC`;

async function main() {
  const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!ids.length) { console.error('Kullanim: node diagnose-merge-loss.js <artistId> ...'); process.exit(1); }
  const client = await getPool().connect();
  try {
    for (const id of ids) {
      const nm = await client.query(`SELECT name FROM tracked_artists WHERE artist_id = $1`, [id]);
      const { rows } = await client.query(SQL, [`spotify:artist:${id}`, id]);
      const gruplar = new Map();
      for (const r of rows) {
        if (!gruplar.has(r.bas)) gruplar.set(r.bas, { tepe: Number(r.tepe), uyeler: [] });
        gruplar.get(r.bas).uyeler.push({ id: r.id, title: r.title, sayi: Number(r.sayi) });
      }
      let esit = 0, farkli = 0, kayip = 0, sifir = 0;
      const liste = [];
      for (const [bas, g] of gruplar) {
        let grupKayip = 0;
        for (const u of g.uyeler) {
          if (u.sayi === g.tepe) { esit++; continue; }
          if (u.sayi === 0) { sifir++; continue; }   // hic okunmamis: kayip diyemeyiz
          farkli++; kayip += u.sayi; grupKayip += u.sayi;
        }
        if (grupKayip > 0) liste.push({ bas, tepe: g.tepe, grupKayip, uyeler: g.uyeler });
      }
      liste.sort((a, b) => b.grupKayip - a.grupKayip);
      console.log(`\n=== ${nm.rows[0]?.name || id}`);
      console.log(`  birden fazla uyeli grup : ${fmt(gruplar.size)}`);
      console.log(`  tepe ile AYNI sayidaki uye : ${fmt(esit)}   (dogru birlestirilmis, kayip yok)`);
      console.log(`  FARKLI sayidaki uye        : ${fmt(farkli)}   ← bunlarin stream'i toplama girmiyor`);
      console.log(`  hic okunmamis uye          : ${fmt(sifir)}`);
      console.log(`  TOPLAMA GIRMEYEN STREAM    : ${fmt(kayip)}`);
      console.log(`  --- en cok kaybettiren ${Math.min(10, liste.length)} grup`);
      for (const g of liste.slice(0, 10)) {
        console.log(`      -${fmt(g.grupKayip).padStart(13)}   grup tepesi ${fmt(g.tepe)}`);
        for (const u of g.uyeler.slice(0, 6)) {
          const im = u.sayi === g.tepe ? 'TEPE  ' : (u.sayi === 0 ? 'okunmamis' : 'ayri  ');
          console.log(`          ${im} ${fmt(u.sayi).padStart(13)}  ${u.title}  (${u.id})`);
        }
        if (g.uyeler.length > 6) console.log(`          ... ${g.uyeler.length - 6} uye daha`);
      }
    }
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(e => { console.error('[kayip] HATA:', e.message); process.exit(1); });
