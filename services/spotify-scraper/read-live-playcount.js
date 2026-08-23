/**
 * read-live-playcount.js — bir şarkının Spotify'daki CANLI playcount'unu okur
 * ve bizdekiyle karşılaştırır. HİÇBİR ŞEY YAZMAZ.
 *
 *   node read-live-playcount.js <trackId> [<trackId> ...]
 *   node read-live-playcount.js --title='Not a Bad Thing'
 *
 * Bir değerin bozuk olduğundan şüphelenildiğinde tek kesin cevap Spotify'ın
 * kendisi. fetchTrackPlaycount ŞARKININ KENDİ sayfasını okuduğu için albüm
 * sayfası bayat ya da okunamaz olsa bile cevap verir.
 */
const { launchBrowser, fetchTrackPlaycount } = require('./spotify');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const fmt = n => Number(n || 0).toLocaleString('en-US');
const titleArg = process.argv.slice(2).find(a => a.startsWith('--title='));
const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));

async function main() {
  const client = await getPool().connect();
  let browser, page;
  try {
    let rows = [];
    if (titleArg) {
      const t = titleArg.split('=').slice(1).join('=');
      rows = (await client.query(
        `SELECT s.id, s.title, (SELECT MAX(stream_count) FROM stream_stats x WHERE x.song_id = s.id) AS stored,
                (SELECT MAX(recorded_date) FROM stream_stats x WHERE x.song_id = s.id)::text AS son
           FROM songs s WHERE s.title ILIKE '%' || $1 || '%' ORDER BY 3 DESC NULLS LAST LIMIT 8`, [t])).rows;
    }
    if (ids.length) {
      rows = rows.concat((await client.query(
        `SELECT s.id, s.title, (SELECT MAX(stream_count) FROM stream_stats x WHERE x.song_id = s.id) AS stored,
                (SELECT MAX(recorded_date) FROM stream_stats x WHERE x.song_id = s.id)::text AS son
           FROM songs s WHERE s.id = ANY($1)`, [ids])).rows);
    }
    if (!rows.length) { console.log('[canlı] Eşleşen şarkı yok.'); return; }

    ({ browser, page } = await launchBrowser(process.env.SP_DC));
    for (const r of rows) {
      const live = await fetchTrackPlaycount(page, r.id);
      const stored = Number(r.stored) || 0;
      if (live === null) { console.log(`  ${r.title}  (${r.id})  → okunamadı`); continue; }
      const fark = live - stored;
      console.log(`  ${r.title}  (${r.id})  son snapshot ${r.son}`);
      console.log(`      bizde: ${fmt(stored)}   Spotify: ${fmt(live)}   fark: ${fark > 0 ? '+' : ''}${fmt(fark)}` +
        (stored > 0 && live < stored * 0.9 ? '   << BİZDEKİ DEĞER SPOTIFY’DAN BELİRGİN YÜKSEK' : ''));
    }
  } finally {
    client.release();
    if (browser) await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error('[canlı] HATA:', e.message); process.exit(1); });
