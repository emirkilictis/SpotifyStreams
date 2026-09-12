/**
 * tweet-monthly-listeners.js — JT'nin aylık dinleyici sayısını günde bir tweetler.
 *
 * Scrape adımından SONRA çalışır ve veriyi Spotify'dan değil, o run'ın DB'ye
 * yazdığı satırdan okur — yani tweet her zaman sitedeki rakamla aynıdır.
 *
 *   node tweet-monthly-listeners.js --dry-run   # metni bas, hiçbir şey gönderme
 *   node tweet-monthly-listeners.js             # gönder
 *
 * SESSİZ KALMA KURALLARI. Bot sahibi yokken çalışıyor, o yüzden şüphe varsa
 * tweetlemez — yanlış rakamı geri almak, hiç atmamaktan çok daha pahalı:
 *   - bugünün satırı yoksa (scrape henüz yakalamadıysa) atlar
 *   - o gün için zaten tweet atıldıysa atlar (tweet_log defteri, idempotent)
 *   - dinleyici sayısı dünden ARTMADIYSA atlar (düşüş ya da aynı kalma). Bot bir
 *     kutlama hesabı; "JT dün 120 bin dinleyici kaybetti" diye tweet atmak
 *     hayranların istediği şey değil. Önceki gün yoksa da atlar: artış olduğu
 *     bilinmeden artış tweeti atılmaz.
 *   - değişim %10'u aşıyorsa atlar. Aylık dinleyici günde ~0.1% oynar; %10'luk
 *     bir sıçrama gerçek değil, veri kazası demektir — fallback roster olayında
 *     31 sanatçı JT'nin kovasına düşüp sayıyı uçurmuştu.
 *   - dinleyici sayısı boş/sıfırsa atlar
 *
 * Her hata yutulur ve exit 0 ile çıkılır: veri zaten yazıldı, tweet ikramdır ve
 * scrape run'ını asla düşürmemeli.
 */
const { postTweetWithPhoto, credsFromEnv, credsComplete, ensureTweetLog } = require('./x-client');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const JT = '31TPClRtHm23RisEBtV3X7';
const MAX_DEGISIM_ORANI = 0.10;   // bunu aşan değişim veri kazası sayılır

const fmt = n => Number(n).toLocaleString('en-US');

// ---------------------------------------------------------------------------

// Tweet'in sonuna eklenen serbest not (TWEET_FOOTER). Tatil duyurusu gibi
// gecici seyler icin: repo degiskeni oldugu icin donunce GitHub'dan silmek
// yetiyor, kod degismiyor. Bos/tanimsizsa hic satir eklenmez.
function tweetMetni({ bugun, dun, zirveMi, tarih, footer }) {
  // Buraya yalnizca artis gunleri ulasiyor (bkz. main), yani fark hep pozitif.
  const fark = dun == null ? null : Number(bugun) - Number(dun);
  const isaret = fark == null ? '' : `+${fmt(fark)}`;
  const gun = new Date(`${tarih}T12:00:00Z`).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  const satirlar = [
    'Justin Timberlake — Spotify monthly listeners',
    '',
    fmt(bugun) + (isaret ? `  (${isaret})` : ''),
  ];
  if (zirveMi) satirlar.push('', 'All-time high.');
  satirlar.push('', gun);
  if (footer && footer.trim()) satirlar.push('', footer.trim());
  return satirlar.join('\n');
}

