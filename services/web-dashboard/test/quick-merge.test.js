'use strict';
// Unit tests for pickQuickMerges (services/spotify-scraper/dedup.js): the
// per-artist merge the scraper runs mid-scrape. Pure function, no database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickQuickMerges } = require('../../spotify-scraper/dedup');

const JT = 'spotify:artist:31TPClRtHm23RisEBtV3X7';
const TIMBALAND = 'spotify:artist:5Y5TRrQiqgUO4S36tzjIRZ'; // untracked -> JT/collab bucket
const TAYLOR = 'spotify:artist:06HL4z0CvFAxyc27GXpf02';
const NAMED = new Set([TAYLOR]);
const DAY = '2026-09-15';

const fresh = (o) => ({ duration_ms: 234000, primary_artist: JT, d: DAY, ...o });
const old = (o) => ({ duration_ms: 234000, primary_artist: JT, d: DAY, ...o });

test('merges the 2026-09-15 compilation copies onto the heads we already had', () => {
  const picks = pickQuickMerges(
    [
      fresh({ id: 'giveNew', title: 'Give It To Me', streams: '551023880' }),
      fresh({ id: 'otherNew', title: 'The Other Side', streams: '195840497' }),
      fresh({ id: 'carryNew', title: 'Carry Out (Featuring Justin Timberlake) - New Version', streams: '275533737' }),
    ],
    [
      // An alias of the Shock Value head carries the same reading: resolve to its head.
      old({ id: 'giveClassOf07', head_id: 'giveHead', title: 'Give It To Me', primary_artist: TIMBALAND, streams: '551023880' }),
      old({ id: 'otherHead', head_id: 'otherHead', title: 'The Other Side (from Trolls World Tour)', streams: '195840497' }),
      old({ id: 'carryHead', head_id: 'carryHead', title: 'Carry Out (Featuring Justin Timberlake)', primary_artist: TIMBALAND, streams: '275533737' }),
    ],
    NAMED
  );
  assert.deepEqual(Object.fromEntries(picks), { giveNew: 'giveHead', otherNew: 'otherHead', carryNew: 'carryHead' });
});

test('needs the same count on the same day', () => {
  const picks = pickQuickMerges(
    [fresh({ id: 'n', title: 'Just Sing', streams: '37925741' })],
    [
      old({ id: 'a', head_id: 'a', title: 'Just Sing', streams: '37925742' }),
      old({ id: 'b', head_id: 'b', title: 'Just Sing', streams: '37925741', d: '2026-09-14' }),
    ],
    NAMED
  );
  assert.equal(picks.size, 0);
});

test('stays below EXACT_MERGE_FLOOR', () => {
  const picks = pickQuickMerges(
    [fresh({ id: 'n', title: 'Deep Cut', streams: '420000' })],
    [old({ id: 'o', head_id: 'o', title: 'Deep Cut', streams: '420000' })],
    NAMED
  );
  assert.equal(picks.size, 0);
});

test('never merges across dashboard buckets', () => {
  const picks = pickQuickMerges(
    [fresh({ id: 'n', title: 'Forever', streams: '5000000', primary_artist: TAYLOR })],
    [old({ id: 'o', head_id: 'o', title: 'Forever', streams: '5000000', primary_artist: JT })],
    NAMED
  );
  assert.equal(picks.size, 0);
});

test('keeps version tags, length and unrelated titles apart', () => {
  const picks = pickQuickMerges(
    [
      fresh({ id: 'live', title: 'Mirrors (Live)', streams: '9000000' }),
      fresh({ id: 'short', title: 'Holy Grail', streams: '8000000', duration_ms: 200000 }),
      fresh({ id: 'other', title: 'Sexyback', streams: '7000000' }),
    ],
    [
      old({ id: 'm', head_id: 'm', title: 'Mirrors', streams: '9000000' }),
      old({ id: 'h', head_id: 'h', title: 'Holy Grail', streams: '8000000', duration_ms: 230000 }),
      old({ id: 'x', head_id: 'x', title: 'Cry Me a River', streams: '7000000' }),
    ],
    NAMED
  );
  assert.equal(picks.size, 0);
});

test('two different heads at the same reading: leave it to the full dedup', () => {
  const picks = pickQuickMerges(
    [fresh({ id: 'n', title: 'Just Sing', streams: '37925741' })],
    [
      old({ id: 'a', head_id: 'headA', title: 'Just Sing', streams: '37925741' }),
      old({ id: 'b', head_id: 'headB', title: 'Just Sing (Trolls World Tour)', streams: '37925741' }),
    ],
    NAMED
  );
  assert.equal(picks.size, 0);
});

test('respects NEVER_MERGE and manual rules', () => {
  const picks = pickQuickMerges(
    [
      fresh({ id: '6ToFxXRBtl5TJFEyIoYK3f', title: 'Mirrors - Radio Edit', streams: '300000000' }),
      fresh({ id: 'ruled', title: 'Suit & Tie', streams: '600000000' }),
    ],
    [
      old({ id: 'r', head_id: 'r', title: 'Mirrors - Radio Edit', streams: '300000000' }),
      old({ id: 's', head_id: 's', title: 'Suit & Tie', streams: '600000000' }),
    ],
    NAMED,
    new Set(['ruled'])
  );
  assert.equal(picks.size, 0);
});
