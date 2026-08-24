/**
 * repair-stale-playcounts.js — günlerdir kıpırdamayan şarkıları Spotify'dan
 * CANLI okuyup gerçek değerine çeker.
 *
 * NEDEN GEREKLİ. Scraper playcount'u ALBÜM sayfasından okuyor. Bazı şarkılarda
 * o sayfanın sayısı bayatlıyor: 2026-08-21'de JT'nin "Holy Grail"i sekiz gündür
 * 406.032.077'de duruyordu ve günlüğü 0 görünüyordu — ama şarkının kendi
 * sayfası 406.368.183 diyordu. "Give It To Me"de de aynısı, 297.867 geride.
 * Veri yanlış değildi, sadece eskiydi; ve donmuş bir şarkı sanatçının günlük
 * toplamından sessizce eksiliyor.
 *
 * repair-stream-drops.js bunları göremez: o araç Spotify'ın stream GERİ ALDIĞI
 * durumu düzeltiyor ve "fark pozitifse atla" diyor. Bu araç tam tersini yapar.
 *
 * NEREDEN OKUR. ŞARKININ KENDİ sayfasından (fetchTrackPlaycount). Bayat olan
 * albüm sayfası olduğu için onu yeniden okumak hiçbir şeyi onarmaz — aynı eski
 * sayıyı verir, fark 0 çıkar, şarkı ertesi saat yine aday olur ve kuyruğu
 * tıkar. İlk sürüm bu yüzden yalnızca albüm sayfası kendiliğinden tazelenmiş
 * şarkıları düzeltebiliyordu; featured şarkılar (başkasının albümünde
 * yaşadıkları için en çok bayatlayanlar) haftalarca donmuş kalıyordu.
 * Track sayfası okunamazsa albüm okumasına düşülür.
 *
 *   node repair-stale-playcounts.js                 # dry-run
 *   node repair-stale-playcounts.js --apply
 *   node repair-stale-playcounts.js --days=3 --limit=25 --artist=<id>
 *
 * SEÇİM. Son `days` gündür değeri hiç değişmemiş, MIN_STREAMS üzerindeki
 * şarkılar; en çok stream'i olandan başlayarak `limit` tanesi. Saatlik
 * çalıştığında birkaç turda hepsini dolaşıyor.
 *
 * `--seen` son kaç gün içinde taranmış şarkıların aday sayılacağını söyler
 * (varsayılan 7). Eskiden bu 1 gündü, yani "hâlâ taranıyor" demekti; ama bir
 * şarkının albüm sayfası büsbütün okunamaz hâle geldiğinde şarkı hiç yeni
 * satır almıyor ve tam da onarıma en çok ihtiyacı olan şarkı aday listesinden
 * düşüyordu. Track sayfası o albümler için de çalıştığından artık kapsanıyor.
 * Silinmiş şarkı zaten okunamaz, okunamayana da yazılmaz.
 *
 * Yalnızca YUKARI yazar (GREATEST). Canlı okuma bizden düşükse ona dokunmaz:
 * düşüşler teyit isteyen ayrı bir mekanizmanın işi, ve tek bir bayat okumayla
 * geçmişi tıraşlamak bugün 513 milyonluk hayalete mal olan hatanın aynısı olur.
 */
const { launchBrowser, fetchAlbumTracks, fetchTrackPlaycount } = require('./spotify');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const MIN_STREAMS = Number(arg('min', 1000000));
const fmt = n => Number(n).toLocaleString('en-US');

// Son N taramada değeri HİÇ değişmemiş şarkılar. Şarkının kendi satırlarına
// bakıyoruz (canonical gruba değil): bayatlayan tek tek track sayfaları.
const DONMUS_SQL = `
  WITH son AS (
    SELECT ss.song_id, ss.stream_count, ss.recorded_date,
           ROW_NUMBER() OVER (PARTITION BY ss.song_id ORDER BY ss.recorded_date DESC) AS rn
    FROM stream_stats ss
  ),
  ozet AS (
    SELECT song_id,
           COUNT(*) AS gun,
           MIN(stream_count) AS en_dusuk,
           MAX(stream_count) AS en_yuksek,
           MAX(recorded_date) AS son_tarih
    FROM son WHERE rn <= $1 GROUP BY song_id
  ),
  aday AS (
    SELECT DISTINCT ON (COALESCE(s.canonical_id, s.id))
           s.id, s.title, s.album_id, o.en_yuksek AS stored, o.son_tarih
    FROM ozet o
    JOIN songs s ON s.id = o.song_id
    WHERE o.gun >= $1
      AND o.en_dusuk = o.en_yuksek           -- hiç kıpırdamamış
      AND o.en_yuksek >= $2
      AND o.son_tarih >= CURRENT_DATE - $5::int  -- büsbütün terk edilmiş değil
      AND s.album_id IS NOT NULL
      -- Sanatci kovasi panonunkiyle AYNI olmak zorunda. Burada bir sure
      -- "primary_artist = $3" yaziyordu ve bu, JT'ye scope'lanan her
      -- calistirmada JT'nin EN BUYUK feature'larini sessizce disarida
      -- birakiyordu: Holy Grail'in primary'si JAY-Z, Give It To Me'ninki
      -- Timbaland. Yani tam da en cok bayatlayan sarkilar (baskasinin
      -- albuminde yasadiklari icin) onarimdan hic gecmiyordu.
      -- JT'nin kovasi bir CATCH-ALL: izlenen baska hicbir sanatciya ait
      -- olmayan her sey.
      AND ($3::text IS NULL OR
           CASE WHEN $6 = '31TPClRtHm23RisEBtV3X7'
             THEN s.primary_artist IS NULL OR s.primary_artist NOT IN (
                    SELECT 'spotify:artist:' || artist_id FROM tracked_artists
                     WHERE artist_id <> '31TPClRtHm23RisEBtV3X7')
             ELSE s.primary_artist = $3
                  OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $6)
           END)
    -- Grup başına TEK aday. Aksi halde bir şarkının edition'ları turu yiyor:
    -- ilk çalıştırmada "Beauty and the Beast" tek başına 5 slot aldı ve sırada
    -- bekleyen başka şarkılara gelmedi. Grubun en yüksek üyesini onarmak
    -- yeterli — günlük kazanç zaten grup MAX'inden hesaplanıyor.
    ORDER BY COALESCE(s.canonical_id, s.id), o.en_yuksek DESC
  )
  SELECT id, title, album_id, stored, son_tarih
  FROM aday ORDER BY stored DESC LIMIT $4`;