// Bugunun degeri ve bir onceki gunun degeri verildiginde tweet atilmamasi
// gerekiyorsa sebebini, atilabiliyorsa null dondurur. Saf fonksiyon: DB'ye ve
// X'e dokunmadan gecmis gunler uzerinde denenebiliyor.
function atlamaSebebi(deger, dun) {
  // Yalnizca artislar. Bot bir kutlama hesabi; dusus tweeti atmak istenmiyor.
  if (dun == null) return 'Önceki gün verisi yok, artış olduğu bilinmiyor';
  const once = Number(dun);
  if (deger <= once) {
    const fark = deger - once;
    return `Aylık dinleyici artmadı (${fmt(once)} → ${fmt(deger)}, ${fark === 0 ? '0' : fmt(fark)}) — yalnızca artışlar tweetleniyor`;
  }
  // Artik yalnizca yukari yon kaldigi icin abs gerekmiyor.
  const oran = (deger - once) / once;
  if (oran > MAX_DEGISIM_ORANI) {
    return `Değişim %${(oran * 100).toFixed(1)}, gerçek olamayacak kadar büyük (${fmt(once)} → ${fmt(deger)}). Veriyi kontrol et`;
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const creds = credsFromEnv();
  if (!dryRun && !credsComplete(creds)) {
    console.log('[tweet] X anahtarları eksik — adım atlandı.');
    return;
  }

  const client = await getPool().connect();
  try {
    await ensureTweetLog(client);

    // Tarih Postgres'te string'e cevriliyor. pg surucusu DATE'i YEREL gece
    // yarisina denk bir Date nesnesi olarak veriyor; toISOString() ile UTC'ye
    // cevirince gun bir geri kayiyor ve bot "yeni gun gelmemis" diye susuyor.
    const { rows } = await client.query(
      `SELECT to_char(recorded_date, 'YYYY-MM-DD') AS tarih,
              monthly_listeners,
              (recorded_date = CURRENT_DATE) AS bugun_mu
       FROM artist_stats
       WHERE artist_id = $1 AND monthly_listeners IS NOT NULL
       ORDER BY recorded_date DESC LIMIT 2`, [JT]);

    if (!rows.length) return console.log('[tweet] Aylık dinleyici verisi yok — atlandı.');

    const bugun = rows[0];
    const tarih = bugun.tarih;
    const dun = rows[1]?.monthly_listeners ?? null;

    // Bugünün satırı gerçekten bugüne mi ait? Scrape henüz yeni günü yakalamadıysa
    // dünün rakamını bugünmüş gibi tweetlemeyelim. Karşılaştırmayı Postgres
    // yapıyor (bugun_mu), ki iki taraf da aynı takvimi kullansın.
    if (!bugun.bugun_mu) {
      return console.log(`[tweet] En yeni veri ${tarih} ve bugün değil — scrape henüz yeni günü yakalamamış, atlandı.`);
    }

    const zaten = await client.query(
      `SELECT tweet_id FROM tweet_log WHERE post_date = $1 AND kind = 'monthly_listeners'`, [tarih]);
    if (zaten.rows.length) {
      return console.log(`[tweet] ${tarih} için zaten atılmış (${zaten.rows[0].tweet_id}) — atlandı.`);
    }

    const deger = Number(bugun.monthly_listeners);
    if (!(deger > 0)) return console.log('[tweet] Dinleyici sayısı boş/sıfır — atlandı.');

    // Kayit defterine (tweet_log) YAZILMIYOR: saatlik run'lar ayni gun tekrar
    // bakiyor, ve gun icinde satir daha yeni bir okumayla guncellenip artisa
    // donerse o zaman atilmasi dogru.
    const sebep = atlamaSebebi(deger, dun);
    if (sebep) return console.log(`[tweet] ${sebep} — atlandı.`);

    const zirve = await client.query(
      `SELECT MAX(monthly_listeners) AS m FROM artist_stats
       WHERE artist_id = $1 AND recorded_date < $2`, [JT, tarih]);
    const zirveMi = zirve.rows[0].m != null && deger > Number(zirve.rows[0].m);

    const metin = tweetMetni({ bugun: deger, dun, zirveMi, tarih, footer: process.env.TWEET_FOOTER });
    if (metin.length > 280) {
      return console.log(`[tweet] Metin ${metin.length} karakter (sınır 280) — atlandı. TWEET_FOOTER'ı kısalt.`);
    }
    console.log('--- tweet ---\n' + metin + '\n-------------');

    if (dryRun) return console.log('[tweet] DRY-RUN — gönderilmedi.');

    // media/jt icinden rastgele bir kareyle gonderiliyor; fotograf tutmazsa
    // gonderi metinle gidiyor (bkz. postTweetWithPhoto).
    const sonuc = await postTweetWithPhoto(metin, creds, 'tweet');
    const id = sonuc?.data?.id ?? null;
    await client.query(
      `INSERT INTO tweet_log (post_date, kind, tweet_id, value)
       VALUES ($1, 'monthly_listeners', $2, $3)
       ON CONFLICT (post_date, kind) DO NOTHING`, [tarih, id, deger]);
    console.log(`[tweet] Gönderildi: ${id}`);
  } finally {
    client.release();
    await closePool();
  }
}

if (require.main !== module) {
  module.exports = { atlamaSebebi, tweetMetni };
} else main().catch(err => {
  // Asla run'ı düşürme: veri zaten yazıldı, tweet ikram.
  console.error('[tweet] HATA (yok sayıldı):', err.message);
});
