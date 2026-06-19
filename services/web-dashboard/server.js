const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { groupSameStreamDuplicates } = require('./lib/dups');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Render's proxy — trust X-Forwarded-* so req.protocol is https (used for absolute OG urls).
app.set('trust proxy', true);



// Roster fallback — mirrors the tracked_artists seed (migration 013). Used by
// GET /api/artists whenever the table is missing/empty (e.g. before the
// migration is applied), so the site never breaks. The table is the source of
// truth once seeded; this stays as a safety net.
const ARTIST_ROSTER_FALLBACK = [
  { artist_id: '31TPClRtHm23RisEBtV3X7', name: 'Justin Timberlake', image_url: '/images/jt.jpg',                                                  accent: '#1ed760', sort_order: 1,  album_only: false, locked: false },
  { artist_id: '5L1lO4eRHmJ7a0Q6csE5cT', name: 'LISA',              image_url: 'https://i.scdn.co/image/ab6761610000e5eb5cd3b3af8b72e32be78571ec', accent: '#ffd700', sort_order: 2,  album_only: false, locked: false },
  { artist_id: '2dIgFjalVxs4ThymZ67YCE', name: 'Stray Kids',        image_url: 'https://i.scdn.co/image/ab6761610000e5ebf9887d2c9288f0e50a3fd69f', accent: '#e2e2e7', sort_order: 3,  album_only: false, locked: false },
  { artist_id: '4UIOuc84ExWojcUzFGtb8W', name: 'Felix',             image_url: 'https://i.scdn.co/image/ab6761610000e5eb51e1a166ae0cc73d8ec19909', accent: '#ffb703', sort_order: 4,  album_only: false, locked: false },
  { artist_id: '2W8yFh0Ga6Yf3jiayVxwkE', name: 'Dove Cameron',      image_url: 'https://i.scdn.co/image/ab6761610000e5eb0c5fcd837c1420d97f500ef9', accent: '#b794f6', sort_order: 5,  album_only: false, locked: false },
  { artist_id: '1HY2Jd0NmPuamShAr6KMms', name: 'Lady Gaga',         image_url: 'https://i.scdn.co/image/ab6761610000e5ebaadc18cac8d48124357c38e6', accent: '#ff52a2', sort_order: 6,  album_only: true,  locked: false },
  { artist_id: '6qqNVTkY8uBg9cP3Jd7DAH', name: 'Billie Eilish',     image_url: 'https://i.scdn.co/image/ab6761610000e5eb4a21b4760d2ecb7b0dcdc8da', accent: '#bad80a', sort_order: 7,  album_only: true,  locked: false },
  { artist_id: '66CXWjxzNUsdJxJ2JdwvnR', name: 'Ariana Grande',     image_url: 'https://i.scdn.co/image/ab6761610000e5eb766397ec42a573a53eb5fb87', accent: '#b39ddb', sort_order: 8,  album_only: true,  locked: false },
  { artist_id: '6Ff53KvcvAj5U7Z1vojB5o', name: '*NSYNC',            image_url: 'https://i.scdn.co/image/ab6761610000e5eb9414ef07d0ca697726912df1', accent: '#3498db', sort_order: 9,  album_only: false, locked: false },
  { artist_id: '3LHYvj5ZejV1NLqncEObSJ', name: 'Vaelis',            image_url: 'https://i.scdn.co/image/ab6761610000e5eb05e2f96f53a2810f5dcdd6c1', accent: '#8b5cf6', sort_order: 10, album_only: false, locked: false },
  { artist_id: '3p3U04w2DaiBzuYMZnYr00', name: 'JC Chasez',         image_url: 'https://i.scdn.co/image/ab6761610000e5eb784d1c3b5bb30c5db83c8fe2', accent: '#e74c3c', sort_order: 11, album_only: false, locked: true  },
  { artist_id: '4qwGe91Bz9K2T8jXTZ815W', name: 'Janet Jackson',     image_url: 'https://i.scdn.co/image/ab6761610000e5eb8b290c36cbc9e89827ff562a', accent: '#d81b60', sort_order: 14, album_only: false, locked: false },
];

// Accepted access codes for the locked artist (JC Chasez). Both unlock the same content.
const JC_PASSCODES = ['peakedinhighschool', 'flop'];
const isJcAllowed = (passcode) => JC_PASSCODES.includes(passcode);

// Admin passcode for reading visitor feedback/requests. Set ADMIN_PASSCODE in the
// environment (Render dashboard); falls back to a dev default so local runs work.
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || 'pairofwings';
const isAdmin = (passcode) => typeof passcode === 'string' && passcode.length > 0 && passcode === ADMIN_PASSCODE;

// Salt for hashing submitter IPs (abuse tracking without storing raw IPs).
const IP_HASH_SECRET = process.env.IP_HASH_SECRET || 'spotify-streams-ip-salt';
const crypto = require('crypto');
const hashIp = (ip) => crypto.createHash('sha256').update(String(ip) + IP_HASH_SECRET).digest('hex').slice(0, 32);

// In-memory throttle: one submission per IP-hash per 30s (best-effort, resets on redeploy).
const lastSubmitAt = new Map();

// Tracks hidden from EVERY listing (songs list, album tracklist, milestones).
// Dead duplicates whose live copy is tracked under a different id.
const HIDDEN_TRACK_IDS = ['6233Z1W8t9Wn1f1gZqHhQ5']; // Suit & Tie - Radio Edit (frozen 2026-05-26; live = 4mQVHEjrnuUd7G5IVhSYTk)

// Admin-hidden song ids (hidden_songs table, migration 014), loaded into this
// cache on startup + after every change. The static HIDDEN_TRACK_IDS above are
// always merged in, so if the table is missing/empty behaviour is unchanged.
let hiddenSongsCache = [];
function hiddenTrackIdsSql() {
  const ids = [...new Set([...HIDDEN_TRACK_IDS, ...hiddenSongsCache])];
  return ids.map(id => `'${id}'`).join(', ');
}

// Felix is credited (sub-unit / featured) on these Stray Kids tracks, so kworb
// lists them on Felix's artist page. Their primary_artist is Stray Kids, so they
// fall outside Felix's "primary_artist = Felix" bucket — pin them in explicitly.
// They stay counted under Stray Kids too (kworb counts a song on every credited
// artist's page), so no double-subtraction is needed.
const FELIX_EXTRA_TRACK_IDS = [
  '1Iu7bqGwYVB6OGq4uLt2ak', // Because (Changbin, Felix)
  '3VMeAc0SlgLaS9RzA8TSxH', // Deep end (Felix)
  '0bxB5Jie9fGKTIibfYVfei', // Up All Night (Bang Chan, Changbin, Felix, Seungmin)
];
const FELIX_EXTRA_TRACK_IDS_SQL = FELIX_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// In-memory cache of active artists, initialized with the fallback list.
// Loaded from tracked_artists table on startup and refreshed on admin updates.
let activeArtistsCache = ARTIST_ROSTER_FALLBACK;

// EVERY tracked artist (active OR inactive). Used ONLY for JT's catch-all
// exclusion: JT's bucket is "everything not claimed by a named artist", so a
// named artist must keep excluding their songs even after they're hidden —
// otherwise hiding/removing an artist dumps their whole catalogue into JT.
let allArtistsCache = ARTIST_ROSTER_FALLBACK;

// The per-artist "which songs belong to this artist's dashboard bucket" filter,
// parameterised by table aliases so it can be reused in subqueries. $1 is the
// artist URI. MUST stay in sync with the inline copies in /api/songs & /api/stats.
function artistBucketMatchSQL(s, a) {
  // JT's catch-all must exclude EVERY tracked artist (active or not), so hiding
  // an artist never leaks their catalogue into JT.
  const jtExclusions = allArtistsCache
    .filter(item => item.artist_id !== '31TPClRtHm23RisEBtV3X7')
    .map(item => `${s}.primary_artist IS DISTINCT FROM 'spotify:artist:${item.artist_id}'`)
    .join(' AND ');

  // Per-artist viewing clauses only apply to currently-active artists.
  const nonJtArtists = activeArtistsCache.filter(item => item.artist_id !== '31TPClRtHm23RisEBtV3X7');
  const specialIds = ['1HY2Jd0NmPuamShAr6KMms', '6qqNVTkY8uBg9cP3Jd7DAH', '66CXWjxzNUsdJxJ2JdwvnR', '4UIOuc84ExWojcUzFGtb8W'];
  const normalClauses = nonJtArtists
    .filter(item => !specialIds.includes(item.artist_id))
    .map(item => `OR ($1 = 'spotify:artist:${item.artist_id}' AND ${s}.primary_artist = 'spotify:artist:${item.artist_id}')`)
    .join('\n    ');

  return `(
    ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7'${jtExclusions ? ' AND (' + jtExclusions + ')' : ''})
    ${normalClauses}
    OR ($1 = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W' AND (${s}.primary_artist = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W' OR ${s}.id IN (${FELIX_EXTRA_TRACK_IDS_SQL})))
    OR ($1 = 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND (${a}.title ILIKE '%fame monster%' OR ${a}.title ILIKE '%mayhem%' OR ${a}.id = '5C7E6m8S9vJ36z0Z39O64L'))
    OR ($1 = 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND (${a}.title ILIKE 'HIT ME HARD AND SOFT%' OR ${a}.title ILIKE 'Happier Than Ever%' OR ${a}.title ILIKE 'WHEN WE ALL FALL ASLEEP, WHERE DO WE GO%' OR ${a}.title ILIKE 'dont smile at me%' OR ${a}.title ILIKE 'don''t smile at me%' OR ${a}.title ILIKE 'Guitar Songs%'))
    OR ($1 = 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND (${a}.title ILIKE 'Yours Truly%' OR ${a}.title ILIKE 'My Everything%' OR ${a}.title ILIKE 'Dangerous Woman%' OR ${a}.title ILIKE 'Sweetener%' OR ${a}.title ILIKE 'thank u, next%' OR ${a}.title ILIKE 'Positions%' OR ${a}.title ILIKE 'eternal sunshine%'))
  )`;
}

