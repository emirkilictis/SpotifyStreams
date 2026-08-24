/**
 * verify-drop-candidates.js — bu gece kırpma NE yapardı, yapmadan önce göster.
 *
 *   node verify-drop-candidates.js                 # dry-run, tüm adaylar
 *   node verify-drop-candidates.js --apply         # gerçekten uygula
 *   node verify-drop-candidates.js <headId> ...    # yalnızca bu başlar
 *
 * Kırpma, bir toplamı sessizce düşürebilen tek mekanizma. Şimdiye kadar ne
 * yapacağını ancak yaptıktan SONRA görebiliyorduk: "Give It To Me" 2026-08-24
 * gecesi 1,189,826 kaybetti ve bunu ertesi gün sayfada fark ettik.
 *
 * Burada çalışan şey gerçek reconcileStreamDrops'un ta kendisi — kopyası değil,
 * aynı fonksiyon, aynı canlı doğrulama. --apply yoksa işlem ROLLBACK edilir,
 * yani kararı görürsün ama veri kıpırdamaz.
 */
const { launchBrowser, fetchTrackPlaycount } = require('./spotify');
const { getPool, reconcileStreamDrops, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const heads = new Set(args.filter(a => !a.startsWith('--')));

  const client = await getPool().connect();
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  try {
    await client.query('BEGIN');
    const applied = await reconcileStreamDrops(client, {
      onlyHeads: heads,
      verify: async (songIds) => {
        const out = new Map();
        for (const id of songIds) {
          try { out.set(id, await fetchTrackPlaycount(page, id)); }
          catch (e) { console.warn(`[verify] ${id} okunamadı: ${e.message}`); out.set(id, null); }
        }
        return out;
      },
    });
    if (applied.length) {
      console.log(`\n--- kırpılacak ${applied.length} baş`);
      for (const a of applied) {
        console.log(`  ${a.head}: ${a.oldCount.toLocaleString('en-US')} → ${a.newCount.toLocaleString('en-US')}  (−${a.drop.toLocaleString('en-US')})`);
      }
    } else {
      console.log('\nKırpılacak baş yok.');
    }
    if (apply) { await client.query('COMMIT'); console.log('\n[verify] UYGULANDI.'); }
    else { await client.query('ROLLBACK'); console.log('\n(dry-run — yazmak için --apply)'); }
  } finally {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
