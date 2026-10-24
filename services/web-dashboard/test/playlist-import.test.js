'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { playlistId, creditType, inspectTracks, applyTracks, JT } = require('../lib/playlist-import');
const { playlistImportRoutes } = require('../lib/playlist-import-routes');
const { adminGuard } = require('../lib/security');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const artist = { artist_id: '45dkTj5sMRSjrmBSBeiHym', name: 'Tate McRae' };
const track = (overrides = {}) => ({ id: '5SV4f2XVyPvDQJFPLnQTVO', name: 'Remembering (feat. Tate McRae)',
  albumId: '1Jm26vxE26y9ud83DfwnZK', albumName: 'Soundtrack', release: '2018-12-12', coverUrl: null,
  artistUris: ['spotify:artist:0G8iubd5gKv5vdPnmHRaxT'], playcount: 6720590,
  duration_ms: 276600, track_number: 7, observed_date: '2026-10-24', ...overrides });
const jobId = '12345678-1234-4234-8234-123456789012';
const job = (tracks) => ({ id: jobId, artist_id: artist.artist_id, playlist_id: '4mE4DY8BGeBb49SAyfy36V',
  requested_role: 'admin', status: 'ready', updated_at: new Date(), tracks });

function database(existing = []) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT artist_id, name')) return { rows: [artist] };
    if (sql.includes('FROM songs s LEFT JOIN songs h')) return { rows: existing };
    return { rows: [], rowCount: 1 };
  } };
}

test('playlist inputs accept Spotify IDs and links but never arbitrary hosts or paths', () => {
  const id = '4mE4DY8BGeBb49SAyfy36V';
  for (const input of [id, `spotify:playlist:${id}`, `https://open.spotify.com/playlist/${id}?si=abc`, `https://open.spotify.com/intl-tr/playlist/${id}`]) assert.equal(playlistId(input), id);
  for (const input of [null, [id], `https://evil.example/playlist/${id}`, `https://open.spotify.com.evil.example/playlist/${id}`,
    `https://user:password@open.spotify.com/playlist/${id}`, `http://open.spotify.com/playlist/${id}`,
    `https://open.spotify.com/track/${id}`, `https://open.spotify.com/playlist/${id}/bad`, 'x'.repeat(2049)]) assert.equal(playlistId(input), null);
});

test('artist credits and explicit title credits stay distinct; ordinary title mentions do not match', () => {
  assert.equal(creditType(track(), artist), 'title');
  assert.equal(creditType(track({ artistUris: ['spotify:artist:' + artist.artist_id] }), artist), 'artist');
  assert.equal(creditType(track({ name: 'Tate McRae tribute' }), artist), 'none');
  assert.equal(creditType(track({ name: 'Example (feat. Tate McRae impersonator)' }), artist), 'none');
  assert.equal(creditType(track({ name: 'Example (with A+B)' }), { ...artist, name: 'A+B' }), 'title');
});

test('preview resolves aliases and prevents hidden, unrelated and protected songs from being selected', async () => {
  const input = [track(), track({ id: '0xMfZuPe4ewkCmMehvJCj4', name: 'Unrelated' }), track({ id: '0NhRVBVUBU8R7o40Bxoi2m', artistUris: ['spotify:artist:' + artist.artist_id], playcount: null })];
  const db = database([{ id: input[0].id, head_id: '4NMm8Jp3Cx27D6s77g0abK', linked: true, primary_artist: 'spotify:artist:other' }]);
  const result = await inspectTracks(db, input, artist, 'admin');
  assert.deepEqual(result.map(t => t.state), ['included', 'unrelated', 'new']);
  assert.equal(result[0].head_id, '4NMm8Jp3Cx27D6s77g0abK');
  assert.equal(result[2].selectable, true);
  assert.equal((await inspectTracks(database([{ id: input[0].id, hidden: true }]), [input[0]], artist, 'admin'))[0].state, 'hidden');
  assert.equal((await inspectTracks(database([{ id: input[0].id, primary_artist: 'spotify:artist:' + JT }]), [input[0]], artist, 'secadmin'))[0].state, 'restricted');
  assert.equal((await inspectTracks(database(), [track({ artistUris: ['spotify:artist:' + JT, 'spotify:artist:' + artist.artist_id] })], artist, 'secadmin'))[0].state, 'restricted');
});

