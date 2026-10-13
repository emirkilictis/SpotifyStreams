/**
 * pin-tracks.js — elle verilen track'leri bir sanatçının kataloğuna pinler.
 *
 * Reconcile kworb listesinden çalışıyor; kworb'un görmediği ya da sıraya
 * giremeyen kayıtlar için bu araç var. Birinin "şu şarkılar eksik" diye
 * gönderdiği Spotify linklerini doğrudan işleyebiliyorsun.
 *
 *   node pin-tracks.js --artist=<id> <trackId|url> [...]        # dry-run
 *   node pin-tracks.js --artist=<id> --apply <trackId|url> ...
 *
 * Reconcile'la AYNI güvenceyi taşıyor: Spotify o sanatçıyı şarkıda gerçekten
 * kredilendirmiyorsa pinlenmez. Aksi halde bir yanlış link, başkasının albümünü
 * bu sanatçının kataloğuna sokardı ve toplamı sessizce şişirirdi.
 *
 * İki durumu birlikte çözer:
 *   - Track bizde yoksa albümünü extra_scrape_albums'a pinler; sanatçının bir
 *     sonraki taraması Spotify'dan şarkıyı ve playcount'u alır.
 *   - Track başka takip edilen sanatçının kovasında zaten varsa canonical
 *     head'i extra_artist_songs ile hedef sanatçıya da bağlar. Önce yine
 *     Spotify kredisini doğrular; playlist'e yanlış şarkı konması toplamı
 *     şişiremez.
 */
const { launchBrowser } = require('./spotify');
const { resolveTracks } = require('./kworb');
const { getPool, upsertAlbum, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const arg = (name) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};

// Hem ham id hem open.spotify.com linki kabul edilir — insanlar linki yapıştırır.
const trackId = (s) => {
  const m = String(s).match(/track[/:]([A-Za-z0-9]{22})/) || String(s).match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const artistId = (arg('artist') || '').replace('spotify:artist:', '').trim();
  const ids = process.argv.slice(2).filter(a => !a.startsWith('--')).map(trackId).filter(Boolean);

  if (!/^[A-Za-z0-9]{22}$/.test(artistId) || !ids.length) {
    console.error('Kullanım: node pin-tracks.js --artist=<id> [--apply] <trackId|url> ...');
    process.exit(1);
  }

  const artistUri = `spotify:artist:${artistId}`;
  const client = await getPool().connect();
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  let inTx = false;
  try {
    const bizde = await client.query(
      `SELECT s.id,
              COALESCE(s.canonical_id, s.id) AS head_id,
              COALESCE(head.primary_artist, s.primary_artist) AS primary_artist,
              EXISTS (
                SELECT 1 FROM extra_artist_songs eas
                WHERE eas.artist_id = $2
                  AND eas.song_id = COALESCE(s.canonical_id, s.id)
              ) AS already_extra
         FROM songs s
         LEFT JOIN songs head ON head.id = COALESCE(s.canonical_id, s.id)
        WHERE s.id = ANY($1)`,
      [ids, artistId]
    );
    const varOlan = new Map(bizde.rows.map(r => [r.id, r]));
    const eksik = ids.filter(i => !varOlan.has(i));
    const baglanacakAday = ids.filter((id) => {
      const row = varOlan.get(id);
      return row && row.primary_artist !== artistUri && !row.already_extra;
    });
    console.log(`[pin] ${ids.length} track, ${varOlan.size} zaten DB'de, ${eksik.length} eksik, ${baglanacakAday.length} ek profil bağı adayı.`);

    // Eksik track'in albümünü ve mevcut-other-bucket track'in kredisini aynı
    // Spotify doğrulamasında çöz. Zaten hedef kovada olanlar için ağ isteği yok.
    const dogrulanacak = [...new Set([...eksik, ...baglanacakAday])];
    const cozulen = dogrulanacak.length ? await resolveTracks(page, dogrulanacak) : new Map();
    const pinlenecek = new Map();
    const baglanacak = new Map();
    for (const id of baglanacakAday) {
      const a = cozulen.get(id);
      if (!a) { console.warn(`[pin] ${id}: Spotify'da çözülemedi, profil bağı atlandı.`); continue; }
      if (!a.artistUris?.length) {
        console.warn(`[pin] ${a.name || id}: kredi listesi boş (şema değişmiş olabilir), profil bağı atlandı.`);
        continue;
      }
      if (!a.artistUris.includes(artistUri)) {
        console.warn(`[pin] ${a.name || id}: Spotify bu sanatçıyı kredilendirmiyor, profil bağı atlandı.`);
        continue;
      }
      const headId = varOlan.get(id).head_id;
      baglanacak.set(headId, a);
      console.log(`[pin] ${a.name || id}\n      → mevcut track hedef sanatçıya da bağlanacak (${headId})`);
    }
    for (const id of eksik) {
      const a = cozulen.get(id);
      if (!a) { console.warn(`[pin] ${id}: Spotify'da çözülemedi, atlandı.`); continue; }
      if (!a.artistUris?.length) {
        console.warn(`[pin] ${a.name || id}: kredi listesi boş (şema değişmiş olabilir), atlandı.`);
        continue;
      }
      if (!a.artistUris.includes(artistUri)) {
        console.warn(`[pin] ${a.name || id}: Spotify bu sanatçıyı kredilendirmiyor, atlandı.`);
        continue;
      }
      pinlenecek.set(a.albumId, a);
      console.log(`[pin] ${a.name || id}\n      → ${a.albumName} (${a.albumId})`);
    }

    if (!pinlenecek.size && !baglanacak.size) return console.log('\n[pin] Yeni albüm ya da profil bağı yok.');
    console.log(`\n[pin] ${pinlenecek.size} albüm, ${baglanacak.size} ek profil bağı yazılacak.`);
    if (!apply) return console.log('[pin] DRY-RUN — yazmak için --apply ekle.');

    await client.query('BEGIN');
    inTx = true;
    for (const [headId] of baglanacak) {
      await client.query(
        `INSERT INTO extra_artist_songs (artist_id, song_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [artistId, headId]
      );
    }
    for (const [albumId, a] of pinlenecek) {
      await upsertAlbum(client, { id: albumId, title: a.albumName, release_date: a.release, image_url: a.coverUrl });
      await client.query(
        `INSERT INTO extra_scrape_albums (artist_id, album_id, title, release_date, is_featured, source, note)
         VALUES ($1,$2,$3,$4,$5,'manual','pin-tracks')
         ON CONFLICT DO NOTHING`,
        [artistId, albumId, a.albumName, a.release || null, false]);
    }
    await client.query('COMMIT');
    inTx = false;
    console.log(`[pin] ${pinlenecek.size} albüm ve ${baglanacak.size} ek profil bağı yazıldı${pinlenecek.size ? ' — eksik albümler sanatçının bir sonraki taramasında çekilecek' : ''}.`);
  } catch (err) {
    if (inTx) await client.query('ROLLBACK').catch(() => {});
    console.error('[pin] HATA:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error('[pin] HATA:', e.message); process.exit(1); });
