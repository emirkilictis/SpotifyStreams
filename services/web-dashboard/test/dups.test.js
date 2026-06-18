'use strict';
// Unit tests for the same-stream duplicate grouping used by the admin panel's
// duplicate finder and the Health summary. Pure function — no DB needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupSameStreamDuplicates } = require('../lib/dups');

const row = (id, streams, extra = {}) => ({
  id, streams, title: id, album: 'A', duration_ms: 200000,
  primary_artist: 'spotify:artist:x', is_featured: false, canonical_id: null, ...extra,
});

test('groups two un-merged songs that share an exact stream count', () => {
  const g = groupSameStreamDuplicates([
    row('a', 1000), row('b', 1000), row('c', 5),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].streams, 1000);
  assert.deepEqual(g[0].songs.map(s => s.id).sort(), ['a', 'b']);
});

test('ignores a stream count held by only one song', () => {
  assert.equal(groupSameStreamDuplicates([row('a', 1000), row('b', 2000)]).length, 0);
});

test('skips a group that is already fully merged (single canonical)', () => {
  // both resolve to canonical "a" → nothing actionable
  const g = groupSameStreamDuplicates([
    row('a', 1000),
    row('b', 1000, { canonical_id: 'a' }),
  ]);
  assert.equal(g.length, 0);
});

test('keeps a group where one of three copies is still separate', () => {
  const g = groupSameStreamDuplicates([
    row('a', 1000),
    row('b', 1000, { canonical_id: 'a' }), // merged
    row('c', 1000),                        // still separate → actionable
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].songs.length, 3);
  assert.equal(g[0].songs.find(s => s.id === 'b').merged, true);
  assert.equal(g[0].songs.find(s => s.id === 'c').merged, false);
});

test('ignores zero / non-numeric stream counts', () => {
  assert.equal(groupSameStreamDuplicates([
    row('a', 0), row('b', 0), row('c', null), row('d', null),
  ]).length, 0);
});

test('handles pg bigint-as-string stream counts', () => {
  const g = groupSameStreamDuplicates([row('a', '14285682'), row('b', '14285682')]);
  assert.equal(g.length, 1);
  assert.equal(g[0].streams, 14285682);
});

test('returns groups sorted by stream count descending', () => {
  const g = groupSameStreamDuplicates([
    row('a', 100), row('b', 100),
    row('c', 9000), row('d', 9000),
  ]);
  assert.deepEqual(g.map(x => x.streams), [9000, 100]);
});

test('empty input yields no groups', () => {
  assert.deepEqual(groupSameStreamDuplicates([]), []);
});
