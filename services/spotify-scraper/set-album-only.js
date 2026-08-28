/**
 * set-album-only.js — bir sanatcinin album_only bayragini degistirir.
 *
 * Bayrak acikken discoverAllAlbumsPuppeteer appears-on'u HIC cekmiyor, yani
 * sanatcinin baskasinin albumundeki kayitlari kesfe girmiyor. Ariana icin bu
 * acikti; kapatilinca butun diskografi geliyor.
 *
 *   node set-album-only.js <artistId> true|false          # dry-run
 *   node set-album-only.js --apply <artistId> true|false
 *
 * Yalnizca komut satirinda ADI GECEN sanatciya dokunur.
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [id, deger] = args.filter(a => !a.startsWith('--'));
  if (!id || !['true', 'false'].includes(deger)) {
    console.error('Kullanim: node set-album-only.js [--apply] <artistId> true|false');
    process.exit(1);
  }
  const client = await getPool().connect();
  try {
    const once = await client.query(
      `SELECT name, album_only FROM tracked_artists WHERE artist_id = $1`, [id]);
    if (!once.rows.length) { console.error(`[roster] ${id} tracked_artists'ta yok.`); process.exit(1); }
    console.log(`[roster] ${once.rows[0].name}: album_only ${once.rows[0].album_only} → ${deger}`);
    if (!apply) { console.log('(dry-run — yazmak icin --apply)'); return; }
    await client.query(
      `UPDATE tracked_artists SET album_only = $2 WHERE artist_id = $1`, [id, deger === 'true']);
    const sonra = await client.query(
      `SELECT album_only FROM tracked_artists WHERE artist_id = $1`, [id]);
    console.log(`[roster] yazildi, simdi: ${sonra.rows[0].album_only}`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(e => { console.error('[roster] HATA:', e.message); process.exit(1); });
