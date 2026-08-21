/**
 * run-dedup.js — dedup'ı tek başına, saatlik çalıştırmak için.
 *
 * Dedup normalde sadece GERÇEK bir tarama yapan run'ın sonunda koşuyor, yani
 * pratikte günde bir. Arada ortaya çıkan kopyalar (yeni keşfedilen bir derleme
 * edition'ı, Spotify'ın bir kaydı başkasına bağlaması) ertesi güne kadar
 * duruyor ve o süre boyunca toplamlar şişik görünüyor.
 *
 * Bu ayrı adım vaktiyle Neon yüzünden kaldırılmıştı: her çalışma compute'u
 * uyandırıyor ve fatura uyanık kalma süresine göre kesiliyordu. Supabase'de
 * öyle bir maliyet yok, o yüzden geri geldi.
 *
 *   node run-dedup.js
 *
 * Admin panelindeki /api/admin/dedup ile aynı işi yapar: tek transaction,
 * hata olursa ROLLBACK — yarım kalmış bir dedup katalogu bozuk bırakır.
 * Hiçbir koşulda exit 1 vermez; scrape verisi zaten yazılmıştır ve dedup'ın
 * kötü bir günü o run'ı düşürmemeli.
 */
const { dedupCanonical } = require('./dedup');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

async function main() {
  const client = await getPool().connect();
  try {
    console.log('[dedup] başlıyor (transactional)...');
    const t = Date.now();
    await client.query('BEGIN');
    const sonuc = await dedupCanonical(client);
    await client.query('COMMIT');
    console.log(`[dedup] bitti (${((Date.now() - t) / 1000).toFixed(1)}sn):`, sonuc);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[dedup] BAŞARISIZ (geri alındı):', err.message);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(err => console.error('[dedup] HATA (yok sayıldı):', err.message));
