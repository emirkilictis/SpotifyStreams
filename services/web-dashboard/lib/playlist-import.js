'use strict';

const ID = /^[A-Za-z0-9]{22}$/;
const JT = '31TPClRtHm23RisEBtV3X7';
const MAX_TRACKS = 50;

function playlistId(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const input = value.trim();
  if (ID.test(input)) return input;
  const uri = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(input);
  if (uri) return uri[1];
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.port || url.username || url.password) return null;
    return /^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

function creditType(track, artist) {
  if (track.artistUris?.includes(`spotify:artist:${artist.artist_id}`)) return 'artist';
  // A title credit is reviewable, never silently treated as an artist match.
  const escaped = artist.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\((?:feat\\.?|featuring|with)\\s+${escaped}\\)`, 'iu').test(track.name || '') ? 'title' : 'none';
}

function validTrack(t) {
  return t && ID.test(t.id) && ID.test(t.albumId) && typeof t.name === 'string'
    && typeof t.albumName === 'string' && Array.isArray(t.artistUris)
    && t.artistUris.length > 0 && t.artistUris.every(uri => /^spotify:artist:[A-Za-z0-9]{22}$/.test(uri))
    && (t.playcount === null || (Number.isSafeInteger(t.playcount) && t.playcount > 0))
    && Number.isSafeInteger(t.duration_ms) && t.duration_ms > 0
    && (t.playcount === null || /^\d{4}-\d{2}-\d{2}$/.test(t.observed_date || ''));
}

async function inspectTracks(client, tracks, artist, role, { albumImport = false } = {}) {
  if (!Array.isArray(tracks) || tracks.length > MAX_TRACKS) throw new Error('Invalid playlist result.');
  const ids = tracks.filter(t => ID.test(t?.id)).map(t => t.id);
  const existing = await client.query(`
    SELECT s.id, COALESCE(s.canonical_id, s.id) AS head_id,
           CASE WHEN h.id IS NOT NULL THEN h.primary_artist ELSE s.primary_artist END AS primary_artist,
           ${albumImport ? `EXISTS (SELECT 1 FROM album_extra_tracks m WHERE m.artist_id=$2 AND m.album_id = ANY($3::text[]) AND m.song_id=s.id)` : 'false'} AS release_linked,
           EXISTS (SELECT 1 FROM extra_artist_songs e WHERE e.artist_id = $2
                   AND e.song_id IN (s.id, COALESCE(s.canonical_id, s.id))) AS linked,
           EXISTS (SELECT 1 FROM hidden_songs x WHERE x.song_id IN (s.id, COALESCE(s.canonical_id, s.id))) AS hidden
    FROM songs s LEFT JOIN songs h ON h.id = s.canonical_id WHERE s.id = ANY($1::text[])
  `, albumImport ? [ids, artist.artist_id, [...new Set(tracks.map(t => t.albumId))]] : [ids, artist.artist_id]);
  const byId = new Map(existing.rows.map(r => [r.id, r]));
  return tracks.map(t => {
    const row = byId.get(t.id);
    const credit = creditType(t, artist);
    const protectedSong = role === 'secadmin' && (artist.artist_id === JT
      || t.artistUris?.includes(`spotify:artist:${JT}`)
      || (row && (!row.primary_artist || row.primary_artist === `spotify:artist:${JT}`)));
    const already = row && (row.primary_artist === `spotify:artist:${artist.artist_id}` || row.linked);
    const state = !validTrack(t) ? 'unresolved' : protectedSong ? 'restricted'
      : row?.hidden ? 'hidden' : already ? (albumImport && !row.release_linked ? 'membership' : 'included') : credit === 'none' ? 'unrelated' : row ? 'link' : 'new';
    return { ...t, credit, state, head_id: row?.head_id || t.id, selectable: ['new', 'link', 'membership'].includes(state) };
  });
}

// Caller owns BEGIN/COMMIT and locks the job row. Re-inspect live membership,
// hidden tracks and role restrictions at apply time, not just at preview time.
async function applyTracks(client, job, selectedIds, role) {
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > MAX_TRACKS
    || selectedIds.some(id => typeof id !== 'string' || !ID.test(id))
    || new Set(selectedIds).size !== selectedIds.length) {
    throw Object.assign(new Error('Select between 1 and 50 distinct songs.'), { status: 400 });
  }
  const artistResult = await client.query('SELECT artist_id, name FROM tracked_artists WHERE artist_id = $1', [job.artist_id]);
  const artist = artistResult.rows[0];
  if (!artist) throw Object.assign(new Error('Artist no longer exists.'), { status: 404 });
  const tracks = await inspectTracks(client, job.tracks, artist, role, { albumImport: job.source_type === 'album' });
  const selected = selectedIds.map(id => tracks.find(t => t.id === id));
  if (selected.some(t => !t || (!t.selectable && t.state !== 'included'))) {
    throw Object.assign(new Error('Some selected songs are hidden, restricted or do not credit this artist. Preview again.'), { status: 409 });
  }
  const summary = { added: 0, linked: 0, already_included: 0, unavailable: 0 };
  for (const t of selected) {
    if (t.state === 'included') { summary.already_included++; continue; }
    if (t.state === 'new' || job.source_type === 'album') {
      await client.query(`INSERT INTO albums(id, title, release_date, image_url)
        VALUES($1, $2, $3, $4) ON CONFLICT(id) DO NOTHING`, [t.albumId, t.albumName, t.release, t.coverUrl]);
    }
    if (t.state === 'new') {
      // Keep imports in the target bucket, as the normal artist scraper does.
      // ON CONFLICT preserves any ownership/canonical changes made meanwhile.
      await client.query(`INSERT INTO songs(id,title,album_id,duration_ms,track_number,is_featured,primary_artist,is_solo)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [t.id, t.name, t.albumId, t.duration_ms, t.track_number, t.artistUris[0] !== `spotify:artist:${artist.artist_id}`,
        `spotify:artist:${artist.artist_id}`, t.artistUris.length === 1 && t.credit === 'artist']);
      if (t.playcount !== null) {
        // Only the first reading, on the observation day. Never manufacture a
        // zero count for a region-restricted song or backdate its lifetime total.
        await client.query(`INSERT INTO stream_stats(song_id,stream_count,recorded_date,recorded_at,baseline_only)
          SELECT $1,$2,$3::date,NOW(),true WHERE NOT EXISTS(SELECT 1 FROM stream_stats WHERE song_id=$1)
          ON CONFLICT(song_id,recorded_date) DO NOTHING`, [t.id, t.playcount, t.observed_date]);
      }
      summary.added++;
    } else summary.linked++;
    // Resolve the canonical again: a parallel scrape may have merged this id.
    await client.query(`INSERT INTO extra_artist_songs(artist_id,song_id)
      SELECT $1,COALESCE(canonical_id,id) FROM songs WHERE id=$2 ON CONFLICT DO NOTHING`, [artist.artist_id, t.id]);
    await client.query(`INSERT INTO extra_scrape_albums(artist_id,album_id,title,release_date,is_featured,source,note)
      VALUES($1,$2,$3,$4,true,'manual',$5) ON CONFLICT DO NOTHING`,
    [artist.artist_id, t.albumId, t.albumName, t.release, `Admin ${job.source_type || 'playlist'} ${job.playlist_id}`]);
    if (job.source_type === 'album') {
      await client.query(`INSERT INTO album_extra_tracks(artist_id,album_id,song_id,track_number)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [artist.artist_id,t.albumId,t.id,t.track_number]);
      await client.query(`INSERT INTO album_profile_settings(artist_id,album_id,visibility)
        VALUES($1,$2,'show') ON CONFLICT DO NOTHING`, [artist.artist_id,t.albumId]);
    }
    if (t.playcount === null) summary.unavailable++;
  }
  return summary;
}

module.exports = { playlistId, creditType, inspectTracks, applyTracks, validTrack, MAX_TRACKS, JT, ID };
