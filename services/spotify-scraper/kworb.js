/**
 * kworb.js — shared reconciliation core for audit-kworb.js (report) and
 * reconcile-kworb.js (auto-fix). Both must classify identically, so the logic
 * lives here once.
 *
 * The problem it models: a freshly added artist almost always lands BELOW their
 * kworb page, for two MECHANICAL reasons — never dedup (our kept tracks match
 * kworb 1:1):
 *   1. OTHER BUCKET — a collab has exactly one primary_artist, so when the
 *      co-credited artist is also tracked the track sits in THEIR bucket. kworb
 *      shows a collab on every credited artist's page. Fix: extra_artist_songs.
 *   2. MISSING — a guest feature whose lead artist we DON'T track never appears
 *      in this artist's Spotify "appears on", so it was never scraped at all.
 *      Fix: pin its album (extra_scrape_albums) so the scraper visits it.
 *
 * kworb is a DISCOVERY hint here, not a source of truth: every number we store
 * still comes from Spotify's own playcount, and before pinning anything we
 * verify against Spotify that the artist really is credited on the track.
 */

// kworb and we often store the SAME recording under different track ids (a song
// reappears on a deluxe/regional edition with a fresh id). So an id miss does
// NOT mean missing — fall back to a normalized-title match against our bucket.
// Keep the "- Remix / - Instrumental / - Cardi B Version" suffix: those are
// DISTINCT tracks (own id, own streams) and must stay separate. Only strip the
// (feat …)/(with …) credit noise that kworb and Spotify format differently.
const normTitle = (t) => String(t || '').toLowerCase()
  .replace(/\(feat[^)]*\)/g, '').replace(/\(with[^)]*\)/g, '')
  .replace(/\bfeat\.?\b[^-]*/g, '')
  .replace(/[^a-z0-9]/g, '');

// Base title with the "- Radio Edit / - Studio Recording / - Remix" suffix
// dropped too. Used ONLY together with a stream-value check: kworb and we often
// LABEL the same recording differently ("Moves Like Jagger - Radio Edit" vs
// "… - Studio Recording From The Voice"), but the same recording has the same
// play count, whereas a real remix has a different one. So base-title + near-equal
// value == same track; base-title + different value == a genuinely distinct remix.
const baseTitle = (t) => normTitle(String(t || '').replace(/\s*-\s*.*$/, ''));
const valuesClose = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.01 + 50000;