// Dynamically generate the album exclusion clauses for albums query based on active artists.
function artistAlbumMatchSQL(s) {
  // Same rule as artistBucketMatchSQL: JT excludes every tracked artist.
  const jtExclusions = allArtistsCache
    .filter(item => item.artist_id !== '31TPClRtHm23RisEBtV3X7')
    .map(item => `${s}.primary_artist IS DISTINCT FROM 'spotify:artist:${item.artist_id}'`)
    .join(' AND ');

  return `(
    ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7'${jtExclusions ? ' AND (' + jtExclusions + ')' : ''})
    OR ($1 <> 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND ${s}.primary_artist = $1)
  )`;
}

// FutureSex/LoveSounds album-id family (all editions + the comp that holds the
// official LoveStoned radio edit). The full-discography scrape pulled in dozens
// of third-party DJ remixes/mixes/dubs/instrumentals released under these ids.
const FSLS_ALBUM_IDS = [
  '0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp',
  '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6',
  '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI',
  '0NvpeY8oCm6oIlhH5Jw4fo', '4zJu74Lx1jB6PcpjKZ7rf8',
];
const FSLS_ALBUM_IDS_SQL = FSLS_ALBUM_IDS.map(id => `'${id}'`).join(', ');

// The 20/20 Experience (Deluxe) family: the deluxe itself + the standalone
// "Mirrors - Radio Edit" single + the live "Suit & Tie - Radio Edit" single.
// Both the album list totals and the album-detail tracklist count these
// singles into the deluxe album.
const TT20_ALBUM_IDS = [
  '0O82niJ0NpcptYRxogeEZu', '28GWVLkctSuSWQ1EUIxZ8m', '5jlQrOtSuTXojcvBCpivyo',
];
const TT20_ALBUM_IDS_SQL = TT20_ALBUM_IDS.map(id => `'${id}'`).join(', ');

// Alternate versions hidden from album tracklists AND album totals
// (the songs stay in the catalog / overall artist totals).
const HIDDEN_ALBUM_TRACK_IDS = [
  '1FaU6P6WJF8irbZ1MXo9ky',  // Pose - Main Version (FSLS Deluxe)
  '2rXovB7Zco7nc3nTHXKJoh',  // My Love (feat. T.I.) - Instrumental
  '5CORNAMvxPl6uCikCsq1Ei',  // What Goes Around...Comes Around - Instrumental
  '6233Z1W8t9Wn1f1gZqHhQ5',  // Suit & Tie - Radio Edit (frozen 2026-05-26 copy; replaced by live 4mQVHEjrnuUd7G5IVhSYTk)
];
const HIDDEN_ALBUM_TRACK_IDS_SQL = HIDDEN_ALBUM_TRACK_IDS.map(id => `'${id}'`).join(', ');

// SQL boolean matching NON-official alternate versions by title: DJ remixes,
// club/radio mixes, dubs, instrumentals, and "<Song> - <Name> Radio Edit".
// Official radio edits ("<Song> - Radio Edit", nothing between dash and the
// words) are intentionally NOT matched so they stay visible.
const NON_OFFICIAL_VERSION_SQL = `(
  s.title ILIKE '%remix%'
  OR s.title ILIKE '%instrumental%'
  OR s.title ILIKE '% mix%'
  OR s.title ILIKE '%dub'
  OR s.title ~* ' - .+ radio (edit|mix|remix)'
)`;
// Hide those alternate versions, but only within the FSLS family.
const FSLS_REMIX_EXCLUSION_SQL =
  `NOT (s.album_id IN (${FSLS_ALBUM_IDS_SQL}) AND ${NON_OFFICIAL_VERSION_SQL})`;

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5,
  // Close our idle clients before Neon's ~5min autosuspend severs them,
  // so we reconnect cleanly instead of getting killed sockets.
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  keepAlive: true
});

// Neon autosuspend kills idle connections; without this listener the
// resulting 'error' event would crash the whole Node process.
pool.on('error', (err) => {
  console.error('[db] Idle client error (recovering):', err.message);
});

