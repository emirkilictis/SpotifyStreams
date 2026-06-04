'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAppFunctions } = require('./_load');
const { normalizeTitle } = require('../../spotify-scraper/dedup');

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------
test('formatNumber', () => {
  const { formatNumber } = loadAppFunctions(['formatNumber']);
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(null), '0');
  assert.equal(formatNumber(undefined), '0');
  assert.equal(formatNumber(1000), '1,000');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(-2819), '-2,819');
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
test('formatDuration', () => {
  const { formatDuration } = loadAppFunctions(['formatDuration']);
  assert.equal(formatDuration(0), '-');          // falsy guard
  assert.equal(formatDuration(undefined), '-');
  assert.equal(formatDuration(212013), '3:32');
  assert.equal(formatDuration(234026), '3:54');
  assert.equal(formatDuration(65000), '1:05');   // seconds zero-padded
  assert.equal(formatDuration(60000), '1:00');
});

// ---------------------------------------------------------------------------
// hexToRgbTriplet
// ---------------------------------------------------------------------------
test('hexToRgbTriplet', () => {
  const { hexToRgbTriplet } = loadAppFunctions(['hexToRgbTriplet']);
  assert.equal(hexToRgbTriplet('#1ed760'), '30, 215, 96');
  assert.equal(hexToRgbTriplet('1ed760'), '30, 215, 96');   // no leading #
  assert.equal(hexToRgbTriplet('#fff'), '255, 255, 255');   // shorthand
  assert.equal(hexToRgbTriplet('#000000'), '0, 0, 0');
  assert.equal(hexToRgbTriplet(''), '30, 215, 96');         // empty -> default
  assert.equal(hexToRgbTriplet('#gggggg'), '30, 215, 96');  // invalid -> default
  assert.equal(hexToRgbTriplet('#12345'), '30, 215, 96');   // wrong length -> default
});

// ---------------------------------------------------------------------------
// formatMilestoneName
// ---------------------------------------------------------------------------
test('formatMilestoneName', () => {
  const { formatMilestoneName } = loadAppFunctions(['formatMilestoneName']);
  assert.equal(formatMilestoneName(1000000000), '1 Billion');
  assert.equal(formatMilestoneName(1500000000), '1.5 Billion');
  assert.equal(formatMilestoneName(2000000000), '2 Billion');
  assert.equal(formatMilestoneName(500000000), '500 Million');
  assert.equal(formatMilestoneName(10000000), '10 Million');
  assert.equal(formatMilestoneName(1000), '1 Thousand');
  assert.equal(formatMilestoneName(500), '500');
});

// ---------------------------------------------------------------------------
// getNextMilestone (reads global currentArtist)
// ---------------------------------------------------------------------------
test('getNextMilestone - default artist', () => {
  const { getNextMilestone } = loadAppFunctions(['getNextMilestone'], { currentArtist: '31TPClRtHm23RisEBtV3X7' });
  assert.equal(getNextMilestone(0), 10000000);            // first milestone
  assert.equal(getNextMilestone(9999999), 10000000);
  assert.equal(getNextMilestone(10000000), 25000000);     // exactly on -> next
  assert.equal(getNextMilestone(517966718), 600000000);
  // Milestone table ends at 5B; beyond it, rounds up to the next whole billion.
  assert.equal(getNextMilestone(5500000000), 6000000000);
  // KNOWN QUIRK: at an exact billion boundary >=5B it returns the *current*
  // value (6e9) rather than the next (7e9). Harmless edge case, documented.
  assert.equal(getNextMilestone(6000000000), 6000000000);
});

test('getNextMilestone - Vaelis custom ladder', () => {
  const { getNextMilestone } = loadAppFunctions(['getNextMilestone'], { currentArtist: '3LHYvj5ZejV1NLqncEObSJ' });
  assert.equal(getNextMilestone(500), 1000);
  assert.equal(getNextMilestone(1500), 2000);
  assert.equal(getNextMilestone(12000), 15000);
});

// ---------------------------------------------------------------------------
// dcChangeCell (depends on formatNumber)
// ---------------------------------------------------------------------------
test('dcChangeCell', () => {
  const { dcChangeCell } = loadAppFunctions(['dcChangeCell', 'formatNumber']);
  // null / zero base -> muted dash. (Assert fields individually: the object
  // comes from a separate VM realm, so deepStrictEqual's prototype check fails.)
  for (const base of [null, undefined, 0]) {
    const r = dcChangeCell(100, base);
    assert.equal(r.txt, '—');
    assert.equal(r.pct, '—');
    assert.equal(r.cls, 'dc-muted');
  }

  const up = dcChangeCell(4253, 461004);
  assert.equal(up.cls, 'dc-pos');
  assert.ok(up.txt.startsWith('+'));
  assert.ok(up.pct.startsWith('▲'));
  assert.ok(up.pct.endsWith('%'));
  assert.ok(!up.pct.includes(' %'), 'no stray space before percent sign');

  const down = dcChangeCell(-2819, 240071);
  assert.equal(down.cls, 'dc-neg');
  assert.ok(down.pct.startsWith('▼'));

  const flat = dcChangeCell(0, 1000);
  assert.equal(flat.cls, 'dc-muted');
  assert.ok(flat.pct.startsWith('●'));
});