/** Scrape one artist's kworb song table. Returns { tracks, headerStreams }. */
async function fetchKworbSongs(artistId) {
  const url = `https://kworb.net/spotify/artist/${artistId}_songs.html`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`kworb HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const rows = html.match(/<tr>([\s\S]*?)<\/tr>/g) || [];
  const tracks = [];
  let headerStreams = null;
  for (const r of rows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 2) continue;
    const rawTitle = cells[0].replace(/<[^>]+>/g, '').trim()
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    const streams = parseInt(cells[1].replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(streams)) continue;
    if (rawTitle === 'Streams') { headerStreams = streams; continue; }
    if (rawTitle === 'Daily' || rawTitle === 'Tracks') continue;
    const idMatch = cells[0].match(/track\/([A-Za-z0-9]{22})/);
    const isFeat = rawTitle.startsWith('* ');
    tracks.push({
      trackId: idMatch ? idMatch[1] : null,
      title: rawTitle.replace(/^\*\s*/, ''),
      streams,
      isFeat,
    });
  }
  // A page that parses to nothing means kworb changed layout (or served an error
  // body with HTTP 200). Refuse to report a 100% gap off that — callers treat a
  // throw as "skip this artist", which is the safe outcome.
  if (!tracks.length) throw new Error(`kworb page for ${artistId} parsed to 0 tracks (layout change?)`);
  return { tracks, headerStreams };
}

/**
 * Snapshot of what WE hold for this artist, shaped for classification.
 *
 * The bucket is "primary_artist = artist  OR  pinned via extra_artist_songs" —
 * the same union the dashboard shows (artistBucketMatchSQL), so an already-linked
 * collab counts as ours instead of being reported (and re-linked) forever.
 * Hidden songs are excluded, again matching the dashboard.
 */
async function loadOurBucket(client, artistId) {
  const artistUri = `spotify:artist:${artistId}`;
  const [songsRes, namesRes, bucketRes] = await Promise.all([
    client.query('SELECT id, primary_artist, canonical_id FROM songs'),
    client.query('SELECT artist_id, name FROM tracked_artists'),
    client.query(
      `SELECT s.id, s.title, dsc.cumulative::bigint AS cum
         FROM (SELECT DISTINCT ON (canonical_id) canonical_id, cumulative
                 FROM daily_streams_canonical
                ORDER BY canonical_id, recorded_date DESC) dsc
         JOIN songs s ON s.id = dsc.canonical_id
        WHERE (s.primary_artist = $1
               OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2))
          AND s.id NOT IN (SELECT song_id FROM hidden_songs)`,
      [artistUri, artistId]
    ),
  ]);

  const byId = new Map();
  for (const s of songsRes.rows) byId.set(s.id, s);

  const trackedUris = new Set();
  const names = new Map();
  for (const a of namesRes.rows) {
    trackedUris.add(`spotify:artist:${a.artist_id}`);
    names.set(`spotify:artist:${a.artist_id}`, a.name);
  }

  const bucketIds = new Set();
  const bucketTitles = new Set();
  const bucketByBase = new Map(); // baseTitle -> [cumulative values]
  let ourTotal = 0;
  for (const r of bucketRes.rows) {
    bucketIds.add(r.id);
    bucketTitles.add(normTitle(r.title));
    const b = baseTitle(r.title);
    if (!bucketByBase.has(b)) bucketByBase.set(b, []);
    bucketByBase.get(b).push(Number(r.cum));
    ourTotal += Number(r.cum);
  }

  return {
    artistUri, byId, names, trackedUris,
    bucketIds, bucketTitles, bucketByBase,
    ourTotal, ourCount: bucketRes.rows.length,
  };
}

/**
 * Bucket every kworb track into ok / otherBucket / missing / noId.
 *
 * otherBucket carries `owner` (the artist URI whose bucket holds it) and
 * `ownerTracked` — only a TRACKED owner is safe to auto-link, because an
 * untracked owner means the track isn't visible on any page and pinning it into
 * this artist's extras would be inventing membership rather than mirroring it.
 */
function classify(kworbTracks, ours) {
  const ok = [], otherBucket = [], missing = [], noId = [];
  for (const t of kworbTracks) {
    const row = t.trackId ? ours.byId.get(t.trackId) : null;
    // kworb links ONE edition of a recording; dedup may have made that edition an
    // alias of a different head. Everything downstream — the bucket, the dashboard,
    // extra_artist_songs — only ever deals in canonical HEADS, so resolve first.
    // Skipping this makes an already-held song look like it's in another bucket,
    // and pins land on an alias id that can never render.
    const headId = row ? (row.canonical_id || row.id) : null;
    const head = headId ? (ours.byId.get(headId) || row) : null;
    if (headId && ours.bucketIds.has(headId)) { ok.push(t); continue; }
    if (head && head.primary_artist === ours.artistUri) { ok.push(t); continue; }
    if (row) {
      otherBucket.push({
        ...t,
        headId,
        owner: head ? head.primary_artist : row.primary_artist,
        ownerTracked: ours.trackedUris.has(head ? head.primary_artist : row.primary_artist),
      });
      continue;
    }
    // id miss: the same recording may live under a different edition id.
    // (a) exact suffix-kept title match, or
    // (b) same base title AND a near-equal stream value (same recording, just
    //     labelled differently) — a real remix has a different value so it stays MISSING.
    if (ours.bucketTitles.has(normTitle(t.title))) { ok.push(t); continue; }
    const sameBase = ours.bucketByBase.get(baseTitle(t.title));
    if (sameBase && sameBase.some((v) => valuesClose(v, t.streams))) { ok.push(t); continue; }
    if (!t.trackId) { noId.push(t); continue; }
    missing.push(t);
  }
  return { ok, otherBucket, missing, noId };
}

/**
 * Ask Spotify itself about a set of track ids: which album they live on and —
 * crucially — who is actually credited. reconcile-kworb.js pins an album only
 * when the artist appears in `artistUris`, so a kworb mis-attribution (or a
 * title collision) can never drag a foreign album into the scrape set.
 *
 * Returns Map trackId -> { albumId, albumName, release, coverUrl, artistUris, playcount, name }.
 */
async function resolveTracks(page, trackIds, { onProgress } = {}) {
  const out = new Map();
  for (let i = 0; i < trackIds.length; i++) {
    const trackId = trackIds[i];
    let tr = null;
    const handler = async (res) => {
      try {
        if (!res.url().includes('pathfinder/v2')) return;
        const b = await res.json().catch(() => null);
        const t = b?.data?.trackUnion;
        if (t && t.uri === `spotify:track:${trackId}` && !tr) tr = t;
      } catch {}
    };
    page.on('response', handler);
    try {
      await page.goto(`https://open.spotify.com/track/${trackId}`, { waitUntil: 'networkidle2', timeout: 40000 });
      for (let n = 0; n < 24 && !tr; n++) await new Promise((r) => setTimeout(r, 500));
    } catch {}
    page.off('response', handler);

    const ao = tr?.albumOfTrack;
    if (ao?.uri) {
      const sources = ao.coverArt?.sources || [];
      const cover = sources.length
        ? sources.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a)).url
        : null;
      // trackUnion splits credits across firstArtist + otherArtists; there is NO
      // flat `artists` field on this query (reading one yields an empty credit
      // list, which silently fails the "is this artist credited?" guard and makes
      // reconcile skip every track it should have pinned).
      const artistUris = [
        ...(tr.firstArtist?.items || []),
        ...(tr.otherArtists?.items || []),
        ...(tr.artists?.items || []),
      ].map((a) => a?.uri).filter(Boolean);
      out.set(trackId, {
        albumId: ao.uri.split(':')[2],
        albumName: ao.name,
        release: ao.date?.isoString?.slice(0, 10) || null,
        coverUrl: cover,
        artistUris: [...new Set(artistUris)],
        playcount: Number(tr.playcount) || null,
        name: tr.name || null,
      });
    }
    if (onProgress) onProgress(i + 1, trackIds.length, trackId, out.get(trackId) || null);
  }
  return out;
}

module.exports = {
  normTitle, baseTitle, valuesClose,
  fetchKworbSongs, loadOurBucket, classify, resolveTracks,
};