test('new songs get a first observation while unavailable songs never get fabricated zeros', async () => {
  const items = [track(), track({ id: '0xMfZuPe4ewkCmMehvJCj4', name: 'Worth It', artistUris: ['spotify:artist:' + artist.artist_id], playcount: null })];
  const db = database();
  assert.deepEqual(await applyTracks(db, job(items), items.map(t => t.id), 'admin'), { added: 2, linked: 0, already_included: 0, unavailable: 1 });
  const snapshots = db.calls.filter(c => c.sql.includes('INSERT INTO stream_stats'));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].params, [items[0].id, 6720590, '2026-10-24']);
  assert.equal(db.calls.filter(c => c.sql.includes('INSERT INTO extra_artist_songs')).length, 2);
  assert.equal(db.calls.filter(c => c.sql.includes('INSERT INTO extra_scrape_albums')).length, 2);
});

test('linking an existing alias preserves its history and links the canonical head', async () => {
  const db = database([{ id: track().id, head_id: '4NMm8Jp3Cx27D6s77g0abK', primary_artist: 'spotify:artist:other' }]);
  const result = await applyTracks(db, job([track()]), [track().id], 'admin');
  assert.equal(result.linked, 1);
  assert.ok(!db.calls.some(c => /INSERT INTO (songs|stream_stats)/.test(c.sql)));
  assert.match(db.calls.find(c => c.sql.includes('INSERT INTO extra_artist_songs')).sql, /COALESCE\(canonical_id,id\)/);
});

test('apply rechecks hidden state, refuses injected selections and skips songs added after preview', async () => {
  for (const db of [database([{ id: track().id, hidden: true }]), database([{ id: track().id, primary_artist: 'spotify:artist:' + JT }])]) {
    await assert.rejects(applyTracks(db, job([track()]), [track().id], 'secadmin'), { status: 409 });
    assert.ok(!db.calls.some(c => c.sql.includes('INSERT INTO')));
  }
  await assert.rejects(applyTracks(database(), job([track()]), ['0xMfZuPe4ewkCmMehvJCj4'], 'admin'), { status: 409 });
  await assert.rejects(applyTracks(database(), job([track()]), [track().id, track().id], 'admin'), { status: 400 });
  const db = database([{ id: track().id, primary_artist: 'spotify:artist:' + artist.artist_id }]);
  assert.equal((await applyTracks(db, job([track()]), [track().id], 'admin')).already_included, 1);
  assert.ok(!db.calls.some(c => c.sql.includes('INSERT INTO')));
});

test('playlist reader excludes recommendations, deduplicates entries and rejects incomplete or oversized playlists', async () => {
  const sandbox = { require: name => name === './spotify' ? {} : name === 'dotenv' ? { config() {} } : { playlistId },
    module: { exports: {} }, __dirname: '/isolated', setTimeout: fn => setImmediate(fn), console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../spotify-scraper/read-playlist.js'), 'utf8'), sandbox);
  const { readPlaylist } = sandbox.module.exports;
  class Page extends EventEmitter {
    constructor(content) { super(); this.content = content; }
    async goto() {
      this.emit('response', { url: () => 'https://api-partner.spotify.com/pathfinder/v2/query', json: async () => ({ data: {
        playlistV2: { content: this.content }, recommendations: { uri: 'spotify:track:0NhRVBVUBU8R7o40Bxoi2m', name: 'Not on this playlist' },
      } }) });
    }
    async evaluate() { return false; }
  }
  const item = (uid, id) => ({ uid, itemV2: { data: { uri: 'spotify:track:' + id, name: 'Playlist song' } } });
  const content = { totalCount: 2, items: [item('first', track().id), item('second', track().id)] };
  const result = await readPlaylist(new Page(content), job([]).playlist_id, { maxTracks: 50 });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, track().id);
  await assert.rejects(readPlaylist(new Page({ ...content, totalCount: 3 }), job([]).playlist_id), /completely/);
  await assert.rejects(readPlaylist(new Page({ ...content, totalCount: 51 }), job([]).playlist_id, { maxTracks: 50 }), /at most 50/);
});

