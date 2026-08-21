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
 *   - değişim %10'u aşıyorsa atlar. Aylık dinleyici günde ~0.1% oynar; %10'luk
 *     bir sıçrama gerçek değil, veri kazası demektir — fallback roster olayında
 *     31 sanatçı JT'nin kovasına düşüp sayıyı uçurmuştu.
 *   - dinleyici sayısı boş/sıfırsa atlar
 *
 * Her hata yutulur ve exit 0 ile çıkılır: veri zaten yazıldı, tweet ikramdır ve
 * scrape run'ını asla düşürmemeli.
 */
const crypto = require('crypto');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const JT = '31TPClRtHm23RisEBtV3X7';
const MAX_DEGISIM_ORANI = 0.10;   // bunu aşan değişim veri kazası sayılır

const fmt = n => Number(n).toLocaleString('en-US');

// ---------------------------------------------------------------------------
// OAuth 1.0a. Tweet atmak için X'in istediği tek şey bu; bir kütüphane eklemek
// yerine 30 satır imzalama yazmak hem bağımlılık yüzeyini hem CI süresini
// küçük tutuyor. (Gönderdiğin OAuth2 Client ID/Secret burada KULLANILMIYOR —
// /2/tweets user-context ister, o da consumer + access token çiftidir.)
// ---------------------------------------------------------------------------
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c =>
  '%' + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(method, url, creds) {
  const params = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  // JSON gövdesi imzaya girmez (yalnız oauth_* ve query parametreleri girer).
  const paramString = Object.keys(params).sort()
    .map(k => `${rfc3986(k)}=${rfc3986(params[k])}`).join('&');
  const base = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&');
  const key = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.accessSecret)}`;
  params.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(params).sort()
    .map(k => `${rfc3986(k)}="${rfc3986(params[k])}"`).join(', ');
}

async function postTweet(text, creds) {
  const url = 'https://api.x.com/2/tweets';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader('POST', url, creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X API ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ---------------------------------------------------------------------------

// Tweet'in sonuna eklenen serbest not (TWEET_FOOTER). Tatil duyurusu gibi
// gecici seyler icin: repo degiskeni oldugu icin donunce GitHub'dan silmek
// yetiyor, kod degismiyor. Bos/tanimsizsa hic satir eklenmez.
function tweetMetni({ bugun, dun, zirveMi, tarih, footer }) {
  const fark = dun == null ? null : Number(bugun) - Number(dun);
  const isaret = fark == null ? '' : (fark >= 0 ? `+${fmt(fark)}` : fmt(fark));
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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const creds = {
    consumerKey: process.env.X_CONSUMER_KEY,
    consumerSecret: process.env.X_CONSUMER_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  };
  if (!dryRun && Object.values(creds).some(v => !v)) {
    console.log('[tweet] X anahtarları eksik — adım atlandı.');
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS tweet_log (
         post_date date PRIMARY KEY,
         tweet_id text,
         value bigint,
         posted_at timestamptz NOT NULL DEFAULT now())`);

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

    const zaten = await client.query(`SELECT tweet_id FROM tweet_log WHERE post_date = $1`, [tarih]);
    if (zaten.rows.length) {
      return console.log(`[tweet] ${tarih} için zaten atılmış (${zaten.rows[0].tweet_id}) — atlandı.`);
    }

    const deger = Number(bugun.monthly_listeners);
    if (!(deger > 0)) return console.log('[tweet] Dinleyici sayısı boş/sıfır — atlandı.');

    if (dun != null) {
      const oran = Math.abs(deger - Number(dun)) / Number(dun);
      if (oran > MAX_DEGISIM_ORANI) {
        return console.log(`[tweet] Değişim %${(oran * 100).toFixed(1)} — gerçek olamayacak kadar büyük, atlandı. ` +
          `(${fmt(dun)} → ${fmt(deger)}) Veriyi kontrol et.`);
      }
    }

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

    const sonuc = await postTweet(metin, creds);
    const id = sonuc?.data?.id ?? null;
    await client.query(
      `INSERT INTO tweet_log (post_date, tweet_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (post_date) DO NOTHING`, [tarih, id, deger]);
    console.log(`[tweet] Gönderildi: ${id}`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(err => {
  // Asla run'ı düşürme: veri zaten yazıldı, tweet ikram.
  console.error('[tweet] HATA (yok sayıldı):', err.message);
});
