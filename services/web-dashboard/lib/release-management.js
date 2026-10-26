'use strict';
const express = require('express');
const { spotifyReference } = require('./spotify-reference');
const { albumEligibilitySql } = require('./album-eligibility');
const ID = /^[A-Za-z0-9]{22}$/;
const JT = '31TPClRtHm23RisEBtV3X7';

function releaseState(row, visible) {
  if (visible) return { code: 'visible', label: 'Visible on the profile' };
  if (row.visibility === 'hide') return { code: 'hidden', label: 'Hidden in release settings' };
  if (!row.track_count) return { code: 'empty', label: 'No songs have been collected for this release' };
  if (!row.eligible_count) return { code: 'tracks_excluded', label: 'Songs are hidden, moved to another album, or outside this artist’s album scope' };
  if (!row.default_eligible && row.visibility !== 'show') return { code: 'filtered', label: 'Excluded by the automatic release filter' };
  return { code: 'mapped', label: 'Songs are grouped under another album or edition' };
}
function releaseManagementRoutes({ pool, requireAdmin, loadAlbums, artistMatch, songMatch, extraMembership, hiddenIds, albumHiddenIds, refresh, ready, familyId, settingsFor = () => null }) {
  const router = express.Router();
  router.use(requireAdmin);
  const fail = (res, err) => {
    if (['42P01','42703'].includes(err.code)) return res.status(503).json({ error: 'Release management is not set up yet. Apply migration 034.' });
    if (!err.status) console.error('[releases]', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not load or save releases. Please try again.' });
  };
  const error = (message, status = 400) => Object.assign(new Error(message), { status });
  async function artistFor(req) {
    const artistId = req.method === 'POST' ? req.body?.artist_id : req.query.artist;
    if (typeof artistId !== 'string' || !ID.test(artistId)) throw error('Choose an artist.');
    if (req.adminRole === 'secadmin' && artistId === JT) throw error('This artist is restricted.', 403);
    const row = (await pool.query('SELECT artist_id,name,active,locked FROM tracked_artists WHERE artist_id=$1', [artistId])).rows[0];
    if (!row) throw error('Artist not found.', 404);
    return row;
  }
  async function catalog(artistId) {
    return (await pool.query(`SELECT albums.id,albums.title,albums.image_url,albums.release_date::text,albums.album_group,
      COALESCE(p.visibility,'auto') AS visibility,p.sort_order,COALESCE(p.release_type,'auto') AS release_type,
      (${albumEligibilitySql()}) AS default_eligible,
      (SELECT COUNT(DISTINCT COALESCE(s.canonical_id,s.id))::int FROM songs s WHERE s.album_id=albums.id
        OR EXISTS(SELECT 1 FROM album_extra_tracks x WHERE x.album_id=albums.id AND x.artist_id=$4 AND x.song_id=s.id)) AS track_count,
      (SELECT COUNT(DISTINCT COALESCE(s.canonical_id,s.id))::int FROM songs s WHERE s.album_id=albums.id
        AND ${artistMatch('s')} AND COALESCE(s.canonical_id,s.id) <> ALL($2::text[])
        AND COALESCE(s.canonical_id,s.id) <> ALL($3::text[])
        AND NOT EXISTS(SELECT 1 FROM album_track_pins pin WHERE pin.song_id=s.id AND pin.album_id<>albums.id)
      ) + (SELECT COUNT(*)::int FROM album_extra_tracks x JOIN songs xs ON xs.id=x.song_id
          WHERE x.artist_id=$4 AND x.album_id=albums.id
          AND COALESCE(xs.canonical_id,xs.id) <> ALL($2::text[]) AND COALESCE(xs.canonical_id,xs.id) <> ALL($3::text[])) AS eligible_count
      FROM albums LEFT JOIN album_profile_settings p ON p.album_id=albums.id AND p.artist_id=$4
      WHERE EXISTS (SELECT 1 FROM songs s LEFT JOIN songs head ON head.id=s.canonical_id
        WHERE s.album_id=albums.id AND (${artistMatch('s')} OR head.primary_artist=$1))
        OR p.album_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM album_extra_tracks x WHERE x.album_id=albums.id AND x.artist_id=$4)
      ORDER BY albums.release_date DESC NULLS LAST,albums.title,albums.id`,
    [`spotify:artist:${artistId}`, hiddenIds(), albumHiddenIds(), artistId])).rows;
  }
  function enrich(row, visible, artistId) {
    const displayId = familyId(row.id);
    const settings = settingsFor(artistId, displayId);
    if (settings) row = { ...row, visibility: settings.visibility, sort_order: settings.sort_order, release_type: settings.release_type };
    return { ...row, display_album_id: displayId, state: releaseState(row, visible.has(displayId)),
      displayed_track_count: visible.get(displayId)?.track_count || 0 };
  }
  router.get('/', async (req, res) => {
    try {
      const artist = await artistFor(req);
      const rows = await catalog(artist.artist_id);
      const visible = new Map((await loadAlbums(artist.artist_id)).map(x => [x.album_id, x]));
      res.json({ artist, releases: rows.map(row => enrich(row, visible, artist.artist_id)), setup_ready: ready() });
    } catch (err) { fail(res, err); }
  });
  router.get('/diagnose', async (req, res) => {
    try {
      const artist = await artistFor(req);
      const reference = spotifyReference(req.query.reference);
      if (!reference) throw error('Enter a Spotify album or song link.');
      let track = null, albumId = reference.id;
      if (reference.kind === 'track') {
        track = (await pool.query(`SELECT s.id,s.title,s.album_id,s.canonical_id,c.primary_artist,
          (${songMatch('c','a').replaceAll('$1','$2')}) AS related,
          (SELECT recorded_date::text FROM stream_stats WHERE song_id=s.id ORDER BY recorded_date DESC LIMIT 1) AS last_observation
          FROM songs s JOIN songs c ON c.id=COALESCE(s.canonical_id,s.id)
          LEFT JOIN albums a ON a.id=c.album_id WHERE s.id=$1`, [reference.id,`spotify:artist:${artist.artist_id}`])).rows[0];
        if (track) {
          const head = track.canonical_id || track.id;
          track.state = hiddenIds().includes(head) ? { code: 'song_hidden', label: 'This recording is hidden from the site' }
            : !track.related ? { code: 'song_unrelated', label: 'This recording is outside the selected artist’s song list' }
            : track.canonical_id ? { code: 'merged', label: 'This Spotify copy is merged into another recording on the song list' }
            : { code: 'song_visible', label: 'This recording is on the artist’s song list' };
        }
        if (track) albumId = track.album_id;
      }
      const album = reference.kind === 'track' && !track ? null :
        (await pool.query('SELECT id,title,image_url,release_date::text,album_group FROM albums WHERE id=$1', [albumId])).rows[0];
      if (!album) return res.json({ artist, reference, state: { code: 'missing', label: 'This item has not been collected yet' }, can_import: reference.kind === 'album' });
      const rows = await catalog(artist.artist_id);
      const row = rows.find(x => x.id === album.id);
      if (!row) return res.json({ artist, reference, album, track, state: track?.state || { code: 'unrelated', label: 'This release is not linked to the selected artist' }, can_import: reference.kind === 'album' });
      const visible = new Map((await loadAlbums(artist.artist_id)).map(x => [x.album_id, x]));
      const displayId = familyId(album.id);
      const familyIds = rows.filter(x => familyId(x.id) === displayId).map(x => x.id);
      const tracks = (await pool.query(`SELECT DISTINCT s.id,s.title,s.track_number,s.canonical_id,COALESCE(s.canonical_id,s.id) AS head_id,
        COALESCE(h.primary_artist,s.primary_artist) AS primary_artist, pin.album_id AS pinned_album,
        EXISTS(SELECT 1 FROM album_extra_tracks x JOIN songs xs ON xs.id=x.song_id
          WHERE x.artist_id=$2 AND x.album_id=$1 AND COALESCE(xs.canonical_id,xs.id)=COALESCE(s.canonical_id,s.id)) AS added_membership,
        (SELECT recorded_date::text FROM stream_stats WHERE song_id=s.id ORDER BY recorded_date DESC LIMIT 1) AS last_observation
        FROM songs s LEFT JOIN songs h ON h.id=s.canonical_id LEFT JOIN album_track_pins pin ON pin.song_id=s.id
        WHERE s.album_id=ANY($3::text[]) OR ${extraMembership('s')} ORDER BY s.track_number NULLS LAST,s.id`, [displayId,artist.artist_id,familyIds])).rows;
      const globalHidden = new Set(hiddenIds()), albumHidden = new Set(albumHiddenIds());
      const result = enrich(row, visible, artist.artist_id);
      res.json({ artist, reference, album: result, track, state: track?.state || result.state, setup_ready: ready(), tracks: tracks.map(t => ({ ...t,
        hidden: globalHidden.has(t.head_id), album_hidden: albumHidden.has(t.head_id),
        selected: track?.id === t.id,
      })) });
    } catch (err) { fail(res, err); }
  });
  async function protectAlbum(client, albumId, role) {
    if (role !== 'secadmin') return;
    const protectedRows = await client.query(`SELECT 1 FROM songs s LEFT JOIN songs h ON h.id=s.canonical_id
      WHERE (s.album_id=$1 OR ${extraMembership('s')})
        AND (s.primary_artist IS NULL OR s.primary_artist=$2 OR h.primary_artist=$2
             OR (h.id IS NOT NULL AND h.primary_artist IS NULL)) LIMIT 1`, [albumId, `spotify:artist:${JT}`]);
    if (protectedRows.rows.length) throw error('This release contains restricted songs.', 403);
  }
  router.post('/:id/tracks', async (req, res) => {
    let client;
    try {
      const artist = await artistFor(req);
      const reference = spotifyReference(req.body?.song_url, 'track');
      const action = req.body?.action || 'add';
      if (!['add','remove'].includes(action)) throw error('Choose a valid membership action.');
      if (!ID.test(req.params.id) || reference?.kind !== 'track') throw error('Enter a Spotify song link.');
      if (!(await catalog(artist.artist_id)).some(row => row.id === req.params.id)) throw error('This release is not linked to the selected artist.', 409);
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT artist_id FROM tracked_artists WHERE artist_id=$1 FOR UPDATE', [artist.artist_id]);
      await protectAlbum(client, req.params.id, req.adminRole);
      const song = (await client.query(`SELECT s.id,COALESCE(s.canonical_id,s.id) AS head_id,s.track_number,
        s.primary_artist, h.primary_artist AS head_artist,
        (${artistMatch('s')} OR h.primary_artist=$1 OR EXISTS(SELECT 1 FROM extra_artist_songs e
          WHERE e.artist_id=$3 AND e.song_id IN(s.id,COALESCE(s.canonical_id,s.id)))) AS related
        FROM songs s LEFT JOIN songs h ON h.id=s.canonical_id WHERE s.id=$2 FOR UPDATE OF s`,
      [`spotify:artist:${artist.artist_id}`,reference.id,artist.artist_id])).rows[0];
      if (!song) throw error('Song not found. Import it from a playlist or album first.', 404);
      if (req.adminRole === 'secadmin' && (!song.primary_artist || song.primary_artist === `spotify:artist:${JT}` || song.head_artist === `spotify:artist:${JT}` || (song.head_id !== song.id && !song.head_artist))) throw error('This song is restricted.', 403);
      if (!song.related) throw error('This song is not linked to the selected artist.', 409);
      if (action === 'add' && (hiddenIds().includes(song.head_id) || albumHiddenIds().includes(song.head_id))) throw error('This song is hidden. Review it in Songs before adding it to an album.', 409);
      if (action === 'remove') {
        await client.query(`DELETE FROM album_extra_tracks x USING songs xs
          WHERE x.song_id=xs.id AND x.artist_id=$1 AND x.album_id=$2
          AND COALESCE(xs.canonical_id,xs.id)=$3`, [artist.artist_id,req.params.id,song.head_id]);
      } else {
        await client.query(`INSERT INTO album_extra_tracks(artist_id,album_id,song_id,track_number)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [artist.artist_id,req.params.id,song.id,song.track_number]);
      }
      await client.query('COMMIT'); await refresh();
      res.json({ success: true });
    } catch (err) { if (client) await client.query('ROLLBACK').catch(() => {}); fail(res, err); }
    finally { client?.release(); }
  });
  router.post('/:id/settings', async (req, res) => {
    let client;
    try {
      const artist = await artistFor(req);
      if (!ID.test(req.params.id)) throw error('Invalid album ID.');
      const { visibility, sort_order: order, release_type: type } = req.body || {};
      if (!['auto','show','hide'].includes(visibility) || !['auto','album','ep','single'].includes(type)
        || !(order === null || (Number.isInteger(order) && order >= 0 && order <= 9999))) throw error('Choose valid visibility, type and an order between 0 and 9999.');
      const rows = await catalog(artist.artist_id);
      if (!rows.some(x => x.id === req.params.id)) throw error('This release is not linked to the selected artist.', 409);
      const target = familyId(req.params.id);
      client = await pool.connect();
      await client.query('BEGIN');
      // Serialize release changes and recheck permissions inside the transaction.
      await client.query('SELECT artist_id FROM tracked_artists WHERE artist_id=$1 FOR UPDATE', [artist.artist_id]);
      await protectAlbum(client, target, req.adminRole);
      await client.query(`INSERT INTO album_profile_settings(artist_id,album_id,visibility,sort_order,release_type)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(artist_id,album_id) DO UPDATE
        SET visibility=$3,sort_order=$4,release_type=$5,updated_at=NOW()`, [artist.artist_id,target,visibility,order,type]);
      await client.query('COMMIT');
      await refresh();
      res.json({ success: true, album_id: target });
    } catch (err) { if (client) await client.query('ROLLBACK').catch(() => {}); fail(res, err); }
    finally { client?.release(); }
  });
  return router;
}
module.exports = { spotifyReference, releaseState, releaseManagementRoutes };
