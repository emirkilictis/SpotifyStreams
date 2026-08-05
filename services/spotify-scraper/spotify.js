/**
 * Spotify scraper — browser-based.
 *
 * Strateji: Cloudflare WAF Node.js isteklerini bloklıyor.
 * Çözüm: Headless Chrome'u sp_dc cookie ile aç,
 *        sayfa içinde yapılan pathfinder/v2 yanıtlarını intercept et.
 */

const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const fs = require('fs');

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PATH = process.env.CHROME_PATH || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : undefined);

function parseSpotifyDate(date) {
  if (!date) return null;
  if (date.isoString) return date.isoString.slice(0, 10);
  if (date.year) {
    const m = String(date.month || 1).padStart(2, '0');
    const d = String(date.day || 1).padStart(2, '0');
    return `${date.year}-${m}-${d}`;
  }
  return null;
}

/**
 * Dismisses cookie consent popup if present on the page.
 */
async function dismissCookieBanner(page) {
  try {
    await page.evaluate(() => {
      const btn = document.getElementById('onetrust-accept-btn-handler');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 800)); // wait for banner to disappear
  } catch (e) {}
}

/**
 * Yeni bir tarayıcı + sayfa oluşturur, sp_dc cookie'sini kurar.
 */
async function launchBrowser(spDc) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  
  page.capturedToken = null;
  page.on('request', req => {
    const headers = req.headers();
    const auth = headers['authorization'];
    if (auth && auth.startsWith('Bearer ') && !page.capturedToken) {
      page.capturedToken = auth.slice(7);
    }
  });

  await page.setCookie({
    name: 'sp_dc', value: spDc,
    domain: '.spotify.com', path: '/', secure: true, httpOnly: true,
  });
  return { browser, page };
}

/**
 * Artist sayfasını açıp queryArtistOverview yanıtını yakalar.
 */
async function fetchArtistDiscographyGroup(page, artistId, operationName, fieldName) {
  let offset = 0;
  const limit = 50;
  const releases = [];
  while (true) {
    const data = await page.evaluate(async (token, artistId, offset, limit, operationName) => {
      const res = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          variables: { uri: `spotify:artist:${artistId}`, offset, limit, order: "DATE_DESC" },
          operationName,
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599"
            }
          }
        })
      });
      return res.json();
    }, page.capturedToken, artistId, offset, limit, operationName);

    const group = data?.data?.artistUnion?.discography?.[fieldName];
    if (!group?.items) break;

    for (const item of group.items) {
      const a = item.releases?.items?.[0];
      if (!a) continue;
      releases.push({
        id:           a.id,
        title:        a.name,
        release_date: parseSpotifyDate(a.date),
        image_url:    a.coverArt?.sources?.[0]?.url ?? null,
      });
    }

    if (group.items.length === 0 || releases.length >= group.totalCount) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 100));
  }
  return releases;
}

