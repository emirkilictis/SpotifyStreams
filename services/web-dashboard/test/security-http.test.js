'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { once } = require('node:events');

// Run the real Express middleware/routes with an isolated environment and a
// fake database. Never load .env, send push messages or call a live database.
const filename = path.join(__dirname, '../server.js');
const localRequire = createRequire(filename);
const env = {
  ADMIN_PASSCODE: 'isolated-admin-secret-'.repeat(3),
  SECADMIN_PASSCODE: 'isolated-secondary-secret-'.repeat(3),
  IP_HASH_SECRET: 'isolated-ip-secret-'.repeat(3),
  DATABASE_URL: 'postgresql://test:test@db.example/test', PORT: '0',
};
let server, base;
before(async () => {
  const express = localRequire('express');
  const client = {
    query: async sql => ({ rows: /FROM tracked_artists ORDER BY sort_order, name/.test(sql)
      ? [{ artist_id: '31TPClRtHm23RisEBtV3X7', name: 'Test', active: true }]
      : [], rowCount: 0 }),
    release() {},
  };
  class FakePool {
    on() {}
    query(...args) { return client.query(...args); }
    async connect() { return client; }
  }
  function fakeExpress() {
    const app = express();
    const listen = app.listen.bind(app);
    app.listen = (_port, cb) => (server = listen(0, '127.0.0.1', cb));
    return app;
  }
  Object.assign(fakeExpress, express);
  const security = localRequire('./lib/security');
  const sandbox = {
    require: name => name === 'express' ? fakeExpress
      : name === 'pg' ? { Pool: FakePool }
      : name === 'dotenv' ? { config() {} }
      : name === './lib/push' ? { pushEnabled: false }
      : name === './lib/security' ? { ...security, securityConfig: () => security.securityConfig(env), proxyTrust: () => 0 }
      : name === './lib/database' ? { databaseConfig: () => localRequire(name).databaseConfig(env) }
      : localRequire(name),
    __dirname: path.dirname(filename), process: { env, on() {}, uptime: () => 0 },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    setInterval, clearInterval, Buffer, URL, AbortController, fetch,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  if (!server.listening) await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } });

test('public dashboard remains accessible; CSP hashes match the served inline scripts', async () => {
  for (const route of ['/', '/index.html', '/admin', '/admin.html', '/guide.html']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /script-src-attr 'none'/);
    assert.doesNotMatch(policy.split(';').find(x => x.trim().startsWith('script-src ')), /unsafe-inline|unsafe-eval/);
    const body = await response.text();
    for (const match of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/i.test(match[1])) continue;
      const hash = crypto.createHash('sha256').update(match[2]).digest('base64');
      assert.ok(policy.includes(hash), route + ' has a matching inline script hash');
    }
  }
});

test('admin routes reject missing and URL credentials, and separate secondary privileges', async () => {
  assert.equal((await fetch(base + '/api/admin/artists')).status, 403);
  assert.equal((await fetch(base + '/api/feedback?key=' + encodeURIComponent(env.ADMIN_PASSCODE))).status, 403);
  const response = await fetch(base + '/api/feedback', { headers: { 'X-Admin-Passcode': env.ADMIN_PASSCODE } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { 'X-Admin-Passcode': env.SECADMIN_PASSCODE } })).status, 403);
  assert.equal((await fetch(base + '/api/push/dispatch', { method: 'POST' })).status, 403);
});

test('JSON bodies are bounded and artist query arrays cannot crash middleware', async () => {
  assert.equal((await fetch(base + '/api/stats?artist=a&artist=b')).status, 400);
  const response = await fetch(base + '/api/verify-jc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'x'.repeat(110 * 1024) }) });
  assert.equal(response.status, 413);
});

test('image proxy refuses private addresses and plaintext URLs', async () => {
  for (const url of ['https://127.0.0.1/', 'http://i.scdn.co/image/a', 'https://i.scdn.co:8443/image/a']) {
    const response = await fetch(base + '/api/img-proxy?u=' + encodeURIComponent(url));
    assert.ok(response.status >= 400);
  }
});

test('forwarded address spoofing cannot bypass feedback throttling', async () => {
  for (let n = 0; n < 2; n++) {
    const response = await fetch(base + '/api/feedback', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${n}` },
      body: JSON.stringify({ message: 'Isolated regression test' }) });
    assert.equal(response.status, n === 0 ? 200 : 429);
  }
});

if (process.env.SECURITY_BROWSER_SMOKE === '1') {
  test('Chrome loads CSP-protected scripts and delegated cards without violations', async () => {
    const puppeteer = require('../../spotify-scraper/node_modules/puppeteer');
    const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        window.policyViolations = [];
        document.addEventListener('securitypolicyviolation', e => window.policyViolations.push(e.violatedDirective));
      });
      await page.goto(base, { waitUntil: 'networkidle0', timeout: 30000 });
      assert.equal(await page.evaluate(() => typeof ApexCharts), 'function');
      assert.equal(await page.evaluate(() => typeof html2canvas), 'function');
      assert.equal(await page.evaluate(async () => {
        const target = document.createElement('div');
        target.style.width = '400px';
        document.body.append(target);
        const chart = new ApexCharts(target, { chart: { type: 'line', animations: { enabled: false }, height: 200 }, series: [{ name: 'Test', data: [1, 2, 3] }] });
        await chart.render();
        const canvas = await html2canvas(target, { logging: false });
        chart.destroy();
        target.remove();
        return canvas.width > 0 && canvas.height > 0;
      }), true);
      const result = await page.evaluate(() => {
        let received;
        window.openAlbumById = (...args) => { received = args; };
        const card = document.createElement('button');
        card.dataset.openAlbum = 'album-id';
        card.dataset.title = 'Title with "quotes" and <tags>';
        card.dataset.date = '2026-10-18';
        card.dataset.cover = '/images/default.jpg';
        document.body.append(card);
        card.click();
        card.remove();
        return { received, violations: window.policyViolations };
      });
      assert.deepEqual(result.received, ['album-id', 'Title with "quotes" and <tags>', '2026-10-18', '/images/default.jpg']);
      assert.deepEqual(result.violations, []);
      await page.goto(base + '/admin', { waitUntil: 'networkidle0' });
      assert.deepEqual(await page.evaluate(() => window.policyViolations), []);
      const injection = await page.evaluate(async () => {
        const script = document.createElement('script');
        script.textContent = 'window.unsafeExecuted = true';
        document.body.append(script);
        const button = document.createElement('button');
        button.setAttribute('onclick', 'window.unsafeExecuted = true');
        document.body.append(button);
        button.click();
        await new Promise(r => setTimeout(r, 50));
        return { executed: Boolean(window.unsafeExecuted), violations: window.policyViolations };
      });
      assert.equal(injection.executed, false);
      assert.ok(injection.violations.includes('script-src-elem'));
      assert.ok(injection.violations.includes('script-src-attr'));
    } finally { await browser.close(); }
  });
}

test('changing spoofed forwarded addresses cannot bypass admin throttling', async () => {
  // A successful request clears earlier failures, then exhaust this source.
  await fetch(base + '/api/feedback', { headers: { 'X-Admin-Passcode': env.ADMIN_PASSCODE } });
  for (let n = 0; n < 10; n++) {
    assert.equal((await fetch(base + '/api/admin/artists', { headers: { 'X-Forwarded-For': `198.51.100.${n}` } })).status, 403);
  }
  const response = await fetch(base + '/api/admin/artists', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});
