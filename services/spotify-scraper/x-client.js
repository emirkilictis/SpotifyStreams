/**
 * x-client.js — X'e tweet atmak için minimum OAuth 1.0a imzalama.
 *
 * Bir istemci kütüphanesi yerine 30 satır: scrape yolundaki bağımlılık yüzeyini
 * ve CI kurulum süresini küçük tutuyor. /2/tweets user-context ister, yani
 * consumer + access token çifti — OAuth2 Client ID/Secret burada kullanılmaz.
 *
 * NOT: imza yalnızca oauth_* parametrelerini kapsar. JSON gövdesi imzaya
 * girmez (doğrusu budur), ama QUERY parametreleri girmeli — bu istemci query
 * destekLEMEZ, çünkü tweet atmak için gerek yok. Query'li bir uca çağrı
 * eklersen imzaya onları da katman gerekir, yoksa 401 alırsın.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c =>
  '%' + c.charCodeAt(0).toString(16).toUpperCase());

function credsFromEnv() {
  return {
    consumerKey: process.env.X_CONSUMER_KEY,
    consumerSecret: process.env.X_CONSUMER_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  };
}

const credsComplete = c => Object.values(c).every(v => !!v);

function oauthHeader(method, url, creds) {
  const params = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params).sort()
    .map(k => `${rfc3986(k)}=${rfc3986(params[k])}`).join('&');
  const base = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&');
  const key = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.accessSecret)}`;
  params.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(params).sort()
    .map(k => `${rfc3986(k)}="${rfc3986(params[k])}"`).join(', ');
}

// Gorsel yukler ve media_id dondurur.
//
// MULTIPART OLMASI SART. Bu dosyanin imzalayicisi yalnizca oauth_* parametrelerini
// kapsiyor; form-urlencoded bir govdede (media_data=<base64>) OAuth 1.0a govde
// alanlarini da imzaya katmayi sart kosar ve imza tutmaz — 401 alinir. Multipart
// govde ise, JSON gibi, imzanin disinda kalir. Bu yuzden imzalayiciya
// dokunmadan gorsel yuklenebiliyor.
//
// Yukleme ucu tweet ucundan AYRI bir host'ta (upload.x.com). Media 24 saat
// yasiyor ve kullanilmazsa kendiliginden dusuyor, yani yuklemek tek basina
// hicbir sey yayinlamiyor.
const MEDIA_UPLOAD_URL = 'https://upload.x.com/1.1/media/upload.json';

async function uploadMedia(filePath, creds = credsFromEnv()) {
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('media', new Blob([bytes]), path.basename(filePath));
  const res = await fetch(MEDIA_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: oauthHeader('POST', MEDIA_UPLOAD_URL, creds) },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X media ${res.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  const id = json.media_id_string || (json.data && json.data.id);
  if (!id) throw new Error(`X media: cevapta media_id yok — ${body.slice(0, 200)}`);
  return id;
}

// media/jt icinden rastgele bir kare. Klasor bos ya da yoksa null doner ve
// tweet metinle atilir — gorsel bir suslemesi, gonderinin sarti degil.
function pickArtistPhoto(dir = path.join(__dirname, 'media', 'jt')) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  } catch { return null; }
  if (!files.length) return null;
  return path.join(dir, files[Math.floor(Math.random() * files.length)]);
}

async function postTweet(text, creds = credsFromEnv(), mediaIds = []) {
  const url = 'https://api.x.com/2/tweets';
  const payload = { text };
  if (mediaIds && mediaIds.length) payload.media = { media_ids: mediaIds };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader('POST', url, creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X API ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// Tweet'i fotografla atar; fotograf bir sebeple tutmazsa METINLE atar.
//
// Iki ayri yerde dusebilir ve ikisi de gonderiyi oldurmemeli: yukleme
// basarisiz olabilir, ya da yukleme tutup /2/tweets media_id'yi reddedebilir.
// Bot gozetimsiz calisiyor — bir fotograf yuzunden gunun postunu kaybetmek,
// fotografsiz post atmaktan çok daha kötü.
async function postTweetWithPhoto(text, creds = credsFromEnv(), etiket = 'x') {
  let mediaIds = [];
  const file = pickArtistPhoto();
  if (file) {
    try {
      mediaIds = [await uploadMedia(file, creds)];
      console.log(`[${etiket}] görsel: ${path.basename(file)}`);
    } catch (err) {
      console.warn(`[${etiket}] görsel yüklenemedi (${err.message}) — metinle gidiyor.`);
    }
  }
  if (!mediaIds.length) return postTweet(text, creds, []);
  try {
    return await postTweet(text, creds, mediaIds);
  } catch (err) {
    console.warn(`[${etiket}] görselli gönderim reddedildi (${err.message}) — metinle tekrar deneniyor.`);
    return postTweet(text, creds, []);
  }
}

// Tweet defterini iki post tipinin paylaşabilmesi için kind kolonuyla kurar.
// tweet_log ilk sürümde sadece post_date PK'siydi; orada duran kayıtlar
// aylık dinleyici tweet'leridir, o yüzden default o.
async function ensureTweetLog(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS tweet_log (
       post_date date NOT NULL,
       tweet_id text,
       value bigint,
       posted_at timestamptz NOT NULL DEFAULT now())`);
  await client.query(
    `ALTER TABLE tweet_log ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'monthly_listeners'`);
  await client.query(`ALTER TABLE tweet_log DROP CONSTRAINT IF EXISTS tweet_log_pkey`);
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS tweet_log_gun_tip ON tweet_log (post_date, kind)`);
}

module.exports = { postTweet, postTweetWithPhoto, uploadMedia, pickArtistPhoto,
                   credsFromEnv, credsComplete, ensureTweetLog };