async function fetchArtistAlbums(page, artistId) {
  let result = null;
  const handler = async (res) => {
    try {
      if (!res.url().includes('pathfinder/v2')) return;
      const body = await res.json().catch(() => null);
      const a = body?.data?.artistUnion;
      if (a?.uri === `spotify:artist:${artistId}` && !result) result = a;
    } catch {}
  };
  page.on('response', handler);

  const nav = await page.goto(`https://open.spotify.com/artist/${artistId}`, {
    waitUntil: 'networkidle2', timeout: 40000,
  });
  await dismissCookieBanner(page);
  for (let i = 0; i < 15; i++) {
    if (result) break;
    await new Promise(r => setTimeout(r, 500));
  }
  page.off('response', handler);

  if (!result) {
    // A wrong/typo'd ID (or an artist Spotify has removed) 404s at the HTTP level
    // and never emits an artistUnion, so it looks identical to a network hiccup.
    // Say which one it is — a 404 is permanent and wants the artist deactivated,
    // a timeout is worth retrying next run.
    const status = nav?.status?.() ?? 0;
    if (status === 404) {
      const err = new Error(`Artist ${artistId} Spotify'da yok (HTTP 404) — ID hatalı ya da sanatçı kaldırılmış.`);
      err.artistNotFound = true;
      throw err;
    }
    throw new Error(`Artist ${artistId} verisi yakalanamadı${status ? ` (HTTP ${status})` : ''}.`);
  }

  // Side-channel: artist-level stats (monthly listeners, followers, world rank).
  // Read by discoverAllAlbumsPuppeteer; avoids changing this function's return type.
  page.lastArtistStats = {
    artist_id:         artistId,
    name:              result.profile?.name ?? null,
    monthly_listeners: result.stats?.monthlyListeners ?? null,
    followers:         result.stats?.followers ?? null,
    world_rank:        result.stats?.worldRank ?? null,
  };

  // Ensure token is captured
  for (let i = 0; i < 10; i++) {
    if (page.capturedToken) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!page.capturedToken) {
    console.warn('[fetchArtistAlbums] Token not captured. Falling back to non-paginated overview.');
    const albums = [];
    const push = (releases) => {
      for (const item of (releases?.items ?? [])) {
        const a = item.releases?.items?.[0];
        if (!a) continue;
        albums.push({
          id:           a.id,
          title:        a.name,
          release_date: parseSpotifyDate(a.date),
          image_url:    a.coverArt?.sources?.[0]?.url ?? null,
        });
      }
    };
    const disc = result.discography;
    push(disc?.albums);
    push(disc?.singles);
    push(disc?.compilations);
    return albums;
  }

  console.log(`[fetchArtistAlbums] Querying paginated discography groups using GraphQL...`);
  try {
    const albums = await fetchArtistDiscographyGroup(page, artistId, 'queryArtistDiscographyAlbums', 'albums');
    const singles = await fetchArtistDiscographyGroup(page, artistId, 'queryArtistDiscographySingles', 'singles');
    const compilations = await fetchArtistDiscographyGroup(page, artistId, 'queryArtistDiscographyCompilations', 'compilations');
    
    return [...albums, ...singles, ...compilations];
  } catch (err) {
    console.warn('[fetchArtistAlbums] Paginated GraphQL fetch failed, falling back to overview:', err.message);
    const albums = [];
    const push = (releases) => {
      for (const item of (releases?.items ?? [])) {
        const a = item.releases?.items?.[0];
        if (!a) continue;
        albums.push({
          id:           a.id,
          title:        a.name,
          release_date: parseSpotifyDate(a.date),
          image_url:    a.coverArt?.sources?.[0]?.url ?? null,
        });
      }
    };
    const disc = result.discography;
    push(disc?.albums);
    push(disc?.singles);
    push(disc?.compilations);
    return albums;
  }
}


/**
 * Album sayfasını açıp getAlbum yanıtını yakalar (track + playcount).
 */
