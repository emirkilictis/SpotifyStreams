'use strict';
// Unit tests for the canonical deduplication logic (services/spotify-scraper/dedup.js).
// Drives the real dedupCanonical() with a fake pg client: the SELECT returns
// canned song rows, and every "UPDATE songs SET canonical_id = $1 WHERE id = $2"
// is captured as an alias -> canonical assignment. No database needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dedupCanonical } = require('../../spotify-scraper/dedup');

// Tüm canlı şarkıların son snapshot tarihi; donmuşlar bundan 2+ gün geride.
const TODAY = new Date('2026-06-13');
const FROZEN_DATE = new Date('2026-05-26');

function makeFakeClient(rows) {
  const assignments = {}; // aliasId -> canonicalId
  const client = {
    assignments,
    async query(text, params) {
      const t = String(text).replace(/\s+/g, ' ').trim();
      if (/SELECT MAX\(recorded_date\) AS max_d/i.test(t)) {
        return { rows: [{ max_d: TODAY }] };
      }
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
// Canlı linked kopya: sayaç drift toleransı içinde, snapshot bugünden.
const live = (streams) => ({ max_streams: streams, last_date: TODAY });
const frozen = (streams) => ({ max_streams: streams, last_date: FROZEN_DATE });

// Representative fixture covering each grouping rule. Distinct normalized
// titles keep the groups from interfering with one another.
const ROWS = [
  // "my love": linked kopya — sayaçlar drift içinde (%0.05) -> merge; older own wins.
  { id: 'aaa', title: 'My Love', duration_ms: 270000, is_featured: false, album_id: 'al1', primary_artist: 'art1', release_date: D('2006-09-11'), ...live(100_000_000) },
  { id: 'bbb', title: 'My Love (Single Version)', duration_ms: 271000, is_featured: false, album_id: 'al2', primary_artist: 'art1', release_date: D('2007-01-01'), ...live(100_050_000) },

  // "give it to me": same title, durations 22s apart -> must NOT merge.
  { id: 'ccc', title: 'Give It To Me', duration_ms: 234026, is_featured: true, album_id: 'al3', primary_artist: 'art1', release_date: D('2007-01-01'), ...live(200) },
  { id: 'ddd', title: 'Give It To Me', duration_ms: 212013, is_featured: true, album_id: 'al3', primary_artist: 'art1', release_date: D('2007-01-01'), ...live(200) },

  // "forever": own (is_featured=false) beats featured even though it's newer.
  { id: 'hhh', title: 'Forever', duration_ms: 200000, is_featured: true, album_id: 'al4', primary_artist: 'art1', release_date: D('2010-01-01'), ...live(300) },
  { id: 'iii', title: 'Forever', duration_ms: 200000, is_featured: false, album_id: 'al5', primary_artist: 'art1', release_date: D('2012-01-01'), ...live(300) },

  // "halo": a (Live) version must stay separate from the studio cut.
  { id: 'eee', title: 'Halo', duration_ms: 240000, is_featured: false, album_id: 'al6', primary_artist: 'art1', release_date: D('2008-01-01'), ...live(400) },
  { id: 'fff', title: 'Halo (Live)', duration_ms: 240000, is_featured: false, album_id: 'al7', primary_artist: 'art1', release_date: D('2009-01-01'), ...live(400) },

  // "miroh": bağımsız sayaçlı canlı re-recording (SKZ vakası) -> must NOT merge.
  { id: 'kkk', title: 'MIROH', duration_ms: 300000, is_featured: false, album_id: 'al8', primary_artist: 'art1', release_date: D('2019-01-01'), ...live(197_900_000) },
  { id: 'lll', title: 'MIROH', duration_ms: 300000, is_featured: false, album_id: 'al9', primary_artist: 'art1', release_date: D('2020-01-01'), ...live(56_300_000) },

  // "cry me a river": sayaçlar farklı AMA biri donmuş (FSLS standard vakası) -> merge.
  { id: 'mmm', title: 'Cry Me A River', duration_ms: 290000, is_featured: false, album_id: 'al10', primary_artist: 'art1', release_date: D('2002-01-01'), ...live(1_000_000_000) },
  { id: 'nnn', title: 'Cry Me A River', duration_ms: 290000, is_featured: false, album_id: 'al11', primary_artist: 'art1', release_date: D('2003-01-01'), ...frozen(900_000_000) },

  // "spotlight": aynı title+duration ama FARKLI dashboard bucket'ları -> must NOT merge.
  { id: 'sk1', title: 'Spotlight', duration_ms: 210000, is_featured: false, album_id: 'al12', primary_artist: 'spotify:artist:2dIgFjalVxs4ThymZ67YCE', release_date: D('2018-01-01'), ...live(500) },
  { id: 'gg1', title: 'Spotlight', duration_ms: 210000, is_featured: false, album_id: 'al13', primary_artist: 'spotify:artist:1HY2Jd0NmPuamShAr6KMms', release_date: D('2019-01-01'), ...live(500) },

  // NEVER_MERGE id stays independent even with an identical sibling.
  { id: '6ToFxXRBtl5TJFEyIoYK3f', title: 'Mirrors', duration_ms: 300000, is_featured: false, album_id: 'al8', primary_artist: 'art1', release_date: D('2013-01-01'), ...live(700) },
  { id: 'jjj', title: 'Mirrors', duration_ms: 300000, is_featured: false, album_id: 'al9', primary_artist: 'art1', release_date: D('2013-01-01'), ...live(700) },

  // FORCE_CANONICAL: this id is always pinned to a specific canonical.
  { id: '2iWljCivLjWnLkwItPZdRV', title: 'Unique Force Track', duration_ms: 180000, is_featured: false, album_id: 'al10', primary_artist: 'art1', release_date: D('2007-01-01'), ...live(800) },
];

test('dedupCanonical groups duplicates and picks the right canonical', async () => {
  const client = makeFakeClient(ROWS);
  const { canonicalCount, aliasCount } = await dedupCanonical(client);
  const a = client.assignments;

  // my love: older own track is canonical (linked pair, drift within tolerance)
  assert.equal(a['bbb'], 'aaa', 'single version should alias to the original');

  // forever: own beats featured regardless of release date
  assert.equal(a['hhh'], 'iii', 'featured copy should alias to the own version');

  // cry me a river: frozen copy merges into the live canonical
  assert.equal(a['nnn'], 'mmm', 'frozen copy should merge into canonical');

  // 3 canonical groups, 3 aliases linked (force overrides are separate)
  assert.equal(canonicalCount, 3);
  assert.equal(aliasCount, 3);
});

test('dedupCanonical keeps different-duration same-title tracks separate', async () => {
  const client = makeFakeClient(ROWS);
  await dedupCanonical(client);
  const a = client.assignments;
  assert.equal(a['ccc'], undefined, '234026ms Give It To Me must not merge');
  assert.equal(a['ddd'], undefined, '212013ms Give It To Me must not merge');
});

test('dedupCanonical keeps independent-playcount live copies separate (re-recordings)', async () => {
  const client = makeFakeClient(ROWS);
  await dedupCanonical(client);
  const a = client.assignments;
  assert.equal(a['kkk'], undefined, 'MIROH original must stay canonical');
  assert.equal(a['lll'], undefined, 'MIROH re-recording must stay canonical');
});

test('dedupCanonical never merges across dashboard artist buckets', async () => {
  const client = makeFakeClient(ROWS);
  await dedupCanonical(client);
  const a = client.assignments;
  assert.equal(a['sk1'], undefined, 'Stray Kids Spotlight must not merge with Gaga');
  assert.equal(a['gg1'], undefined, 'Gaga Spotlight must not merge with Stray Kids');
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
