'use strict';
// Unit tests for the canonical deduplication logic (services/spotify-scraper/dedup.js).
// Drives the real dedupCanonical() with a fake pg client: the SELECT returns
// canned song rows, and every "UPDATE songs SET canonical_id = $1 WHERE id = $2"
// is captured as an alias -> canonical assignment. No database needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dedupCanonical } = require('../../spotify-scraper/dedup');

function makeFakeClient(rows) {
  const assignments = {}; // aliasId -> canonicalId
  const client = {
    assignments,
    async query(text, params) {
      const t = String(text).replace(/\s+/g, ' ').trim();
      if (/^SELECT/i.test(t)) return { rows };
      if (/UPDATE songs SET canonical_id = NULL/i.test(t)) return { rowCount: 0 };
      if (/UPDATE songs SET canonical_id = \$1 WHERE id = \$2/i.test(t)) {
        assignments[params[1]] = params[0];
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

const D = (s) => new Date(s);

// Representative fixture covering each grouping rule. Distinct normalized
// titles keep the groups from interfering with one another.
const ROWS = [
  // "my love": same song, near-identical duration -> merge; older own wins.
  { id: 'aaa', title: 'My Love', duration_ms: 270000, is_featured: false, album_id: 'al1', primary_artist: 'art1', release_date: D('2006-09-11') },
  { id: 'bbb', title: 'My Love (Single Version)', duration_ms: 271000, is_featured: false, album_id: 'al2', primary_artist: 'art1', release_date: D('2007-01-01') },

  // "give it to me": same title, durations 22s apart -> must NOT merge.
  { id: 'ccc', title: 'Give It To Me', duration_ms: 234026, is_featured: true, album_id: 'al3', primary_artist: 'art1', release_date: D('2007-01-01') },
  { id: 'ddd', title: 'Give It To Me', duration_ms: 212013, is_featured: true, album_id: 'al3', primary_artist: 'art1', release_date: D('2007-01-01') },

  // "forever": own (is_featured=false) beats featured even though it's newer.
  { id: 'hhh', title: 'Forever', duration_ms: 200000, is_featured: true, album_id: 'al4', primary_artist: 'art1', release_date: D('2010-01-01') },
  { id: 'iii', title: 'Forever', duration_ms: 200000, is_featured: false, album_id: 'al5', primary_artist: 'art1', release_date: D('2012-01-01') },

  // "halo": a (Live) version must stay separate from the studio cut.
  { id: 'eee', title: 'Halo', duration_ms: 240000, is_featured: false, album_id: 'al6', primary_artist: 'art1', release_date: D('2008-01-01') },
  { id: 'fff', title: 'Halo (Live)', duration_ms: 240000, is_featured: false, album_id: 'al7', primary_artist: 'art1', release_date: D('2009-01-01') },

  // NEVER_MERGE id stays independent even with an identical sibling.
  { id: '6ToFxXRBtl5TJFEyIoYK3f', title: 'Mirrors', duration_ms: 300000, is_featured: false, album_id: 'al8', primary_artist: 'art1', release_date: D('2013-01-01') },
  { id: 'jjj', title: 'Mirrors', duration_ms: 300000, is_featured: false, album_id: 'al9', primary_artist: 'art1', release_date: D('2013-01-01') },

  // FORCE_CANONICAL: this id is always pinned to a specific canonical.
  { id: '2iWljCivLjWnLkwItPZdRV', title: 'Unique Force Track', duration_ms: 180000, is_featured: false, album_id: 'al10', primary_artist: 'art1', release_date: D('2007-01-01') },
];

test('dedupCanonical groups duplicates and picks the right canonical', async () => {
  const client = makeFakeClient(ROWS);
  const { canonicalCount, aliasCount } = await dedupCanonical(client);
  const a = client.assignments;

  // my love: older own track is canonical
  assert.equal(a['bbb'], 'aaa', 'single version should alias to the original');

  // forever: own beats featured regardless of release date
  assert.equal(a['hhh'], 'iii', 'featured copy should alias to the own version');

  // 2 canonical groups, 2 aliases linked (force overrides are separate)
  assert.equal(canonicalCount, 2);
  assert.equal(aliasCount, 2);
});

test('dedupCanonical keeps different-duration same-title tracks separate', async () => {
  const client = makeFakeClient(ROWS);
  await dedupCanonical(client);
  const a = client.assignments;
  assert.equal(a['ccc'], undefined, '234026ms Give It To Me must not merge');
  assert.equal(a['ddd'], undefined, '212013ms Give It To Me must not merge');
});

test('dedupCanonical keeps (Live) versions separate from studio', async () => {
  const client = makeFakeClient(ROWS);
  await dedupCanonical(client);
  const a = client.assignments;
  assert.equal(a['eee'], undefined);
  assert.equal(a['fff'], undefined);
});

test('dedupCanonical respects NEVER_MERGE', async () => {
  const client = makeFakeClient(ROWS);
  await dedupCanonical(client);
  const a = client.assignments;
  assert.equal(a['6ToFxXRBtl5TJFEyIoYK3f'], undefined, 'never-merge id stays independent');
  assert.equal(a['jjj'], undefined, 'its sibling has nothing to merge into');
});

test('dedupCanonical applies FORCE_CANONICAL overrides', async () => {
  const client = makeFakeClient(ROWS);
  await dedupCanonical(client);
  assert.equal(client.assignments['2iWljCivLjWnLkwItPZdRV'], '13X42np3KJr0o2LkK1MG76');
});

test('dedupCanonical handles an empty catalog without error', async () => {
  const client = makeFakeClient([]);
  const { canonicalCount, aliasCount } = await dedupCanonical(client);
  assert.equal(canonicalCount, 0);
  assert.equal(aliasCount, 0);
});