async function main() {
  const apply = process.argv.includes('--apply');
  const days = Number(arg('days', 2));
  const limit = Number(arg('limit', 20));
  const seen = Number(arg('seen', 7));
  const artist = arg('artist', null);
  const artistId = artist ? artist.replace('spotify:artist:', '') : null;
  const artistParam = artistId ? `spotify:artist:${artistId}` : null;

  const client = await getPool().connect();
  let browser, page;
  try {
    const { rows } = await client.query(DONMUS_SQL, [days, MIN_STREAMS, artistParam, limit, seen, artistId]);
    if (!rows.length) {
      console.log(`[stale] ${days} gündür sabit kalan şarkı yok. Yapacak bir şey yok.`);
      return;
    }
    console.log(`[stale] ${rows.length} aday (>= ${days} gün sabit, >= ${fmt(MIN_STREAMS)} stream)`);

    ({ browser, page } = await launchBrowser(process.env.SP_DC));

    const guncellenecek = [];
    for (const row of rows) {
      // Önce şarkının KENDİ sayfası — bayat olan albüm sayfası, onu tekrar
      // okumak bu aracın var oluş sebebini boşa çıkarır.
      let canli = null;
      let kaynak = 'track';
      try {
        canli = await fetchTrackPlaycount(page, row.id);
      } catch (e) {
        console.warn(`[stale] ${row.title}: track sayfası okunamadı (${e.message}).`);
      }
      // Track sayfası tutmazsa albüm okumasına düş: eskisi kadar iyi değil ama
      // hiç okumamaktan iyi.
      if (canli === null) {
        try {
          const tracks = await fetchAlbumTracks(page, row.album_id);
          const hit = tracks.find(t => t.id === row.id);
          if (hit && hit.playCount > 0) { canli = hit.playCount; kaynak = 'albüm'; }
        } catch (e) {
          console.warn(`[stale] ${row.title}: albüm okuma hatası (${e.message}).`);
        }
      }
      if (canli === null) {
        console.warn(`[stale] ${row.title}: playcount okunamadı, atlandı.`);
        continue;
      }
      const stored = Number(row.stored) || 0;
      const fark = canli - stored;
      console.log(`[stale] ${row.title}\n        bizde: ${fmt(stored)}   Spotify (${kaynak}): ${fmt(canli)}   fark: ${fark > 0 ? '+' : ''}${fmt(fark)}`);
      if (fark <= 0) { console.log('        → canlı değer daha yüksek değil, dokunulmadı.'); continue; }
      guncellenecek.push({ id: row.id, count: canli, stored });
    }

    if (!guncellenecek.length) { console.log('\n[stale] Güncellenecek bir şey yok.'); return; }
    const toplam = guncellenecek.reduce((a, g) => a + (g.count - g.stored), 0);
    console.log(`\n[stale] ${guncellenecek.length} şarkı, toplam +${fmt(toplam)} stream geride.`);
    if (!apply) return console.log('[stale] DRY-RUN — yazmak için --apply ekle.');

    await client.query('BEGIN');
    for (const g of guncellenecek) {
      await client.query(
        `INSERT INTO stream_stats (song_id, stream_count, recorded_date, recorded_at)
         VALUES ($1, $2, CURRENT_DATE, NOW())
         ON CONFLICT (song_id, recorded_date) DO UPDATE
           SET stream_count = GREATEST(EXCLUDED.stream_count, stream_stats.stream_count),
               recorded_at = NOW()`,
        [g.id, g.count]);
    }
    await client.query('COMMIT');
    console.log(`[stale] ${guncellenecek.length} şarkı güncellendi.`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[stale] HATA (yok sayıldı):', err.message);
  } finally {
    client.release();
    if (browser) await browser.close();
    await closePool();
  }
}

main().catch(err => console.error('[stale] HATA (yok sayıldı):', err.message));
