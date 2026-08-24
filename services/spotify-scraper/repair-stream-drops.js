/**
 * repair-stream-drops.js — Spotify'ın GERİ ALDIĞI stream'leri siteye yansıtır.
 *
 * Normal akışta bu iş kendiliğinden yürür: scraper düşük gelen playcount'u
 * stream_observations'a yazar, aynı düşüş ikinci bir tarama gününde de
 * görülürse reconcileStreamDrops() geçmişi tıraşlayıp gerçek değeri yazar.
 *
 * Bu araç o döngüyü beklemek istemediğin durum için: verilen track'lerin
 * playcount'unu Spotify'dan CANLI okur, gözlem olarak kaydeder ve düzeltmeyi
 * tek gözlemle uygular (canlı okuma zaten teyidin kendisi).
 *
 *   node repair-stream-drops.js <trackId> [trackId...]         # dry-run
 *   node repair-stream-drops.js --apply <trackId> [trackId...]  # yaz
 *   node repair-stream-drops.js --apply --force <trackId>       # oran korumasını atla
 *   node repair-stream-drops.js --apply --only-listed <trackId>  # yalnızca bu id'yi tıraşla
 *
 * Düzeltme HER ZAMAN yalnızca komut satırında verilen track'lerin başlarına
 * uygulanır. --only-listed ayrıca tıraşlamayı ailenin tamamı yerine yalnızca
 * verilen id'lerle sınırlar: ailede doğru değeri taşıyan bir üye varsa şart.
 *
 * Okuma ŞARKININ KENDİ sayfasından yapılır: bizdeki değerin bozuk olduğu
 * durumlarda bozan şey çoğu zaman albüm sayfasının kendisi oluyor, onu tekrar
 * okumak aynı bozuk sayıyı geri getirir.
 *
 * --force yalnızca komut satırında ADIYLA verilen track'lerin başına, yalnızca
 * o çalıştırma için %25 düşüş korumasını kapatır. Koruma normalde doğru:
 * büyük bir düşüş genellikle CANLI okumanın bozuk olduğunu gösterir. Tersinin
 * kanıtlandığı durumda kullanılır — Cardi B'nin "Never Lose Me"si bir günde
 * 113,8M'den 190,7M'ye sıçrayıp orada dondu ve şarkının kendi sayfası 114,2M
 * diyordu; düzeltmesi %40 olduğu için koruma reddediyor, hayalet duruyordu.
 * Kullanmadan önce canlı değeri gözünle doğrula (read-live-playcount.js).
 */
const { launchBrowser, fetchAlbumTracks, fetchTrackPlaycount } = require('./spotify');
const { getPool, reconcileStreamDrops, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const force = args.includes('--force');
  const onlyListed = args.includes('--only-listed');
  const trackIds = args.filter(a => !a.startsWith('--'));
  if (!trackIds.length) {
    console.error('Kullanım: node repair-stream-drops.js [--apply] <trackId> [trackId...]');
    process.exit(1);
  }

  const client = await getPool().connect();
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  try {
    // Track -> albüm: playcount albüm sayfasından okunuyor (fetchAlbumTracks).
    const meta = await client.query(
      `SELECT s.id, s.title, s.album_id, COALESCE(s.canonical_id, s.id) AS head,
              (SELECT MAX(ss.stream_count) FROM stream_stats ss
               JOIN songs s2 ON s2.id = ss.song_id
               WHERE COALESCE(s2.canonical_id, s2.id) = COALESCE(s.canonical_id, s.id)) AS stored
       FROM songs s WHERE s.id = ANY($1)`, [trackIds]
    );
    if (!meta.rows.length) { console.error('Bu id\'ler songs tablosunda yok.'); return; }

    const observed = [];
    for (const row of meta.rows) {
      let live = await fetchTrackPlaycount(page, row.id);
      if (live === null) {
        const tracks = await fetchAlbumTracks(page, row.album_id);
        const hit = tracks.find(t => t.id === row.id);
        if (hit && hit.playCount > 0) live = hit.playCount;
      }
      if (live === null) {
        console.warn(`[repair] ${row.title}: Spotify'da playcount okunamadı, atlandı.`);
        continue;
      }
      const stored = Number(row.stored) || 0;
      const diff = live - stored;
      console.log(`[repair] ${row.title}\n         bizde: ${stored}   Spotify: ${live}   fark: ${diff > 0 ? '+' : ''}${diff}`);
      if (diff >= 0) { console.log('         → düşüş yok, atlandı.'); continue; }
      observed.push({ songId: row.id, head: row.head, count: live, stored });
    }
    if (!observed.length) { console.log('\nDüzeltilecek bir şey yok.'); return; }
    if (!apply) { console.log('\n(dry-run — yazmak için --apply)'); return; }

    await client.query('BEGIN');
    for (const o of observed) {
      await client.query(
        `INSERT INTO stream_observations (song_id, observed_date, stream_count, stored_count)
         VALUES ($1, (((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date), $2, $3)
         ON CONFLICT (song_id, observed_date) DO UPDATE
           SET stream_count = EXCLUDED.stream_count, stored_count = EXCLUDED.stored_count`,
        [o.songId, o.count, o.stored]
      );
    }
    // Canlı okuma teyidin kendisi olduğu için tek gözlem yeterli — AMA yalnızca
    // burada okuduğumuz şarkılar için. onlyHeads olmadan bu çağrı bekleyen tüm
    // gözlem birikimini de uygular ve minConfirmations: 1 ikinci günün teyidini
    // bekleyenleri de içeri alır: 2026-08-23'te tek şarkı için çalıştırılan bir
    // koşu böyle 40 kaydı birden düzeltti.
    const heads = new Set(observed.map(o => o.head));
    // Oran koruması yalnızca --force ile ve yalnızca adı geçen başlar için kalkar.
    const forceHeads = force ? heads : new Set();
    // --only-listed: tıraşlama yalnızca komut satırındaki id'lere. Ailede doğru
    // değeri taşıyan bir üye varsa şart.
    const clampIds = onlyListed ? new Set(observed.map(o => o.songId)) : null;
    // Doğrulayıcı: bu araç canlı değerleri zaten yukarıda okudu, aynı sayfaları
    // ikinci kez açmanın anlamı yok. reconcileStreamDrops artık kanıtsız
    // kırpmıyor, kanıt burada elimizde.
    const liveById = new Map(observed.map(o => [o.songId, o.count]));
    const applied = await reconcileStreamDrops(client, {
      minConfirmations: 1, forceHeads, onlyHeads: heads, clampIds,
      verify: async (songIds) => {
        const out = new Map();
        for (const id of songIds) {
          if (liveById.has(id)) { out.set(id, liveById.get(id)); continue; }
          try { out.set(id, await fetchTrackPlaycount(page, id)); }
          catch { out.set(id, null); }
        }
        return out;
      },
    });
    await client.query('COMMIT');
    console.log(`\n[repair] ${applied.length} kayıt düzeltildi.`);
  } finally {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
