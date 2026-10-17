'use strict';
const fs = require('node:fs');

// Keep URL SSL parameters from overriding pg's verified TLS configuration.
// https://node-postgres.com/features/ssl#usage-with-connectionstring
function databaseConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 is not permitted.');
  }
  let url;
  try {
    url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const mode = env.DB_SSL_MODE || 'verify-full';
  if (!['verify-full', 'disable'].includes(mode)) {
    throw new Error('DB_SSL_MODE must be verify-full (default) or disable for local development.');
  }
  if (mode === 'disable' && (!local || env.NODE_ENV === 'production' || env.RENDER)) {
    throw new Error('Unencrypted PostgreSQL is allowed only on loopback in local development.');
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^ssl/i.test(key) || key.toLowerCase() === 'uselibpqcompat') url.searchParams.delete(key);
  }
  const ssl = mode === 'disable' ? false : { rejectUnauthorized: true };
  if (ssl && env.DB_SSL_CA && env.DB_SSL_CA_FILE) {
    throw new Error('Set only one of DB_SSL_CA or DB_SSL_CA_FILE.');
  }
  if (ssl && (env.DB_SSL_CA || env.DB_SSL_CA_FILE)) {
    ssl.ca = env.DB_SSL_CA
      ? env.DB_SSL_CA.replace(/\\n/g, '\n')
      : fs.readFileSync(env.DB_SSL_CA_FILE, 'utf8');
  } else if (ssl && url.hostname.endsWith('.pooler.supabase.com')) {
    // Supabase publishes this public root through its official dashboard.
    // Trust it only for Supabase pooler hosts; keep hostname checks enabled.
    ssl.ca = fs.readFileSync(require('node:path').join(__dirname, '../certs/supabase-prod-ca-2021.crt'), 'utf8');
  }
  return { connectionString: url.toString(), ssl };
}

module.exports = { databaseConfig };
