/**
 * tweet-daily-milestone.js — JT'nin günlük stream'i eşiği aşarsa tweetler.
 *
 * Varsayılan eşik 10.000.000. Nadiren olur, o yüzden olduğunda haber değeri var.
 *
 *   node tweet-daily-milestone.js --dry-run
 *   DAILY_TWEET_THRESHOLD=12000000 node tweet-daily-milestone.js
 *
 * RAKAM NEREDEN GELİYOR. Sitenin kendi /api/stats ucundan — DB'den değil.
 * Günlük stream'in sanatçıya atfı basit bir primary_artist filtresi değil
 * (feature'lar ayrı bir kova kuralıyla katılıyor): DB'den elle hesaplayınca
 * 7.5M çıkıyor, sitenin gösterdiği ise 9.1M. Tweet ile sayfadaki rakam
 * birbirini tutmazsa ikisi de güvenilmez olur, o yüzden kaynak tek: site.
 *
 * KISMİ GÜNE KARŞI KORUMA. Tarama sürerken günlük rakam yükselerek oturuyor
 * (9.8M görünüp sonra 9.4M'ye inmesi bu yüzden — eksik/yeni satırlar geldikçe
 * canonical MAX'ler değişiyor). Eşiğe yarım bir günle takılıp "10M'i geçti"
 * diye tweetlemek, birkaç dakika sonra yanlışa dönüşebilir. Bu yüzden JT'nin
 * şarkılarının en az %90'ı o güne yazılmadan hiçbir şey gönderilmez — web push
 * duyurusundaki kuralın aynısı.
 *
 * Gün başına tek tweet (tweet_log, kind='daily_10m'). Her hata yutulur.
 */
const { postTweet, credsFromEnv, credsComplete, ensureTweetLog } = require('./x-client');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const JT = '31TPClRtHm23RisEBtV3X7';
const ESIK = Number(process.env.DAILY_TWEET_THRESHOLD || 10000000);
const MIN_KAPSAMA = 0.90;
const SITE = process.env.DASHBOARD_URL || 'https://spotify-streams-dashboard.onrender.com';

const fmt = n => Number(n).toLocaleString('en-US');

function tweetMetni({ daily, tarih, footer }) {
  const gun = new Date(`${tarih}T12:00:00Z`).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const satirlar = [
    `Justin Timberlake passed 10M daily streams.`,
    '',
    `${fmt(daily)} on ${gun}.`,
  ];
  if (footer && footer.trim()) satirlar.push('', footer.trim());
  return satirlar.join('\n');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const creds = credsFromEnv();
  if (!dryRun && !credsComplete(creds)) {
    return console.log('[daily] X anahtarları eksik — adım atlandı.');
  }

  const client = await getPool().connect();
  try {
    await ensureTweetLog(client);

    // Kapsama: JT'nin şarkılarının kaçı bugüne yazılmış? Yarım günde eşik
    // yanlış tetiklenebilir.
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
      return console.log(`[daily] Kapsama %${(oran * 100).toFixed(0)} (${yazilan}/${toplam}) — ` +
        `gün henüz oturmamış, atlandı.`);
    }

    const zaten = await client.query(
      `SELECT tweet_id FROM tweet_log WHERE post_date = $1 AND kind = 'daily_10m'`, [bugun_str]);
    if (zaten.rows.length) {
      return console.log(`[daily] ${bugun_str} için zaten atılmış (${zaten.rows[0].tweet_id}) — atlandı.`);
    }

    // Rakamı siteden al: tweet ile sayfa aynı sayıyı söylemeli.
    const res = await fetch(`${SITE}/api/stats?artist=${JT}`, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) return console.log(`[daily] Site ${res.status} döndü — atlandı.`);
    const stats = await res.json();

    const daily = Number(stats.daily_gain || 0);
    const sonGun = String(stats.last_update || '').slice(0, 10);
    if (sonGun !== bugun_str) {
      return console.log(`[daily] Sitenin son günü ${sonGun}, bugün ${bugun_str} — atlandı.`);
    }
    if (!(daily > ESIK)) {
      return console.log(`[daily] ${fmt(daily)} — eşiğin (${fmt(ESIK)}) altında, atlandı.`);
    }

    const metin = tweetMetni({ daily, tarih: bugun_str, footer: process.env.TWEET_FOOTER });
    if (metin.length > 280) return console.log(`[daily] Metin ${metin.length} karakter — atlandı.`);
    console.log('--- tweet ---\n' + metin + '\n-------------');
    if (dryRun) return console.log('[daily] DRY-RUN — gönderilmedi.');

    const sonuc = await postTweet(metin, creds);
    const id = sonuc?.data?.id ?? null;
    await client.query(
      `INSERT INTO tweet_log (post_date, kind, tweet_id, value)
       VALUES ($1, 'daily_10m', $2, $3)
       ON CONFLICT (post_date, kind) DO NOTHING`, [bugun_str, id, daily]);
    console.log(`[daily] Gönderildi: ${id}`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(err => console.error('[daily] HATA (yok sayıldı):', err.message));
