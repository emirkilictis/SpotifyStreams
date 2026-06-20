'use strict';

// Group songs that share the EXACT same peak stream count but resolve to
// different canonicals (i.e. linked copies the deduper hasn't merged yet).
// Pure function so it can be unit-tested without a database.
//
// rows: [{ id, title, album, duration_ms, primary_artist, is_featured,
//          canonical_id, streams }]
// Returns: [{ streams, songs: [{ id, title, album, duration_ms,
//             primary_artist, is_featured, merged, canonical_id }] }]
// sorted by stream count descending. Only groups with 2+ DISTINCT effective
// canonicals are returned (an already-fully-merged group is not actionable).
function groupSameStreamDuplicates(rows) {
  const byBucketAndStreams = new Map();
  for (const row of rows) {
    const streams = Number(row.streams);
    if (!Number.isFinite(streams) || streams <= 0) continue;
    const bucket = row.bucket || 'collab';
    const key = `${bucket}_${streams}`;
    if (!byBucketAndStreams.has(key)) byBucketAndStreams.set(key, []);
    byBucketAndStreams.get(key).push(row);
  }

  const groups = [];
  for (const [key, songs] of byBucketAndStreams) {
    if (songs.length < 2) continue;
    const canonicals = new Set(songs.map(s => s.canonical_id || s.id));
    if (canonicals.size < 2) continue; // already merged together
    const streams = Number(key.substring(key.lastIndexOf('_') + 1));
    groups.push({
      streams,
      songs: songs.map(s => ({
        id: s.id,
        title: s.title,
        album: s.album,
        duration_ms: s.duration_ms,
        primary_artist: s.primary_artist,
        is_featured: s.is_featured,
        merged: s.canonical_id != null,
        canonical_id: s.canonical_id,
      })),
    });
  }
  groups.sort((a, b) => b.streams - a.streams);
  return groups;
}

module.exports = { groupSameStreamDuplicates };
