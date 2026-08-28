/**
 * diagnose-catalogue.js — bir sanatcinin kataloğunun ne kadarini gercekten
 * tariyoruz?
 *
 * "Kworb'dan 300 parca gerideyiz" iki ayri sey olabilir ve ikisinin cozumu
 * farkli: sarkiyi HIC KESFETMEMIS olabiliriz (kesif eksik), ya da kesfedip
 * hic okumamis olabiliriz (tarama eksik). Bu betik ikisini ayirir.
 *
 * Ayrica taramanin "bu sanatci bugun tamamlandi" kararini nasil verdigini
 * gosterir: artistsWithTodaysData YALNIZCA primary_artist = sanatci olan
 * satirlari sayiyor. Bir sanatcinin feature'lari baskasinin primary'sinde
 * durdugu icin bu kapi onlari HIC gormuyor.
 *
 *   DATABASE_URL=... node diagnose-catalogue.js "ariana" "anitta"
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const fmt = n => Number(n || 0).toLocaleString('en-US');

async function main() {
  const isimler = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!isimler.length) { console.error('Kullanim: node diagnose-catalogue.js "<isim parcasi>" ...'); process.exit(1); }
  const client = await getPool().connect();
  try {
    for (const isim of isimler) {
      const a = await client.query(
        `SELECT artist_id, name FROM tracked_artists
          WHERE LOWER(name) LIKE '%' || LOWER($1) || '%' LIMIT 1`, [isim]);
      if (!a.rows.length) { console.log(`\n[!] "${isim}" tracked_artists'ta yok.`); continue; }
      const { artist_id: id, name } = a.rows[0];
      const uri = `spotify:artist:${id}`;
      console.log(`\n=== ${name}  (${id})`);

      // Kesfedilen sarkilar: kendi primary'si olanlar + baskasinin albuminde
      // olup ona atfedilenler. Ikinci grup tam da kapinin goremedigi grup.
      const s = await client.query(`
        WITH bugun AS (
          SELECT ((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date AS d
        ),
        kapsam AS (
          SELECT s.id, s.is_featured, s.primary_artist
          FROM songs s
          WHERE s.primary_artist = $1
             OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2)
        )
        SELECT
          (SELECT COUNT(*) FROM kapsam)                                        AS toplam,
          (SELECT COUNT(*) FROM kapsam WHERE NOT is_featured)                  AS kendi,
          (SELECT COUNT(*) FROM kapsam WHERE is_featured)                      AS feature,
          (SELECT COUNT(*) FROM kapsam k
             WHERE NOT EXISTS (SELECT 1 FROM stream_stats ss WHERE ss.song_id = k.id))  AS hic_okunmamis,
          (SELECT COUNT(*) FROM kapsam k
             WHERE EXISTS (SELECT 1 FROM stream_stats ss, bugun b
                            WHERE ss.song_id = k.id AND ss.recorded_date = b.d))        AS bugun_okunan,
          (SELECT COUNT(DISTINCT canon) FROM (
             SELECT COALESCE(s2.canonical_id, s2.id) AS canon FROM songs s2
             WHERE s2.id IN (SELECT id FROM kapsam)) q)                        AS bas
      `, [uri, id]);
      const r = s.rows[0];
      console.log(`  kesfedilen sarki : ${fmt(r.toplam)}   (kendi ${fmt(r.kendi)} · feature ${fmt(r.feature)})`);
      console.log(`  tekil bas        : ${fmt(r.bas)}`);
      console.log(`  hic okunmamis    : ${fmt(r.hic_okunmamis)}   ← kesfedilmis ama playcount'u hic alinmamis`);
      console.log(`  bugun okunan     : ${fmt(r.bugun_okunan)}`);

      // Kapinin gordugu sey: SADECE primary_artist = sanatci.
      const g = await client.query(`
        WITH b AS (SELECT ((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date AS d),
        mine AS (
          SELECT ss.recorded_date FROM stream_stats ss
          JOIN songs s ON s.id = ss.song_id WHERE s.primary_artist = $1
        ),
        prev AS (SELECT MAX(recorded_date) AS pd FROM mine, b WHERE recorded_date < b.d)
        SELECT (SELECT COUNT(*) FROM mine, b WHERE recorded_date = b.d)       AS bugun,
               (SELECT COUNT(*) FROM mine, prev WHERE recorded_date = prev.pd) AS onceki
      `, [uri]);
      const bugun = Number(g.rows[0].bugun), onceki = Number(g.rows[0].onceki);
      const tamam = bugun > 0 && bugun >= onceki;
      console.log(`  kapinin gordugu  : bugun ${fmt(bugun)} · onceki gun ${fmt(onceki)}  → "${tamam ? 'TAMAMLANDI, atla' : 'eksik, tara'}"`);
      if (tamam && Number(r.hic_okunmamis) > 0) {
        console.log(`  ⚠ kapi TAMAMLANDI diyor ama ${fmt(r.hic_okunmamis)} sarki hic okunmamis.`);
      }

      // Albumler: kesfedilmis ama hic sarkisi okunmamis olanlar
      const al = await client.query(`
        SELECT al.id, al.title, COUNT(s.id) AS sarki,
               COUNT(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM stream_stats ss WHERE ss.song_id = s.id)) AS okunmamis
        FROM albums al JOIN songs s ON s.album_id = al.id
        WHERE s.primary_artist = $1 OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2)
        GROUP BY al.id, al.title
        HAVING COUNT(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM stream_stats ss WHERE ss.song_id = s.id)) > 0
        ORDER BY 4 DESC LIMIT 12`, [uri, id]);
      if (al.rows.length) {
        console.log(`  --- icinde hic okunmamis sarki olan albumler (ilk ${al.rows.length})`);
        for (const x of al.rows) console.log(`      ${String(x.okunmamis).padStart(3)}/${String(x.sarki).padStart(3)}  ${x.title}`);
      }
    }
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(e => { console.error('[katalog] HATA:', e.message); process.exit(1); });