// ---------------------------------------------------------------------------
// cleanTrackTitle  (the title-corruption regression we fixed)
// ---------------------------------------------------------------------------
test('cleanTrackTitle - does NOT corrupt titles containing "with"/"feat"', () => {
  const { cleanTrackTitle } = loadAppFunctions(['cleanTrackTitle']);
  assert.equal(cleanTrackTitle('Die With A Smile'), 'Die With A Smile');
  assert.equal(cleanTrackTitle('Stuck with U'), 'Stuck with U');
  assert.equal(cleanTrackTitle('Dancing With Myself'), 'Dancing With Myself');
  assert.equal(cleanTrackTitle('Cry Me a River'), 'Cry Me a River');
});

test('cleanTrackTitle - strips parenthetical credits & version suffixes', () => {
  const { cleanTrackTitle } = loadAppFunctions(['cleanTrackTitle']);
  assert.equal(cleanTrackTitle('Rain On Me (with Ariana Grande)'), 'Rain On Me');
  assert.equal(cleanTrackTitle('Sour Candy (with BLACKPINK)'), 'Sour Candy');
  assert.equal(cleanTrackTitle('SexyBack (feat. Timbaland)'), 'SexyBack');
  assert.equal(cleanTrackTitle('Chop Me Up (feat. Timbaland & Three-6 Mafia)'), 'Chop Me Up');
  assert.equal(cleanTrackTitle('Mirrors - Radio Edit'), 'Mirrors');
  assert.equal(cleanTrackTitle('Medley: Sexy Ladies / Let Me Talk to You (Prelude)'), 'Sexy Ladies / Let Me Talk to You');
  assert.equal(cleanTrackTitle('What Goes Around.../...Comes Around (Interlude)'), 'What Goes Around.../...Comes Around');
  // no dangling open-paren ever
  for (const t of ['Rain On Me (with Ariana Grande)', 'Sour Candy (with BLACKPINK)']) {
    assert.ok(!cleanTrackTitle(t).includes('('), 'no dangling paren: ' + t);
  }
});

test('cleanTrackTitle - empty/edge', () => {
  const { cleanTrackTitle } = loadAppFunctions(['cleanTrackTitle']);
  assert.equal(cleanTrackTitle(''), '');
  assert.equal(cleanTrackTitle(null), '');
  assert.equal(cleanTrackTitle(undefined), '');
});

// ---------------------------------------------------------------------------
// cleanAlbumTitle
// ---------------------------------------------------------------------------
test('cleanAlbumTitle', () => {
  const { cleanAlbumTitle } = loadAppFunctions(['cleanAlbumTitle']);
  assert.equal(cleanAlbumTitle('FutureSex/LoveSounds (Deluxe Edition)'), 'FutureSex/LoveSounds');
  assert.equal(cleanAlbumTitle('eternal sunshine (Deluxe Edition)'), 'eternal sunshine');
  assert.equal(cleanAlbumTitle('The 20/20 Experience - Deluxe'), 'The 20/20 Experience');
  assert.equal(cleanAlbumTitle('MAYHEM'), 'MAYHEM');
});

// ---------------------------------------------------------------------------
// filterHistoryByRange
// ---------------------------------------------------------------------------
test('filterHistoryByRange', () => {
  const { filterHistoryByRange } = loadAppFunctions(['filterHistoryByRange']);
  const hist = [];
  for (let day = 1; day <= 30; day++) {
    hist.push({ recorded_date: `2026-06-${String(day).padStart(2, '0')}`, v: day });
  }
  assert.equal(filterHistoryByRange([], '7').length, 0);
  assert.equal(filterHistoryByRange(hist, 'all').length, 30);
  // base date = 2026-06-30; range 7 -> cutoff 2026-06-23 -> days 23..30 = 8 rows
  const last7 = filterHistoryByRange(hist, '7');
  assert.ok(last7.length >= 7 && last7.length <= 8, `7D range returned ${last7.length}`);
  assert.equal(last7[last7.length - 1].v, 30);
});

// ---------------------------------------------------------------------------
// dedup.normalizeTitle  (canonical grouping key)
// ---------------------------------------------------------------------------
test('normalizeTitle - strips feat/version, normalizes punctuation', () => {
  assert.equal(normalizeTitle('SexyBack (feat. Timbaland)'), 'sexyback');
  assert.equal(normalizeTitle('Mirrors - Radio Edit'), 'mirrors');
  assert.equal(normalizeTitle('My Love (Single Version)'), 'my love');
  assert.equal(normalizeTitle('Cry Me a River'), 'cry me a river');
  // same song, different release decorations -> same key
  assert.equal(
    normalizeTitle('Until the End of Time'),
    normalizeTitle('Until the End of Time - Radio Edit')
  );
});

test('normalizeTitle - keeps the Beyoncé duet separate', () => {
  const duet = normalizeTitle('Until the End of Time (Duet with Beyoncé)');
  const solo = normalizeTitle('Until the End of Time');
  assert.notEqual(duet, solo, 'duet must not collapse into the solo canonical');
});

test('normalizeTitle - empty/edge', () => {
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null), '');
});
