'use strict';
// API edge-case / robustness tests. Probes for crashes (5xx), injection
// handling, bad-input handling, auth gating and basic data integrity.
// Requires the dashboard running on BASE_URL. The site is public: no login.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const JT = '31TPClRtHm23RisEBtV3X7';

async function get(p, headers = {}) {
  return fetch(`${BASE_URL}${p}`, { headers, redirect: 'manual' });
}

before(async () => {
  // Fail fast with a clear message if the server isn't up.
  try {
    await fetch(`${BASE_URL}/healthz`);
  } catch (e) {
    throw new Error(`Dashboard not reachable at ${BASE_URL} — start it first. (${e.message})`);
  }
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

// --- No fan login -----------------------------------------------------------
test('/login and /logout redirect home', async () => {
  for (const p of ['/login', '/logout']) {
    const res = await get(p);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  }
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

test('/api/charts returns the requested category before history finishes', async () => {
  const res = await get('/api/charts?category=kpop');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.category, 'kpop');
  assert.equal(body.category_label, 'K-pop');
  assert.equal(body.metrics_complete, false);
  assert.ok(Array.isArray(body.charts?.daily?.songs));
  assert.ok(Array.isArray(body.charts?.weekly?.albums));
});

test('/api/ai-charts compatibility route returns daily and weekly chart-history metrics', async () => {
  const res = await get('/api/ai-charts?metrics=1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.category, 'ai');
  assert.equal(body.metrics_complete, true);
  for (const period of ['daily', 'weekly']) {
    for (const kind of ['songs', 'artists', 'albums']) {
      const rows = body.charts?.[period]?.[kind];
      assert.ok(Array.isArray(rows), `${period}.${kind} is an array`);
      for (const row of rows.slice(0, 3)) {
        assert.ok(Number.isInteger(row.rank) && row.rank > 0, 'rank is positive');
        assert.ok(row.previous_rank === null || Number.isInteger(row.previous_rank), 'previous rank is nullable integer');
        assert.ok(Number.isInteger(row.periods_on_chart) && row.periods_on_chart >= 1, 'time on chart is positive');
        assert.ok(Number.isInteger(row.peak_rank) && row.peak_rank <= row.rank, 'peak is at least as good as current rank');
        assert.ok(Number.isInteger(row.periods_at_peak) && row.periods_at_peak >= 1, 'time at peak is positive');
      }
    }
  }
});

test('/api/charts rejects unknown categories', async () => {
  const res = await get('/api/charts?category=rock');
  assert.equal(res.status, 400);
});

test('album-only artists are excluded from artist charts', async () => {
  const [rosterRes, chartRes] = await Promise.all([
    get('/api/artists'),
    get('/api/charts?category=female'),
  ]);
  assert.equal(rosterRes.status, 200);
  assert.equal(chartRes.status, 200);
  const roster = await rosterRes.json();
  const chart = await chartRes.json();
  const albumOnlyIds = new Set(
    roster
      .filter((artist) => artist.album_only && artist.categories?.includes('female'))
      .map((artist) => artist.artist_id)
  );
  assert.ok(albumOnlyIds.size > 0, 'fixture has at least one female album-only artist');
  for (const period of ['daily', 'weekly']) {
    assert.ok(
      chart.charts[period].artists.every((artist) => !albumOnlyIds.has(artist.artist_id)),
      `${period} artist chart excludes partial catalogues`
    );
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
  const res = await fetch(`${BASE_URL}/api/songs?artist=${JT}`, { method: 'POST' });
  assert.ok(res.status < 500, `got ${res.status}`);
});
