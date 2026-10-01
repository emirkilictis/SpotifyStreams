'use strict';
// Unit tests for pickPartialDebutFolds (services/spotify-scraper/db.js): which
// new releases get their partial first reading folded into the next day.
// Pure function, no database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickPartialDebutFolds } = require('../../spotify-scraper/db');

const TODAY = '2026-10-03';
const row = (over) => ({
  head: 'h', title: 't', release_date: '2026-10-01',
  d1: '2026-10-01', c1: 10000, d2: '2026-10-02', c2: 1010000, ...over,
});
const folds = (r) => pickPartialDebutFolds([r], TODAY).length === 1;

test('a few hours on release day, then a full day: folded', () => {
  assert.equal(folds(row()), true);
});

test('a real full first day is left alone', () => {
  // 700K then +1M: the first day is 70% of the second, not a sliver of it.
  assert.equal(folds(row({ c1: 700000, c2: 1700000 })), false);
});

test('the 25% line', () => {
  assert.equal(folds(row({ c1: 240000, c2: 1240000 })), true);   // 24%
  assert.equal(folds(row({ c1: 260000, c2: 1260000 })), false);  // 26%
});

test('a two-day gap is compared per day', () => {
  // +2M over two days = 1M a day; 10K is still a sliver.
  assert.equal(folds(row({ d2: '2026-10-03', c2: 2010000 })), true);
  // 400K against 1M a day: 40%, not partial.
  assert.equal(folds(row({ c1: 400000, d2: '2026-10-03', c2: 2400000 })), false);
});

test('a gap longer than two days is not folded', () => {
  assert.equal(folds(row({ d2: '2026-10-04', c2: 3010000 })), false);
});

test('only a reading on (or one day around) release day can be partial', () => {
  assert.equal(folds(row({ d1: '2026-09-30', d2: '2026-10-01' })), true);  // -1
  assert.equal(folds(row({ d1: '2026-10-02', d2: '2026-10-03' })), true);  // +1
  assert.equal(folds(row({ d1: '2026-10-03', d2: '2026-10-04' })), false); // +2
});

test('old first readings are never rewritten', () => {
  assert.equal(pickPartialDebutFolds([row()], '2026-10-20').length, 0);
});

test('no growth, no count or no release date: nothing to fold', () => {
  assert.equal(folds(row({ c2: 10000 })), false);
  assert.equal(folds(row({ c1: 0 })), false);
  assert.equal(folds(row({ release_date: null })), false);
});
