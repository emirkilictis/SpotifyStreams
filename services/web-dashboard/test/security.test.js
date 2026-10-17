'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { securityConfig, proxyTrust } = require('../lib/security');
const { databaseConfig } = require('../lib/database');
const { fetchImage, publicIPv4 } = require('../lib/image-proxy');
const { Pool } = require('pg');
const { validPushEndpoint, validPushKeys } = require('../lib/push-endpoint');

const env = {
  ADMIN_PASSCODE: 'test-admin-secret-'.repeat(3),
  SECADMIN_PASSCODE: 'test-secondary-secret-'.repeat(3),
  IP_HASH_SECRET: 'test-ip-hash-secret-'.repeat(3),
  JC_PASSCODES: 'test-artist-secret-'.repeat(3),
};

test('missing, short, reused and published secrets cannot start the dashboard', () => {
  for (const key of ['ADMIN_PASSCODE', 'SECADMIN_PASSCODE', 'IP_HASH_SECRET']) {
    for (const bad of [undefined, '', 'short', 'x'.repeat(32)]) {
      assert.throws(() => securityConfig({ ...env, [key]: bad }), new RegExp(key));
    }
  }
  assert.throws(() => securityConfig({ ...env, SECADMIN_PASSCODE: env.ADMIN_PASSCODE }), /different/);
  assert.throws(() => securityConfig({ ...env, JC_PASSCODES: env.ADMIN_PASSCODE }), /independent/);
});

test('role checks preserve separation and reject malformed credentials', () => {
  const config = securityConfig(env);
  assert.equal(config.getAdminRole(env.ADMIN_PASSCODE), 'admin');
  assert.equal(config.getAdminRole('admin:' + env.ADMIN_PASSCODE), 'admin');
  assert.equal(config.getAdminRole('secadmin:' + env.SECADMIN_PASSCODE), 'secadmin');
  for (const value of [null, {}, [], 'admin:' + env.SECADMIN_PASSCODE, 'secadmin:' + env.ADMIN_PASSCODE, 'x'.repeat(1025)]) {
    assert.equal(config.getAdminRole(value), null);
  }
  assert.equal(config.isJcAllowed(env.JC_PASSCODES), true);
  assert.equal(securityConfig({ ...env, JC_PASSCODES: '' }).isJcAllowed(''), false);
  assert.notEqual(config.hashIp('127.0.0.1'), securityConfig({ ...env, IP_HASH_SECRET: env.IP_HASH_SECRET + 'new' }).hashIp('127.0.0.1'));
});

test('legacy URL flags cannot disable certificate checks in the actual pg configuration', async () => {
  for (const flag of ['sslmode=no-verify', 'sslmode=disable', 'sslmode=require', 'sslmode=verify-ca', 'ssl=false', 'sslrootcert=ignored&uselibpqcompat=true']) {
    const config = databaseConfig({ DATABASE_URL: 'postgresql://user:password@db.example/db?' + flag });
    const pool = new Pool(config);
    assert.equal(pool.options.ssl.rejectUnauthorized, true);
    const params = new (require('pg/lib/connection-parameters'))(config);
    assert.equal(params.ssl.rejectUnauthorized, true);
    assert.equal(new URL(config.connectionString).search, '');
    await pool.end();
  }
});

