/**
 * tweet-daily-recap.js — JT'nin günlük stream'i eşiği aşarsa, günün özetini
 * ve en çok akan 5 şarkısını tweetler.
 *
 * Varsayılan eşik 9.000.000 (DAILY_TWEET_THRESHOLD ile değiştirilir).
 *
 *   node tweet-daily-recap.js --dry-run
 *
 * RAKAMLAR SİTEDEN GELİR, DB'den değil. Günlük stream'in sanatçıya atfı basit
 * bir primary_artist filtresi değil — feature'lar ayrı bir kova kuralıyla
 * katılıyor — ve DB'den elle hesaplayınca 7.5M çıkarken sayfa 9.1M gösteriyor.
 * Tweet ile sayfa aynı sayıyı söylemezse ikisi de güvenilmez olur.
 *
 * KISMİ GÜNE KARŞI KORUMA. Tarama sürerken günlük rakam oturana kadar oynuyor
 * (9.8M görünüp sonra 9.4M'ye inmesi bu yüzden). Eşiğe yarım bir günle takılıp
 * tweetlemek birkaç dakika sonra yanlışa dönebilir, o yüzden JT'nin
 * şarkılarının en az %90'ı o güne yazılmadan hiçbir şey gönderilmez.
 *
 * 280 KARAKTER. Şarkı adları uzun ("CAN'T STOP THE FEELING! (from DreamWorks
 * Animation's "TROLLS")"), o yüzden başlıklar parantez/tire öncesinden kesilir
 * ve metin hâlâ sığmıyorsa liste 5'ten 4'e, 3'e inerek küçültülür. Hiçbir
 * durumda X'e sığmayacak bir metin gönderilmez.
 *
 * Gün başına tek tweet (tweet_log, kind='daily_recap'). Her hata yutulur.
 */
const { postTweet, credsFromEnv, credsComplete, ensureTweetLog } = require('./x-client');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const JT = '31TPClRtHm23RisEBtV3X7';
const ESIK = Number(process.env.DAILY_TWEET_THRESHOLD || 9000000);
const MIN_KAPSAMA = 0.90;
const SITE = process.env.DASHBOARD_URL || 'https://spotify-streams-dashboard.onrender.com';
const LIMIT = 280;

const fmt = n => Number(n).toLocaleString('en-US');

// "CAN'T STOP THE FEELING! (from DreamWorks…)" → "CAN'T STOP THE FEELING!"
// Parantez ve tire sonrası ek bilgidir; şarkıyı tanımak için gereken kısım
// baştaki addır. Kalan yine uzunsa kırpılır.
function kisaBaslik(t, max = 28) {
  let s = String(t || '').split(' (')[0].split(' - ')[0].trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

function tweetMetni({ daily, sarkilar, tarih, footer }) {
  const gun = new Date(`${tarih}T12:00:00Z`).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  const kur = n => {
    const satirlar = [`Justin Timberlake — ${fmt(daily)} daily streams`, ''];
    sarkilar.slice(0, n).forEach((s, i) => {
      satirlar.push(`${i + 1}. ${kisaBaslik(s.title)} — ${fmt(s.daily)}`);
    });
    satirlar.push('', gun);
    if (footer && footer.trim()) satirlar.push('', footer.trim());
    return satirlar.join('\n');
  };

  // 5'ten başlayıp sığana kadar kısalt. 1 şarkıyla bile sığmıyorsa (footer çok
  // uzun demektir) çağıran taraf atlar.
  for (let n = Math.min(5, sarkilar.length); n >= 1; n--) {
    const m = kur(n);
    if (m.length <= LIMIT) return m;
  }
  return kur(1);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const creds = credsFromEnv();
  if (!dryRun && !credsComplete(creds)) {
    return console.log('[recap] X anahtarları eksik — adım atlandı.');
  }

  const client = await getPool().connect();
  try {
    await ensureTweetLog(client);

    const kaps = await client.query(
      `SELECT COUNT(*) FILTER (WHERE bugun) AS yazilan, COUNT(*) AS toplam,
              to_char(CURRENT_DATE, 'YYYY-MM-DD') AS bugun_str
       FROM (
         SELECT s.id, EXISTS (
           SELECT 1 FROM stream_stats x
           WHERE x.song_id = s.id AND x.recorded_date = CURRENT_DATE) AS bugun
         FROM songs s
         WHERE (s.primary_artist = $1 OR s.primary_artist IS NULL)
           AND s.canonical_id IS NULL
       ) q`, [`spotify:artist:${JT}`]);

    const { yazilan, toplam, bugun_str } = kaps.rows[0];
    const oran = Number(toplam) ? Number(yazilan) / Number(toplam) : 0;
    if (oran < MIN_KAPSAMA) {
      return console.log(`[recap] Kapsama %${(oran * 100).toFixed(0)} (${yazilan}/${toplam}) — gün oturmamış, atlandı.`);
    }

    const zaten = await client.query(
      `SELECT tweet_id FROM tweet_log WHERE post_date = $1 AND kind = 'daily_recap'`, [bugun_str]);
    if (zaten.rows.length) {
      return console.log(`[recap] ${bugun_str} için zaten atılmış (${zaten.rows[0].tweet_id}) — atlandı.`);
    }

    const stats = await fetch(`${SITE}/api/stats?artist=${JT}`, { signal: AbortSignal.timeout(120000) });
    if (!stats.ok) return console.log(`[recap] /api/stats ${stats.status} — atlandı.`);
    const s = await stats.json();

    const daily = Number(s.daily_gain || 0);
    const sonGun = String(s.last_update || '').slice(0, 10);
    if (sonGun !== bugun_str) {
      return console.log(`[recap] Sitenin son günü ${sonGun}, bugün ${bugun_str} — atlandı.`);
    }
    if (!(daily > ESIK)) {
      return console.log(`[recap] ${fmt(daily)} — eşiğin (${fmt(ESIK)}) altında, atlandı.`);
    }

    const sres = await fetch(`${SITE}/api/songs?artist=${JT}`, { signal: AbortSignal.timeout(180000) });
    if (!sres.ok) return console.log(`[recap] /api/songs ${sres.status} — atlandı.`);
    const sarkilar = (await sres.json())
      .map(x => ({ title: x.title, daily: Number(x.daily_gain || 0) }))
      .filter(x => x.daily > 0)
      .sort((a, b) => b.daily - a.daily);

    if (sarkilar.length < 5) {
      return console.log(`[recap] Sadece ${sarkilar.length} şarkı hareket etmiş — liste eksik kalır, atlandı.`);
    }

    const metin = tweetMetni({ daily, sarkilar, tarih: bugun_str, footer: process.env.TWEET_FOOTER });
    if (metin.length > LIMIT) {
      return console.log(`[recap] Metin ${metin.length} karakter, sığmıyor — atlandı. TWEET_FOOTER'ı kısalt.`);
    }
    console.log(`--- tweet (${metin.length} karakter) ---\n${metin}\n-------------`);
    if (dryRun) return console.log('[recap] DRY-RUN — gönderilmedi.');

    const sonuc = await postTweet(metin, creds);
    const id = sonuc?.data?.id ?? null;
    await client.query(
      `INSERT INTO tweet_log (post_date, kind, tweet_id, value)
       VALUES ($1, 'daily_recap', $2, $3)
       ON CONFLICT (post_date, kind) DO NOTHING`, [bugun_str, id, daily]);
    console.log(`[recap] Gönderildi: ${id}`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(err => console.error('[recap] HATA (yok sayıldı):', err.message));