async function fetchAlbumTracks(page, albumId) {
  // Ensure token is captured
  for (let i = 0; i < 10; i++) {
    if (page.capturedToken) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (page.capturedToken) {
    // The pathfinder endpoint intermittently returns an empty body ("Unexpected
    // end of JSON input"), which used to drop us straight into the 40s page-nav
    // fallback below. Retry the cheap in-page fetch once first — it almost always
    // succeeds on the second try, saving ~40-50s per affected album.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await page.evaluate(async (token, albumId) => {
          const res = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              variables: {
                uri: `spotify:album:${albumId}`,
                offset: 0,
                limit: 300
              },
              operationName: "queryAlbumTracks",
              extensions: {
                persistedQuery: {
                  version: 1,
                  sha256Hash: "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10"
                }
              }
            })
          });
          if (!res.ok) return { __err: 'http ' + res.status };
          const text = await res.text();
          if (!text) return { __err: 'empty body' };
          try { return JSON.parse(text); } catch { return { __err: 'bad json' }; }
        }, page.capturedToken, albumId);

        if (data && !data.__err) {
          const items = data?.data?.albumUnion?.tracksV2?.items ?? [];
          return items.map(item => {
            const t = item.track;
            if (!t) return null;
            const artistUris = (t.artists?.items ?? []).map(x => x.uri);
            return {
              id:           t.uri?.split(':')[2],
              title:        t.name,
              duration_ms:  t.duration?.totalMilliseconds ?? null,
              track_number: t.trackNumber ?? null,
              playCount:    parseInt(t.playcount ?? '0', 10),
              artistUris,
            };
          }).filter(Boolean);
        }
        if (attempt === 0) { await new Promise(r => setTimeout(r, 400)); continue; }
        console.warn(`[fetchAlbumTracks] GraphQL empty for album ${albumId} (${data.__err}) after retry, falling back to page navigation.`);
      } catch (err) {
        if (attempt === 0) { await new Promise(r => setTimeout(r, 400)); continue; }
        console.warn(`[fetchAlbumTracks] Paginated GraphQL query failed for album ${albumId}, falling back to page navigation:`, err.message);
      }
    }
  }

  let result = null;
  const handler = async (res) => {
    try {
      if (!res.url().includes('pathfinder/v2')) return;
      const body = await res.json().catch(() => null);
      const al = body?.data?.albumUnion;
      // Sadece tam Album response'unu al (track verisi olan)
      if (al?.__typename === 'Album' && al?.uri === `spotify:album:${albumId}` && al?.tracksV2?.items && !result) {
        result = al;
      }
    } catch {}
  };
  page.on('response', handler);

  try {
    await page.goto(`https://open.spotify.com/album/${albumId}`, {
      waitUntil: 'networkidle2', timeout: 15000,
    });
  } catch (navErr) {
    // networkidle2 can time out on heavy pages even though the album response
    // already arrived via the interception handler; don't burn the full budget.
    console.warn(`[fetchAlbumTracks] Nav timeout for album ${albumId} (${navErr.message}); checking interception.`);
  }
  await dismissCookieBanner(page);
  for (let i = 0; i < 12; i++) {
    if (result) break;
    await new Promise(r => setTimeout(r, 500));
  }
  page.off('response', handler);

  if (!result) {
    console.warn(`[fetchAlbumTracks] Album ${albumId} verisi yakalanamadı.`);
    return [];
  }

  const items = result.tracksV2?.items ?? [];
  return items.map(item => {
    const t = item.track;
    if (!t) return null;
    const artistUris = (t.artists?.items ?? []).map(x => x.uri);
    return {
      id:           t.uri?.split(':')[2],
      title:        t.name,
      duration_ms:  t.duration?.totalMilliseconds ?? null,
      track_number: t.trackNumber ?? null,
      playCount:    parseInt(t.playcount ?? '0', 10),
      artistUris,
    };
  }).filter(Boolean);
}

/**
 * Artist'in featured olduğu (appears on) albümleri döner.
 * artistUnion.relatedContent.appearsOn.items[i].releases.items[0]
 */
