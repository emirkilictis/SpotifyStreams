/**
 * repair-june-2026-date-shift.js — 2026-06-11/12/13 tarih kaymasi onarimi.
 *
 * TEK SEFERLIK. Uygulandi: 2026-09-04. Tekrar calistirmak zararsiz (pencerede
 * satir kalmadi), ama isi bitti.
 *
 * 9ef3401 (2026-06-14) oncesinde recorded_date, yazma anindaki UTC tarihiydi.
 * Istanbul'da gece yarisini gecen kosular bir gun ILERI damgalandi. 06-11
 * taramasi 06-12 04:03-05:03 UTC'de calisti ve 1231 satir 06-12 olarak yazildi;
 * 06-11 neredeyse bos kaldi, 06-13 de iki gunu birden topladi (Mirrors o gun
 * 2,124,217 gosterdi, normali ~1M).
 *
 * SONUC: 413 cakisan satir GREATEST ile birlestirildi, 818 satir 06-11'e
 * tasindi, 06-12 bosaldi. Mirrors 06-13 artik 1,062,108 (siteyi besleyen
 * agg_gains sicramayi 2 gune boluyor). JT'de 06-13'te kendi medyaninin 1.5
 * katini asan sarki kalmadi.
 *
 * DOKUNULMAYANLAR — bilerek:
 *   - Nisan/Mayis'taki gunluk 16-18 satirlik UTC 00:00 gruplari LISA'nin bagis
 *     gecmisi; sentetik recorded_at tasiyorlar, -12h kurali onlara islemez.
 *   - 06-13 tarihli 865 satir kurala gore 06-12'ye ait, ama hicbirinde sisme
 *     yok (565 sarkinin 0'inda 3x asim). Tasimak veriyi kariştirir, fayda yok.
 *
 * Satirlari kuralin soyledigi tarihe geri aliyoruz. Cakismada GREATEST: tasinan
 * okuma daha yeni ve 413 cakismanin 410'unda daha buyuk, 3'unde esit.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const { Pool } = require('pg');
const f=n=>Number(n??0).toLocaleString('en-US');
const pencere = (a) => `${a}.recorded_date='2026-06-12'
      AND ${a}.recorded_at >= '2026-06-12 03:00:00+00' AND ${a}.recorded_at < '2026-06-12 06:00:00+00'`;

const ornek = async (c, etiket) => {
  const r = await c.query(`
    SELECT to_char(recorded_date,'MM-DD') g, MAX(stream_count) mx
    FROM stream_stats ss JOIN songs s ON s.id=ss.song_id
    WHERE COALESCE(s.canonical_id,s.id)='4rHZZAmHpZrA3iH5zx8frV'
      AND recorded_date BETWEEN '2026-06-09' AND '2026-06-15'
    GROUP BY 1 ORDER BY 1`);
  console.log(`\n  Mirrors ${etiket}:`);
  let prev=null;
  for(const x of r.rows){ const d=prev==null?null:Number(x.mx)-prev;
    console.log(`    ${x.g}  ${String(f(x.mx)).padStart(13)}  ${d==null?'':(d>0?'+':'')+f(d)}`); prev=Number(x.mx); }
};

(async()=>{
  const apply = process.argv.includes('--apply');
  const p=new Pool({connectionString:process.env.DATABASE_URL});
  const c=await p.connect();
  try{
    await c.query('BEGIN');
    await ornek(c,'ONCE');

    const m = await c.query(`
      UPDATE stream_stats b
      SET stream_count = GREATEST(b.stream_count, a.stream_count), recorded_at = a.recorded_at
      FROM stream_stats a
      WHERE ${pencere('a')}
        AND b.song_id = a.song_id AND b.recorded_date = '2026-06-11'`);
    console.log(`\n  cakisan 06-11 satiri guncellendi (GREATEST): ${m.rowCount}`);

    const d = await c.query(`
      DELETE FROM stream_stats a
      WHERE ${pencere('a')}
        AND EXISTS (SELECT 1 FROM stream_stats b WHERE b.song_id=a.song_id AND b.recorded_date='2026-06-11')`);
    console.log(`  birlestirilen 06-12 satiri silindi: ${d.rowCount}`);

    const u = await c.query(`UPDATE stream_stats ss SET recorded_date='2026-06-11' WHERE ${pencere('ss')}`);
    console.log(`  06-12 -> 06-11 tarihi degistirildi: ${u.rowCount}`);

    const kalan = await c.query(`SELECT COUNT(*)::int n FROM stream_stats WHERE recorded_date='2026-06-12'`);
    console.log(`  06-12'de kalan satir: ${kalan.rows[0].n}`);
    await ornek(c,'SONRA');

    if(!apply){ await c.query('ROLLBACK'); console.log('\n  DRY-RUN — geri alindi. Yazmak icin --apply'); }
    else { await c.query('COMMIT'); console.log('\n  UYGULANDI.'); }
  }catch(e){ await c.query('ROLLBACK').catch(()=>{}); console.error('HATA (geri alindi):', e.message); process.exitCode=1; }
  finally{ c.release(); await p.end(); }
})();
