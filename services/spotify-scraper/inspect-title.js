/**
 * inspect-title.js — bir başlığın altındaki BÜTÜN satırları ve nasıl
 * gruplandıklarını gösterir. HİÇBİR ŞEY YAZMAZ (yalnızca SELECT + canlı okuma).
 *
 *   node inspect-title.js 'until the end of time'
 *   node inspect-title.js --live 'until the end of time'
 *
 * İki şarkının tek sayılması stream KAYBEDER: grup değeri üyelerin MAX'i, yani
 * küçük olanın kendi stream'leri toplama hiç girmez. Spotify iki kaydı bir süre
 * aynı playcount'la sunup sonra ayırdığında tam bu olur — ayrım bizde
 * kendiliğinden geri gelmez, çünkü manual_merges kuralı dedup'ın her turda
 * yeniden kurduğu hesabın ÜSTÜNE yazılıyor.
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const live = process.argv.includes('--live');
const histArg = process.argv.slice(2).find(a => a.startsWith('--history='));
const hist = histArg ? Number(histArg.split('=')[1]) : 0;
const q = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ');
const fmt = n => Number(n || 0).toLocaleString('en-US');

async function main() {
  if (!q) { console.error("Kullanım: node inspect-title.js [--live] '<başlık parçası>'"); process.exit(1); }
  const client = await getPool().connect();
  let browser, page;
  try {
    const rows = (await client.query(
      `SELECT s.id, s.title, s.canonical_id, s.is_featured, s.primary_artist,
              al.title AS album,
              (SELECT MAX(stream_count) FROM stream_stats x WHERE x.song_id = s.id) AS val,
              (SELECT MAX(recorded_date) FROM stream_stats x WHERE x.song_id = s.id)::text AS son
         FROM songs s LEFT JOIN albums al ON al.id = s.album_id
        WHERE s.title ILIKE '%' || $1 || '%'
        ORDER BY val DESC NULLS LAST`, [q])).rows;

    console.log(`\n=== "${q}" — ${rows.length} satır\n`);
    const heads = new Set();
    for (const r of rows) {
      const head = r.canonical_id || r.id;
      heads.add(head);
      console.log(`  ${fmt(r.val).padStart(14)}  ${r.canonical_id ? 'alias→' + r.canonical_id : 'BAŞ   '}  ${r.son}  ${r.is_featured ? 'feat' : 'lead'}  ${r.title}`);
      console.log(`                  ${r.id}  ${r.album || '(albümsüz)'}`);
    }

    // Grup toplamları: her baş kaç sayılıyor.
    const grup = (await client.query(
      `SELECT COALESCE(s.canonical_id, s.id) AS head,
              (SELECT title FROM songs h WHERE h.id = COALESCE(s.canonical_id, s.id)) AS head_title,
              MAX(x.stream_count) AS grup_degeri,
              COUNT(DISTINCT s.id) AS uye
         FROM songs s JOIN stream_stats x ON x.song_id = s.id
        WHERE COALESCE(s.canonical_id, s.id) = ANY($1)
        GROUP BY 1, 2 ORDER BY 3 DESC`, [[...heads]])).rows;
    console.log(`\n--- Gruplar (dashboard bunları sayıyor)`);
    let toplam = 0;
    for (const g of grup) {
      toplam += Number(g.grup_degeri);
      console.log(`  ${fmt(g.grup_degeri).padStart(14)}  ${g.uye} üye  ${g.head_title}  (${g.head})`);
    }
    console.log(`  ${'='.repeat(14)}\n  ${fmt(toplam).padStart(14)}  toplam sayılan`);

    // Bu id'lere dokunan kalıcı kurallar. Dedup'ın en son uyguladığı şey bunlar,
    // yani Spotify ayırsa bile kendiliğinden çözülmezler.
    const ids = rows.map(r => r.id);
    for (const tbl of ['manual_merges', 'manual_splits']) {
      try {
        const m = (await client.query(
          `SELECT * FROM ${tbl} WHERE alias_id = ANY($1) OR canonical_id = ANY($1)`, [ids])).rows;
        console.log(`\n--- ${tbl}: ${m.length}`);
        for (const x of m) console.log(`  ${JSON.stringify(x)}`);
      } catch (e) { console.log(`\n--- ${tbl}: okunamadı (${e.message})`); }
    }

    // Son N gun: grubun degeri gunden gune ne yapmis. Daily "-" gorunuyorsa
    // cevap burada — deger kipirdamamissa gunluk kazanc sifirdir.
    if (hist) {
      console.log(`\n--- Gruplarin son ${hist} gunu (deger = uyelerin MAX'i)`);
      for (const g of grup) {
        const h = (await client.query(
          `SELECT x.recorded_date::text AS d, MAX(x.stream_count)::bigint AS v
             FROM stream_stats x JOIN songs s ON s.id = x.song_id
            WHERE COALESCE(s.canonical_id, s.id) = $1
            GROUP BY 1 ORDER BY 1 DESC LIMIT $2`, [g.head, hist])).rows;
        console.log(`  ${g.head_title}`);
        let onceki = null;
        for (const r of h.slice().reverse()) {
          const fark = onceki === null ? null : Number(r.v) - onceki;
          console.log(`      ${r.d}  ${fmt(r.v).padStart(14)}` +
            (fark === null ? '' : `   ${fark > 0 ? '+' : ''}${fmt(fark)}`));
          onceki = Number(r.v);
        }
      }
    }

    if (live) {
      const { launchBrowser, fetchTrackPlaycount } = require('./spotify');
      ({ browser, page } = await launchBrowser(process.env.SP_DC));
      console.log(`\n--- Spotify şu an ne diyor`);
      for (const r of rows) {
        const pc = await fetchTrackPlaycount(page, r.id);
        console.log(`  ${pc === null ? 'okunamadı'.padStart(14) : fmt(pc).padStart(14)}  bizde ${fmt(r.val).padStart(14)}  ${r.title}`);
      }
    }
  } finally {
    client.release();
    if (browser) await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error('[inspect] HATA:', e.message); process.exit(1); });
