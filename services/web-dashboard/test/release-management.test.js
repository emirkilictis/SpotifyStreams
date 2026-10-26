'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const express = require('express');
const { spotifyReference, releaseState, releaseManagementRoutes } = require('../lib/release-management');
const { adminGuard } = require('../lib/security');
const { inspectTracks, applyTracks } = require('../lib/playlist-import');
const { readAlbum } = require('../../spotify-scraper/read-album');
const artist = { artist_id: '5L1lO4eRHmJ7a0Q6csE5cT', name: 'LISA', active: true };
const album = '7H0c8sfmrbAbrMjYuEvWQk', song = '2odDiXqmvqGNKzHUoEGTHB';

test('Spotify diagnostics accept only album/song URLs, URIs and exact IDs', () => {
  assert.deepEqual(spotifyReference(`https://open.spotify.com/intl-tr/album/${album}?si=test`), { kind: 'album', id: album });
  assert.deepEqual(spotifyReference(`spotify:track:${song}`), { kind: 'track', id: song });
  assert.deepEqual(spotifyReference(song, 'track'), { kind: 'track', id: song });
  for (const ref of [[album], null, `https://open.spotify.com.evil.test/album/${album}`, `https://user@open.spotify.com/album/${album}`, `http://open.spotify.com/album/${album}`, `https://open.spotify.com/artist/${album}`, `https://open.spotify.com/album/${album}/extra`]) assert.equal(spotifyReference(ref), null);
});
test('diagnoses distinguish a profile filter from hidden or missing recordings', () => {
  const row = { track_count: 6, eligible_count: 6, default_eligible: false, visibility: 'auto' };
  assert.equal(releaseState(row, false).code, 'filtered');
  assert.equal(releaseState({ ...row, visibility: 'hide' }, false).code, 'hidden');
  assert.equal(releaseState({ ...row, eligible_count: 0 }, false).code, 'tracks_excluded');
  assert.equal(releaseState({ ...row, track_count: 0 }, false).code, 'empty');
  assert.equal(releaseState(row, true).code, 'visible');
});
test('album reader rejects incomplete/oversized responses and ignores a different album', async () => {
  class Page extends EventEmitter {
    constructor(payload) { super(); this.payload = payload; }
    async goto() { for (const a of this.payload) this.emit('response', { url: () => 'https://api.spotify.com/pathfinder/v2', json: async () => ({ data: { albumUnion: a } }) }); }
  }
  const payload = { uri: 'spotify:album:' + album, name: 'PRESS PLAY', date: { isoString: '2026-10-23' }, tracksV2: { totalCount: 1, items: [{ track: { uri: 'spotify:track:' + song, name: 'Song', trackNumber: 1 } }] } };
  assert.equal((await readAlbum(new Page([payload]), album)).tracks.length, 1);
  await assert.rejects(readAlbum(new Page([{ ...payload, tracksV2: { ...payload.tracksV2, totalCount: 2 } }]), album), /completely/);
  await assert.rejects(readAlbum(new Page([payload]), album, { maxTracks: 0 }), /at most/);
  assert.equal((await readAlbum(new Page([{ ...payload, uri: 'spotify:album:' + song }, payload]), album)).album.id, album);
});
test('album imports reuse an included canonical recording without writing its streams or moving it', async () => {
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT artist_id, name')) return { rows: [artist] };
    if (sql.includes('FROM songs s LEFT JOIN songs h')) return { rows: [{ id: song, head_id: song, primary_artist: 'spotify:artist:' + artist.artist_id }] };
    return { rows: [] };
  } };
  const track = { id: song, albumId: album, albumName: 'PRESS PLAY', release: '2026-10-23', coverUrl: null,
    artistUris: ['spotify:artist:' + artist.artist_id], name: 'Song', duration_ms: 200000, playcount: 123456,
    observed_date: '2026-10-25', track_number: 2 };
  assert.equal((await inspectTracks(db,[track],artist,'admin',{ albumImport: true }))[0].state, 'membership');
  const result = await applyTracks(db, { artist_id: artist.artist_id, source_type: 'album', playlist_id: album, tracks: [track] }, [song], 'admin');
  assert.equal(result.linked, 1);
  assert.ok(calls.some(x => x.sql.includes('INSERT INTO album_extra_tracks')));
  assert.ok(!calls.some(x => /INSERT INTO (songs|stream_stats)|UPDATE songs/.test(x.sql)));
});
test('release routes enforce roles, validate settings and use actual public visibility', async () => {
  const calls = [];
  let protectedAlbum = false;
  const row = { id: album, title: 'PRESS PLAY', track_count: 6, eligible_count: 6, default_eligible: false, visibility: 'auto' };
  const client = { release() {}, async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT artist_id,name')) return { rows: [artist] };
    if (sql.startsWith('SELECT albums.id')) return { rows: [row] };
    if (sql.startsWith('SELECT 1 FROM songs')) return { rows: protectedAlbum ? [{}] : [] };
    return { rows: [] };
  } };
  const app = express(); app.use(express.json());
  app.use('/releases', releaseManagementRoutes({ pool: { query: (...args) => client.query(...args), connect: async () => client },
    requireAdmin: adminGuard(pass => ['admin','secadmin'].includes(pass) ? pass : null), loadAlbums: async () => [{ album_id: album, track_count: 6 }],
    songMatch: () => 'c.primary_artist=$1', artistMatch: () => 's.primary_artist=$1', extraMembership: () => 'FALSE', hiddenIds: () => [], albumHiddenIds: () => [],
    refresh: async () => {}, ready: () => true, familyId: id => id }));
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/releases';
  const request = (path, role, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'X-Admin-Passcode': role, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('?artist='+artist.artist_id,'')).status,403);
    assert.equal((await request('?artist=31TPClRtHm23RisEBtV3X7','secadmin')).status,403);
    assert.equal((await request('?artist=a&artist=b','admin')).status,400);
    const list = await (await request('?artist='+artist.artist_id,'admin')).json();
    assert.equal(list.releases[0].state.code,'visible');
    const settings = { artist_id: artist.artist_id, visibility: 'show', sort_order: null, release_type: 'ep' };
    assert.equal((await request('/'+album+'/settings','admin',{ ...settings, sort_order: -1 })).status,400);
    protectedAlbum = true;
    assert.equal((await request('/'+album+'/settings','secadmin',settings)).status,403);
    assert.ok(!calls.some(c => c.sql.includes('INSERT INTO album_profile_settings')));
    assert.equal((await request('/'+album+'/settings','admin',settings)).status,200);
    assert.deepEqual(calls.find(c => c.sql.includes('INSERT INTO album_profile_settings')).params, [artist.artist_id,album,'show',null,'ep']);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
