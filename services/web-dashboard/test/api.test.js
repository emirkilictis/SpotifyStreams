'use strict';
// API edge-case / robustness tests. Probes for crashes (5xx), injection
// handling, bad-input handling, auth gating and basic data integrity.
// Requires the dashboard running on BASE_URL with a valid login passcode.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PASSCODE = process.env.TEST_PASSCODE || 'timberlake_fan';
const JT = '31TPClRtHm23RisEBtV3X7';

let cookie = '';

async function get(p, headers = {}) {
  return fetch(`${BASE_URL}${p}`, { headers: { Cookie: cookie, ...headers }, redirect: 'manual' });
}

before(async () => {
  // Fail fast with a clear message if the server isn't up.
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: PASSCODE }),
    });
  } catch (e) {
    throw new Error(`Dashboard not reachable at ${BASE_URL} — start it first. (${e.message})`);
  }
  assert.equal(res.status, 200, 'login should succeed with the test passcode');
  cookie = res.headers.get('set-cookie').split(';')[0];
});

// --- Public access -----------------------------------------------------------
test('public /api/* returns 200', async () => {
  const res = await fetch(`${BASE_URL}/api/songs?artist=${JT}`, { redirect: 'manual' });
  assert.equal(res.status, 200);
});

test('public page route returns 200', async () => {
  const res = await fetch(`${BASE_URL}/`, { redirect: 'manual' });
  assert.equal(res.status, 200);
});

// --- Login validation ------------------------------------------------------
test('login with missing passcode -> 400', async () => {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('login with wrong passcode -> 401', async () => {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'nope-not-real' }),
  });
  assert.equal(res.status, 401);
});

// --- Happy paths return well-formed data -----------------------------------
test('/api/songs returns array of well-formed song rows', async () => {
  const res = await get(`/api/songs?artist=${JT}`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(Array.isArray(rows) && rows.length > 0, 'expected non-empty array');
  for (const r of rows.slice(0, 5)) {
    assert.ok('id' in r && 'title' in r, 'row has id+title');
    // NOTE: pg serializes ::bigint columns as strings (JS can't hold 64-bit
    // ints safely). The frontend always wraps these in Number(); verify the
    // values are at least finite-numeric strings.
    assert.ok(Number.isFinite(Number(r.cumulative)), 'cumulative is numeric');
    assert.ok(Number.isFinite(Number(r.daily_gain)), 'daily_gain is numeric');
  }
});

test('/api/songs is sorted by cumulative descending (numeric)', async () => {
  const res = await get(`/api/songs?artist=${JT}`);
  const rows = await res.json();
  for (let i = 1; i < rows.length; i++) {
    assert.ok(Number(rows[i - 1].cumulative) >= Number(rows[i].cumulative), `row ${i} out of order`);
  }
});

test('hidden frozen track (Suit & Tie - Radio Edit) is excluded everywhere', async () => {
  const res = await get(`/api/songs?artist=${JT}`);
  const rows = await res.json();
  assert.ok(!rows.some(r => r.id === '6233Z1W8t9Wn1f1gZqHhQ5'), 'hidden track id must not appear');
});

test('/api/stats, /api/artist-stats, /api/albums, /api/milestones-reached -> 200', async () => {
  for (const p of [`/api/stats?artist=${JT}`, `/api/artist-stats?artist=${JT}`, `/api/albums?artist=${JT}`, `/api/milestones-reached?artist=${JT}`]) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} should be 200`);
  }
});

// --- Robustness: malformed / malicious input must never 5xx ----------------
test('unknown artist id never crashes (no 5xx)', async () => {
  const res = await get(`/api/songs?artist=doesnotexist123`);
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.ok(Array.isArray(await res.json()));
});

test('SQL-injection attempt in artist param is neutralized (no 5xx, no dump)', async () => {
  const payload = encodeURIComponent("' OR 1=1; DROP TABLE songs;--");
  const res = await get(`/api/songs?artist=${payload}`);
  assert.ok(res.status < 500, `injection caused ${res.status}`);
  if (res.status === 200) {
    const rows = await res.json();
    assert.ok(Array.isArray(rows), 'should be an array, not a dump');
  }
});

test('nonexistent album id -> no 5xx, array if 200', async () => {
  const res = await get(`/api/albums/0000000000nonexistent/songs`);
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.ok(Array.isArray(await res.json()));
});

test('nonexistent song/album history ids -> no 5xx', async () => {
  for (const p of ['/api/songs/0000nonexistent/history', '/api/albums/0000nonexistent/history']) {
    const res = await get(p);
    assert.ok(res.status < 500, `${p} -> ${res.status}`);
  }
});

test('stats for unknown artist -> no 5xx', async () => {
  const res = await get(`/api/stats?artist=garbage`);
  assert.ok(res.status < 500, `got ${res.status}`);
});

// --- JC Chasez lock (access control) ---------------------------------------
test('locked artist (JC Chasez) is forbidden without passcode header', async () => {
  const res = await get(`/api/stats?artist=3p3U04w2DaiBzuYMZnYr00`);
  assert.equal(res.status, 403);
});

test('locked artist accessible with correct passcode header', async () => {
  const res = await get(`/api/stats?artist=3p3U04w2DaiBzuYMZnYr00`, { 'X-JC-Passcode': 'peakedinhighschool' });
  assert.equal(res.status, 200);
});

// --- Method handling -------------------------------------------------------
test('POST to a GET-only API route does not 5xx', async () => {
  const res = await fetch(`${BASE_URL}/api/songs?artist=${JT}`, { method: 'POST', headers: { Cookie: cookie } });
  assert.ok(res.status < 500, `got ${res.status}`);
});