// Errors Neon throws while suspended/waking — safe to retry.
const TRANSIENT_PG_CODES = new Set(['XX000', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006']);
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
const isTransientDbError = (err) =>
  TRANSIENT_PG_CODES.has(err.code) ||
  TRANSIENT_NET_CODES.has(err.code) ||
  /connection terminated|control plane|connection refused|timeout exceeded/i.test(err.message || '');

// pool.query with retry/backoff so a request arriving while Neon wakes up
// (a few seconds, occasionally longer) succeeds instead of returning 500.
const RETRY_DELAYS_MS = [500, 1500, 4000, 8000];
async function dbQuery(text, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientDbError(err)) throw err;
      console.warn(`[db] Transient error "${err.code || err.message}", retry ${attempt + 1}/${RETRY_DELAYS_MS.length}...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Reload active artists cache from tracked_artists table, falling back to static roster.
async function refreshActiveArtistsCache() {
  try {
    const r = await dbQuery(
      `SELECT artist_id, name, image_url, accent, sort_order, album_only, locked, active
       FROM tracked_artists ORDER BY sort_order, name`
    );
    if (r.rows.length) {
      allArtistsCache = r.rows;
      activeArtistsCache = r.rows.filter(a => a.active);
      return;
    }
  } catch (err) {
    console.warn('[cache] tracked_artists table unavailable, using fallback:', err.code || err.message);
  }
  activeArtistsCache = ARTIST_ROSTER_FALLBACK;
  allArtistsCache = ARTIST_ROSTER_FALLBACK;
}

// Load admin-hidden song ids from the hidden_songs table into the cache.
// Falls back to an empty list (→ only the static HIDDEN_TRACK_IDS apply).
async function refreshHiddenSongsCache() {
  try {
    const r = await dbQuery(`SELECT song_id FROM hidden_songs`);
    hiddenSongsCache = r.rows.map(x => x.song_id);
  } catch (err) {
    console.warn('[cache] hidden_songs table unavailable:', err.code || err.message);
    hiddenSongsCache = [];
  }
}

// Last-resort guards: log instead of letting a stray async error take the site down.
process.on('unhandledRejection', (err) => {
  console.error('[fatal-guard] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] Uncaught exception:', err);
});

app.use(express.json());
app.use(cookieParser('spotify-streams-secret-key'));

// Auth check middleware.
// The general site passcode has been removed — the dashboard is public.
// JC Chasez stays locked separately via validateArtistAccess / isJcAllowed
// (X-JC-Passcode header), which do NOT depend on this middleware.
const requireAuth = (req, res, next) => next();

// Keep-alive ping target (cron-job.org, every 10 min) — keeps Render's free
// instance from spinning down. Deliberately does NOT touch the DB so Neon can
// still autosuspend and save its free compute hours.
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Public Routes
app.get('/login', (req, res) => {
  if (req.signedCookies.fan_session) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.post('/api/login', async (req, res) => {
  const { passcode } = req.body;
  if (!passcode) {
    return res.status(400).json({ success: false, message: 'Passcode is required!' });
  }
  try {
    const result = await dbQuery('SELECT * FROM access_codes WHERE code = $1', [passcode]);
    if (result.rows.length > 0) {
      res.cookie('fan_session', passcode, {
        signed: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
      });
      return res.json({ success: true });
    } else {
      return res.status(401).json({ success: false, message: 'Invalid passcode!' });
    }
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error occurred.' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('fan_session');
  res.redirect('/login');
});

// Style.css must be accessible by the login page
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/style.css'));
});

// Protected API Routes
const validateArtistAccess = (req, res, next) => {
  const artistParam = req.query.artist;
  if (artistParam) {
    const artistId = artistParam.replace('spotify:artist:', '');
    if (artistId === '3p3U04w2DaiBzuYMZnYr00') {
      const passcode = req.headers['x-jc-passcode'];
      if (!isJcAllowed(passcode)) {
        return res.status(403).json({ error: 'Forbidden: Access to this artist is locked.' });
      }
    }
  }
  next();
};

app.post('/api/verify-jc', requireAuth, (req, res) => {
  const { passcode } = req.body;
  if (isJcAllowed(passcode)) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, message: 'Invalid passcode!' });
});

app.get('/api/songs', requireAuth, validateArtistAccess, async (req, res) => {
  const artistParam = req.query.artist || '31TPClRtHm23RisEBtV3X7';
  const artistUri = artistParam.startsWith('spotify:artist:') ? artistParam : `spotify:artist:${artistParam}`;
  try {
    const query = `
      SELECT
        s.id,
        s.title,
        s.is_featured,
        s.is_solo,
        s.duration_ms,
        CASE 
          WHEN s.album_id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN '0tcExuDWMQdBbwSpqN8Ku2'
          WHEN s.album_id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
          ELSE s.album_id 
        END AS album_id,
        CASE 
          WHEN s.album_id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN 'FutureSex/LoveSounds (Deluxe Edition)'
          WHEN s.album_id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN 'eternal sunshine (Deluxe Edition)'
          ELSE a.title 
        END AS album_title,
        CASE 
          WHEN s.album_id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN '2006-09-11'::date
          WHEN s.album_id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '2024-03-08'::date
          WHEN s.album_id = '74vajFwEwXJ61OW1DKSPEa' THEN '2020-10-30'::date
          WHEN s.album_id = '2uMTmPEFafKfKeobvdx5EE' THEN '2014-08-25'::date
          WHEN s.album_id = '0JPItniR1C7tjd4ac2R1Vk' THEN '2016-05-20'::date
          WHEN s.album_id = '2VSBGJ8bUuNgmOYXHIQagM' THEN '2013-09-03'::date
          ELSE a.release_date 
        END AS release_date,
        dsc.recorded_date,
        COALESCE(dsc.cumulative, 0)::bigint AS cumulative,
        COALESCE(dsc.daily_gain, 0)::bigint AS daily_gain,
        -- 7-day trailing average daily gain — smooths Spotify's weekly cadence
        -- (weekend spikes / Monday drops) so ETA estimates aren't whipsawed by
        -- which single day the latest snapshot happens to land on.
        COALESCE(avg7.daily_avg_7d, 0)::bigint AS daily_avg_7d
      FROM songs s
      LEFT JOIN albums a ON s.album_id = a.id
      LEFT JOIN (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          recorded_date,
          cumulative,
          daily_gain
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc ON s.id = dsc.canonical_id
      LEFT JOIN (
        SELECT canonical_id, ROUND(AVG(daily_gain))::bigint AS daily_avg_7d
        FROM (
          SELECT canonical_id, daily_gain,
                 ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY recorded_date DESC) AS rn
          FROM daily_streams_canonical
        ) z WHERE rn <= 7
        GROUP BY canonical_id
      ) avg7 ON s.id = avg7.canonical_id
      WHERE s.canonical_id IS NULL AND ${artistBucketMatchSQL('s', 'a')}
      AND s.id NOT IN (${hiddenTrackIdsSql()})
      AND ${FSLS_REMIX_EXCLUSION_SQL}
      ORDER BY cumulative DESC;
    `;
    const result = await dbQuery(query, [artistUri]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch songs error:', err);
    res.status(500).json({ error: 'Failed to load song list.' });
  }
});

app.get('/api/stats', requireAuth, validateArtistAccess, async (req, res) => {
  const artistParam = req.query.artist || '31TPClRtHm23RisEBtV3X7';
  const artistUri = artistParam.startsWith('spotify:artist:') ? artistParam : `spotify:artist:${artistParam}`;
  try {
    const query = `
      SELECT 
        COALESCE(SUM(dsc.cumulative), 0)::bigint AS total_streams,
        COALESCE(SUM(dsc.cumulative) FILTER (WHERE NOT s.is_featured), 0)::bigint AS lead_streams,
        COALESCE(SUM(dsc.cumulative) FILTER (WHERE s.is_featured), 0)::bigint AS feat_streams,
        COALESCE(SUM(dsc.cumulative) FILTER (WHERE s.is_solo), 0)::bigint AS solo_streams,
        COALESCE(SUM(dsc.daily_gain), 0)::bigint AS daily_gain,
        -- 7-day trailing average of the artist's total daily gain. Smooths out
        -- Spotify's irregular update cadence (some days post 0, the next ~2x),
        -- which otherwise makes the headline daily number bounce wildly.
        -- Robust to catalogue additions: a song's first snapshot has NULL
        -- daily_gain (LAG), so newly-tracked songs don't spike the average.
        (
          SELECT COALESCE(ROUND(AVG(pd.day_gain)), 0)::bigint
          FROM (
            SELECT d2.recorded_date, SUM(d2.daily_gain) AS day_gain
            FROM daily_streams_canonical d2
            JOIN songs s2 ON s2.id = d2.canonical_id
            JOIN albums a2 ON s2.album_id = a2.id
            WHERE ${artistBucketMatchSQL('s2', 'a2')}
              AND s2.id NOT IN (${hiddenTrackIdsSql()})
            GROUP BY d2.recorded_date
            ORDER BY d2.recorded_date DESC
            LIMIT 7
          ) pd
        ) AS daily_avg_7d,
        COUNT(*)::int AS total_songs,
        MAX(dsc.recorded_date) AS last_update
      FROM (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          cumulative,
          daily_gain,
          recorded_date
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc
      JOIN songs s ON s.id = dsc.canonical_id
      JOIN albums a ON s.album_id = a.id
      WHERE ${artistBucketMatchSQL('s', 'a')}
      AND s.id NOT IN (${hiddenTrackIdsSql()});
    `;
    const result = await dbQuery(query, [artistUri]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fetch stats error:', err);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

app.get('/api/artist-stats', requireAuth, validateArtistAccess, async (req, res) => {
  const artistParam = req.query.artist || '31TPClRtHm23RisEBtV3X7';
  const artistId = artistParam.replace('spotify:artist:', '');
  try {
    // Last two daily snapshots → latest values + day-over-day change.
    const latestRes = await dbQuery(
      `SELECT artist_name, monthly_listeners, followers, world_rank, recorded_date
       FROM artist_stats
       WHERE artist_id = $1
       ORDER BY recorded_date DESC
       LIMIT 2`,
      [artistId]
    );
    const historyRes = await dbQuery(
      `SELECT recorded_date, monthly_listeners, followers
       FROM artist_stats
       WHERE artist_id = $1 AND monthly_listeners IS NOT NULL
       ORDER BY recorded_date ASC`,
      [artistId]
    );

    const latest = latestRes.rows[0] || null;
    const prev = latestRes.rows[1] || null;
    let monthlyListenersChange = null;
    let followersChange = null;
    if (latest && prev) {
      if (latest.monthly_listeners != null && prev.monthly_listeners != null) {
        monthlyListenersChange = Number(latest.monthly_listeners) - Number(prev.monthly_listeners);
      }
      if (latest.followers != null && prev.followers != null) {
        followersChange = Number(latest.followers) - Number(prev.followers);
      }
    }

    res.json({
      latest: latest ? { ...latest, monthly_listeners_change: monthlyListenersChange, followers_change: followersChange } : null,
      history: historyRes.rows
    });
  } catch (err) {
    console.error('Fetch artist stats error:', err);
    res.status(500).json({ error: 'Failed to load artist stats.' });
  }
});

app.get('/api/scraper-status', requireAuth, async (req, res) => {
  try {
    // 1. Global scraper status row
    const statusRes = await dbQuery(
      'SELECT status, started_at, updated_at FROM scraper_status WHERE id = 1'
    );
    const global = statusRes.rows[0] || { status: 'idle', started_at: null, updated_at: null };

    // 2. Per-artist: last snapshot date + row count from daily_streams_canonical.
    //    Join via songs.primary_artist (the canonical artist URI column) →
    //    daily_streams_canonical (view on canonical_streams keyed by canonical_id = songs.id).
    //    Falls back gracefully if tracked_artists doesn't exist yet.
    let perArtist = [];
    try {
      const artistRes = await dbQuery(`
        SELECT
          ta.artist_id,
          ta.name,
          ta.active,
          COUNT(DISTINCT dsc.canonical_id)::int  AS row_count,
          MAX(dsc.recorded_date)                  AS last_date,
          MIN(dsc.recorded_date)                  AS first_date
        FROM tracked_artists ta
        LEFT JOIN songs s
          ON s.primary_artist = 'spotify:artist:' || ta.artist_id
        LEFT JOIN daily_streams_canonical dsc
          ON dsc.canonical_id = s.id
        GROUP BY ta.artist_id, ta.name, ta.active
        ORDER BY ta.sort_order, ta.name
      `);
      perArtist = artistRes.rows;
    } catch (_) {
      // tracked_artists table may not exist yet — skip per-artist data
    }


    res.json({
      status:      global.status,
      started_at:  global.started_at,
      updated_at:  global.updated_at,
      artists:     perArtist,
    });
  } catch (err) {
    res.json({ status: 'idle', started_at: null, updated_at: null, artists: [] });
  }
});


app.get('/api/milestones-reached', requireAuth, validateArtistAccess, async (req, res) => {
  const artistParam = req.query.artist || '31TPClRtHm23RisEBtV3X7';
  const artistUri = artistParam.startsWith('spotify:artist:') ? artistParam : `spotify:artist:${artistParam}`;
  try {
    // A milestone M is "reached on date D" when a song or album's cumulative crossed M between
    // the previous snapshot (prev_cum < M) and D (cumulative >= M). Only crossings we actually
    // witnessed during tracking are returned: prev_cum NOT NULL AND the gap between snapshots
    // is small (≤ MILESTONE_MAX_GAP_DAYS). A song frozen for weeks then refreshed makes a huge
    // jump that crosses several thresholds — attributing that jump to the refresh date would
    // wrongly claim "reached 1B today" when it actually happened during the gap. We skip those.
    const MILESTONE_MAX_GAP_DAYS = 2;
    const query = `
      WITH thresholds(m) AS (
        VALUES (1000), (5000), (10000), (25000), (50000), (100000), (250000), (500000),
               (1000000), (2500000), (5000000), (10000000), (25000000), (50000000),
               (100000000), (200000000), (300000000), (400000000), (500000000),
               (600000000), (700000000), (800000000), (900000000), (1000000000),
               (1200000000), (1500000000), (1800000000), (2000000000), (2500000000),
               (3000000000), (3500000000), (4000000000), (4500000000), (5000000000)
      ),
      -- Song History and crossings
      song_hist AS (
        SELECT
          dsc.canonical_id,
          dsc.recorded_date,
          dsc.cumulative,
          LAG(dsc.cumulative) OVER (PARTITION BY dsc.canonical_id ORDER BY dsc.recorded_date) AS prev_cum,
          LAG(dsc.recorded_date) OVER (PARTITION BY dsc.canonical_id ORDER BY dsc.recorded_date) AS prev_date
        FROM daily_streams_canonical dsc
        JOIN songs s ON s.id = dsc.canonical_id
        JOIN albums a ON s.album_id = a.id
        WHERE ${artistBucketMatchSQL('s', 'a')}
        AND s.id NOT IN (${hiddenTrackIdsSql()})
      ),
      song_crossings AS (
        SELECT
          h.canonical_id AS song_id,
          c.title,
          t.m::bigint AS milestone,
          MIN(h.recorded_date) AS reached_date,
          'song'::text AS type
        FROM song_hist h
        JOIN thresholds t ON h.prev_cum IS NOT NULL
                         AND (h.recorded_date - h.prev_date) <= ${MILESTONE_MAX_GAP_DAYS}
                         AND h.prev_cum < t.m AND h.cumulative >= t.m
        JOIN songs c ON c.id = h.canonical_id
        GROUP BY h.canonical_id, c.title, t.m
      ),
      
      -- Album History and crossings
      album_songs_mapped AS (
        SELECT DISTINCT ON (
          CASE
            WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
            WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
            WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
            ELSE s.album_id
          END,
          COALESCE(s.canonical_id, s.id)
        )
        CASE
          WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
          WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
          WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
          ELSE s.album_id
        END AS album_id,
        COALESCE(s.canonical_id, s.id) AS canonical_song_id
        FROM songs s
        JOIN albums a ON s.album_id = a.id
        WHERE ${artistAlbumMatchSQL('s')}
        AND COALESCE(s.canonical_id, s.id) NOT IN (${HIDDEN_ALBUM_TRACK_IDS_SQL})
        AND ${FSLS_REMIX_EXCLUSION_SQL}
      ),
      album_display_titles AS (
        SELECT DISTINCT ON (
          CASE 
            WHEN id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
            WHEN id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
            WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
            ELSE id 
          END
        )
        CASE 
          WHEN id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
          WHEN id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
          WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
          ELSE id 
        END AS album_id,
        CASE 
          WHEN id IN (${FSLS_ALBUM_IDS_SQL}) THEN 'FutureSex/LoveSounds (Deluxe Edition)'
          WHEN id IN (${TT20_ALBUM_IDS_SQL}) THEN 'The 20/20 Experience (Deluxe Version)'
          WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN 'eternal sunshine (Deluxe Edition)'
          ELSE title 
        END AS album_title
        FROM albums
      ),
      album_daily_raw AS (
        SELECT
          asm.album_id,
          adt.album_title,
          dsc.recorded_date,
          SUM(COALESCE(dsc.cumulative, 0))::bigint AS raw_cumulative
        FROM daily_streams_canonical dsc
        JOIN album_songs_mapped asm ON dsc.canonical_id = asm.canonical_song_id
        JOIN album_display_titles adt ON asm.album_id = adt.album_id
        GROUP BY asm.album_id, adt.album_title, dsc.recorded_date
      ),
      -- Running max over the raw daily sum: if a day's scrape is partial (some
      -- songs failed and the SUM dipped) we hold the previous high instead of
      -- dropping, so the next full scrape doesn't look like a milestone jump.
      -- The per-song view already enforces a running max; this protects against
      -- the album-level SUM losing rows on partial-scrape days.
      album_daily_totals AS (
        SELECT
          album_id,
          album_title,
          recorded_date,
          MAX(raw_cumulative) OVER (
            PARTITION BY album_id
            ORDER BY recorded_date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumulative
        FROM album_daily_raw
      ),
      album_hist AS (
        SELECT
          album_id,
          album_title,
          recorded_date,
          cumulative,
          LAG(cumulative) OVER (PARTITION BY album_id ORDER BY recorded_date) AS prev_cum,
          LAG(recorded_date) OVER (PARTITION BY album_id ORDER BY recorded_date) AS prev_date
        FROM album_daily_totals
      ),
      -- The min cumulative we have ever observed for this album. If it is already
      -- above some milestone M, then the album crossed M before tracking started
      -- (or before the album's song roster stabilised in our DB) — don't claim
      -- those crossings happened on the day the album-level sum first jumped past M.
      album_min_cum AS (
        SELECT album_id, MIN(cumulative) AS min_seen
        FROM album_hist
        GROUP BY album_id
      ),
      album_crossings AS (
        SELECT
          ah.album_id AS song_id, -- align column names for UNION
          ah.album_title AS title,
          t.m::bigint AS milestone,
          MIN(ah.recorded_date) AS reached_date,
          'album'::text AS type
        FROM album_hist ah
        JOIN album_min_cum amc ON amc.album_id = ah.album_id
        JOIN thresholds t ON ah.prev_cum IS NOT NULL
                         AND (ah.recorded_date - ah.prev_date) <= ${MILESTONE_MAX_GAP_DAYS}
                         AND ah.prev_cum < t.m AND ah.cumulative >= t.m
                         AND amc.min_seen < t.m
        GROUP BY ah.album_id, ah.album_title, t.m
      )
      SELECT * FROM song_crossings
      UNION ALL
      SELECT * FROM album_crossings
      ORDER BY reached_date DESC, milestone DESC;
    `;
    const result = await dbQuery(query, [artistUri]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch milestones reached error:', err);
    res.status(500).json({ error: 'Failed to load reached milestones.' });
  }
});

app.get('/api/albums', requireAuth, validateArtistAccess, async (req, res) => {
  const artistParam = req.query.artist || '31TPClRtHm23RisEBtV3X7';
  const artistUri = artistParam.startsWith('spotify:artist:') ? artistParam : `spotify:artist:${artistParam}`;
  try {
    const query = `
      WITH album_canonical_songs AS (
        SELECT DISTINCT ON (
          CASE
            WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
            WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
            WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
            ELSE s.album_id
          END,
          COALESCE(s.canonical_id, s.id)
        )
        CASE
          WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
          WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
          WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
          ELSE s.album_id
        END AS album_id,
        COALESCE(s.canonical_id, s.id) AS canonical_song_id,
        COALESCE(dsc.cumulative, 0) AS cumulative,
        COALESCE(dsc.daily_gain, 0) AS daily_gain,
        COALESCE(avg7.daily_avg_7d, 0) AS daily_avg_7d
        FROM songs s
        JOIN albums a ON s.album_id = a.id
        LEFT JOIN (
          SELECT DISTINCT ON (canonical_id)
            canonical_id,
            cumulative,
            daily_gain
          FROM daily_streams_canonical
          ORDER BY canonical_id, recorded_date DESC
        ) dsc ON COALESCE(s.canonical_id, s.id) = dsc.canonical_id
        LEFT JOIN (
          SELECT canonical_id, ROUND(AVG(daily_gain))::bigint AS daily_avg_7d
          FROM (
            SELECT canonical_id, daily_gain,
                   ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY recorded_date DESC) AS rn
            FROM daily_streams_canonical
          ) z WHERE rn <= 7
          GROUP BY canonical_id
        ) avg7 ON COALESCE(s.canonical_id, s.id) = avg7.canonical_id
        WHERE ${artistAlbumMatchSQL('s')}
        AND COALESCE(s.canonical_id, s.id) NOT IN (${HIDDEN_ALBUM_TRACK_IDS_SQL})
        AND ${FSLS_REMIX_EXCLUSION_SQL}
      ),
      unique_albums AS (
        SELECT DISTINCT ON (
          CASE 
            WHEN id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN '0tcExuDWMQdBbwSpqN8Ku2'
            WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
            ELSE id 
          END
        )
        CASE 
          WHEN id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN '0tcExuDWMQdBbwSpqN8Ku2'
          WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
          ELSE id 
        END AS album_id,
        CASE 
          WHEN id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN 'FutureSex/LoveSounds (Deluxe Edition)'
          WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN 'eternal sunshine (Deluxe Edition)'
          ELSE title 
        END AS album_title,
        CASE 
          WHEN id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN '2006-09-11'::date
          WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '2024-03-08'::date
          WHEN id = '74vajFwEwXJ61OW1DKSPEa' THEN '2020-10-30'::date
          WHEN id = '2uMTmPEFafKfKeobvdx5EE' THEN '2014-08-25'::date
          WHEN id = '0JPItniR1C7tjd4ac2R1Vk' THEN '2016-05-20'::date
          WHEN id = '2VSBGJ8bUuNgmOYXHIQagM' THEN '2013-09-03'::date
          ELSE release_date 
        END AS release_date,
        CASE 
          WHEN id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN 'https://i.scdn.co/image/ab67616d0000b273c68f26a3d34fbd0faed2b473'
          WHEN id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN 'https://i.scdn.co/image/ab67616d0000b2738b58d20f1b77295730db15b4'
          ELSE image_url 
        END AS image_url
        FROM albums
        WHERE 
          ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND (
            title ILIKE 'Justified%'
            OR title ILIKE 'FutureSex/LoveSounds%'
            OR title ILIKE 'The 20/20 Experience%'
            OR title ILIKE 'Man of the Woods%'
            OR title ILIKE 'Everything I Thought It Was%'
            OR id IN ('1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo')
          ))
          OR ($1 = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND (
            title ILIKE 'Alter Ego%'
            OR title ILIKE 'LALISA%'
            OR title ILIKE 'New Woman%'
            OR title ILIKE 'Moonlit Floor%'
            OR title ILIKE 'SG%'
            OR title ILIKE 'Born Again%'
            OR title ILIKE 'Goals%'
            OR title ILIKE 'FXCK UP THE WORLD%'
            OR title ILIKE 'Priceless%'
            OR title ILIKE 'Rockstar%'
          ))
          OR ($1 = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND (
            title ILIKE 'Celebrity%'
            OR title ILIKE 'No Strings Attached%'
            OR title ILIKE 'The Winter Album%'
            OR title ILIKE 'Home For Christmas%'
            OR title ILIKE 'Home for Christmas%'
            OR title ILIKE '%N Sync%'
            OR title ILIKE '%*NSYNC%'
            OR title ILIKE 'The Essential *NSYNC%'
            OR title ILIKE 'The Collection%'
            OR title ILIKE 'Greatest Hits%'
          ))
          OR ($1 = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND (
            title ILIKE 'Schizophrenic%'
            OR title ILIKE 'Playing With Fire%'
          ))
          OR ($1 = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND id IN (
            '5CUnnqJBuAiR8F7AIEZFz2',  -- LOVE (Deluxe)
            '5fygScHoj5CWBAuhT5OdJK',  -- Out of Time
            '1J31HAtMOWrvSodhFZaDpU'   -- LOVE
          ))
          OR ($1 = 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND (
            title ILIKE '%fame monster%'
            OR title ILIKE '%mayhem%'
            OR id = '5C7E6m8S9vJ36z0Z39O64L'
          ))
          OR ($1 = 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND (
            title ILIKE 'HIT ME HARD AND SOFT%'
            OR (title ILIKE 'Happier Than Ever%' AND title NOT ILIKE '%edit%')
            OR title ILIKE 'WHEN WE ALL FALL ASLEEP, WHERE DO WE GO%'
            OR title ILIKE 'dont smile at me%'
            OR title ILIKE 'don''t smile at me%'
            OR title ILIKE 'Guitar Songs%'
          ))
          OR ($1 = 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND (
            title ILIKE 'Yours Truly%'
            OR title ILIKE 'My Everything%'
            OR title ILIKE 'Dangerous Woman%'
            OR title ILIKE 'Sweetener%'
            OR title ILIKE 'thank u, next%'
            OR title ILIKE 'Positions%'
            OR title ILIKE 'eternal sunshine%'
            OR title ILIKE 'hate that i made you love me%'
          ))
          OR ($1 = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE')
          OR ($1 = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W')
          OR ($1 = 'spotify:artist:2W8yFh0Ga6Yf3jiayVxwkE')
      )
      SELECT
        ua.album_id,
        ua.album_title,
        ua.release_date,
        ua.image_url,
        COUNT(acs.canonical_song_id)::int AS track_count,
        COALESCE(SUM(acs.cumulative), 0)::bigint AS total_streams,
        COALESCE(SUM(acs.daily_gain), 0)::bigint AS daily_gain,
        COALESCE(SUM(acs.daily_avg_7d), 0)::bigint AS daily_avg_7d
      FROM unique_albums ua
      JOIN album_canonical_songs acs ON ua.album_id = acs.album_id
      GROUP BY ua.album_id, ua.album_title, ua.release_date, ua.image_url
      ORDER BY release_date DESC NULLS LAST, total_streams DESC;
    `;
    const result = await dbQuery(query, [artistUri]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch albums error:', err);
    res.status(500).json({ error: 'Failed to load albums.' });
  }
});

app.get('/api/albums/:id/songs', requireAuth, async (req, res) => {
  try {
    // Check if album belongs to JC Chasez (spotify:artist:3p3U04w2DaiBzuYMZnYr00)
    const albumCheck = await dbQuery(
      `SELECT DISTINCT s.primary_artist 
       FROM songs s 
       WHERE s.album_id = $1`,
      [req.params.id]
    );
    // Lock if ANY track on the album belongs to JC Chasez (a mixed-artist
    // album must not slip the lock just because its first row is someone else).
    const isJcAlbum = albumCheck.rows.some(
      r => r.primary_artist === 'spotify:artist:3p3U04w2DaiBzuYMZnYr00'
    );
    if (isJcAlbum) {
      const passcode = req.headers['x-jc-passcode'];
      if (!isJcAllowed(passcode)) {
        return res.status(403).json({ error: 'Forbidden: Access to this album is locked.' });
      }
    }

    const query = `
      WITH album_songs AS (
        SELECT DISTINCT ON (COALESCE(s.canonical_id, s.id))
          COALESCE(s.canonical_id, s.id) as id,
          c.title,
          c.is_featured,
          c.duration_ms,
          s.track_number,
          dsc.recorded_date,
          COALESCE(dsc.cumulative, 0)::bigint AS cumulative,
          COALESCE(dsc.daily_gain, 0)::bigint AS daily_gain,
          COALESCE(prev.daily_gain, 0)::bigint AS prev_daily_gain
        FROM songs s
        JOIN songs c ON c.id = COALESCE(s.canonical_id, s.id)
        LEFT JOIN (
          SELECT DISTINCT ON (canonical_id)
            canonical_id,
            cumulative,
            daily_gain,
            recorded_date
          FROM daily_streams_canonical
          ORDER BY canonical_id, recorded_date DESC
        ) dsc ON COALESCE(s.canonical_id, s.id) = dsc.canonical_id
        LEFT JOIN LATERAL (
          SELECT daily_gain
          FROM daily_streams_canonical pv
          WHERE pv.canonical_id = COALESCE(s.canonical_id, s.id)
            AND pv.recorded_date < dsc.recorded_date
          ORDER BY pv.recorded_date DESC
          LIMIT 1
        ) prev ON true
        WHERE (
          (
            -- FSLS Deluxe: also pull "LoveStoned / I Think She Knows - Radio Edit" (lives on the Bravo Black Hits comp 4zJu...)
            $1 = '0tcExuDWMQdBbwSpqN8Ku2'
            AND s.album_id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo', '4zJu74Lx1jB6PcpjKZ7rf8')
          )
          OR (
            $1 = '5EYKrEDnKhhcNxGedaRQeK'
            AND s.album_id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp')
          )
          OR (
            -- The 20/20 Experience (Deluxe): also include the standalone "Mirrors - Radio Edit"
            -- and the live "Suit & Tie - Radio Edit" single (deluxe copy was delisted/frozen)
            $1 = '0O82niJ0NpcptYRxogeEZu'
            AND s.album_id IN (${TT20_ALBUM_IDS_SQL})
          )
          OR (
            $1 <> '0tcExuDWMQdBbwSpqN8Ku2'
            AND $1 <> '5EYKrEDnKhhcNxGedaRQeK'
            AND $1 <> '0O82niJ0NpcptYRxogeEZu'
            AND s.album_id = $1
          )
        )
        -- Hidden alternate versions (display only — songs stay in the catalog / DB)
        AND COALESCE(s.canonical_id, s.id) NOT IN (${HIDDEN_ALBUM_TRACK_IDS_SQL})
        -- Drop third-party DJ remixes/mixes/dubs/instrumentals & unofficial
        -- "Radio Edit"s pulled into the FSLS family by the discography scrape.
        AND ${FSLS_REMIX_EXCLUSION_SQL}
        ORDER BY COALESCE(s.canonical_id, s.id), s.track_number ASC
      )
      SELECT * FROM album_songs
      ORDER BY
        CASE
          WHEN (title ILIKE '%radio edit%' OR title ILIKE '%remix%' OR title ILIKE '%mix%' OR title ILIKE '%edit%' OR title ILIKE '%instrumental%') THEN 1
          ELSE 0
        END ASC,
        -- Keep the appended "Mirrors - Radio Edit" single pinned to the very bottom
        CASE WHEN id = '6ToFxXRBtl5TJFEyIoYK3f' THEN 1 ELSE 0 END ASC,
        track_number ASC;
    `;
    const result = await dbQuery(query, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch album songs error:', err);
    res.status(500).json({ error: 'Failed to load album songs.' });
  }
});

app.get('/api/songs/:id/history', requireAuth, async (req, res) => {
  try {
    const songCheck = await dbQuery(
      `SELECT primary_artist FROM songs WHERE id = $1`,
      [req.params.id]
    );
    if (songCheck.rows.length > 0) {
      const primaryArtist = songCheck.rows[0].primary_artist;
      if (primaryArtist === 'spotify:artist:3p3U04w2DaiBzuYMZnYr00') {
        const passcode = req.headers['x-jc-passcode'];
        if (!isJcAllowed(passcode)) {
          return res.status(403).json({ error: 'Forbidden: Access to this song is locked.' });
        }
      }
    }

    const query = `
      SELECT recorded_date, cumulative, daily_gain
      FROM daily_streams_canonical
      WHERE canonical_id = $1
      ORDER BY recorded_date ASC;
    `;
    const result = await dbQuery(query, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch song history error:', err);
    res.status(500).json({ error: 'Failed to load song history.' });
  }
});

app.get('/api/albums/:id/history', requireAuth, async (req, res) => {
  try {
    const albumCheck = await dbQuery(
      `SELECT DISTINCT s.primary_artist 
       FROM songs s 
       WHERE s.album_id = $1`,
      [req.params.id]
    );
    // Lock if ANY track on the album belongs to JC Chasez (a mixed-artist
    // album must not slip the lock just because its first row is someone else).
    const isJcAlbum = albumCheck.rows.some(
      r => r.primary_artist === 'spotify:artist:3p3U04w2DaiBzuYMZnYr00'
    );
    if (isJcAlbum) {
      const passcode = req.headers['x-jc-passcode'];
      if (!isJcAllowed(passcode)) {
        return res.status(403).json({ error: 'Forbidden: Access to this album is locked.' });
      }
    }

    const query = `
      WITH album_canonicals AS (
        -- Same membership rules as the tracklist: resolve the album's songs to
        -- their canonical ids first, so tracks whose canonical copy lives on a
        -- different album (e.g. Say Something's single) are still counted.
        SELECT DISTINCT COALESCE(s.canonical_id, s.id) AS cid
        FROM songs s
        WHERE
          (
            (
              $1 = '0tcExuDWMQdBbwSpqN8Ku2'
              AND s.album_id IN (${FSLS_ALBUM_IDS_SQL})
            )
            OR (
              $1 = '0O82niJ0NpcptYRxogeEZu'
              AND s.album_id IN (${TT20_ALBUM_IDS_SQL})
            )
            OR (
              $1 = '5EYKrEDnKhhcNxGedaRQeK'
              AND s.album_id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp')
            )
            OR (
              $1 <> '0tcExuDWMQdBbwSpqN8Ku2'
              AND $1 <> '0O82niJ0NpcptYRxogeEZu'
              AND $1 <> '5EYKrEDnKhhcNxGedaRQeK'
              AND s.album_id = $1
            )
          )
          AND COALESCE(s.canonical_id, s.id) NOT IN (${HIDDEN_ALBUM_TRACK_IDS_SQL})
          AND ${FSLS_REMIX_EXCLUSION_SQL}
      )
      SELECT
        dsc.recorded_date,
        SUM(dsc.cumulative)::bigint AS cumulative,
        SUM(dsc.daily_gain)::bigint AS daily_gain
      FROM daily_streams_canonical dsc
      JOIN album_canonicals ac ON ac.cid = dsc.canonical_id
      GROUP BY dsc.recorded_date
      ORDER BY dsc.recorded_date ASC;
    `;
    const result = await dbQuery(query, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch album history error:', err);
    res.status(500).json({ error: 'Failed to load album history.' });
  }
});

// ---- Visitor feedback / artist-request form ----------------------------------

// Public: submit a request or feedback. Stored for the admin to read later.
app.post('/api/feedback', async (req, res) => {
  try {
    const message = String(req.body.message || '').trim();
    const contact = String(req.body.contact || '').trim().slice(0, 200) || null;
    const artistId = String(req.body.artist || '').replace('spotify:artist:', '').slice(0, 40) || null;
    const pagePath = String(req.body.page || '').slice(0, 300) || null;

    if (message.length < 3) {
      return res.status(400).json({ error: 'Please write a few words.' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message too long (max 2000 characters).' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ipHash = hashIp(ip);
    const now = Date.now();
    const prev = lastSubmitAt.get(ipHash) || 0;
    if (now - prev < 30000) {
      return res.status(429).json({ error: 'Too fast — please try again in a few seconds.' });
    }
    lastSubmitAt.set(ipHash, now);

    await dbQuery(
      `INSERT INTO feedback_requests (message, contact, artist_id, page_path, ip_hash, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [message, contact, artistId, pagePath, ipHash, String(req.headers['user-agent'] || '').slice(0, 400)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Feedback submit error:', err);
    res.status(500).json({ error: 'Could not send, please try again later.' });
  }
});

// Admin: list submissions. Auth via X-Admin-Passcode header or ?key= query.
const requireAdmin = (req, res, next) => {
  const key = req.headers['x-admin-passcode'] || req.query.key;
  if (!isAdmin(key)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

app.get('/api/feedback', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '';
    if (status && ['new', 'read', 'done', 'spam'].includes(status)) {
      params.push(status);
      where = `WHERE status = $1`;
    }
    const result = await dbQuery(
      `SELECT id, message, contact, artist_id, page_path, status, created_at
       FROM feedback_requests ${where}
       ORDER BY created_at DESC LIMIT 500`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Feedback list error:', err);
    res.status(500).json({ error: 'Failed to load feedback.' });
  }
});

// Admin: update a submission's status (read / done / spam).
app.patch('/api/feedback/:id', requireAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || '');
    if (!['new', 'read', 'done', 'spam'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await dbQuery(`UPDATE feedback_requests SET status = $1 WHERE id = $2`, [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Feedback update error:', err);
    res.status(500).json({ error: 'Failed to update.' });
  }
});

// Admin: permanently delete a submission.
app.delete('/api/feedback/:id', requireAdmin, async (req, res) => {
  try {
    await dbQuery(`DELETE FROM feedback_requests WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Feedback delete error:', err);
    res.status(500).json({ error: 'Failed to delete.' });
  }
});

// ---- Tracked-artist roster (source of truth = tracked_artists table) ---------

// Public: the active roster for the picker / dropdown / themes. Falls back to the
// hardcoded ARTIST_ROSTER_FALLBACK if the table is missing/empty, so the site
// works identically whether or not migration 013 has been applied yet.
app.get('/api/artists', async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT artist_id, name, image_url, accent, sort_order, album_only, locked
       FROM tracked_artists WHERE active = true ORDER BY sort_order, name`
    );
    if (r.rows.length) return res.json(r.rows);
  } catch (err) {
    console.warn('[artists] table unavailable, serving fallback roster:', err.code || err.message);
  }
  res.json(ARTIST_ROSTER_FALLBACK);
});

// Admin: full roster incl. inactive, for management.
app.get('/api/admin/artists', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT artist_id, name, image_url, accent, sort_order, album_only, locked, active, created_at
       FROM tracked_artists ORDER BY sort_order, name`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Admin artists list error:', err);
    res.status(500).json({ error: 'Failed to load artists (is migration 013 applied?).' });
  }
});

// Admin: create or upsert an artist row.
app.post('/api/admin/artists', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const artistId = String(b.artist_id || '').replace('spotify:artist:', '').trim();
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9]{22}$/.test(artistId)) return res.status(400).json({ error: 'Invalid Spotify artist id.' });
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    await dbQuery(
      `INSERT INTO tracked_artists (artist_id, name, image_url, accent, sort_order, album_only, locked, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (artist_id) DO UPDATE SET
         name=$2, image_url=$3, accent=$4, sort_order=$5, album_only=$6, locked=$7, active=$8`,
      [artistId, name, b.image_url || null, b.accent || null,
       Number.isFinite(+b.sort_order) ? +b.sort_order : 100,
       !!b.album_only, !!b.locked, b.active === undefined ? true : !!b.active]
    );
    await refreshActiveArtistsCache();
    res.json({ success: true, artist_id: artistId });
  } catch (err) {
    console.error('Admin artist create error:', err);
    res.status(500).json({ error: 'Failed to save artist.' });
  }
});

// Admin: patch individual fields.
app.patch('/api/admin/artists/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id).replace('spotify:artist:', '');
    const allowed = ['name', 'image_url', 'accent', 'sort_order', 'album_only', 'locked', 'active'];
    const sets = [], vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
    vals.push(id);
    const r = await dbQuery(`UPDATE tracked_artists SET ${sets.join(', ')} WHERE artist_id = $${vals.length}`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'Artist not found.' });
    await refreshActiveArtistsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Admin artist update error:', err);
    res.status(500).json({ error: 'Failed to update artist.' });
  }
});

// Admin: remove an artist from the roster.
// If the artist still has scraped songs, a hard delete would dump their whole
// catalogue into JT's catch-all bucket (JT = "everything not claimed by a named
// artist"). So we SOFT-delete (active=false) those — keeping them excluded from
// JT and hidden from the site. Only artists with no songs are truly removed.
app.delete('/api/admin/artists/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id).replace('spotify:artist:', '');
    const songCheck = await dbQuery(
      `SELECT 1 FROM songs WHERE primary_artist = $1 LIMIT 1`,
      [`spotify:artist:${id}`]
    );
    let softDeleted = false;
    if (songCheck.rows.length) {
      await dbQuery(`UPDATE tracked_artists SET active = false WHERE artist_id = $1`, [id]);
      softDeleted = true;
    } else {
      await dbQuery(`DELETE FROM tracked_artists WHERE artist_id = $1`, [id]);
    }
    await refreshActiveArtistsCache();
    res.json({ success: true, softDeleted });
  } catch (err) {
    console.error('Admin artist delete error:', err);
    res.status(500).json({ error: 'Failed to delete artist.' });
  }
});

// Admin: PURGE an artist's entire catalogue from the DB. Normal delete only
// soft-deletes (to protect data + keep songs out of JT's catch-all); this is the
// hard option that actually removes everything: songs (+ stream_stats via cascade),
// any orphaned albums, artist_stats, the roster row, and admin rules referencing
// the songs. Guarded: JT is blocked (its bucket IS the catch-all) and the body
// must echo the id back. Transactional — any failure rolls the whole thing back.
const JT_ARTIST_ID = '31TPClRtHm23RisEBtV3X7';
app.post('/api/admin/artists/:id/purge', requireAdmin, async (req, res) => {
  const id = String(req.params.id).replace('spotify:artist:', '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return res.status(400).json({ error: 'Invalid artist id.' });
  if (id === JT_ARTIST_ID) {
    return res.status(403).json({ error: 'Justin Timberlake is the catch-all bucket and cannot be purged.' });
  }
  if (String(req.body?.confirm || '') !== id) {
    return res.status(400).json({ error: 'Confirmation mismatch — purge aborted.' });
  }

  const uri = `spotify:artist:${id}`;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Albums that currently hold this artist's songs — candidates for cleanup
    // once their songs are gone (shared/collab albums are spared by the check).
    const albRes = await client.query(
      `SELECT DISTINCT album_id FROM songs WHERE primary_artist = $1 AND album_id IS NOT NULL`, [uri]);
    const albumIds = albRes.rows.map(r => r.album_id);

    // Detach any canonical link pointing at these songs (internal aliases AND any
    // cross-artist reference) so the FK doesn't block deletion.
    await client.query(
      `UPDATE songs SET canonical_id = NULL
       WHERE canonical_id IN (SELECT id FROM songs WHERE primary_artist = $1)`, [uri]);

    // Tidy admin rules that referenced these songs (tables are optional — guard).
    const exists = async (t) => (await client.query(`SELECT to_regclass($1) AS t`, [t])).rows[0].t != null;
    if (await exists('public.hidden_songs')) {
      await client.query(
        `DELETE FROM hidden_songs WHERE song_id IN (SELECT id FROM songs WHERE primary_artist = $1)`, [uri]);
    }
    if (await exists('public.manual_merges')) {
      await client.query(
        `DELETE FROM manual_merges
         WHERE alias_id IN (SELECT id FROM songs WHERE primary_artist = $1)
            OR canonical_id IN (SELECT id FROM songs WHERE primary_artist = $1)`, [uri]);
    }

    // Songs (stream_stats cascade-delete via FK).
    const songRes = await client.query(`DELETE FROM songs WHERE primary_artist = $1`, [uri]);

    // Remove albums that no longer have any songs.
    let albumsDeleted = 0;
    if (albumIds.length) {
      const delAlb = await client.query(
        `DELETE FROM albums WHERE id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM songs WHERE album_id = albums.id)`, [albumIds]);
      albumsDeleted = delAlb.rowCount;
    }

    if (await exists('public.artist_stats')) {
      await client.query(`DELETE FROM artist_stats WHERE artist_id = $1`, [id]);
    }
    await client.query(`DELETE FROM tracked_artists WHERE artist_id = $1`, [id]);

    await client.query('COMMIT');
    await Promise.all([refreshActiveArtistsCache(), refreshHiddenSongsCache()]);
    console.log(`[purge] ${uri}: ${songRes.rowCount} songs, ${albumsDeleted} albums removed.`);
    res.json({ success: true, songs_deleted: songRes.rowCount, albums_deleted: albumsDeleted });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('Admin purge error:', err);
    res.status(500).json({ error: 'Purge failed — rolled back, nothing was deleted.' });
  } finally {
    if (client) client.release();
  }
});

// Admin: health overview — per-artist totals/songs/daily/last-snapshot with
// anomaly flags, plus orphan detection (artists with songs but no roster row,
// whose catalogue leaks into JT's catch-all — the Britney class of bug).
app.get('/api/admin/health', requireAdmin, async (req, res) => {
  try {
    const globalMaxRes = await dbQuery(`SELECT MAX(recorded_date)::text AS d FROM stream_stats`);
    const globalMax = globalMaxRes.rows[0]?.d || null;

    const roster = allArtistsCache;
    const perArtist = await Promise.all(roster.map(async (a) => {
      const uri = `spotify:artist:${a.artist_id}`;
      const r = await dbQuery(
        `SELECT COALESCE(SUM(dsc.cumulative),0)::bigint AS total,
                COUNT(*)::int AS songs,
                COALESCE(SUM(dsc.daily_gain),0)::bigint AS daily,
                MAX(dsc.recorded_date)::text AS last_update
         FROM (SELECT DISTINCT ON (canonical_id) canonical_id, cumulative, daily_gain, recorded_date
               FROM daily_streams_canonical ORDER BY canonical_id, recorded_date DESC) dsc
         JOIN songs s ON s.id = dsc.canonical_id
         JOIN albums alb ON s.album_id = alb.id
         WHERE ${artistBucketMatchSQL('s', 'alb')} AND s.id NOT IN (${hiddenTrackIdsSql()})`,
        [uri]
      );
      const row = r.rows[0];
      const flags = [];
      const daysStale = (globalMax && row.last_update)
        ? Math.round((new Date(globalMax) - new Date(row.last_update)) / 86400000) : null;
      if (a.active && daysStale != null && daysStale >= 2) flags.push('frozen');
      if (a.active && Number(row.songs) === 0) flags.push('no-songs');
      return {
        artist_id: a.artist_id, name: a.name, active: a.active,
        total: row.total, songs: row.songs, daily: row.daily,
        last_update: row.last_update, days_stale: daysStale, flags,
      };
    }));

    // Orphans: canonical songs whose primary_artist isn't a tracked artist.
    // JT's catch-all absorbs these. A few low-count ones are normal (genuine JT
    // collaborators); a high song-count means a removed artist's catalogue is
    // leaking. We surface counts so the admin can judge / re-add as inactive.
    const trackedIds = roster.map(a => a.artist_id);
    const orphanRes = await dbQuery(
      `SELECT s.primary_artist,
              COUNT(*)::int AS songs,
              COALESCE(SUM(ls.cumulative),0)::bigint AS total,
              (array_agg(s.title ORDER BY ls.cumulative DESC NULLS LAST))[1] AS sample_title
       FROM songs s
       JOIN (SELECT DISTINCT ON (canonical_id) canonical_id, cumulative
             FROM daily_streams_canonical ORDER BY canonical_id, recorded_date DESC) ls
         ON ls.canonical_id = s.id
       WHERE s.canonical_id IS NULL
         AND s.primary_artist IS NOT NULL
         AND replace(s.primary_artist,'spotify:artist:','') <> ALL($1::text[])
       GROUP BY s.primary_artist
       HAVING COUNT(*) >= 8
       ORDER BY total DESC`,
      [trackedIds]
    );
    const orphans = orphanRes.rows.map(o => ({
      artist_id: (o.primary_artist || '').replace('spotify:artist:', ''),
      songs: o.songs, total: o.total, sample_title: o.sample_title,
    }));

    // Scraper run state + overall alert summary, so the panel can surface
    // problems (stale data / frozen catalogues / unmerged dups) at a glance.
    let scraper = { status: 'unknown', started_at: null, updated_at: null };
    try {
      const sr = await dbQuery(
        `SELECT status, started_at::text, updated_at::text FROM scraper_status WHERE id = 1`
      );
      if (sr.rows[0]) scraper = sr.rows[0];
    } catch (e) {
      console.warn('[health] scraper_status unavailable:', e.code || e.message);
    }

    let dupGroups = 0;
    try {
      dupGroups = (await scanSameStreamDuplicates()).length;
    } catch (e) {
      console.warn('[health] dup scan failed:', e.code || e.message);
    }

    const daysSinceUpdate = globalMax
      ? Math.round((Date.now() - new Date(globalMax + 'T00:00:00Z')) / 86400000) : null;
    const summary = {
      global_last_update: globalMax,
      days_since_update: daysSinceUpdate,
      scraper_status: scraper.status,
      scraper_started_at: scraper.started_at,
      scraper_updated_at: scraper.updated_at,
      active_artists: perArtist.filter(a => a.active).length,
      frozen_artists: perArtist.filter(a => a.flags.includes('frozen')).length,
      no_song_artists: perArtist.filter(a => a.flags.includes('no-songs')).length,
      orphan_groups: orphans.length,
      duplicate_groups: dupGroups,
      stale: daysSinceUpdate != null && daysSinceUpdate >= 2,
    };

    res.json({ global_last_update: globalMax, summary, artists: perArtist, orphans });
  } catch (err) {
    console.error('Admin health error:', err);
    res.status(500).json({ error: 'Failed to load health.' });
  }
});

// The real scraper (Puppeteer + Spotify cookie) only runs in GitHub Actions —
// Render has neither Chrome nor the SP_DC secret, so we trigger the workflow via
// the GitHub API instead of spawning a local process that would silently crash.
const GH_REPO = process.env.GH_REPO || 'emirkilictis/SpotifyStreams';
const GH_WORKFLOW_FILE = process.env.GH_WORKFLOW_FILE || 'daily-scrape.yml';
const GH_REF = process.env.GH_REF || 'main';
const GH_DISPATCH_TOKEN =
  process.env.GH_DISPATCH_TOKEN || process.env.GITHUB_DISPATCH_TOKEN ||
  process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;

// Admin: trigger a scrape by dispatching the GitHub Actions workflow
// (optionally scoped to a single artist).
app.post('/api/admin/scrape', requireAdmin, async (req, res) => {
  const { artist_id } = req.body || {};

  let artists = '';
  if (artist_id) {
    const cleanId = String(artist_id).replace('spotify:artist:', '').trim();
    if (!/^[A-Za-z0-9]{22}$/.test(cleanId)) {
      return res.status(400).json({ error: 'Invalid artist ID.' });
    }
    artists = cleanId;
  }

  if (!GH_DISPATCH_TOKEN) {
    return res.status(503).json({
      error: 'Scrape trigger not configured: set the GH_DISPATCH_TOKEN env var (a GitHub token with Actions: write) on the server.',
    });
  }

  // Don't pile on if a run is already mid-flight.
  try {
    const statusRes = await dbQuery("SELECT status FROM scraper_status WHERE id = 1");
    const currentStatus = statusRes.rows[0]?.status || 'idle';
    if (currentStatus === 'scraping' || currentStatus === 'deduping') {
      return res.status(409).json({ error: `Scraper is already active (status: ${currentStatus}). Please wait.` });
    }
  } catch (err) {
    console.warn('[scrape-trigger] Failed to check scraper status, proceeding anyway:', err.message);
  }

  try {
    const url = `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW_FILE}/dispatches`;
    const ghRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GH_DISPATCH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'spotify-streams-dashboard',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: GH_REF, inputs: { force: 'true', artists } }),
    });

    if (ghRes.status === 204) {
      console.log(`[scrape-trigger] Dispatched workflow (artists='${artists || 'ALL'}').`);
      return res.json({
        success: true,
        message: artists
          ? 'Scrape queued on GitHub Actions for this artist. Songs appear in a couple of minutes.'
          : 'Full scrape queued on GitHub Actions. This takes several minutes.',
      });
    }

    const detail = await ghRes.text().catch(() => '');
    console.error(`[scrape-trigger] GitHub dispatch failed (${ghRes.status}): ${detail}`);
    if (ghRes.status === 401 || ghRes.status === 403) {
      return res.status(502).json({ error: 'GitHub rejected the token (check it has Actions: write on the repo and is not expired).' });
    }
    if (ghRes.status === 404) {
      return res.status(502).json({ error: `Workflow not found (${GH_REPO} / ${GH_WORKFLOW_FILE}). Check GH_REPO / GH_WORKFLOW_FILE.` });
    }
    return res.status(502).json({ error: `GitHub dispatch failed (HTTP ${ghRes.status}).` });
  } catch (err) {
    console.error('[scrape-trigger] dispatch error:', err.message);
    return res.status(502).json({ error: 'Could not reach GitHub to trigger the scrape.' });
  }
});

// Admin: re-run canonical deduplication on demand (when duplicates/inflation
// appear without waiting for a full scrape). Wrapped in a transaction so a
// mid-run failure rolls back instead of leaving the catalogue un-deduped.
const { dedupCanonical } = require('../spotify-scraper/dedup');
let dedupRunning = false;
app.post('/api/admin/dedup', requireAdmin, async (req, res) => {
  if (dedupRunning) return res.status(409).json({ error: 'Dedup is already running.' });
  dedupRunning = true;
  res.json({ started: true });
  (async () => {
    let client;
    try {
      client = await pool.connect();
      console.log('[admin-dedup] starting (transactional)...');
      await client.query('BEGIN');
      const result = await dedupCanonical(client);
      await client.query('COMMIT');
      console.log('[admin-dedup] done:', result);
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch {} }
      console.error('[admin-dedup] failed (rolled back):', err.message);
    } finally {
      if (client) client.release();
      dedupRunning = false;
    }
  })();
});

// Admin: search songs by title (to find one to hide). Canonical tracks only.
app.get('/api/admin/song-search', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const r = await dbQuery(
      `SELECT s.id, s.title, s.primary_artist, a.title AS album,
              (SELECT MAX(stream_count) FROM stream_stats WHERE song_id = s.id) AS streams
       FROM songs s LEFT JOIN albums a ON a.id = s.album_id
       WHERE s.canonical_id IS NULL AND s.title ILIKE $1
       ORDER BY streams DESC NULLS LAST LIMIT 40`,
      [`%${q}%`]
    );
    // Mark hidden from the cache (no hard dependency on the hidden_songs table).
    const hidden = new Set(hiddenSongsCache);
    res.json(r.rows.map(row => ({ ...row, hidden: hidden.has(row.id) })));
  } catch (err) {
    console.error('Admin song-search error:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// Admin: list hidden songs (with titles).
app.get('/api/admin/hidden-songs', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT h.song_id, h.reason, h.created_at, s.title, s.primary_artist
       FROM hidden_songs h LEFT JOIN songs s ON s.id = h.song_id
       ORDER BY h.created_at DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Admin hidden-songs list error:', err);
    res.status(500).json({ error: 'Failed to load (is migration 014 applied?).' });
  }
});

// Admin: hide a song from every dashboard listing.
app.post('/api/admin/hidden-songs', requireAdmin, async (req, res) => {
  try {
    const id = String(req.body.song_id || '').replace('spotify:track:', '').trim();
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return res.status(400).json({ error: 'Invalid track id.' });
    await dbQuery(
      `INSERT INTO hidden_songs (song_id, reason) VALUES ($1, $2)
       ON CONFLICT (song_id) DO UPDATE SET reason = $2`,
      [id, String(req.body.reason || '').slice(0, 300) || null]
    );
    await refreshHiddenSongsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Admin hide-song error:', err);
    res.status(500).json({ error: 'Failed to hide song.' });
  }
});

// Admin: un-hide a song.
app.delete('/api/admin/hidden-songs/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id).replace('spotify:track:', '');
    await dbQuery(`DELETE FROM hidden_songs WHERE song_id = $1`, [id]);
    await refreshHiddenSongsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Admin unhide-song error:', err);
    res.status(500).json({ error: 'Failed to un-hide song.' });
  }
});

// Admin: find candidate duplicates — songs that share the EXACT same peak stream
// count but resolve to different canonicals (i.e. not yet merged together). This is
// the strongest signal of a linked Spotify copy the deduper missed. Returns groups.
async function scanSameStreamDuplicates() {
  const r = await dbQuery(
    `SELECT s.id, s.title, s.duration_ms, s.primary_artist, s.canonical_id, s.is_featured,
            a.title AS album,
            COALESCE((SELECT MAX(stream_count) FROM stream_stats WHERE song_id = s.id), 0)::bigint AS streams
     FROM songs s LEFT JOIN albums a ON a.id = s.album_id
     WHERE s.duration_ms IS NOT NULL`
  );
  return groupSameStreamDuplicates(r.rows);
}

app.get('/api/admin/same-stream-dups', requireAdmin, async (req, res) => {
  try {
    res.json(await scanSameStreamDuplicates());
  } catch (err) {
    console.error('Admin same-stream-dups error:', err);
    res.status(500).json({ error: 'Failed to scan duplicates.' });
  }
});

// Admin: list manual merge / split rules (with titles).
app.get('/api/admin/manual-merges', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT m.alias_id, m.canonical_id, m.reason, m.created_at,
              sa.title AS alias_title, sc.title AS canonical_title
       FROM manual_merges m
       LEFT JOIN songs sa ON sa.id = m.alias_id
       LEFT JOIN songs sc ON sc.id = m.canonical_id
       ORDER BY m.created_at DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Admin manual-merges list error:', err);
    res.status(500).json({ error: 'Failed to load (is migration 016 applied?).' });
  }
});

// Admin: add a manual merge (alias_id -> canonical_id) or split (canonical_id null),
// and apply it immediately so the dashboard reflects it without a full dedup run.
app.post('/api/admin/manual-merges', requireAdmin, async (req, res) => {
  const clean = (v) => String(v || '').replace('spotify:track:', '').trim();
  try {
    const alias = clean(req.body.alias_id);
    let canonical = clean(req.body.canonical_id) || null;
    if (!/^[A-Za-z0-9]{22}$/.test(alias)) return res.status(400).json({ error: 'Invalid alias id.' });
    if (canonical && !/^[A-Za-z0-9]{22}$/.test(canonical)) return res.status(400).json({ error: 'Invalid canonical id.' });
    if (canonical && canonical === alias) return res.status(400).json({ error: 'A song cannot be its own canonical.' });

    // Resolve the chosen canonical to its own root (in case it is itself an alias).
    if (canonical) {
      const root = await dbQuery(`SELECT canonical_id FROM songs WHERE id = $1`, [canonical]);
      if (root.rows[0]?.canonical_id) canonical = root.rows[0].canonical_id;
      if (canonical === alias) return res.status(400).json({ error: 'Would create a merge loop.' });
    }

    await dbQuery(
      `INSERT INTO manual_merges (alias_id, canonical_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (alias_id) DO UPDATE SET canonical_id = $2, reason = $3, created_at = NOW()`,
      [alias, canonical, String(req.body.reason || '').slice(0, 300) || null]
    );
    // Apply now: merge sets canonical, split detaches the song to stand alone.
    if (canonical) {
      await dbQuery(`UPDATE songs SET canonical_id = $1 WHERE id = $2`, [canonical, alias]);
      // Re-point anything that was pointing at the alias to the new canonical.
      await dbQuery(`UPDATE songs SET canonical_id = $1 WHERE canonical_id = $2`, [canonical, alias]);
    } else {
      await dbQuery(`UPDATE songs SET canonical_id = NULL WHERE id = $1`, [alias]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Admin manual-merge add error:', err);
    res.status(500).json({ error: 'Failed to save rule (is migration 016 applied?).' });
  }
});

// Admin: remove a manual rule. If it was a merge, detach the alias now (immediate
// unmerge); the next full dedup re-clusters it on the automatic rules.
app.delete('/api/admin/manual-merges/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id).replace('spotify:track:', '');
    const prev = await dbQuery(`SELECT canonical_id FROM manual_merges WHERE alias_id = $1`, [id]);
    await dbQuery(`DELETE FROM manual_merges WHERE alias_id = $1`, [id]);
    if (prev.rows[0]?.canonical_id) {
      await dbQuery(`UPDATE songs SET canonical_id = NULL WHERE id = $1`, [id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Admin manual-merge delete error:', err);
    res.status(500).json({ error: 'Failed to remove rule.' });
  }
});

// Serve index.html with cache-busting query strings on app.js/style.css so that a new
// deploy is always picked up — even by aggressive mobile caches (iOS Safari bfcache).
// The version token is derived from the asset mtimes, so it changes only on real updates.
function assetVersion() {
  try {
    const a = fs.statSync(path.join(__dirname, 'public/app.js')).mtimeMs;
    const c = fs.statSync(path.join(__dirname, 'public/style.css')).mtimeMs;
    return Math.floor(Math.max(a, c)).toString(36);
  } catch {
    return Date.now().toString(36);
  }
}
app.get(['/', '/index.html'], requireAuth, (req, res) => {
  const v = assetVersion();
  let html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

  // Build link-preview (Open Graph / Twitter) tags — per-artist when ?artist= is set.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const aId = String(req.query.artist || '').replace('spotify:artist:', '');
  const og = activeArtistsCache.find(item => item.artist_id === aId);
  const title = og ? `${og.name} — Spotify Streams` : 'Spotify Streams — Fan Dashboard';
  const desc = og
    ? `${og.name}'s live Spotify stream counts, daily gains, and milestones — updated daily.`
    : 'Live Spotify stream counts, daily gains, and milestones for your favorite artists — updated daily.';
  let img = (og && og.image_url) ? og.image_url : '/images/jt.jpg';
  if (img.startsWith('/')) img = baseUrl + img;
  const pageUrl = baseUrl + req.originalUrl;
  const ogEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ogTags = `
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Spotify Streams — Fan Dashboard">
  <meta property="og:title" content="${ogEsc(title)}">
  <meta property="og:description" content="${ogEsc(desc)}">
  <meta property="og:image" content="${ogEsc(img)}">
  <meta property="og:url" content="${ogEsc(pageUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogEsc(title)}">
  <meta name="twitter:description" content="${ogEsc(desc)}">
  <meta name="twitter:image" content="${ogEsc(img)}">
  <meta name="theme-color" content="#1db954">`;

  html = html
    .replace('<!-- OG_META -->', ogTags)
    .replace('href="/style.css"', `href="/style.css?v=${v}"`)
    .replace('src="/app.js"', `src="/app.js?v=${v}"`);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
});

// Admin panel (the page is static; the feedback API it calls is passcode-gated).
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Protected Static Files
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// Catch-all redirect to home
app.get('*', requireAuth, (req, res) => {
  res.redirect('/');
});

app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  await Promise.all([refreshActiveArtistsCache(), refreshHiddenSongsCache()]);
});
