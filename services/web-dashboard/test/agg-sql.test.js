'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { artistLatestAggCTE, artistCachedAggCTE } = require('../lib/agg-sql');

test('cached artist aggregate reads only recent indexed materialized rows', () => {
  const sql = artistCachedAggCTE('s.primary_artist = $1');
  assert.match(sql, /FROM chart_daily_streams c/);
  assert.match(sql, /ORDER BY c\.recorded_date DESC\s+LIMIT 10/);
  assert.doesNotMatch(sql, /FROM stream_stats/);
  assert.match(sql, /AS day_gain/);
});

test('cached artist aggregate bounds caller-provided history depth', () => {
  assert.match(artistCachedAggCTE('TRUE', 1), /LIMIT 8/);
  assert.match(artistCachedAggCTE('TRUE', 500), /LIMIT 31/);
});

test('live artist aggregate remains the raw-history fallback', () => {
  const sql = artistLatestAggCTE('s.primary_artist = $1');
  assert.match(sql, /FROM stream_stats ss/);
  assert.doesNotMatch(sql, /FROM chart_daily_streams c/);
});
