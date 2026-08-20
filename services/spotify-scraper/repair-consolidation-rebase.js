/**
 * repair-consolidation-rebase.js — Spotify'ın katalog BİRLEŞTİRMESİNİN açtığı
 * sahte tek-gün sıçramasını siler.
 *
 * Spotify zaman zaman iki kaydı (dil varyantı, deluxe sürüm, düet) tek sayaca
 * bağlıyor ve o günden itibaren her ikisi için de birleşik playcount veriyor.
 * daily_streams_canonical running MAX kullandığı için bu, o gün "bir günde 30
 * milyon dinlenme" gibi görünüyor — oysa kimse dinlemedi, sayaç yeniden
 * tabanlandı. 2026-08-18'de 18 şarkıda tek seferde oldu (toplam 530M sahte).
 *
 * Düzeltme: sıçramanın ÖNCESİNDEKİ geçmişe offset eklenir, böylece seri
 * kesintisiz hale gelir ve o günün kazancı tipik değerine döner. BUGÜNKÜ
 * toplamlar değişmez; değişen, sıçrama öncesi günlerin toplamıdır — ki bu
 * kasıtlı: birleşen kaydın stream'leri gerçekten vardı, running MAX küçük
 * olanı yutuyordu.
 *
 * Bu araç YALNIZCA gerçek yeniden tabanlama için. Sıçrama sonrası değer geri
 * düşüyorsa bu bir birleştirme değil, hatalı okumadır — onun yeri
 * repair-stream-drops.js.
 *
 *   node repair-consolidation-rebase.js                      # dry-run (varsayılan)
 *   node repair-consolidation-rebase.js --apply              # yaz
 *   node repair-consolidation-rebase.js --date=2026-08-18 --min-gain=5000000
 *
 * Yazmadan önce etkilenen satırların tamamı stream_stats_rebase_backup_<tarih>
 * tablosuna kopyalanır; geri almak için o tablodan stream_count geri yazılır.
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

// Sıçrayan başlıkları ve uygulanacak offset'i tek sorguda çıkarır: offset =
// o günkü sahte kazanç eksi şarkının kendi tipik (medyan) günlük kazancı, ki
// düzeltmeden sonra o gün normal bir gün gibi görünsün.
const OFFSET_SQL = `
  WITH etk AS (
    SELECT d.canonical_id, d.daily_gain
    FROM daily_streams_canonical d
    WHERE d.recorded_date = $1 AND d.daily_gain > $2
  ),
  tipik AS (
    SELECT d.canonical_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY d.daily_gain) AS g
    FROM daily_streams_canonical d
    JOIN etk e ON e.canonical_id = d.canonical_id
    WHERE d.recorded_date BETWEEN ($1::date - 8) AND ($1::date - 1)
    GROUP BY 1
  )
  SELECT e.canonical_id,
         s.title,
         e.daily_gain::bigint AS sahte,
         (e.daily_gain - COALESCE(t.g, 0))::bigint AS off
  FROM etk e
  JOIN songs s ON s.id = e.canonical_id
  LEFT JOIN tipik t ON t.canonical_id = e.canonical_id
  ORDER BY e.daily_gain DESC`;

async function main() {
  const apply = process.argv.includes('--apply');
  const date = arg('date', '2026-08-18');
  const minGain = Number(arg('min-gain', '5000000'));
  const backupTable = `stream_stats_rebase_backup_${date.replace(/-/g, '')}`;

  const client = await getPool().connect();
  try {
    const { rows } = await client.query(OFFSET_SQL, [date, minGain]);
    if (!rows.length) {
      console.log(`[rebase] ${date} gününde ${minGain.toLocaleString()} üzeri sıçrama yok. Yapacak bir şey yok.`);
      return;
    }

    console.log(`[rebase] ${date} — ${rows.length} şarkı, toplam sahte kazanç: ` +
      rows.reduce((a, r) => a + Number(r.sahte), 0).toLocaleString());
    for (const r of rows) {
      console.log(`  ${String(r.off).padStart(12)}  ${r.title}`);
    }

    if (!apply) {
      console.log('\n[rebase] DRY-RUN. Yazmak için --apply ekle.');
      return;
    }

    await client.query('BEGIN');

    // Geri dönüş için etkilenecek satırların birebir kopyası.
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${backupTable} (
         id bigint, song_id text, stream_count bigint, recorded_date date, note text)`);
    const backup = await client.query(
      `INSERT INTO ${backupTable}
       SELECT ss.id, ss.song_id, ss.stream_count, ss.recorded_date, $3
       FROM stream_stats ss
       JOIN songs s ON s.id = ss.song_id
       WHERE COALESCE(s.canonical_id, s.id) = ANY($1) AND ss.recorded_date < $2
       AND NOT EXISTS (SELECT 1 FROM ${backupTable} b WHERE b.id = ss.id)`,
      [rows.map(r => r.canonical_id), date, `${date} rebase`]);
    console.log(`\n[rebase] ${backup.rowCount} satır ${backupTable} tablosuna yedeklendi.`);

    // Sıçrama öncesi geçmişe offset: aynı grubun TÜM üyelerine eşit eklenir,
    // böylece per-gün MAX'in sırası bozulmaz ve eski günlük kazançlar aynı kalır.
    let touched = 0;
    for (const r of rows) {
      const res = await client.query(
        `UPDATE stream_stats ss SET stream_count = ss.stream_count + $1
         FROM songs s
         WHERE s.id = ss.song_id
           AND COALESCE(s.canonical_id, s.id) = $2
           AND ss.recorded_date < $3`,
        [r.off, r.canonical_id, date]);
      touched += res.rowCount;
    }

    await client.query('COMMIT');
    console.log(`[rebase] ${touched} satır güncellendi.`);

    const after = await client.query(
      `SELECT recorded_date, SUM(daily_gain)::bigint AS gunluk
       FROM daily_streams_canonical
       WHERE recorded_date BETWEEN ($1::date - 2) AND ($1::date + 2)
       GROUP BY 1 ORDER BY 1`, [date]);
    console.log('\n[rebase] düzeltme sonrası roster günlük toplamları:');
    for (const r of after.rows) {
      console.log(`  ${r.recorded_date.toISOString().slice(0, 10)}  ${Number(r.gunluk).toLocaleString()}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(err => { console.error('[rebase] HATA:', err.message); process.exit(1); });