test('custom CA is preserved and insecure remote/deployed connections are refused', () => {
  const url = 'postgresql://user:password@db.example/db?sslmode=no-verify';
  assert.equal(databaseConfig({ DATABASE_URL: url, DB_SSL_CA: 'certificate\\nchain' }).ssl.ca, 'certificate\nchain');
  assert.throws(() => databaseConfig({ DATABASE_URL: url, DB_SSL_MODE: 'disable' }), /loopback/);
  assert.throws(() => databaseConfig({ DATABASE_URL: url, NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /not permitted/);
  const local = 'postgresql://user:password@localhost/db';
  assert.equal(databaseConfig({ DATABASE_URL: local, DB_SSL_MODE: 'disable' }).ssl, false);
  assert.throws(() => databaseConfig({ DATABASE_URL: local, DB_SSL_MODE: 'disable', RENDER: 'true' }), /loopback/);
  assert.throws(() => databaseConfig({ DATABASE_URL: local, DB_SSL_MODE: 'disable', NODE_ENV: 'production' }), /loopback/);
  assert.throws(() => databaseConfig({ DATABASE_URL: 'secret-is-not-a-url' }), { message: 'DATABASE_URL must be a valid PostgreSQL URL.' });
});

test('the official bundled CA is scoped to Supabase poolers and explicit CA settings take precedence', () => {
  const pooler = 'postgresql://user:password@aws-0-region.pooler.supabase.com/db?sslmode=no-verify';
  const config = databaseConfig({ DATABASE_URL: pooler });
  assert.equal(config.ssl.rejectUnauthorized, true);
  const cert = new (require('node:crypto').X509Certificate)(config.ssl.ca);
  assert.equal(cert.ca, true);
  assert.equal(cert.fingerprint256, '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
  assert.equal(databaseConfig({ DATABASE_URL: pooler, DB_SSL_CA: 'explicit-ca' }).ssl.ca, 'explicit-ca');
  assert.equal(databaseConfig({ DATABASE_URL: pooler.replace('.com/', '.com.attacker.example/') }).ssl.ca, undefined);
  assert.equal(databaseConfig({ DATABASE_URL: 'postgresql://user:password@other.example/db' }).ssl.ca, undefined);
});

test('proxy trust is bounded and defaults to direct access outside Render', () => {
  assert.equal(proxyTrust({}), 0);
  assert.equal(proxyTrust({ RENDER: 'true' }), 1);
  assert.throws(() => proxyTrust({ TRUST_PROXY_HOPS: 'true' }));
});

test('push subscriptions accept browser services and reject arbitrary destinations and oversized keys', () => {
  for (const url of ['https://fcm.googleapis.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/test', 'https://web.push.apple.com/test', 'https://wns2.notify.windows.com/test']) {
    assert.equal(validPushEndpoint(url), true);
  }
  for (const url of ['https://127.0.0.1/', 'https://attacker.example/', 'https://fcm.googleapis.com.attacker.example/', 'https://fcm.googleapis.com:8443/', 'https://user:pass@fcm.googleapis.com/', 'http://web.push.apple.com/']) {
    assert.equal(validPushEndpoint(url), false);
  }
  assert.equal(validPushKeys({ p256dh: Buffer.alloc(65).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') }), true);
  assert.equal(validPushKeys({ p256dh: 'x'.repeat(10000), auth: 'x'.repeat(22) }), false);
});

test('image proxy rejects internal addresses, credentials, plaintext and unusual ports before sending', async () => {
  for (const address of ['0.0.0.0', '10.1.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(publicIPv4(address), false, address);
  }
  let calls = 0;
  const deps = { lookup: async () => [{ address: '127.0.0.1' }], get: () => { calls++; } };
  for (const url of ['https://images.example/a', 'http://images.example/a', 'https://images.example:8443/a', 'https://user:pass@images.example/a']) {
    await assert.rejects(fetchImage(url, () => true, deps));
  }
  assert.equal(calls, 0);
});

test('image requests pin DNS, do not follow redirects, reject active content and bound bodies', async () => {
  for (const [status, type, length] of [[302, 'image/png', 0], [200, 'image/svg+xml', 0], [200, 'image/png', 9 * 1024 * 1024], [200, 'image/png', 0]]) {
    let calls = 0;
    const upstream = new EventEmitter();
    upstream.destroy = () => {};
    upstream.statusCode = status;
    upstream.headers = { 'content-type': type, 'content-length': String(length) };
    const request = new EventEmitter();
    request.destroy = err => { request.emit('error', err); request.emit('close'); };
    const promise = fetchImage('https://images.example/image', () => true, {
      lookup: async () => [{ address: '93.184.216.34' }],
      get: (_url, options, callback) => {
        calls++;
        options.lookup('images.example', {}, (_err, ip) => assert.equal(ip, '93.184.216.34'));
        setImmediate(() => {
          callback(upstream);
          if (status === 200 && type === 'image/png' && length === 0) upstream.emit('data', Buffer.alloc(9 * 1024 * 1024));
        });
        return request;
      },
    });
    await assert.rejects(promise);
    assert.equal(calls, 1);
  }
});
