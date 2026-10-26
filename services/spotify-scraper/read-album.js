'use strict';
const { MAX_TRACKS } = require('../web-dashboard/lib/playlist-import');
const { spotifyReference } = require('../web-dashboard/lib/spotify-reference');

// Capture the requested album, rejecting incomplete pages and recommendations.
async function readAlbum(page, id, { maxTracks = MAX_TRACKS } = {}) {
  const reference = spotifyReference(id);
  if (reference?.kind !== 'album') throw new Error('Use an album link.');
  let album = null;
  const pending = new Set();
  const handler = response => {
    const task = (async () => {
      if (!response.url().includes('pathfinder')) return;
      const body = await response.json().catch(() => null);
      const a = body?.data?.albumUnion;
      if (a?.uri === `spotify:album:${reference.id}` && a.name && a.tracksV2?.items) album = a;
    })().catch(() => {});
    pending.add(task); task.finally(() => pending.delete(task));
  };
  page.on('response', handler);
  try {
    try { await page.goto(`https://open.spotify.com/album/${reference.id}`, { waitUntil: 'networkidle2', timeout: 45000 }); }
    catch { /* a complete response may have arrived before navigation timed out */ }
    await Promise.all([...pending]);
    for (let n = 0; n < 12 && !album; n++) await new Promise(r => setTimeout(r, 500));
    await Promise.all([...pending]);
    const items = album?.tracksV2?.items || [];
    const total = Number(album?.tracksV2?.totalCount);
    if (total > maxTracks || items.length > maxTracks) throw new Error(`Use an album with at most ${maxTracks} songs.`);
    if (!album || !Number.isInteger(total) || total < 1 || items.length !== total) throw new Error('Album could not be read completely. Try again.');
    const tracks = items.map(item => ({ id: item.track?.uri?.split(':')[2], name: item.track?.name, track_number: item.track?.trackNumber }));
    if (tracks.some(t => !/^[A-Za-z0-9]{22}$/.test(t.id || '')) || new Set(tracks.map(t => t.id)).size !== total) throw new Error('Album could not be read completely. Try again.');
    const cover = [...(album.coverArt?.sources || [])].sort((a,b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
    return { album: { id: reference.id, title: album.name, release_date: album.date?.isoString?.slice(0,10) || null, image_url: cover }, tracks };
  } finally { page.off('response', handler); }
}
module.exports = { readAlbum };
