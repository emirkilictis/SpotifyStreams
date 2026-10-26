'use strict';
require('dotenv').config({ path: __dirname + '/../../.env' });
const { launchBrowser } = require('./spotify');
const { readPlaylist } = require('./read-playlist');
const { readAlbum } = require('./read-album');
const { resolveTracks } = require('./kworb');
const { getPool, closePool } = require('./db');
const { MAX_TRACKS } = require('../web-dashboard/lib/playlist-import');

async function previewImport(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('Invalid import ID.');
  const pool = getPool();
  let browser;
  const claimed = await pool.query(`UPDATE playlist_imports SET status='reading',updated_at=NOW()
    WHERE id=$1 AND status='queued' RETURNING *`, [id]);
  if (!claimed.rows.length) return;
  try {
    if (!process.env.SP_DC) throw new Error('The Spotify session is not configured.');
    const job = claimed.rows[0];
    const session = await launchBrowser(process.env.SP_DC);
    browser = session.browser;
    const source = job.source_type === 'album'
      ? await readAlbum(session.page, job.playlist_id, { maxTracks: MAX_TRACKS })
      : await readPlaylist(session.page, job.playlist_id, { maxTracks: MAX_TRACKS });
    const { tracks } = source;
    const started = Date.now();
    const resolved = new Map();
    for (const track of tracks) {
      if (Date.now() - started > 20 * 60 * 1000) throw new Error('Reading timed out. Try a smaller playlist.');
      const date = (await pool.query(`SELECT (((NOW() - INTERVAL '12 hours') AT TIME ZONE 'Europe/Istanbul')::date)::text AS today`)).rows[0].today;
      const item = (await resolveTracks(session.page, [track.id])).get(track.id);
      resolved.set(track.id, { ...(item || track), ...(job.source_type === 'album' ? {
        albumId: source.album.id, albumName: source.album.title, release: source.album.release_date,
        coverUrl: source.album.image_url, track_number: track.track_number,
      } : {}), observed_date: date });
      await pool.query(`UPDATE playlist_imports SET updated_at=NOW() WHERE id=$1 AND status='reading'`, [id]);
      console.log(`[playlist] ${resolved.size}/${tracks.length}: ${item?.name || track.name}`);
    }
    const result = tracks.map(t => resolved.get(t.id));
    await pool.query(`UPDATE playlist_imports SET status='ready',tracks=$2::jsonb,error=NULL,updated_at=NOW()
      WHERE id=$1 AND status='reading'`, [id, JSON.stringify(result)]);
  } catch (err) {
    // Keep browser/network errors (which may contain request headers) out of the
    // database and public API. Full details remain in the private workflow log.
    console.error('[playlist] Preview failed:', err.message);
    const safe = /^(Use a playlist|Use an album|No songs could|Album could|Playlist could|Reading timed|The Spotify session)/.test(err.message)
      ? err.message : 'Spotify could not be read. Check the Spotify link is available and the Spotify session is valid, then try again.';
    await pool.query(`UPDATE playlist_imports SET status='failed',error=$2,updated_at=NOW() WHERE id=$1 AND status='reading'`, [id, safe]);
    throw new Error(safe);
  } finally { if (browser) await browser.close(); }
}

if (require.main === module) {
  previewImport(process.argv[2]).catch(err => { console.error(err.message); process.exitCode = 1; }).finally(closePool);
}
module.exports = { previewImport };
