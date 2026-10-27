'use strict';
const ID = /^[A-Za-z0-9]{22}$/;
const URI = /^spotify:artist:[A-Za-z0-9]{22}$/;

// Late Spotify guest credits must reach every tracked full-catalogue profile.
// Keep the canonical recording, its owner and its observations intact.
async function syncArtistCredits(client, album, tracks) {
  if (!ID.test(album?.id || '')) throw new Error('Invalid album for artist credits.');
  const pairs = new Map();
  for (const track of tracks) {
    if (!ID.test(track?.id || '') || !Array.isArray(track.artistUris)) continue;
    const credits = [...new Set(track.artistUris.filter(uri => typeof uri === 'string' && URI.test(uri)))];
    if (credits.length < 2) continue;
    for (const uri of credits) {
      pairs.set(track.id + ':' + uri, { song_id: track.id, artist_uri: uri });
    }
  }
  if (!pairs.size) return { linked: 0, pinned: 0, classifications: 0 };
  const result = await client.query(`
    WITH incoming AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(song_id text,artist_uri text)
    ), eligible AS MATERIALIZED (
      SELECT DISTINCT ta.artist_id, head.id AS song_id
      FROM incoming i JOIN songs s ON s.id=i.song_id
      JOIN songs head ON head.id=COALESCE(s.canonical_id,s.id)
      JOIN tracked_artists ta ON 'spotify:artist:' || ta.artist_id=i.artist_uri
      WHERE ta.active=true AND ta.album_only IS NOT TRUE
        AND head.primary_artist IS DISTINCT FROM i.artist_uri
        AND head.id <> '6233Z1W8t9Wn1f1gZqHhQ5'
        AND NOT EXISTS(SELECT 1 FROM hidden_songs h WHERE h.song_id IN(s.id,head.id))
    ), linked AS (
      INSERT INTO extra_artist_songs(artist_id,song_id)
      SELECT artist_id,song_id FROM eligible ON CONFLICT DO NOTHING RETURNING song_id
    ), pinned AS (
      INSERT INTO extra_scrape_albums(artist_id,album_id,title,release_date,is_featured,source,note)
      SELECT DISTINCT artist_id,$2,$3,$4::date,true,'spotify-credits','Spotify guest credits verified on collected album tracks'
      FROM eligible ON CONFLICT DO NOTHING RETURNING album_id
    ), classifications AS (
      UPDATE songs SET is_solo=false
      WHERE id IN(SELECT s.id FROM songs s JOIN incoming i ON i.song_id=s.id
                  UNION SELECT COALESCE(s.canonical_id,s.id) FROM songs s JOIN incoming i ON i.song_id=s.id)
        AND is_solo IS DISTINCT FROM false RETURNING id
    )
    SELECT (SELECT COUNT(*)::int FROM linked) AS linked,
           (SELECT COUNT(*)::int FROM pinned) AS pinned,
           (SELECT COUNT(*)::int FROM classifications) AS classifications`,
  [JSON.stringify([...pairs.values()]),album.id,album.title,album.release_date || null]);
  return result.rows[0];
}
module.exports = { syncArtistCredits };
