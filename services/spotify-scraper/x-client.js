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

async function postTweet(text, creds = credsFromEnv()) {
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

module.exports = { postTweet, credsFromEnv, credsComplete, ensureTweetLog };
