// Does this Spotify artist ID exist?
//
// open.spotify.com/artist/<id> answers HTTP 200 for ANY 22-character ID: the
// web player is a single-page app and shows "page not found" client-side. So a
// typo'd ID looks exactly like a network hiccup to the scraper, and it was
// retried every hour. Lince (lY00G5g5QmKHm0AJDJTctQ, added 2026-11-20) turned
// the job red 16 times in two days this way. The public oEmbed endpoint does
// answer 404 for an unknown ID (and 200 for a real one), needs no token, and is
// cheap.
//
// Returns true (exists), false (Spotify says 404) or null (could not tell:
// timeout, 5xx, rate limit). Callers must treat null as "unknown", never as
// "missing".
async function spotifyArtistExists(artistId, { timeoutMs = 8000 } = {}) {
  const target = `https://open.spotify.com/artist/${encodeURIComponent(artistId)}`;
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null;
  } catch {
    return null;
  }
}

module.exports = { spotifyArtistExists };
