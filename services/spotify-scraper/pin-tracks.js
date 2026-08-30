/**
 * pin-tracks.js — elle verilen track'lerin albümlerini bir sanatçıya pinler.
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
 * Pinlenen albüm o sanatçının BİR SONRAKİ taramasında çekilir.
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
  try {
    const bizde = await client.query(`SELECT id FROM songs WHERE id = ANY($1)`, [ids]);
    const varOlan = new Set(bizde.rows.map(r => r.id));
    const eksik = ids.filter(i => !varOlan.has(i));
    console.log(`[pin] ${ids.length} track, ${varOlan.size} zaten DB'de, ${eksik.length} eksik.`);
    if (!eksik.length) return;

    const cozulen = await resolveTracks(page, eksik);
    const pinlenecek = new Map();
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

    if (!pinlenecek.size) return console.log('\n[pin] Pinlenecek albüm yok.');
    console.log(`\n[pin] ${pinlenecek.size} albüm pinlenecek.`);
    if (!apply) return console.log('[pin] DRY-RUN — yazmak için --apply ekle.');

    await client.query('BEGIN');
    for (const [albumId, a] of pinlenecek) {
      await upsertAlbum(client, { id: albumId, title: a.albumName, release_date: a.release, image_url: a.coverUrl });
      await client.query(
        `INSERT INTO extra_scrape_albums (artist_id, album_id, title, release_date, is_featured, source, note)
         VALUES ($1,$2,$3,$4,$5,'manual','pin-tracks')
         ON CONFLICT DO NOTHING`,
        [artistId, albumId, a.albumName, a.release || null, false]);
    }
    await client.query('COMMIT');
    console.log(`[pin] ${pinlenecek.size} albüm pinlendi — sanatçının bir sonraki taramasında çekilecek.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pin] HATA:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error('[pin] HATA:', e.message); process.exit(1); });
