const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Render's proxy — trust X-Forwarded-* so req.protocol is https (used for absolute OG urls).
app.set('trust proxy', true);

// Per-artist link preview (Open Graph / Twitter Card) metadata.
// img = absolute Spotify CDN url, or a local path (made absolute at request time).
const ARTIST_OG = {
  '31TPClRtHm23RisEBtV3X7': { name: 'Justin Timberlake', img: '/images/jt.jpg' },
  '5L1lO4eRHmJ7a0Q6csE5cT': { name: 'LISA',           img: 'https://i.scdn.co/image/ab6761610000e5eb5cd3b3af8b72e32be78571ec' },
  '1HY2Jd0NmPuamShAr6KMms': { name: 'Lady Gaga',       img: 'https://i.scdn.co/image/ab6761610000e5ebaadc18cac8d48124357c38e6' },
  '6qqNVTkY8uBg9cP3Jd7DAH': { name: 'Billie Eilish',   img: 'https://i.scdn.co/image/ab6761610000e5eb4a21b4760d2ecb7b0dcdc8da' },
  '66CXWjxzNUsdJxJ2JdwvnR': { name: 'Ariana Grande',   img: 'https://i.scdn.co/image/ab6761610000e5eb766397ec42a573a53eb5fb87' },
  '6Ff53KvcvAj5U7Z1vojB5o': { name: '*NSYNC',          img: 'https://i.scdn.co/image/ab6761610000e5eb9414ef07d0ca697726912df1' },
  '3LHYvj5ZejV1NLqncEObSJ': { name: 'Vaelis',          img: 'https://i.scdn.co/image/ab6761610000e5eb05e2f96f53a2810f5dcdd6c1' },
  '2dIgFjalVxs4ThymZ67YCE': { name: 'Stray Kids',      img: 'https://i.scdn.co/image/ab6761610000e5ebf9887d2c9288f0e50a3fd69f' },
  '4UIOuc84ExWojcUzFGtb8W': { name: 'Felix',           img: 'https://i.scdn.co/image/ab6761610000e5eb51e1a166ae0cc73d8ec19909' },
};

// Accepted access codes for the locked artist (JC Chasez). Both unlock the same content.
const JC_PASSCODES = ['peakedinhighschool', 'flop'];
const isJcAllowed = (passcode) => JC_PASSCODES.includes(passcode);

// Tracks hidden from EVERY listing (songs list, album tracklist, milestones).
// Dead duplicates whose live copy is tracked under a different id.
const HIDDEN_TRACK_IDS = ['6233Z1W8t9Wn1f1gZqHhQ5']; // Suit & Tie - Radio Edit (frozen 2026-05-26; live = 4mQVHEjrnuUd7G5IVhSYTk)
const HIDDEN_TRACK_IDS_SQL = HIDDEN_TRACK_IDS.map(id => `'${id}'`).join(', ');

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
  }
});

app.use(express.json());
app.use(cookieParser('spotify-streams-secret-key'));

