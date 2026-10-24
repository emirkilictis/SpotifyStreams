'use strict';
const express = require('express');
const { randomUUID } = require('node:crypto');
const { playlistId, inspectTracks, applyTracks, JT, ID, MAX_TRACKS } = require('./playlist-import');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function playlistImportRoutes({ pool, requireAdmin, dispatch, refresh }) {
  const router = express.Router();
  router.use(requireAdmin);
  const allowed = (job, role) => !(role === 'secadmin' && (job.artist_id === JT || job.requested_role === 'admin'));
  const errorResponse = (res, err) => {
    if (err.code === '42P01') return res.status(503).json({ error: 'Playlist import setup is incomplete. Apply migration 033 first.' });
    console.error('[playlist-import]', err.message);
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Playlist import failed. Please try again.' });
  };

  router.get('/', async (req, res) => {
    try {
      const r = await pool.query(`SELECT id,artist_id,playlist_id,status,error,result,created_at,updated_at
        FROM playlist_imports WHERE ($1='admin' OR (requested_role='secadmin' AND artist_id<>$2))
        ORDER BY created_at DESC LIMIT 12`, [req.adminRole, JT]);
      res.json(r.rows);
    } catch (err) { errorResponse(res, err); }
  });

  router.post('/', async (req, res) => {
    const artistId = req.body?.artist_id;
    const pid = playlistId(req.body?.playlist_url);
    if (typeof artistId !== 'string' || !ID.test(artistId) || !pid) return res.status(400).json({ error: 'Choose an artist and enter a Spotify playlist link.' });
    if (req.adminRole === 'secadmin' && artistId === JT) return res.status(403).json({ error: 'This artist is restricted.' });
    let client, id;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Serialize enqueue requests across server processes, bounding browser
      // work even when the administrator double-clicks or has multiple tabs.
      await client.query('SELECT pg_advisory_xact_lock(830033)');
      const artist = await client.query('SELECT artist_id FROM tracked_artists WHERE artist_id=$1', [artistId]);
      if (!artist.rows.length) throw Object.assign(new Error('Artist not found.'), { status: 404 });
      const active = await client.query(`SELECT id FROM playlist_imports WHERE status IN ('queued','reading')
        AND updated_at > NOW() - INTERVAL '40 minutes' LIMIT 1`);
      if (active.rows.length) throw Object.assign(new Error('A playlist is already being read. Wait for it to finish before starting another.'), { status: 409 });
      await client.query(`UPDATE playlist_imports SET status='failed',error='Reading timed out. Please preview the playlist again.',updated_at=NOW()
        WHERE status IN ('queued','reading') AND updated_at <= NOW() - INTERVAL '40 minutes'`);
      id = randomUUID();
      await client.query(`INSERT INTO playlist_imports(id,artist_id,playlist_id,requested_role) VALUES($1,$2,$3,$4)`, [id, artistId, pid, req.adminRole]);
      await client.query('COMMIT');
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return errorResponse(res, err);
    } finally { client?.release(); }
    try {
      await dispatch(id);
      res.status(202).json({ id, status: 'queued', max_tracks: MAX_TRACKS });
    } catch (err) {
      await pool.query(`UPDATE playlist_imports SET status='failed',error=$2,updated_at=NOW() WHERE id=$1 AND status='queued'`, [id, err.message]).catch(() => {});
      errorResponse(res, Object.assign(err, { status: 502 }));
    }
  });

  router.get('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid import ID.' });
    try {
      const r = await pool.query('SELECT * FROM playlist_imports WHERE id=$1', [req.params.id]);
      const job = r.rows[0];
      if (!job) return res.status(404).json({ error: 'Import not found.' });
      if (!allowed(job, req.adminRole)) return res.status(403).json({ error: 'This import is restricted.' });
      // A killed runner cannot write a failure. Surface it without polling forever.
      if (['queued', 'reading'].includes(job.status) && Date.now() - new Date(job.updated_at).getTime() > 40 * 60 * 1000) {
        job.status = 'failed'; job.error = 'Reading timed out. Please preview the playlist again.';
      }
      const artist = (await pool.query('SELECT artist_id,name FROM tracked_artists WHERE artist_id=$1', [job.artist_id])).rows[0];
      const tracks = job.status === 'ready' && artist ? await inspectTracks(pool, job.tracks, artist, req.adminRole) : [];
      res.json({ ...job, tracks, artist_name: artist?.name });
    } catch (err) { errorResponse(res, err); }
  });

  router.post('/:id/apply', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid import ID.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM playlist_imports WHERE id=$1 FOR UPDATE', [req.params.id]);
      const job = r.rows[0];
      if (!job) throw Object.assign(new Error('Import not found.'), { status: 404 });
      if (!allowed(job, req.adminRole)) throw Object.assign(new Error('This import is restricted.'), { status: 403 });
      if (job.status === 'applied') {
        await client.query('COMMIT');
        await refresh();
        return res.json({ success: true, result: job.result });
      }
      if (job.status !== 'ready' || Date.now() - new Date(job.updated_at).getTime() > 24 * 60 * 60 * 1000) {
        throw Object.assign(new Error('Preview is not ready or has expired. Preview the playlist again.'), { status: 409 });
      }
      const result = await applyTracks(client, job, req.body?.song_ids, req.adminRole);
      await client.query(`UPDATE playlist_imports SET status='applied',result=$2::jsonb,updated_at=NOW() WHERE id=$1`, [job.id, JSON.stringify(result)]);
      await client.query('COMMIT');
      await refresh();
      res.json({ success: true, result });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      errorResponse(res, err);
    } finally { client?.release(); }
  });
  return router;
}
module.exports = { playlistImportRoutes };