test('scraping a pinned feature updates just the approved track and ordinary credited tracks', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../spotify-scraper/scraper.js'), 'utf8');
  const fn = source.slice(source.indexOf('async function processAlbum('), source.indexOf('\nasync function scrapeArtist('));
  const rows = [];
  const sandbox = { BLACKLISTED_TRACK_IDS: new Set(), ARTIST_SEARCH_NAMES: {}, isCoverOrTribute: () => false,
    fetchAlbumTracks: async () => [
      { id: track().id, title: track().name, artistUris: track().artistUris, playCount: 6720591 },
      { id: 'unrelated', title: 'Another soundtrack song', artistUris: track().artistUris, playCount: 50000 },
      { id: 'credited', title: 'Credited song', artistUris: ['spotify:artist:' + artist.artist_id], playCount: 500000 },
    ], upsertSongsBatch: async (_, songs) => rows.push(...songs), upsertStreamStatsBatch: async (_, streams) => streams.length, console };
  vm.runInNewContext(fn + '\nthis.processAlbum = processAlbum;', sandbox);
  const stats = { tracksProcessed: 0, streamsUpdated: 0 };
  const kept = await sandbox.processAlbum({}, {}, { id: track().albumId, title: 'Soundtrack', is_featured: true },
    'spotify:artist:' + artist.artist_id, stats, false, new Set([track().id]));
  assert.equal(kept, 2);
  assert.deepEqual(rows.map(r => r.id), [track().id, 'credited']);
  assert.equal(stats.streamsUpdated, 2);
});

test('admin routes enforce authorization, queue previews without importing and make apply retries idempotent', async () => {
  const calls = [];
  let dispatched = null;
  let refreshes = 0;
  const applied = { ...job([]), status: 'applied', result: { added: 2 } };
  const client = { release() {}, async query(sql, params) {
    calls.push(sql);
    if (sql.includes('SELECT artist_id FROM tracked_artists')) return { rows: [artist] };
    if (sql.includes('FROM playlist_imports WHERE id=$1')) return { rows: [applied] };
    return { rows: [], rowCount: 0 };
  } };
  const app = express(); app.use(express.json());
  app.use('/imports', playlistImportRoutes({ pool: { query: client.query, connect: async () => client },
    requireAdmin: adminGuard(pass => ['admin', 'secadmin'].includes(pass) ? pass : null),
    dispatch: async id => { dispatched = id; }, refresh: async () => { refreshes++; } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (route, role, body) => fetch(base + route, { method: 'POST', headers: { 'X-Admin-Passcode': role, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await send('/imports', '', {})).status, 403);
    assert.equal((await send('/imports', 'secadmin', { artist_id: JT, playlist_url: job([]).playlist_id })).status, 403);
    assert.equal((await send('/imports', 'admin', { artist_id: artist.artist_id, playlist_url: 'https://evil.example/playlist/anything' })).status, 400);
    assert.equal((await send('/imports', 'admin', { artist_id: artist.artist_id, playlist_url: job([]).playlist_id })).status, 202);
    assert.match(dispatched, /^[0-9a-f-]{36}$/);
    assert.ok(!calls.some(sql => sql.includes('INSERT INTO songs')));
    assert.equal((await send(`/imports/${jobId}/apply`, 'secadmin', { song_ids: [track().id] })).status, 403);
    const response = await send(`/imports/${jobId}/apply`, 'admin', { song_ids: [track().id] });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, { added: 2 });
    assert.equal(refreshes, 1);
    assert.ok(!calls.some(sql => sql.includes('INSERT INTO songs')));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