// Auth check middleware.
// The general site passcode has been removed — the dashboard is public.
// JC Chasez stays locked separately via validateArtistAccess / isJcAllowed
// (X-JC-Passcode header), which do NOT depend on this middleware.
const requireAuth = (req, res, next) => next();

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
    const result = await pool.query('SELECT * FROM access_codes WHERE code = $1', [passcode]);
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
        COALESCE(dsc.daily_gain, 0)::bigint AS daily_gain
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
      WHERE s.canonical_id IS NULL AND (
        ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND (s.primary_artist IS DISTINCT FROM 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:4UIOuc84ExWojcUzFGtb8W'))
        OR ($1 = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT')
        OR ($1 = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o')
        OR ($1 = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00')
        OR ($1 = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ')
        OR ($1 = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE')
        OR ($1 = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W' AND s.primary_artist = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W')
        OR ($1 = 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND (
            a.title ILIKE '%fame monster%'
            OR a.title ILIKE '%mayhem%'
            OR a.id = '5C7E6m8S9vJ36z0Z39O64L'
        ))
        OR ($1 = 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND (
            a.title ILIKE 'HIT ME HARD AND SOFT%'
            OR a.title ILIKE 'Happier Than Ever%'
            OR a.title ILIKE 'WHEN WE ALL FALL ASLEEP, WHERE DO WE GO%'
            OR a.title ILIKE 'dont smile at me%'
            OR a.title ILIKE 'don''t smile at me%'
            OR a.title ILIKE 'Guitar Songs%'
        ))
        OR ($1 = 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND (
            a.title ILIKE 'Yours Truly%'
            OR a.title ILIKE 'My Everything%'
            OR a.title ILIKE 'Dangerous Woman%'
            OR a.title ILIKE 'Sweetener%'
            OR a.title ILIKE 'thank u, next%'
            OR a.title ILIKE 'Positions%'
            OR a.title ILIKE 'eternal sunshine%'
        ))
      )
      AND s.id NOT IN (${HIDDEN_TRACK_IDS_SQL})
      AND ${FSLS_REMIX_EXCLUSION_SQL}
      ORDER BY cumulative DESC;
    `;
    const result = await pool.query(query, [artistUri]);
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
      WHERE (
        ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND (s.primary_artist IS DISTINCT FROM 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:4UIOuc84ExWojcUzFGtb8W'))
        OR ($1 = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT')
        OR ($1 = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o')
        OR ($1 = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00')
        OR ($1 = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ')
        OR ($1 = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE')
        OR ($1 = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W' AND s.primary_artist = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W')
        OR ($1 = 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND (
            a.title ILIKE '%fame monster%'
            OR a.title ILIKE '%mayhem%'
            OR a.id = '5C7E6m8S9vJ36z0Z39O64L'
        ))
        OR ($1 = 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND (
            a.title ILIKE 'HIT ME HARD AND SOFT%'
            OR a.title ILIKE 'Happier Than Ever%'
            OR a.title ILIKE 'WHEN WE ALL FALL ASLEEP, WHERE DO WE GO%'
            OR a.title ILIKE 'dont smile at me%'
            OR a.title ILIKE 'don''t smile at me%'
            OR a.title ILIKE 'Guitar Songs%'
        ))
        OR ($1 = 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND (
            a.title ILIKE 'Yours Truly%'
            OR a.title ILIKE 'My Everything%'
            OR a.title ILIKE 'Dangerous Woman%'
            OR a.title ILIKE 'Sweetener%'
            OR a.title ILIKE 'thank u, next%'
            OR a.title ILIKE 'Positions%'
            OR a.title ILIKE 'eternal sunshine%'
        ))
      )
      AND s.id NOT IN (${HIDDEN_TRACK_IDS_SQL});
    `;
    const result = await pool.query(query, [artistUri]);
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
    const latestRes = await pool.query(
      `SELECT artist_name, monthly_listeners, followers, world_rank, recorded_date
       FROM artist_stats
       WHERE artist_id = $1
       ORDER BY recorded_date DESC
       LIMIT 2`,
      [artistId]
    );
    const historyRes = await pool.query(
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

app.get('/api/milestones-reached', requireAuth, validateArtistAccess, async (req, res) => {
  const artistParam = req.query.artist || '31TPClRtHm23RisEBtV3X7';
  const artistUri = artistParam.startsWith('spotify:artist:') ? artistParam : `spotify:artist:${artistParam}`;
  try {
    // A milestone M is "reached on date D" when a song or album's cumulative crossed M between
    // the previous snapshot (prev_cum < M) and D (cumulative >= M). Only crossings we actually
    // witnessed during tracking are returned (prev_cum NOT NULL).
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
          LAG(dsc.cumulative) OVER (PARTITION BY dsc.canonical_id ORDER BY dsc.recorded_date) AS prev_cum
        FROM daily_streams_canonical dsc
        JOIN songs s ON s.id = dsc.canonical_id
        JOIN albums a ON s.album_id = a.id
        WHERE (
          ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND (s.primary_artist IS DISTINCT FROM 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:4UIOuc84ExWojcUzFGtb8W'))
          OR ($1 = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist = 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT')
          OR ($1 = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist = 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o')
          OR ($1 = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist = 'spotify:artist:3p3U04w2DaiBzuYMZnYr00')
          OR ($1 = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist = 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ')
          OR ($1 = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist = 'spotify:artist:2dIgFjalVxs4ThymZ67YCE')
          OR ($1 = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W' AND s.primary_artist = 'spotify:artist:4UIOuc84ExWojcUzFGtb8W')
          OR ($1 = 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND (a.title ILIKE '%fame monster%' OR a.title ILIKE '%mayhem%' OR a.id = '5C7E6m8S9vJ36z0Z39O64L'))
          OR ($1 = 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND (a.title ILIKE 'HIT ME HARD AND SOFT%' OR a.title ILIKE 'Happier Than Ever%' OR a.title ILIKE 'WHEN WE ALL FALL ASLEEP, WHERE DO WE GO%' OR a.title ILIKE 'dont smile at me%' OR a.title ILIKE 'don''t smile at me%' OR a.title ILIKE 'Guitar Songs%'))
          OR ($1 = 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND (a.title ILIKE 'Yours Truly%' OR a.title ILIKE 'My Everything%' OR a.title ILIKE 'Dangerous Woman%' OR a.title ILIKE 'Sweetener%' OR a.title ILIKE 'thank u, next%' OR a.title ILIKE 'Positions%' OR a.title ILIKE 'eternal sunshine%'))
        )
        AND s.id NOT IN (${HIDDEN_TRACK_IDS_SQL})
      ),
      song_crossings AS (
        SELECT
          h.canonical_id AS song_id,
          c.title,
          t.m::bigint AS milestone,
          MIN(h.recorded_date) AS reached_date,
          'song'::text AS type
        FROM song_hist h
        JOIN thresholds t ON h.prev_cum IS NOT NULL AND h.prev_cum < t.m AND h.cumulative >= t.m
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
        WHERE (
          ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND (s.primary_artist IS DISTINCT FROM 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:4UIOuc84ExWojcUzFGtb8W'))
          OR ($1 <> 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND s.primary_artist = $1)
        )
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
      album_daily_totals AS (
        SELECT
          asm.album_id,
          adt.album_title,
          dsc.recorded_date,
          SUM(COALESCE(dsc.cumulative, 0))::bigint AS cumulative
        FROM daily_streams_canonical dsc
        JOIN album_songs_mapped asm ON dsc.canonical_id = asm.canonical_song_id
        JOIN album_display_titles adt ON asm.album_id = adt.album_id
        GROUP BY asm.album_id, adt.album_title, dsc.recorded_date
      ),
      album_hist AS (
        SELECT
          album_id,
          album_title,
          recorded_date,
          cumulative,
          LAG(cumulative) OVER (PARTITION BY album_id ORDER BY recorded_date) AS prev_cum
        FROM album_daily_totals
      ),
      album_crossings AS (
        SELECT
          ah.album_id AS song_id, -- align column names for UNION
          ah.album_title AS title,
          t.m::bigint AS milestone,
          MIN(ah.recorded_date) AS reached_date,
          'album'::text AS type
        FROM album_hist ah
        JOIN thresholds t ON ah.prev_cum IS NOT NULL AND ah.prev_cum < t.m AND ah.cumulative >= t.m
        GROUP BY ah.album_id, ah.album_title, t.m
      )
      SELECT * FROM song_crossings
      UNION ALL
      SELECT * FROM album_crossings
      ORDER BY reached_date DESC, milestone DESC;
    `;
    const result = await pool.query(query, [artistUri]);
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
        COALESCE(dsc.daily_gain, 0) AS daily_gain
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
        WHERE (
          ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND (s.primary_artist IS DISTINCT FROM 'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3p3U04w2DaiBzuYMZnYr00' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:3LHYvj5ZejV1NLqncEObSJ' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:2dIgFjalVxs4ThymZ67YCE' AND s.primary_artist IS DISTINCT FROM 'spotify:artist:4UIOuc84ExWojcUzFGtb8W'))
          OR ($1 <> 'spotify:artist:31TPClRtHm23RisEBtV3X7' AND s.primary_artist = $1)
        )
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
      )
      SELECT
        ua.album_id,
        ua.album_title,
        ua.release_date,
        ua.image_url,
        COUNT(acs.canonical_song_id)::int AS track_count,
        COALESCE(SUM(acs.cumulative), 0)::bigint AS total_streams,
        COALESCE(SUM(acs.daily_gain), 0)::bigint AS daily_gain
      FROM unique_albums ua
      JOIN album_canonical_songs acs ON ua.album_id = acs.album_id
      GROUP BY ua.album_id, ua.album_title, ua.release_date, ua.image_url
      ORDER BY release_date DESC NULLS LAST, total_streams DESC;
    `;
    const result = await pool.query(query, [artistUri]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch albums error:', err);
    res.status(500).json({ error: 'Failed to load albums.' });
  }
});

app.get('/api/albums/:id/songs', requireAuth, async (req, res) => {
  try {
    // Check if album belongs to JC Chasez (spotify:artist:3p3U04w2DaiBzuYMZnYr00)
    const albumCheck = await pool.query(
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
    const result = await pool.query(query, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch album songs error:', err);
    res.status(500).json({ error: 'Failed to load album songs.' });
  }
});

app.get('/api/songs/:id/history', requireAuth, async (req, res) => {
  try {
    const songCheck = await pool.query(
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
    const result = await pool.query(query, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch song history error:', err);
    res.status(500).json({ error: 'Failed to load song history.' });
  }
});

app.get('/api/albums/:id/history', requireAuth, async (req, res) => {
  try {
    const albumCheck = await pool.query(
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
    const result = await pool.query(query, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch album history error:', err);
    res.status(500).json({ error: 'Failed to load album history.' });
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
  const og = ARTIST_OG[aId];
  const title = og ? `${og.name} — Spotify Streams` : 'Spotify Streams — Fan Dashboard';
  const desc = og
    ? `${og.name}'s live Spotify stream counts, daily gains, and milestones — updated daily.`
    : 'Live Spotify stream counts, daily gains, and milestones for your favorite artists — updated daily.';
  let img = og ? og.img : '/images/jt.jpg';
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

// Protected Static Files
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// Catch-all redirect to home
app.get('*', requireAuth, (req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