async function fetchArtistAppearsOn(page, artistId) {
  // Ensure token is captured
  for (let i = 0; i < 20; i++) {
    if (page.capturedToken) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const allAlbums = [];
  if (!page.capturedToken) {
    console.warn('[fetchArtistAppearsOn] Token not captured. Falling back to single-page interception.');
    let result = null;
    const handler = async (res) => {
      try {
        if (!res.url().includes('pathfinder/v2')) return;
        const body = await res.json().catch(() => null);
        const a = body?.data?.artistUnion;
        if (a?.relatedContent?.appearsOn && !result) result = a.relatedContent.appearsOn;
      } catch {}
    };
    page.on('response', handler);

    await page.goto(`https://open.spotify.com/artist/${artistId}/appears-on`, {
      waitUntil: 'networkidle2', timeout: 40000,
    });
    await dismissCookieBanner(page);
    for (let i = 0; i < 15; i++) {
      if (result) break;
      await new Promise(r => setTimeout(r, 500));
    }
    page.off('response', handler);

    if (!result) {
      console.warn(`[fetchArtistAppearsOn] AppearsOn verisi yakalanamadı.`);
      return [];
    }

    for (const item of (result.items ?? [])) {
      const a = item.releases?.items?.[0];
      if (!a) continue;
      const primaryArtist = a.artists?.items?.[0]?.uri ?? null;
      allAlbums.push({
        id:             a.id,
        title:          a.name,
        release_date:   parseSpotifyDate(a.date),
        primary_artist: primaryArtist,
        image_url:      a.coverArt?.sources?.[0]?.url ?? null,
      });
    }
    return allAlbums;
  }

  console.log(`[fetchArtistAppearsOn] Querying paginated appearsOn using GraphQL inside browser...`);
  let offset = 0;
  const limit = 50;
  
  while (true) {
    try {
      const data = await page.evaluate(async (token, artistId, offset, limit) => {
        const res = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            variables: {
              uri: `spotify:artist:${artistId}`,
              offset,
              limit
            },
            operationName: "queryArtistAppearsOn",
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: "9a4bb7a20d6720fe52d7b47bc001cfa91940ddf5e7113761460b4a288d18a4c1"
              }
            }
          })
        });
        return res.json();
      }, page.capturedToken, artistId, offset, limit);
      
      const appearsOn = data?.data?.artistUnion?.relatedContent?.appearsOn;
      if (!appearsOn?.items) {
        console.warn(`[fetchArtistAppearsOn] No items returned at offset ${offset}`);
        break;
      }
      
      const items = appearsOn.items;
      for (const item of items) {
        const a = item.releases?.items?.[0];
        if (!a) continue;
        const primaryArtist = a.artists?.items?.[0]?.uri ?? null;
        allAlbums.push({
          id:             a.id,
          title:          a.name,
          release_date:   parseSpotifyDate(a.date),
          primary_artist: primaryArtist,
          image_url:      a.coverArt?.sources?.[0]?.url ?? null,
        });
      }
      
      console.log(`[fetchArtistAppearsOn]   Fetched ${items.length} releases (total: ${allAlbums.length}/${appearsOn.totalCount})`);
      if (items.length === 0 || allAlbums.length >= appearsOn.totalCount) {
        break;
      }
      offset += limit;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[fetchArtistAppearsOn] Error at offset ${offset}:`, err.message);
      break;
    }
  }
  
  return allAlbums;
}

/**
 * Fetches an artist's profile photo straight from the intercepted artistUnion
 * GraphQL response on their open.spotify.com page — same technique as
 * backfill-album-covers.js's albumCover(), just keyed on artistUnion.visuals
 * instead of albumUnion.coverArt. No separate API credentials needed.
 */
async function fetchArtistAvatar(page, artistId) {
  let avatar = null;
  const targetUri = `spotify:artist:${artistId}`;
  const handler = async (res) => {
    try {
      if (!res.url().includes('pathfinder/v2')) return;
      const body = await res.json().catch(() => null);
      const au = body?.data?.artistUnion;
      const sources = au?.visuals?.avatarImage?.sources;
      if (au?.uri === targetUri && sources?.length && !avatar) {
        // Pick the widest EXPLICITLY. This used to take the last element on the
        // assumption that the list was ascending; Spotify now sends them as
        // [640, 160, 320], so "last" was the 320px thumbnail and every artist
        // added since then got a soft, low-res photo.
        const best = sources.reduce((a, b) =>
          ((b.width || b.height || 0) > (a.width || a.height || 0) ? b : a));
        avatar = best.url || sources[0].url;
      }
    } catch {}
  };
  page.on('response', handler);
  try {
    await page.goto(`https://open.spotify.com/artist/${artistId}`, {
      waitUntil: 'networkidle2', timeout: 15000,
    });
  } catch (e) { /* response may already be intercepted despite a late asset timeout */ }
  for (let i = 0; i < 12; i++) {
    if (avatar) break;
    await new Promise(r => setTimeout(r, 500));
  }
  page.off('response', handler);
  return avatar;
}

module.exports = { launchBrowser, fetchArtistAlbums, fetchAlbumTracks, fetchArtistAppearsOn, fetchArtistAvatar };
