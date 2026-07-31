const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { groupSameStreamDuplicates } = require('./lib/dups');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Render's proxy — trust X-Forwarded-* so req.protocol is https (used for absolute OG urls).
app.set('trust proxy', true);

// Don't advertise the framework/version.
app.disable('x-powered-by');

// Conservative security headers on every response. Deliberately NO Content-Security-
// Policy and NO Cross-Origin-Resource-Policy: a CSP would risk breaking inline
// scripts/html2canvas blobs, and CORP would stop Twitter/Facebook from fetching the
// OG share image. These headers are safe and don't change how the page renders.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');           // no MIME sniffing
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');               // clickjacking guard
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), browsing-topics=()');
  if (req.secure) {                                             // HTTPS only (Render), never localhost
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});



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
  { artist_id: '6qqNVTkY8uBg9cP3Jd7DAH', name: 'Billie Eilish',     image_url: 'https://i.scdn.co/image/ab6761610000e5eb4a21b4760d2ecb7b0dcdc8da', accent: '#bad80a', sort_order: 7,  album_only: false, locked: false },
  { artist_id: '66CXWjxzNUsdJxJ2JdwvnR', name: 'Ariana Grande',     image_url: 'https://i.scdn.co/image/ab6761610000e5eb766397ec42a573a53eb5fb87', accent: '#b39ddb', sort_order: 8,  album_only: true,  locked: false },
  { artist_id: '6Ff53KvcvAj5U7Z1vojB5o', name: '*NSYNC',            image_url: 'https://i.scdn.co/image/ab6761610000e5eb9414ef07d0ca697726912df1', accent: '#3498db', sort_order: 9,  album_only: false, locked: false },
  { artist_id: '3LHYvj5ZejV1NLqncEObSJ', name: 'Vaelis',            image_url: 'https://i.scdn.co/image/ab6761610000e5eb05e2f96f53a2810f5dcdd6c1', accent: '#8b5cf6', sort_order: 10, album_only: false, locked: false },
  { artist_id: '3p3U04w2DaiBzuYMZnYr00', name: 'JC Chasez',         image_url: 'https://i.scdn.co/image/ab6761610000e5eb784d1c3b5bb30c5db83c8fe2', accent: '#e74c3c', sort_order: 11, album_only: false, locked: true  },
  { artist_id: '4qwGe91Bz9K2T8jXTZ815W', name: 'Janet Jackson',     image_url: 'https://i.scdn.co/image/ab6761610000e5eb8b290c36cbc9e89827ff562a', accent: '#d81b60', sort_order: 14, album_only: false, locked: false },
];

// Accepted access codes for a locked artist (currently JC Chasez). Both unlock
// any artist flagged `locked` in the roster.
const JC_PASSCODES = ['peakedinhighschool', 'flop'];
const isJcAllowed = (passcode) => JC_PASSCODES.includes(passcode);

// True if the given artist id is currently flagged `locked` in the live roster
// (tracked_artists). Server-side access control reads this so the admin `locked`
// toggle is the SINGLE source of truth — removing the lock in the panel actually
// unlocks the API (no more hardcoded JC id, which left the API 403'ing after the
// frontend was unlocked → "NaN" in the stat tiles).
const isArtistLockedById = (artistId) =>
  allArtistsCache.some(a => a.artist_id === artistId && a.locked);

// Admin passcode for reading visitor feedback/requests. Set ADMIN_PASSCODE in the
// environment (Render dashboard); falls back to a dev default so local runs work.
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || 'pairofwings';
// Constant-time compare so the response time can't leak how many leading chars of
// the passcode are correct. Hashing both sides first keeps it constant-time even
// when the lengths differ (timingSafeEqual requires equal-length buffers).
const _passHash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const _adminHash = _passHash(ADMIN_PASSCODE);
const SECADMIN_PASSCODE = process.env.SECADMIN_PASSCODE || 'pineapple';
const _secHash = _passHash(SECADMIN_PASSCODE);

const getAdminRole = (passcode) => {
  if (typeof passcode !== 'string' || passcode.length === 0) return null;
  const hashed = _passHash(passcode);
  if (crypto.timingSafeEqual(hashed, _adminHash)) return 'admin';
  if (crypto.timingSafeEqual(hashed, _secHash)) return 'secadmin';

  if (passcode.includes(':')) {
    const colonIdx = passcode.indexOf(':');
    const user = passcode.slice(0, colonIdx);
    const pass = passcode.slice(colonIdx + 1);
    const passHashed = _passHash(pass);
    if (user === 'secadmin' && crypto.timingSafeEqual(passHashed, _secHash)) {
      return 'secadmin';
    }
    if (user === 'admin' && crypto.timingSafeEqual(passHashed, _adminHash)) {
      return 'admin';
    }
  }
  return null;
};

const isAdmin = (passcode) => getAdminRole(passcode) !== null;

// Salt for hashing submitter IPs (abuse tracking without storing raw IPs).
const IP_HASH_SECRET = process.env.IP_HASH_SECRET || 'spotify-streams-ip-salt';
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
  '3B1kVUGFALavXUt8s9L65V', // GENIE (HAN, Felix, I.N) — primary_artist is HAN
];
const FELIX_EXTRA_TRACK_IDS_SQL = FELIX_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// I.N is credited (sub-unit / featured) on these Stray Kids tracks whose
// primary_artist is someone else — same pin-in idea as FELIX_EXTRA_TRACK_IDS.
const IN_EXTRA_TRACK_IDS = [
  '3B1kVUGFALavXUt8s9L65V', // GENIE (HAN, Felix, I.N) — primary_artist is HAN
  '5gXUFmE5AKFiInKyHVVEnL', // Hug Me (I.N) — primary_artist is Stray Kids
  '1J0qupz0gVGSB5jcRY35tL', // Maknae On Top (I.N) — primary_artist is Stray Kids
  '4fdxYCWRK0YXkxepMKsCDG', // START! — primary_artist is Lee Know, fan-reported I.N is also credited
  '0tXaDUdlhJHC3NyO843wTi', // START! (dup copy) — primary_artist is Lee Know
  '7xUu5XhIGzuZspFp5v3VqG', // START! - Instrumental — primary_artist is Lee Know
  // My Universe removed — a fan reported it's not actually credited to I.N on
  // Spotify (only to Stray Kids as the group), matching an identical report
  // from Seungmin's page (see SEUNGMIN_EXTRA_TRACK_IDS below).
];
const IN_EXTRA_TRACK_IDS_SQL = IN_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// Changbin is credited (sub-unit / featured) on these Stray Kids tracks whose
// primary_artist is someone else — same pin-in idea as FELIX_EXTRA_TRACK_IDS.
const CHANGBIN_EXTRA_TRACK_IDS = [
  '1Iu7bqGwYVB6OGq4uLt2ak', // Because (Changbin, Felix) — primary_artist is Stray Kids
  '786A4mxiKmPGHA7z7dPA9K', // DOODLE (Changbin) — primary_artist is Stray Kids
  '1J0qupz0gVGSB5jcRY35tL', // Maknae On Top (I.N) — Changbin is also a credited feature per Spotify
  '56uBQujWiOiFMFg1R3TZUJ', // Piece of a Puzzle (Changbin, Seungmin) — primary_artist is Stray Kids
  '1Z6NmeYIfN4e8TuEYLFTKL', // Streetlight (Changbin) — primary_artist is Stray Kids
  '0bxB5Jie9fGKTIibfYVfei', // Up All Night (Bang Chan, Changbin, Felix, Seungmin) — primary_artist is Stray Kids
  '56ZpFy1kLsXwtbHWX1CgJ4', // ZONE (Bang Chan, Changbin, HAN) — primary_artist is Stray Kids
];
const CHANGBIN_EXTRA_TRACK_IDS_SQL = CHANGBIN_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// Bang Chan is credited (sub-unit / featured) on these Stray Kids tracks whose
// primary_artist is someone else — same pin-in idea as FELIX_EXTRA_TRACK_IDS.
const BANGCHAN_EXTRA_TRACK_IDS = [
  '3vGSv4l4czTve9jZoYeIWk', // Connected (Bang Chan) — primary_artist is Stray Kids
  '0hLvtmoexLKl14LrzxOYRt', // Drive (Bang Chan, Lee Know) — primary_artist is Stray Kids
  '0XABJLloqjHsF4mY4tGIOH', // i hate to admit (Bang Chan) — primary_artist is Stray Kids
  '1J0qupz0gVGSB5jcRY35tL', // Maknae On Top (I.N) — Bang Chan is also a credited feature per Spotify
  '1Z6NmeYIfN4e8TuEYLFTKL', // Streetlight (Changbin) — Bang Chan is also a credited feature per Spotify
  '0bxB5Jie9fGKTIibfYVfei', // Up All Night (Bang Chan, Changbin, Felix, Seungmin) — primary_artist is Stray Kids
  '56ZpFy1kLsXwtbHWX1CgJ4', // ZONE (Bang Chan, Changbin, HAN) — primary_artist is Stray Kids
];
const BANGCHAN_EXTRA_TRACK_IDS_SQL = BANGCHAN_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// HAN is credited (sub-unit / featured) on these Stray Kids tracks whose
// primary_artist is someone else — same pin-in idea as FELIX_EXTRA_TRACK_IDS.
const HAN_EXTRA_TRACK_IDS = [
  '3czfvJgfEDfBT5OKA5qAU5', // Alien (HAN) — primary_artist is Stray Kids
  '7jcpg7osgYWffx9LmLEoZ4', // Close (HAN) — primary_artist is Stray Kids
  '4atsZkGtoHHPugKK5wzAE1', // I GOT IT (HAN) — primary_artist is Stray Kids
  '1ifB8sqR8gd09DSEloo4Du', // Wish You Back (HAN) — primary_artist is Stray Kids
  '56ZpFy1kLsXwtbHWX1CgJ4', // ZONE (Bang Chan, Changbin, HAN) — primary_artist is Stray Kids
];
const HAN_EXTRA_TRACK_IDS_SQL = HAN_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// Lee Know is credited (sub-unit / featured) on these Stray Kids tracks whose
// primary_artist is someone else — same pin-in idea as FELIX_EXTRA_TRACK_IDS.
const LEEKNOW_EXTRA_TRACK_IDS = [
  '0hLvtmoexLKl14LrzxOYRt', // Drive (Bang Chan, Lee Know) — primary_artist is Stray Kids
  '0nuXhivBOFDiriWCpdyU93', // Limbo (Lee Know) — primary_artist is Stray Kids
];
const LEEKNOW_EXTRA_TRACK_IDS_SQL = LEEKNOW_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// Hyunjin is credited (sub-unit / featured) on these Stray Kids tracks whose
// primary_artist is someone else — same pin-in idea as FELIX_EXTRA_TRACK_IDS.
const HYUNJIN_EXTRA_TRACK_IDS = [
  '1SrsEuRiRoopW2pZDaHgVA', // Love Untold (Hyunjin) — primary_artist is Stray Kids
  '07x9Jr01lqjlFycZsfKBae', // ice.cream (Hyunjin) — primary_artist is Stray Kids
  '1BwFLLe233S6HR1ravS3yi', // miss you (Hyunjin) — primary_artist is Stray Kids
];
const HYUNJIN_EXTRA_TRACK_IDS_SQL = HYUNJIN_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// Seungmin is credited (sub-unit / featured) on these Stray Kids tracks whose
// primary_artist is someone else — same pin-in idea as FELIX_EXTRA_TRACK_IDS.
const SEUNGMIN_EXTRA_TRACK_IDS = [
  // My Universe removed — a fan reported it's not actually credited to Seungmin
  // on Spotify (only to Stray Kids as the group), matching an identical report
  // from I.N's page (see IN_EXTRA_TRACK_IDS above).
  // "Close to You" (4Fopzm) and GO LIVE's group "Phobia" (16Xt6a alias + 1KC5Y3 head)
  // removed on fan report: Seungmin already has his OWN OST releases of both
  // (primary_artist=Seungmin: Phobia on "I'm the Queen in This Life" OST, Close to
  // You on "Love in Contract" OST), so pinning the SKZ copies showed each twice.
  // GO LIVE "Phobia" is a full-group track (not an individually-credited sub-unit),
  // so it doesn't belong on his soloist page at all. Also removed from the
  // extra_artist_songs DB table (the live source; this list is only the fallback).
  '56uBQujWiOiFMFg1R3TZUJ', // Piece of a Puzzle (Changbin, Seungmin) — primary_artist is Stray Kids
  '5kFGqKqHzVVMMI7V7uoID1', // Stars and Raindrops (Seungmin) — primary_artist is Stray Kids
  '0bxB5Jie9fGKTIibfYVfei', // Up All Night (Bang Chan, Changbin, Felix, Seungmin) — primary_artist is Stray Kids
];
const SEUNGMIN_EXTRA_TRACK_IDS_SQL = SEUNGMIN_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// Cardi B guest features that the full-disc scrape attributed to a CO-TRACKED
// lead artist's bucket (a track has exactly one primary_artist), so they never
// surfaced on Cardi's page even though kworb credits them to her. Same idea as
// FELIX_EXTRA_TRACK_IDS: the track keeps its lead-artist bucket too, so it shows
// on both pages — kworb counts a collab on every credited artist. No effect on
// JT's catch-all (primary_artist is unchanged, still a tracked-artist exclusion)
// and there is no roster-wide total that would double-count.
const CARDI_EXTRA_TRACK_IDS = [
  '4wFjTWCunQFKtukqrNijEt', // MotorSport (Migos feat. Nicki Minaj & Cardi B) — lives in Nicki's bucket (~647M)
  '1YNQscOx6OqBQjxgJVhEeW', // Girls (Rita Ora feat. Cardi B, Bebe Rexha & Charli XCX) — lives in Bebe's bucket (~205M)
  '6FluOWqqqg99zqIinlUHyZ', // Girls - Steve Aoki Remix — Bebe's bucket (~4.4M)
  '2hpjjSJQJJOqtp3DWNLbVb', // Girls - Martin Jensen Remix — Bebe's bucket (~4.2M)
];
const CARDI_EXTRA_TRACK_IDS_SQL = CARDI_EXTRA_TRACK_IDS.map(id => `'${id}'`).join(', ');

// In-memory cache of active artists, initialized with the fallback list.
// Loaded from tracked_artists table on startup and refreshed on admin updates.
let activeArtistsCache = ARTIST_ROSTER_FALLBACK;

// EVERY tracked artist (active OR inactive). Used ONLY for JT's catch-all
// exclusion: JT's bucket is "everything not claimed by a named artist", so a
// named artist must keep excluding their songs even after they're hidden —
// otherwise hiding/removing an artist dumps their whole catalogue into JT.
let allArtistsCache = ARTIST_ROSTER_FALLBACK;

let extraArtistSongsCache = {};
async function refreshExtraArtistSongsCache() {
  try {
    // Resolve each pin to its CANONICAL HEAD. Pins are stored as whatever track
    // id was pinned, but every bucket query filters `canonical_id IS NULL`, so a
    // pin that dedup later turned into an alias would silently stop counting —
    // the song just quietly vanishes from that artist's page. COALESCE keeps
    // head pins byte-identical to before and repairs alias ones on the fly.
    const res = await dbQuery(
      `SELECT e.artist_id, COALESCE(s.canonical_id, e.song_id) AS song_id
         FROM extra_artist_songs e
         LEFT JOIN songs s ON s.id = e.song_id`
    );
    const temp = {};
    for (const row of res.rows) {
      if (!temp[row.artist_id]) temp[row.artist_id] = [];
      temp[row.artist_id].push(row.song_id);
    }
    extraArtistSongsCache = temp;
  } catch (err) {
    console.error('Failed to load extra_artist_songs from DB, using fallback:', err.message);
    extraArtistSongsCache = {
      '4UIOuc84ExWojcUzFGtb8W': FELIX_EXTRA_TRACK_IDS,
      '1odvXbzhdzNajv6un9x5Mc': IN_EXTRA_TRACK_IDS,
      '3XSid6KaiKoMAVZs2ug3yw': CHANGBIN_EXTRA_TRACK_IDS,
      '5jRUIqBSxmsBPNiEwKUjgZ': BANGCHAN_EXTRA_TRACK_IDS,
      '46YvTuKiPBUu5KP9818J2F': HAN_EXTRA_TRACK_IDS,
      '04jivE3Ek7Xu8WSGVmEqUn': LEEKNOW_EXTRA_TRACK_IDS,
      '0ymFDpsRImjK673AGgFBcg': HYUNJIN_EXTRA_TRACK_IDS,
      '2nTtulf6WM0raQcIbzYJuf': SEUNGMIN_EXTRA_TRACK_IDS,
      '4kYSro6naA4h99UJvo89HB': CARDI_EXTRA_TRACK_IDS
    };
  }
}

function getExtraTrackIdsSql(artistId) {
  const ids = extraArtistSongsCache[artistId] || [];
  if (ids.length === 0) return "'dummy_nonexistent_id'";
  return ids.map(id => `'${id}'`).join(', ');
}

// ---- Admin-editable album tracklist overrides (display-only, migration 019) ---
// album_track_pins: pin a song into an album's DISPLAY tracklist (e.g. a remix
// single into its parent album). album_hidden_tracks: hide a song from album
// tracklists/totals ONLY (stays in the flat list + artist total). Neither
// changes canonical_id or any total — same safety as the hardcoded FSLS/TT20/ATD
// remaps. Cached like extraArtistSongsCache; refreshed on write + via /refresh-caches.
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
let albumTrackPinsCache = [];        // [{ song_id, album_id }]
let albumHiddenTracksCache = [];     // [song_id, ...]

async function refreshAlbumTrackPinsCache() {
  try {
    const r = await dbQuery('SELECT song_id, album_id FROM album_track_pins');
    // Keep only well-formed ids — these interpolate into SQL fragments.
    albumTrackPinsCache = r.rows.filter(
      x => SPOTIFY_ID_RE.test(x.song_id) && SPOTIFY_ID_RE.test(x.album_id)
    );
  } catch (err) {
    console.error('Failed to load album_track_pins, using empty:', err.message);
    albumTrackPinsCache = [];
  }
}
async function refreshAlbumHiddenTracksCache() {
  try {
    const r = await dbQuery('SELECT song_id FROM album_hidden_tracks');
    albumHiddenTracksCache = r.rows.map(x => x.song_id).filter(id => SPOTIFY_ID_RE.test(id));
  } catch (err) {
    console.error('Failed to load album_hidden_tracks, using empty:', err.message);
    albumHiddenTracksCache = [];
  }
}

// ---- Link-preview (Open Graph) per-artist stats cache -----------------------
// The `/` route builds the OG/Twitter card tags on every pageload (bots + users
// hit it). We can't run a heavy per-artist stats query inline, so a background
// job precomputes each active artist's total + 7-day-average daily gain (the
// same numbers the dashboard headline shows) into this Map. The OG handler reads
// it instantly; a cache miss just falls back to plain text.
let ogStatsCache = new Map(); // artist_id -> { total: bigint-string, daily: bigint-string }

// Compact stream formatter for preview text: 18.2B, 7.4M, 950K.
function fmtStreamsShort(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 1 : 2).replace(/\.?0+$/, '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(v);
}

// These caches used to refresh ONLY at boot and on writes made through the
// admin API. reconcile-kworb.js runs in GitHub Actions and writes
// extra_artist_songs straight to the DB, so without a reload an auto-linked
// collab stays invisible here until the next deploy.
//
// This is deliberately LAZY rather than a setInterval. Neon suspends the
// compute after a few idle minutes and bills by the hour it stays awake; a
// background timer pings it forever and the database never sleeps, which is
// what burned through the monthly compute allowance. Refreshing on the next
// request that arrives after the TTL means an idle site costs nothing.
const ROSTER_CACHE_TTL_MS = 10 * 60 * 1000;
const OG_CACHE_TTL_MS = 30 * 60 * 1000;
let rosterCacheAt = 0;
let ogCacheAt = 0;
let rosterRefreshInFlight = null;

function refreshRosterCaches() {
  rosterCacheAt = Date.now();
  return Promise.all([
    refreshActiveArtistsCache(), refreshHiddenSongsCache(), refreshExtraArtistSongsCache(),
    refreshAlbumTrackPinsCache(), refreshAlbumHiddenTracksCache(),
  ]);
}

// Fire-and-forget: never make a page wait on a cache that is merely stale.
function touchRosterCaches() {
  const now = Date.now();
  if (now - rosterCacheAt >= ROSTER_CACHE_TTL_MS && !rosterRefreshInFlight) {
    rosterRefreshInFlight = refreshRosterCaches()
      .catch(() => {})
      .finally(() => { rosterRefreshInFlight = null; });
  }
  if (now - ogCacheAt >= OG_CACHE_TTL_MS) {
    ogCacheAt = now;
    refreshOgStatsCache().catch(() => {});
  }
}

async function refreshOgStatsCache() {
  ogCacheAt = Date.now();
  try {
    const roster = activeArtistsCache;
    const next = new Map();
    await Promise.all(roster.map(async (a) => {
      try {
        const uri = `spotify:artist:${a.artist_id}`;
        const r = await dbQuery(
          `SELECT COALESCE(SUM(dsc.cumulative), 0)::bigint AS total,
                  (
                    SELECT COALESCE(ROUND(AVG(pd.day_gain)), 0)::bigint
                    FROM (
                      SELECT d2.recorded_date, SUM(d2.daily_gain) AS day_gain
                      FROM daily_streams_canonical d2
                      JOIN songs s2 ON s2.id = d2.canonical_id
                      JOIN albums a2 ON s2.album_id = a2.id
                      WHERE s2.canonical_id IS NULL AND ${artistBucketMatchSQL('s2', 'a2')}
                        AND s2.id NOT IN (${hiddenTrackIdsSql()})
                      GROUP BY d2.recorded_date
                      ORDER BY d2.recorded_date DESC
                      LIMIT 7
                    ) pd
                  ) AS daily
           FROM (
             SELECT DISTINCT ON (canonical_id) canonical_id, cumulative
             FROM daily_streams_canonical ORDER BY canonical_id, recorded_date DESC
           ) dsc
           JOIN songs s ON s.id = dsc.canonical_id
           JOIN albums alb ON s.album_id = alb.id
           WHERE s.canonical_id IS NULL AND ${artistBucketMatchSQL('s', 'alb')}
             AND s.id NOT IN (${hiddenTrackIdsSql()})`,
          [uri]
        );
        next.set(a.artist_id, { total: r.rows[0].total, daily: r.rows[0].daily });
      } catch (_) { /* skip this artist; keep whatever was cached */ }
    }));
    if (next.size) ogStatsCache = next;
  } catch (err) {
    console.warn('[og] stats cache refresh failed:', err.code || err.message);
  }
}

// ---- Song-level anomaly detector (health) -----------------------------------
// The recurring "artist X's dailies broke again" bug: the artist total keeps
// updating (some tracks move) while specific songs sit frozen for many days —
// invisible to the artist-level frozen flag. This finds canonical heads that
// USED to gain but have shown a flat daily_gain across their last N snapshots
// (so it's a genuine stall, not a naturally-dead B-side).
const FROZEN_RECENT_N = 6;        // last N snapshots must all be flat
const FROZEN_MIN_STREAMS = 3000000; // ignore tiny/dead tracks
async function scanFrozenSongs() {
  const r = await dbQuery(
    `WITH recent AS (
       SELECT canonical_id, recorded_date, daily_gain, cumulative,
              ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY recorded_date DESC) AS rn
       FROM daily_streams_canonical
     ),
     agg AS (
       SELECT canonical_id,
         MAX(cumulative) FILTER (WHERE rn = 1) AS cumulative,
         to_char(MAX(recorded_date) FILTER (WHERE rn = 1), 'YYYY-MM-DD') AS last_date,
         COUNT(*) FILTER (WHERE rn <= ${FROZEN_RECENT_N} AND COALESCE(daily_gain, 0) = 0) AS zero_recent,
         COUNT(*) FILTER (WHERE rn BETWEEN ${FROZEN_RECENT_N + 1} AND 20 AND daily_gain > 0) AS moved_before
       FROM recent
       WHERE rn <= 20
       GROUP BY canonical_id
     )
     SELECT s.id, s.title, s.primary_artist, agg.cumulative, agg.last_date, agg.zero_recent
     FROM agg
     JOIN songs s ON s.id = agg.canonical_id
     WHERE s.canonical_id IS NULL
       AND agg.zero_recent >= ${FROZEN_RECENT_N}
       AND agg.moved_before > 0
       AND agg.cumulative >= ${FROZEN_MIN_STREAMS}
       AND s.id NOT IN (${hiddenTrackIdsSql()})
     ORDER BY agg.cumulative DESC
     LIMIT 80`
  );
  return r.rows;
}

// CASE fragment that remaps a pinned song's album to its pinned display album.
// Prepended to the album-id CASEs so a pin overrides the scraped album membership
// (used by the album LIST card totals + milestones). Empty string when no pins.
function pinnedAlbumCaseSql() {
  return albumTrackPinsCache
    .map(p => `WHEN s.id = '${p.song_id}' THEN '${p.album_id}'`)
    .join('\n            ');
}

// Membership fragment for the album-detail tracklist & history: matches a row
// when the song is pinned to the album currently being viewed ($1). Always a
// valid boolean; a dummy row keeps it false when there are no pins.
function pinnedMembershipSql() {
  const rows = albumTrackPinsCache.length
    ? albumTrackPinsCache.map(p => `('${p.song_id}', '${p.album_id}')`).join(', ')
    : `('__none__', '__none__')`;
  return `(s.id, $1) IN (VALUES ${rows})`;
}

// The full album-tracklist hide list: hardcoded seeds + DB cache. Never empty
// (HIDDEN_ALBUM_TRACK_IDS always has entries), so it drops into `NOT IN (...)`.
function albumHiddenTrackIdsSql() {
  const ids = [...new Set([...HIDDEN_ALBUM_TRACK_IDS, ...albumHiddenTracksCache])];
  return ids.map(id => `'${id}'`).join(', ');
}

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
  const normalClauses = nonJtArtists
    .map(item => {
      if (item.artist_id === '1HY2Jd0NmPuamShAr6KMms') {
        return `OR ($1 = 'spotify:artist:1HY2Jd0NmPuamShAr6KMms' AND (${a}.title ILIKE '%fame monster%' OR ${a}.title ILIKE '%mayhem%' OR ${a}.id = '5C7E6m8S9vJ36z0Z39O64L'))`;
      }
      if (item.artist_id === '66CXWjxzNUsdJxJ2JdwvnR') {
        return `OR ($1 = 'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR' AND (${a}.title ILIKE 'Yours Truly%' OR ${a}.title ILIKE 'My Everything%' OR ${a}.title ILIKE 'Dangerous Woman%' OR ${a}.title ILIKE 'Sweetener%' OR ${a}.title ILIKE 'thank u, next%' OR ${a}.title ILIKE 'Positions%' OR ${a}.title ILIKE 'eternal sunshine%'))`;
      }
      return `OR ($1 = 'spotify:artist:${item.artist_id}' AND (${s}.primary_artist = 'spotify:artist:${item.artist_id}' OR ${s}.id IN (${getExtraTrackIdsSql(item.artist_id)})))`;
    })
    .join('\n    ');

  return `(
    ($1 = 'spotify:artist:31TPClRtHm23RisEBtV3X7'${jtExclusions ? ' AND (' + jtExclusions + ')' : ''})
    ${normalClauses}
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

// Cardi B's two standalone "ErrTime" remix singles are each their own 1-track
// "album". Pin them into AM I THE DRAMA? (Ultimate Edition) so they surface on
// that tracklist as distinct rows carrying the remixes' REAL streams — they are
// canonical heads (Latto 14.75M, Jeezy 1.18M), so this changes NO totals, only
// which album they display under. The Ultimate Edition's own remix copies are
// playcount-linked to the ORIGINAL ErrTime (byte-identical count) so they
// collapse into it under DISTINCT-ON and never show as remixes; these standalone
// heads are the only copies carrying the remixes' independent counts. Same
// pattern as the TT20/FSLS single-into-album pins above. Display-only.
const ATD_ULTIMATE_ID = '0qJL6xmheW2HD1H0SWCxRh';
const ATD_ULTIMATE_TITLE = 'AM I THE DRAMA? (Ultimate Edition)';
const ATD_ULTIMATE_COVER = 'https://i.scdn.co/image/ab67616d00001e02967b09b0309b97afc0b6ee1d';
const ATD_REMIX_SINGLE_IDS = ['2i2SkQ9IRn6q9E8RjhpOH3', '58YOjlNjfpWLFmHglWof4g'];
const ATD_REMIX_SINGLE_IDS_SQL = ATD_REMIX_SINGLE_IDS.map(id => `'${id}'`).join(', ');

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
// Refresh the roster/OG caches off the back of real traffic instead of a timer,
// so an idle site lets the database suspend. See touchRosterCaches.
app.use((req, res, next) => { touchRosterCaches(); next(); });

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
    if (isArtistLockedById(artistId)) {
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
          WHEN s.album_id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN '${ATD_ULTIMATE_ID}'
          ELSE s.album_id
        END AS album_id,
        CASE
          WHEN s.album_id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN '${ATD_ULTIMATE_TITLE}'
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
          WHEN s.album_id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN NULL::date
          ELSE a.release_date
        END AS release_date,
        CASE 
          WHEN s.album_id IN ('0tcExuDWMQdBbwSpqN8Ku2', '2scB1uhcCI1TSf6b9TCZK3', '51lCQxAHpJHuqvvK0z12zp', '1tze7ApbUfn71mNcaixlX6', '3N1D55OU4TgweV2SSx6rpl', '2T4Y4BOSbReX4EEM79hIO6', '5DEGO898K51fENd1Jt0Rek', '3E81KB8Gxn4kkh8GP5M3DK', '6G2boZuVyTIIxlmTG52NsI', '0NvpeY8oCm6oIlhH5Jw4fo') THEN 'https://i.scdn.co/image/ab67616d0000b273c68f26a3d34fbd0faed2b473'
          WHEN s.album_id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN 'https://i.scdn.co/image/ab67616d0000b2738b58d20f1b77295730db15b4'
          WHEN s.album_id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN '${ATD_ULTIMATE_COVER}'
          ELSE a.image_url
        END AS album_cover_url,
        dsc.recorded_date,
        COALESCE(dsc.cumulative, 0)::bigint AS cumulative,
        COALESCE(dsc.daily_gain, 0)::bigint AS daily_gain,
        -- 7-day trailing average daily gain — smooths Spotify's weekly cadence
        -- (weekend spikes / Monday drops) so ETA estimates aren't whipsawed by
        -- which single day the latest snapshot happens to land on.
        COALESCE(avg7.daily_avg_7d, 0)::bigint AS daily_avg_7d,
        -- Raw (un-clamped) latest-day change. daily_gain above uses the
        -- running-max view so it can NEVER go negative; this one reads the
        -- raw canonical_streams so a genuine playcount DROP (deleted/pulled
        -- streams, bad snapshot) surfaces as a negative. Frontend only shows
        -- it when it's actually negative.
        COALESCE(rawd.real_change, 0)::bigint AS real_daily_change,
        -- The day before the latest snapshot, so a card can show a day-over-day
        -- delta without refetching each song's history one request at a time.
        COALESCE(prev.daily_gain, 0)::bigint AS prev_daily_gain
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
      LEFT JOIN LATERAL (
        SELECT daily_gain
        FROM daily_streams_canonical pv
        WHERE pv.canonical_id = s.id
          AND pv.recorded_date < dsc.recorded_date
        ORDER BY pv.recorded_date DESC
        LIMIT 1
      ) prev ON true
      LEFT JOIN (
        SELECT canonical_id, ROUND(AVG(daily_gain))::bigint AS daily_avg_7d
        FROM (
          SELECT canonical_id, daily_gain,
                 ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY recorded_date DESC) AS rn
          FROM daily_streams_canonical
        ) z WHERE rn <= 7
        GROUP BY canonical_id
      ) avg7 ON s.id = avg7.canonical_id
      LEFT JOIN (
        SELECT canonical_id, real_change FROM (
          SELECT song_id AS canonical_id,
                 (stream_count - LAG(stream_count) OVER (
                   PARTITION BY song_id ORDER BY recorded_date
                 ))::bigint AS real_change,
                 ROW_NUMBER() OVER (
                   PARTITION BY song_id ORDER BY recorded_date DESC
                 ) AS rn
          FROM canonical_streams
        ) z WHERE rn = 1
      ) rawd ON s.id = rawd.canonical_id
      WHERE s.canonical_id IS NULL AND ${artistBucketMatchSQL('s', 'a')}
      AND s.id NOT IN (${hiddenTrackIdsSql()})
      ORDER BY cumulative DESC;
    `;
    const result = await dbQuery(query, [artistUri]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch songs error:', err);
    res.status(500).json({ error: 'Failed to load song list.' });
  }
});

// Trending: songs whose RECENT daily gain has jumped meaningfully above their
// OWN normal. We compare a 7-day recent window against the preceding 21-day
// baseline (both averaged from the calendar-normalised daily_gain, so irregular
// snapshot cadence is handled by date windows, not row counts). A song trends
// when recent >= baseline * TREND_LIFT AND it clears absolute floors — the floors
// stop a near-dead track (tiny→tiny) from reading as a giant % spike, and stop
// weekly-cadence wobble on small songs from flooding the list.
//
// The lift is measured RELATIVE TO THE ARTIST'S OWN CATALOGUE-WIDE lift in the
// same window. When a whole catalogue rises ~10% (playlist push, a comeback,
// seasonal bump) every song clears a fixed +20% bar on noise alone and the strip
// fills with passengers, burying the one song that actually broke out. Dividing
// by the artist's overall lift keeps only songs outrunning their own artist.
// A FALLING catalogue is clamped to 1.0 — a decline must never LOWER the bar,
// or "least-declining song" would read as trending.
//
// All three are env-tunable on Render (no code change) so the section's
// sensitivity can be dialled live: lower TREND_LIFT for a busier strip.
const TREND_LIFT = Number(process.env.TREND_LIFT || 1.2);            // recent must be >= 20% over the song's own baseline, on top of the artist's own lift
const TREND_MIN_BASE = Number(process.env.TREND_MIN_BASE || 25000);      // baseline must be a real >=25k/day song (kills tiny→tiny % spikes)
const TREND_MIN_RECENT = Number(process.env.TREND_MIN_RECENT || 50000);    // recent must be a real >=50k/day surge
app.get('/api/trending', requireAuth, validateArtistAccess, async (req, res) => {
  const artistParam = req.query.artist || '31TPClRtHm23RisEBtV3X7';
  const artistUri = artistParam.startsWith('spotify:artist:') ? artistParam : `spotify:artist:${artistParam}`;
  try {
    const query = `
      WITH anchor AS (SELECT MAX(recorded_date) AS d FROM daily_streams_canonical),
      win AS (
        SELECT
          dsc.canonical_id,
          AVG(dsc.daily_gain) FILTER (
            WHERE dsc.recorded_date > (SELECT d FROM anchor) - INTERVAL '4 days') AS recent_avg,
          COUNT(*) FILTER (
            WHERE dsc.recorded_date > (SELECT d FROM anchor) - INTERVAL '4 days') AS recent_n,
          AVG(dsc.daily_gain) FILTER (
            WHERE dsc.recorded_date <= (SELECT d FROM anchor) - INTERVAL '4 days'
              AND dsc.recorded_date >  (SELECT d FROM anchor) - INTERVAL '25 days') AS base_avg,
          COUNT(*) FILTER (
            WHERE dsc.recorded_date <= (SELECT d FROM anchor) - INTERVAL '4 days'
              AND dsc.recorded_date >  (SELECT d FROM anchor) - INTERVAL '25 days') AS base_n,
          MAX(dsc.cumulative) AS cumulative
        FROM daily_streams_canonical dsc
        WHERE dsc.recorded_date > (SELECT d FROM anchor) - INTERVAL '25 days'
        GROUP BY dsc.canonical_id
      ),
      -- Everything in this artist's bucket that has enough history to compare.
      scoped AS (
        SELECT
          s.id, s.title, s.is_featured,
          a.title AS album_title,
          a.image_url AS album_cover_url,
          win.cumulative, win.recent_avg, win.base_avg
        FROM win
        JOIN songs s ON s.id = win.canonical_id
        LEFT JOIN albums a ON s.album_id = a.id
        WHERE s.canonical_id IS NULL
          AND ${artistBucketMatchSQL('s', 'a')}
          AND s.id NOT IN (${hiddenTrackIdsSql()})
          AND win.recent_n >= 2
          AND win.base_n >= 3
          AND win.base_avg > 0
      ),
      -- How much the WHOLE catalogue moved over the same two windows. Stream-
      -- weighted (SUM/SUM, not AVG of ratios) so the artist's real listening
      -- shift drives it instead of long-tail percentage noise.
      artist_lift AS (
        SELECT GREATEST(COALESCE(SUM(recent_avg) / NULLIF(SUM(base_avg), 0), 1), 1) AS mult
        FROM scoped
      )
      SELECT
        scoped.id,
        scoped.title,
        scoped.is_featured,
        scoped.album_title,
        scoped.album_cover_url,
        scoped.cumulative::bigint AS cumulative,
        ROUND(scoped.recent_avg)::bigint AS recent_avg,
        ROUND(scoped.base_avg)::bigint AS base_avg,
        -- lift_pct stays the song's RAW gain over its own baseline (what the
        -- card shows); artist_lift_pct is the catalogue move it had to beat.
        ROUND((scoped.recent_avg / scoped.base_avg - 1) * 100)::int AS lift_pct,
        ROUND((artist_lift.mult - 1) * 100)::int AS artist_lift_pct
      FROM scoped CROSS JOIN artist_lift
      WHERE scoped.base_avg >= ${TREND_MIN_BASE}
        AND scoped.recent_avg >= ${TREND_MIN_RECENT}
        AND scoped.recent_avg >= scoped.base_avg * artist_lift.mult * ${TREND_LIFT}
      ORDER BY (scoped.recent_avg / scoped.base_avg) DESC
      LIMIT 12;
    `;
    const result = await dbQuery(query, [artistUri]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch trending error:', err);
    res.status(500).json({ error: 'Failed to load trending songs.' });
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
        COALESCE(SUM(dsc.daily_gain) FILTER (WHERE NOT s.is_featured), 0)::bigint AS lead_daily_gain,
        COALESCE(SUM(dsc.daily_gain) FILTER (WHERE s.is_featured), 0)::bigint AS feat_daily_gain,
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
            WHERE s2.canonical_id IS NULL AND ${artistBucketMatchSQL('s2', 'a2')}
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
      -- s.canonical_id IS NULL: count ONLY true canonical heads. The view keys on
      -- COALESCE(canonical_id, id), so a residual dedup chain/cycle would surface a
      -- non-head as its own row and double-count the recording (this is what showed
      -- Christina's inflated 15.5B). The guard makes the headline total structurally
      -- immune regardless of dedup state.
      WHERE s.canonical_id IS NULL AND ${artistBucketMatchSQL('s', 'a')}
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

// The dashboard polls this endpoint continuously, so it must stay cheap: the
// answer is identical for every visitor, so compute it at most once per window
// and hand out the same object. Without this, N open tabs meant N queries every
// poll — the single biggest driver of Neon compute usage.
const SCRAPER_STATUS_TTL_MS = 30 * 1000;
let scraperStatusCache = null;
let scraperStatusAt = 0;
let scraperStatusInFlight = null;

app.get('/api/scraper-status', requireAuth, async (req, res) => {
  try {
    if (scraperStatusCache && Date.now() - scraperStatusAt < SCRAPER_STATUS_TTL_MS) {
      return res.json(scraperStatusCache);
    }
    // Collapse concurrent misses into one query.
    if (scraperStatusInFlight) return res.json(await scraperStatusInFlight);
    scraperStatusInFlight = buildScraperStatus()
      .catch((err) => {
        // Over quota, asleep, whatever — the banner is decoration. Degrade to
        // "idle" and cache THAT too, so a database that is refusing queries
        // doesn't get one retry per poll per tab.
        console.error('Scraper status error:', err.message);
        return { status: 'idle', started_at: null, updated_at: null, artists: [] };
      })
      .then((payload) => { scraperStatusCache = payload; scraperStatusAt = Date.now(); return payload; })
      .finally(() => { scraperStatusInFlight = null; });
    return res.json(await scraperStatusInFlight);
  } catch (err) {
    console.error('Scraper status error:', err);
    return res.json({ status: 'idle', started_at: null, updated_at: null, artists: [] });
  }
});

async function buildScraperStatus() {
  {
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
      // Reads canonical_streams DIRECTLY, not daily_streams_canonical: that view
      // recomputes a running MAX and a LAG over the whole catalogue every time
      // it is touched. The banner only needs each artist's newest snapshot date
      // — the row_count / first_date this used to also compute were never read
      // by the client, and COUNT(DISTINCT) over that view was the expensive bit.
      const artistRes = await dbQuery(`
        SELECT
          ta.artist_id,
          ta.name,
          ta.active,
          MAX(cs.recorded_date) AS last_date
        FROM tracked_artists ta
        LEFT JOIN songs s
          ON s.primary_artist = 'spotify:artist:' || ta.artist_id
        LEFT JOIN canonical_streams cs
          ON cs.song_id = s.id
        GROUP BY ta.artist_id, ta.name, ta.active
        ORDER BY ta.sort_order, ta.name
      `);
      perArtist = artistRes.rows;
    } catch (_) {
      // tracked_artists table may not exist yet — skip per-artist data
    }


    return {
      status:      global.status,
      started_at:  global.started_at,
      updated_at:  global.updated_at,
      artists:     perArtist,
    };
  }
}


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
        WHERE s.canonical_id IS NULL AND ${artistBucketMatchSQL('s', 'a')}
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
            ${pinnedAlbumCaseSql()}
            WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
            WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
            WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
            WHEN a.id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN '${ATD_ULTIMATE_ID}'
            ELSE s.album_id
          END,
          COALESCE(s.canonical_id, s.id)
        )
        CASE
          ${pinnedAlbumCaseSql()}
          WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
          WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
          WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
          WHEN a.id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN '${ATD_ULTIMATE_ID}'
          ELSE s.album_id
        END AS album_id,
        COALESCE(s.canonical_id, s.id) AS canonical_song_id
        FROM songs s
        JOIN albums a ON s.album_id = a.id
        WHERE ${artistAlbumMatchSQL('s')}
        AND COALESCE(s.canonical_id, s.id) NOT IN (${albumHiddenTrackIdsSql()})
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
            ${pinnedAlbumCaseSql()}
            WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
            WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
            WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
            WHEN a.id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN '${ATD_ULTIMATE_ID}'
            ELSE s.album_id
          END,
          COALESCE(s.canonical_id, s.id)
        )
        CASE
          ${pinnedAlbumCaseSql()}
          WHEN a.id IN (${FSLS_ALBUM_IDS_SQL}) THEN '0tcExuDWMQdBbwSpqN8Ku2'
          WHEN a.id IN (${TT20_ALBUM_IDS_SQL}) THEN '0O82niJ0NpcptYRxogeEZu'
          WHEN a.id IN ('5EYKrEDnKhhcNxGedaRQeK', '6cbwstHlsAIIWurIIXXBPd', '2xqTa2dCR54yYHEcttiXyD', '7saicsozAZSsKEVQh4WAig', '5Csjy4XeA7KnizkhIvI7y2', '3L2iweH45rVdTBPldbY6dp') THEN '5EYKrEDnKhhcNxGedaRQeK'
          WHEN a.id IN (${ATD_REMIX_SINGLE_IDS_SQL}) THEN '${ATD_ULTIMATE_ID}'
          ELSE s.album_id
        END AS album_id,
        COALESCE(s.canonical_id, s.id) AS canonical_song_id,
        COALESCE(dsc.cumulative, 0) AS cumulative,
        COALESCE(dsc.daily_gain, 0) AS daily_gain,
        COALESCE(prev.daily_gain, 0) AS prev_daily_gain,
        COALESCE(avg7.daily_avg_7d, 0) AS daily_avg_7d
        FROM songs s
        JOIN albums a ON s.album_id = a.id
        LEFT JOIN (
          SELECT DISTINCT ON (canonical_id)
            canonical_id,
            cumulative,
            daily_gain,
            recorded_date
          FROM daily_streams_canonical
          ORDER BY canonical_id, recorded_date DESC
        ) dsc ON COALESCE(s.canonical_id, s.id) = dsc.canonical_id
        -- Day before the latest snapshot, summed per album below so a card can
        -- show an album's day-over-day delta without extra round trips.
        LEFT JOIN LATERAL (
          SELECT daily_gain
          FROM daily_streams_canonical pv
          WHERE pv.canonical_id = COALESCE(s.canonical_id, s.id)
            AND pv.recorded_date < dsc.recorded_date
          ORDER BY pv.recorded_date DESC
          LIMIT 1
        ) prev ON true
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
        AND COALESCE(s.canonical_id, s.id) NOT IN (${albumHiddenTrackIdsSql()})
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
          -- Generic fallback for any OTHER artist (incl. ones added later from the
          -- admin panel — Dove, Janet, etc.): show their albums automatically so
          -- there's no missing-tab bug, but skip compilations / "featured on"
          -- various-artists albums (Hits of 2024, Party Hits, …) by requiring the
          -- album to hold at least one of the artist's OWN lead (non-featured)
          -- canonical songs. The 10 explicitly-branched artists above are excluded
          -- from this clause, so their lists stay byte-for-byte unchanged.
          OR (
            $1 <> ALL(ARRAY[
              'spotify:artist:31TPClRtHm23RisEBtV3X7',
              'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT',
              'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o',
              'spotify:artist:3p3U04w2DaiBzuYMZnYr00',
              'spotify:artist:3LHYvj5ZejV1NLqncEObSJ',
              'spotify:artist:1HY2Jd0NmPuamShAr6KMms',
              'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR',
              'spotify:artist:2dIgFjalVxs4ThymZ67YCE',
              'spotify:artist:4UIOuc84ExWojcUzFGtb8W'
            ])
            AND EXISTS (
              SELECT 1 FROM songs hs
              WHERE hs.album_id = albums.id
                AND hs.primary_artist = $1
                AND hs.canonical_id IS NULL
                AND hs.is_featured IS NOT TRUE
            )
          )
      )
      SELECT
        ua.album_id,
        ua.album_title,
        ua.release_date,
        ua.image_url,
        COUNT(acs.canonical_song_id)::int AS track_count,
        COALESCE(SUM(acs.cumulative), 0)::bigint AS total_streams,
        COALESCE(SUM(acs.daily_gain), 0)::bigint AS daily_gain,
        COALESCE(SUM(acs.prev_daily_gain), 0)::bigint AS prev_daily_gain,
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
    // Check whether the album belongs to a currently-locked artist (DB-driven).
    const albumCheck = await dbQuery(
      `SELECT DISTINCT s.primary_artist
       FROM songs s
       WHERE s.album_id = $1`,
      [req.params.id]
    );
    // Lock if ANY track on the album belongs to a locked artist (a mixed-artist
    // album must not slip the lock just because its first row is someone else).
    const isLockedAlbum = albumCheck.rows.some(
      r => isArtistLockedById((r.primary_artist || '').replace('spotify:artist:', ''))
    );
    if (isLockedAlbum) {
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
            -- AM I THE DRAMA? (Ultimate Edition): also pull the two standalone
            -- ErrTime remix singles so they show as distinct remix rows here.
            $1 = '${ATD_ULTIMATE_ID}'
            AND s.album_id IN ('${ATD_ULTIMATE_ID}', ${ATD_REMIX_SINGLE_IDS_SQL})
          )
          OR (
            $1 <> '0tcExuDWMQdBbwSpqN8Ku2'
            AND $1 <> '5EYKrEDnKhhcNxGedaRQeK'
            AND $1 <> '0O82niJ0NpcptYRxogeEZu'
            AND $1 <> '${ATD_ULTIMATE_ID}'
            AND s.album_id = $1
          )
          -- Admin-pinned tracks (migration 019): show under the album they're pinned to.
          OR ${pinnedMembershipSql()}
        )
        -- Hidden alternate versions (display only — songs stay in the catalog / DB)
        AND COALESCE(s.canonical_id, s.id) NOT IN (${albumHiddenTrackIdsSql()})
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
      const primaryArtist = (songCheck.rows[0].primary_artist || '').replace('spotify:artist:', '');
      if (isArtistLockedById(primaryArtist)) {
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
    // Lock if ANY track on the album belongs to a locked artist (a mixed-artist
    // album must not slip the lock just because its first row is someone else).
    const isLockedAlbum = albumCheck.rows.some(
      r => isArtistLockedById((r.primary_artist || '').replace('spotify:artist:', ''))
    );
    if (isLockedAlbum) {
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
              -- AM I THE DRAMA? (Ultimate Edition): fold in the two standalone
              -- ErrTime remix singles so the album chart matches the tracklist.
              $1 = '${ATD_ULTIMATE_ID}'
              AND s.album_id IN ('${ATD_ULTIMATE_ID}', ${ATD_REMIX_SINGLE_IDS_SQL})
            )
            OR (
              $1 <> '0tcExuDWMQdBbwSpqN8Ku2'
              AND $1 <> '0O82niJ0NpcptYRxogeEZu'
              AND $1 <> '5EYKrEDnKhhcNxGedaRQeK'
              AND $1 <> '${ATD_ULTIMATE_ID}'
              AND s.album_id = $1
            )
            -- Admin-pinned tracks (migration 019): count under their pinned album.
            OR ${pinnedMembershipSql()}
          )
          AND COALESCE(s.canonical_id, s.id) NOT IN (${albumHiddenTrackIdsSql()})
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
// Brute-force guard: the passcode is short and there's no account system, so after
// a burst of wrong guesses from one IP we lock that IP out for a while. Counts only
// FAILURES and a correct passcode clears the counter, so the real admin is never
// locked out by their own successful access.
const adminFails = new Map(); // ip -> { count, until }
const ADMIN_MAX_FAILS = 10;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
const requireAdmin = (req, res, next) => {
  const ip = clientIp(req);
  const now = Date.now();
  if (adminFails.size > 5000) {                 // bound memory under a distributed flood
    for (const [k, v] of adminFails) if (v.until < now && v.count === 0) adminFails.delete(k);
  }
  const rec = adminFails.get(ip);
  if (rec && rec.until > now) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const key = req.headers['x-admin-passcode'] || req.query.key;
  const role = getAdminRole(key);
  if (!role) {
    const r = rec || { count: 0, until: 0 };
    r.count += 1;
    if (r.count >= ADMIN_MAX_FAILS) { r.until = now + ADMIN_LOCK_MS; r.count = 0; }
    adminFails.set(ip, r);
    return res.status(403).json({ error: 'Forbidden' });
  }
  adminFails.delete(ip);                          // success clears the counter
  req.adminRole = role;
  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (req.adminRole !== 'admin') {
    return res.status(403).json({ error: 'God mode is restricted to the main admin.' });
  }
  next();
};

const isJtSong = async (songId) => {
  const cleanId = String(songId).replace('spotify:track:', '').trim();
  const r = await dbQuery('SELECT primary_artist FROM songs WHERE id = $1', [cleanId]);
  return r.rowCount > 0 && r.rows[0].primary_artist === 'spotify:artist:31TPClRtHm23RisEBtV3X7';
};

// Extract distinct Spotify track/artist IDs mentioned in a feedback message.
// Matches open.spotify.com/{track,artist}/<id> links (tagged with their kind)
// and bare 22-char base62 tokens (kind unknown). Capped so a spammy message
// can't produce an unbounded action list.
function extractSpotifyIds(message) {
  const text = String(message || '');
  const out = [];
  const seen = new Set();
  const push = (kind, id) => {
    if (!SPOTIFY_ID_RE.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ kind, id });
  };
  let m;
  const linkRe = /open\.spotify\.com\/(track|artist)\/([A-Za-z0-9]{22})/g;
  while ((m = linkRe.exec(text)) && out.length < 12) push(m[1], m[2]);
  const bareRe = /(?:^|[^A-Za-z0-9])([A-Za-z0-9]{22})(?![A-Za-z0-9])/g;
  while ((m = bareRe.exec(text)) && out.length < 12) push('id', m[1]);
  return out;
}

app.get('/api/feedback', requireAdmin, async (req, res) => {
  res.setHeader('X-Admin-Role', req.adminRole);
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
    // Pull any Spotify track/artist IDs out of the message (bare 22-char tokens
    // or open.spotify.com links) so the admin panel can turn each report into a
    // one-click jump to that exact song/artist instead of hand-deciphering it.
    const rows = result.rows.map(r => ({ ...r, spotify_ids: extractSpotifyIds(r.message) }));
    res.json(rows);
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

// Same-origin image proxy. The Compare card is exported to PNG via html2canvas;
// cross-origin avatars/covers without CORS headers (e.g. some admin-pasted CDN
// URLs) would otherwise taint the canvas and break the screenshot. Streaming the
// bytes through our own origin sidesteps that. Read-only; images are public.
app.get('/api/img-proxy', async (req, res) => {
  const u = req.query.u;
  if (!u || typeof u !== 'string' || !/^https?:\/\//i.test(u)) return res.status(400).end();
  let target;
  try { target = new URL(u); } catch { return res.status(400).end(); }
  // Basic SSRF guard: never let the proxy hit internal/loopback hosts.
  const host = target.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return res.status(400).end();
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const upstream = await fetch(target.href, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (SpotifyStreams image proxy)' },
    });
    clearTimeout(timer);
    if (!upstream.ok) return res.status(502).end();
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return res.status(415).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return res.status(413).end();
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) {
    res.status(502).end();
  }
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
    if (req.adminRole === 'secadmin') {
      if (artistId === '31TPClRtHm23RisEBtV3X7' || name.toLowerCase().includes('justin timberlake')) {
        return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
      }
    }
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
    if (req.adminRole === 'secadmin') {
      const targetName = String(req.body.name || '').trim().toLowerCase();
      if (id === '31TPClRtHm23RisEBtV3X7' || targetName.includes('justin timberlake')) {
        return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
      }
    }
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
    if (req.adminRole === 'secadmin') {
      if (id === '31TPClRtHm23RisEBtV3X7') {
        return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
      }
    }
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
app.post('/api/admin/artists/:id/purge', requireAdmin, requireSuperAdmin, async (req, res) => {
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
    await Promise.all([refreshActiveArtistsCache(), refreshHiddenSongsCache(), refreshExtraArtistSongsCache(), refreshAlbumTrackPinsCache(), refreshAlbumHiddenTracksCache()]);
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

    // Last kworb reconciliation per artist (written by reconcile-kworb.js). This
    // is what turns "why is this new artist below kworb?" from a thing you notice
    // by eye, days later, into a flag on the Health tab.
    const kworbByArtist = new Map();
    try {
      const kr = await dbQuery(
        `SELECT artist_id, checked_at, kworb_total, our_total, gap,
                COALESCE(repaired_streams, 0) AS repaired_streams,
                linked_count, pinned_count,
                COALESCE(jsonb_array_length(unresolved), 0) AS unresolved_count, error
         FROM kworb_audit`
      );
      for (const row of kr.rows) kworbByArtist.set(row.artist_id, row);
    } catch (e) {
      console.warn('[health] kworb_audit unavailable:', e.code || e.message);
    }

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

      // kworb shortfall. Only a MATERIAL one is worth a flag: a residual under
      // ~0.5% is the normal cost of edition tracks kworb folds into parents and
      // of snapshot timing, not a missing catalogue. A NEGATIVE gap (we're above
      // kworb) is fine — we hold a longer tail and a fresher snapshot.
      const k = kworbByArtist.get(a.artist_id) || null;
      let kworb = null;
      if (k) {
        const kTotal = Number(k.kworb_total) || 0;
        // A pass measures the gap BEFORE repairing it, so flag on what's left
        // after the repairs it just made — otherwise an artist we fully fixed
        // keeps showing their old shortfall until the next check a day later.
        const residual = (Number(k.gap) || 0) - (Number(k.repaired_streams) || 0);
        const residualPct = kTotal > 0 ? (residual / kTotal) * 100 : 0;
        kworb = {
          checked_at: k.checked_at, kworb_total: k.kworb_total, our_total: k.our_total,
          gap: residual, measured_gap: k.gap, repaired_streams: k.repaired_streams,
          gap_pct: Math.round(residualPct * 100) / 100,
          linked_count: k.linked_count, pinned_count: k.pinned_count,
          unresolved_count: k.unresolved_count, error: k.error,
        };
        if (a.active && residual > 10e6 && residualPct >= 0.5) flags.push('kworb-gap');
      }
      // A never-checked artist deliberately gets NO flag: reconcile-kworb.js does
      // never-checked ones first, so it clears within a day — flagging the whole
      // roster on day one would just drown the rows that really need attention.

      return {
        artist_id: a.artist_id, name: a.name, active: a.active,
        total: row.total, songs: row.songs, daily: row.daily,
        last_update: row.last_update, days_stale: daysStale, flags, kworb,
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

    // Song-level frozen detection (the "artist looks fine but individual tracks
    // are stuck" class of bug). Attach the artist name from the roster cache.
    let frozenSongs = [];
    try {
      const nameByUri = new Map(roster.map(a => [`spotify:artist:${a.artist_id}`, a.name]));
      frozenSongs = (await scanFrozenSongs()).map(s => ({
        id: s.id,
        title: s.title,
        artist_id: (s.primary_artist || '').replace('spotify:artist:', ''),
        artist_name: nameByUri.get(s.primary_artist) || null,
        cumulative: s.cumulative,
        last_date: s.last_date,
        zero_recent: s.zero_recent,
      }));
    } catch (e) {
      console.warn('[health] frozen-song scan failed:', e.code || e.message);
    }

    // Whole calendar days elapsed, not the rounded fractional distance: with
    // Math.round a snapshot from yesterday reads "2 days" from midday onwards,
    // which makes a healthy scraper look a day behind.
    const daysSinceUpdate = globalMax
      ? Math.floor((Date.now() - new Date(globalMax + 'T00:00:00Z')) / 86400000) : null;
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
      frozen_songs: frozenSongs.length,
      kworb_gap_artists: perArtist.filter(a => a.flags.includes('kworb-gap')).length,
      stale: daysSinceUpdate != null && daysSinceUpdate >= 2,
    };

    res.json({ global_last_update: globalMax, summary, artists: perArtist, orphans, frozen_songs: frozenSongs });
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
    if (req.adminRole === 'secadmin' && cleanId === '31TPClRtHm23RisEBtV3X7') {
      return res.status(403).json({ error: 'secadmin is not allowed to trigger scrapes for Justin Timberlake.' });
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

// Admin: recent GitHub Actions runs of the scrape workflow, so the panel can show
// whether scrapes are actually succeeding (the spawn-on-Render past gave no signal).
app.get('/api/admin/workflow-runs', requireAdmin, async (req, res) => {
  if (!GH_DISPATCH_TOKEN) {
    return res.status(503).json({ error: 'Not configured: set GH_DISPATCH_TOKEN to view runs.' });
  }
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW_FILE}/runs?per_page=12`;
    const ghRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GH_DISPATCH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'spotify-streams-dashboard',
      },
    });
    if (!ghRes.ok) {
      const detail = await ghRes.text().catch(() => '');
      console.error(`[workflow-runs] GitHub ${ghRes.status}: ${detail}`);
      return res.status(502).json({ error: `GitHub returned HTTP ${ghRes.status}.` });
    }
    const data = await ghRes.json();
    const runs = (data.workflow_runs || []).map(r => ({
      id: r.id,
      status: r.status,            // queued | in_progress | completed
      conclusion: r.conclusion,    // success | failure | cancelled | null
      event: r.event,              // workflow_dispatch | schedule | …
      title: r.display_title,
      created_at: r.created_at,
      run_started_at: r.run_started_at,
      updated_at: r.updated_at,
      html_url: r.html_url,
    }));
    res.json(runs);
  } catch (err) {
    console.error('[workflow-runs] error:', err.message);
    res.status(502).json({ error: 'Could not reach GitHub.' });
  }
});

// Admin: inspect a song's raw stream_stats snapshots (the song + any merged
// aliases), with day-over-day deltas so bad rows — duplicate days, drops,
// partial-scrape phantoms — stand out. song_id = a canonical song id.
app.get('/api/admin/song-snapshots', requireAdmin, async (req, res) => {
  try {
    const id = String(req.query.song_id || '').replace('spotify:track:', '').trim();
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return res.status(400).json({ error: 'Invalid song id.' });
    const r = await dbQuery(
      `SELECT ss.id, ss.song_id, ss.recorded_date::text AS recorded_date, ss.stream_count::bigint AS stream_count,
              (ss.stream_count - LAG(ss.stream_count) OVER (PARTITION BY ss.song_id ORDER BY ss.recorded_date))::bigint AS delta,
              s.title
       FROM stream_stats ss
       JOIN songs s ON s.id = ss.song_id
       WHERE ss.song_id IN (SELECT id FROM songs WHERE id = $1 OR canonical_id = $1)
       ORDER BY ss.recorded_date DESC, ss.song_id
       LIMIT 60`,
      [id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Admin song-snapshots error:', err);
    res.status(500).json({ error: 'Failed to load snapshots.' });
  }
});

// Admin: delete a single bad snapshot row by its stream_stats id. The
// daily_streams_canonical view recomputes automatically; the next scrape
// re-adds today's row if it was today's. Guarded by an id echo in the body.
app.delete('/api/admin/snapshots/:id', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid snapshot id.' });
    if (String(req.body?.confirm || '') !== String(id)) {
      return res.status(400).json({ error: 'Confirmation mismatch.' });
    }
    const r = await dbQuery(`DELETE FROM stream_stats WHERE id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Snapshot not found (already gone?).' });
    console.log(`[snapshot] deleted stream_stats id ${id}.`);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin snapshot-delete error:', err);
    res.status(500).json({ error: 'Failed to delete snapshot.' });
  }
});

// Admin: re-run canonical deduplication on demand (when duplicates/inflation
// appear without waiting for a full scrape). Wrapped in a transaction so a
// mid-run failure rolls back instead of leaving the catalogue un-deduped.
const { dedupCanonical } = require('../spotify-scraper/dedup');
let dedupRunning = false;
app.post('/api/admin/dedup', requireAdmin, requireSuperAdmin, async (req, res) => {
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
    // A bare 22-char token is a Spotify ID — match it exactly (and resolve the
    // canonical head if the id is a merged alias) so a pasted/linked track from a
    // feedback report jumps straight to its editable row. Otherwise title search.
    const isId = SPOTIFY_ID_RE.test(q);
    const r = await dbQuery(
      `SELECT s.id, s.title, s.primary_artist, a.title AS album,
              (SELECT MAX(stream_count) FROM stream_stats WHERE song_id = s.id) AS streams
       FROM songs s LEFT JOIN albums a ON a.id = s.album_id
       WHERE s.canonical_id IS NULL
         AND (${isId ? 's.id = $1 OR s.id = (SELECT COALESCE(canonical_id, id) FROM songs WHERE id = $1)' : 's.title ILIKE $2'})
       ORDER BY streams DESC NULLS LAST LIMIT 40`,
      isId ? [q] : [null, `%${q}%`]
    );
    // Mark hidden / album-hidden / pinned from the caches (no hard table dep).
    const hidden = new Set(hiddenSongsCache);
    const albumHidden = new Set(albumHiddenTracksCache);
    const pinnedBy = new Map(albumTrackPinsCache.map(p => [p.song_id, p.album_id]));
    res.json(r.rows.map(row => ({
      ...row,
      hidden: hidden.has(row.id),
      album_hidden: albumHidden.has(row.id),
      pinned_album: pinnedBy.get(row.id) || null,
    })));
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
    if (req.adminRole === 'secadmin') {
      const isJt = await isJtSong(id);
      if (isJt) {
        return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
      }
    }
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
    if (req.adminRole === 'secadmin') {
      const isJt = await isJtSong(id);
      if (isJt) {
        return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
      }
    }
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
  const namedArtistsSet = new Set(
    allArtistsCache
      .filter(item => item.artist_id !== '31TPClRtHm23RisEBtV3X7')
      .map(item => `spotify:artist:${item.artist_id}`)
  );

  const r = await dbQuery(
    `SELECT s.id, s.title, s.duration_ms, s.primary_artist, s.canonical_id, s.is_featured,
            a.title AS album,
            COALESCE(cs.streams, 0)::bigint AS streams
     FROM songs s
     LEFT JOIN albums a ON a.id = s.album_id
     LEFT JOIN (
       SELECT song_id, MAX(stream_count) AS streams
       FROM canonical_streams
       GROUP BY song_id
     ) cs ON cs.song_id = s.id
     WHERE s.duration_ms IS NOT NULL AND s.canonical_id IS NULL`
  );

  const rowsWithBucket = r.rows.map(row => {
    const bucket = namedArtistsSet.has(row.primary_artist) ? row.primary_artist : 'collab';
    return { ...row, bucket };
  });

  return groupSameStreamDuplicates(rowsWithBucket);
}

app.get('/api/admin/same-stream-dups', requireAdmin, async (req, res) => {
  try {
    res.json(await scanSameStreamDuplicates());
  } catch (err) {
    console.error('Admin same-stream-dups error:', err);
    res.status(500).json({ error: 'Failed to scan duplicates.' });
  }
});

// Mirror the deduper's linked-copy tolerance (services/spotify-scraper/dedup.js
// LINKED_COUNT_TOLERANCE): two copies whose peak playcounts are within 0.5% are
// the same recording (scrape-time drift); beyond that they're genuinely
// different songs. We audit against the same threshold so the panel's verdict
// matches what the merger actually did.
const MERGE_AUDIT_TOLERANCE = 0.005;

// Admin: per-bucket merge audit — the over-merge check we used to run by hand.
// For every merged alias we compare its last scraped count against where its
// canonical stood ON THE SAME DATE. Within 0.5% (the deduper's own tolerance) =
// a legit linked copy; beyond = two different recordings merged together, which
// hides the smaller copy's streams (a cluster only counts the MAX).
//
// Comparing date-aligned (not all-time peaks) is essential: a frozen appears-on
// copy stops growing while the kept copy keeps climbing, so their *lifetime*
// peaks drift well past 0.5% even though they're the same recording. Aligning on
// the alias's last date neutralises that and leaves only genuine over-merges.
// Read-only.
app.get('/api/admin/merge-audit', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(`
      WITH alias_last AS (
        SELECT DISTINCT ON (song_id) song_id, recorded_date, stream_count
        FROM stream_stats ORDER BY song_id, recorded_date DESC
      )
      SELECT al.id            AS alias_id,
             al.title         AS alias_title,
             al_last.stream_count::bigint AS alias_peak,
             cn.title         AS canon_title,
             cn.primary_artist AS canon_artist,
             (SELECT ss.stream_count FROM stream_stats ss
               WHERE ss.song_id = cn.id AND ss.recorded_date <= al_last.recorded_date
               ORDER BY ss.recorded_date DESC LIMIT 1)::bigint AS canon_peak
      FROM songs al
      JOIN songs cn ON cn.id = al.canonical_id
      JOIN alias_last al_last ON al_last.song_id = al.id
      WHERE al.canonical_id IS NOT NULL
    `);

    // bucket key = canonical's primary artist if it's a named tracked artist,
    // otherwise everything falls into JT's catch-all (same rule as the dashboard).
    const named = new Map(
      allArtistsCache
        .filter(a => a.artist_id !== '31TPClRtHm23RisEBtV3X7')
        .map(a => [`spotify:artist:${a.artist_id}`, a.name])
    );
    const jt = allArtistsCache.find(a => a.artist_id === '31TPClRtHm23RisEBtV3X7');
    const jtName = jt ? jt.name : 'Justin Timberlake (catch-all)';

    const buckets = new Map();
    for (const row of r.rows) {
      const uri = row.canon_artist || '';
      const key = named.has(uri) ? uri : 'collab';
      const name = named.get(uri) || jtName;
      if (!buckets.has(key)) {
        buckets.set(key, { key, name, merged: 0, linked: 0, over: 0, hidden: 0n, samples: [] });
      }
      const b = buckets.get(key);
      b.merged++;
      const a = Number(row.alias_peak), c = Number(row.canon_peak);
      const tol = Math.max(a, c) * MERGE_AUDIT_TOLERANCE;
      if (a > 0 && c > 0 && Math.abs(a - c) > tol) {
        b.over++;
        b.hidden += BigInt(Math.min(a, c)); // streams excluded from the total (only the MAX copy counts)
        b.samples.push({
          alias_title: row.alias_title, alias_peak: row.alias_peak,
          canon_title: row.canon_title, canon_peak: row.canon_peak,
        });
      } else {
        b.linked++;
      }
    }

    const out = [...buckets.values()].map(b => ({
      key: b.key, name: b.name, merged: b.merged, linked: b.linked, over: b.over,
      hidden: b.hidden.toString(),
      samples: b.samples
        .sort((x, y) => Number(y.alias_peak) - Number(x.alias_peak))
        .slice(0, 6),
    })).sort((a, b) => b.over - a.over || (Number(b.hidden) - Number(a.hidden)));

    const totals = out.reduce(
      (t, b) => ({ merged: t.merged + b.merged, linked: t.linked + b.linked, over: t.over + b.over }),
      { merged: 0, linked: 0, over: 0 }
    );
    res.json({ buckets: out, totals });
  } catch (err) {
    console.error('Admin merge-audit error:', err);
    res.status(500).json({ error: 'Failed to run merge audit.' });
  }
});

// Admin: list manual merge / split rules (with titles).
app.get('/api/admin/manual-merges', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT m.alias_id, m.canonical_id, m.reason, m.created_at,
              sa.title AS alias_title, sc.title AS canonical_title,
              sa.primary_artist AS alias_artist, sc.primary_artist AS canonical_artist
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
    if (req.adminRole === 'secadmin') {
      const aliasIsJt = await isJtSong(alias);
      const canonicalIsJt = canonical ? await isJtSong(canonical) : false;
      if (aliasIsJt || canonicalIsJt) {
        return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
      }
    }
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
    if (req.adminRole === 'secadmin') {
      const isJt = await isJtSong(id);
      const prevJt = prev.rows[0]?.canonical_id ? await isJtSong(prev.rows[0].canonical_id) : false;
      if (isJt || prevJt) {
        return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
      }
    }
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

// ═══════════════════════ God-mode admin endpoints ═══════════════════════

// Admin: global overview — headline numbers, top daily movers, per-table DB
// sizes. Read-only; backs the God tab's stat cards.
app.get('/api/admin/overview', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const [head, streams, movers, tables] = await Promise.all([
      dbQuery(`SELECT
          (SELECT COUNT(*) FROM songs)::int AS songs,
          (SELECT COUNT(*) FROM songs WHERE canonical_id IS NOT NULL)::int AS merged_songs,
          (SELECT COUNT(*) FROM stream_stats)::bigint AS snapshots,
          (SELECT MIN(recorded_date)::text FROM stream_stats) AS first_date,
          (SELECT MAX(recorded_date)::text FROM stream_stats) AS last_date,
          pg_database_size(current_database())::bigint AS db_bytes`),
      dbQuery(`SELECT COALESCE(SUM(cumulative),0)::bigint AS total,
                      COALESCE(SUM(daily_gain) FILTER (WHERE recorded_date =
                        (SELECT MAX(recorded_date) FROM daily_streams_canonical)),0)::bigint AS today
               FROM (SELECT DISTINCT ON (canonical_id) canonical_id, cumulative, daily_gain, recorded_date
                     FROM daily_streams_canonical ORDER BY canonical_id, recorded_date DESC) x`),
      dbQuery(`SELECT s.title, s.primary_artist, alb.title AS album,
                      d.daily_gain::bigint AS daily_gain, d.cumulative::bigint AS cumulative
               FROM daily_streams_canonical d
               JOIN songs s ON s.id = d.canonical_id
               LEFT JOIN albums alb ON alb.id = s.album_id
               WHERE d.recorded_date = (SELECT MAX(recorded_date) FROM daily_streams_canonical)
                 AND s.id NOT IN (${hiddenTrackIdsSql()})
               ORDER BY d.daily_gain DESC
               LIMIT 15`),
      dbQuery(`SELECT relname AS table_name, n_live_tup::bigint AS approx_rows,
                      pg_total_relation_size(relid)::bigint AS bytes
               FROM pg_stat_user_tables
               ORDER BY pg_total_relation_size(relid) DESC
               LIMIT 12`),
    ]);
    res.json({
      ...head.rows[0],
      total_streams: streams.rows[0].total,
      today_gain: streams.rows[0].today,
      tracked_artists: allArtistsCache.length,
      active_artists: activeArtistsCache.length,
      movers: movers.rows,
      tables: tables.rows,
    });
  } catch (err) {
    console.error('Admin overview error:', err);
    res.status(500).json({ error: 'Failed to load overview.' });
  }
});

// Admin: read-only SQL console. The real teeth are the READ ONLY transaction
// and the statement_timeout — Postgres itself rejects any write attempt. The
// regex checks just catch accidents before they hit the DB. Single statement,
// SELECT/WITH only, capped at 500 rows via a wrapping subquery.
const SQL_ROW_CAP = 500;
app.post('/api/admin/sql', requireAdmin, requireSuperAdmin, async (req, res) => {
  const raw = String(req.body?.query || '').trim().replace(/;\s*$/, '');
  if (!raw) return res.status(400).json({ error: 'Empty query.' });
  if (raw.includes(';')) return res.status(400).json({ error: 'Single statement only (no semicolons).' });
  if (!/^(select|with)\b/i.test(raw)) return res.status(400).json({ error: 'Only SELECT / WITH queries are allowed.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '10s'`);
    const started = Date.now();
    const r = await client.query({
      text: `SELECT * FROM (${raw}) __god LIMIT ${SQL_ROW_CAP + 1}`,
      rowMode: 'array',
    });
    await client.query('ROLLBACK');
    const truncated = r.rows.length > SQL_ROW_CAP;
    const fields = r.fields || [];
    // pg parses date/timestamp columns to JS Dates at LOCAL midnight — a naive
    // toISOString() shifts them back a day (UTC+3 → previous day). Format in
    // local time instead; DATE columns (OID 1082) drop the time part.
    const fmtVal = (v, i) => {
      if (v === null) return null;
      if (v instanceof Date) {
        const day = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
        return fields[i]?.dataTypeID === 1082 ? day : `${day} ${v.toTimeString().slice(0, 8)}`;
      }
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    };
    res.json({
      columns: fields.map(f => f.name),
      rows: (truncated ? r.rows.slice(0, SQL_ROW_CAP) : r.rows).map(row => row.map(fmtVal)),
      truncated,
      ms: Date.now() - started,
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    res.status(400).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

// Admin: wipe every stream_stats row recorded on one date, optionally scoped to
// one artist's primary bucket — the cleanup for double-day / partial-scrape
// incidents. Two-step: preview:true returns the count only; the real delete
// must echo the date back in `confirm`.
app.post('/api/admin/snapshots/delete-day', requireAdmin, requireSuperAdmin, async (req, res) => {
  const date = String(req.body?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD).' });
  const artistId = String(req.body?.artist_id || '').replace('spotify:artist:', '').trim();
  if (artistId && !/^[A-Za-z0-9]{22}$/.test(artistId)) return res.status(400).json({ error: 'Invalid artist id.' });
  const params = [date];
  let where = `recorded_date = $1`;
  if (artistId) {
    params.push(`spotify:artist:${artistId}`);
    where += ` AND song_id IN (SELECT id FROM songs WHERE primary_artist = $2)`;
  }
  try {
    if (req.body?.preview) {
      const r = await dbQuery(`SELECT COUNT(*)::int AS n FROM stream_stats WHERE ${where}`, params);
      return res.json({ preview: true, rows: r.rows[0].n });
    }
    if (String(req.body?.confirm || '') !== date) {
      return res.status(400).json({ error: 'Confirmation mismatch — nothing deleted.' });
    }
    const r = await dbQuery(`DELETE FROM stream_stats WHERE ${where}`, params);
    console.log(`[delete-day] ${date}${artistId ? ' / ' + artistId : ''}: ${r.rowCount} rows removed.`);
    res.json({ success: true, rows: r.rowCount });
  } catch (err) {
    console.error('Admin delete-day error:', err);
    res.status(500).json({ error: 'Failed to delete snapshots.' });
  }
});

// Admin: re-stamp every snapshot row recorded on one date onto another date —
// the fix for Spotify shipping a daily update late. Playcounts that arrive
// after the noon-Istanbul rollover get stamped a day too late, which leaves a
// hole on the real day and makes daily_gain divide the two-day jump in half
// (the views divide by the recorded_date gap). Moving the rows back to the day
// the update actually belongs to restores the true gains.
// Covers stream_stats AND artist_stats. If a row already exists on the target
// date, the pair is merged (stream_stats keeps the max count; artist_stats
// keeps the moved row's values) so the unique indexes are never violated.
// Two-step like delete-day: preview:true returns counts only; the real move
// must echo the source date back in `confirm`. Transactional.
app.post('/api/admin/snapshots/move-day', requireAdmin, requireSuperAdmin, async (req, res) => {
  const from = String(req.body?.from || '').trim();
  const to   = String(req.body?.to || '').trim();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD).' });
  if (from === to) return res.status(400).json({ error: 'Source and target dates are the same.' });
  const artistId = String(req.body?.artist_id || '').replace('spotify:artist:', '').trim();
  if (artistId && !/^[A-Za-z0-9]{22}$/.test(artistId)) return res.status(400).json({ error: 'Invalid artist id.' });

  // $1 = from, $2 = to, $3 = 'spotify:artist:<id>' or NULL (scope for songs).
  // Preview adds $4 = bare artist id or NULL (artist_stats stores it unprefixed).
  const sParams = [from, to, artistId ? `spotify:artist:${artistId}` : null];
  const songScope = `($3::text IS NULL OR s.song_id IN (SELECT id FROM songs WHERE primary_artist = $3::text))`;

  let client;
  try {
    if (req.body?.preview) {
      const hasArtistStats =
        (await dbQuery(`SELECT to_regclass('public.artist_stats') AS t`)).rows[0].t != null;
      const r = await dbQuery(
        `SELECT
           (SELECT COUNT(*) FROM stream_stats s
             WHERE s.recorded_date = $1 AND ${songScope})::int AS stream_rows,
           (SELECT COUNT(*) FROM stream_stats s
             JOIN stream_stats t ON t.song_id = s.song_id AND t.recorded_date = $2
             WHERE s.recorded_date = $1 AND ${songScope})::int AS merged_rows,
           ${hasArtistStats
             ? `(SELECT COUNT(*) FROM artist_stats a
                  WHERE a.recorded_date = $1 AND ($4::text IS NULL OR a.artist_id = $4::text))::int`
             : `(LENGTH(COALESCE($4::text, '')) * 0)::int`} AS artist_rows`,
        [...sParams, artistId || null]
      );
      return res.json({ preview: true, ...r.rows[0] });
    }
    if (String(req.body?.confirm || '') !== from) {
      return res.status(400).json({ error: 'Confirmation mismatch — nothing moved.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // 1) Songs that already have a row on the target date: fold the source row
    //    into it (max count wins, same rule as the scraper's upsert), then drop
    //    the source copy so step 3's re-stamp can't hit the unique index.
    await client.query(
      `UPDATE stream_stats t
          SET stream_count = GREATEST(t.stream_count, s.stream_count),
              recorded_at  = GREATEST(t.recorded_at, s.recorded_at)
         FROM stream_stats s
        WHERE t.recorded_date = $2 AND s.recorded_date = $1
          AND t.song_id = s.song_id AND ${songScope}`,
      sParams
    );
    await client.query(
      `DELETE FROM stream_stats s
        USING stream_stats t
        WHERE s.recorded_date = $1 AND t.recorded_date = $2
          AND t.song_id = s.song_id AND ${songScope}`,
      sParams
    );
    // 3) Re-stamp everything left on the source date.
    const moved = await client.query(
      `UPDATE stream_stats s SET recorded_date = $2
        WHERE s.recorded_date = $1 AND ${songScope}`,
      sParams
    );

    // artist_stats mirrors the same merge-then-move, keeping the moved (newer)
    // values on conflict. Table is optional on old DBs — guard like purge does.
    let artistMoved = 0;
    const hasArtistStats =
      (await client.query(`SELECT to_regclass('public.artist_stats') AS t`)).rows[0].t != null;
    if (hasArtistStats) {
      const aParams = [from, to, artistId || null];
      const aScope = `($3::text IS NULL OR s.artist_id = $3::text)`;
      await client.query(
        `UPDATE artist_stats t
            SET monthly_listeners = COALESCE(s.monthly_listeners, t.monthly_listeners),
                followers         = COALESCE(s.followers, t.followers),
                world_rank        = COALESCE(s.world_rank, t.world_rank),
                artist_name       = COALESCE(s.artist_name, t.artist_name),
                recorded_at       = GREATEST(t.recorded_at, s.recorded_at)
           FROM artist_stats s
          WHERE t.recorded_date = $2 AND s.recorded_date = $1
            AND t.artist_id = s.artist_id AND ${aScope}`,
        aParams
      );
      await client.query(
        `DELETE FROM artist_stats s
          USING artist_stats t
          WHERE s.recorded_date = $1 AND t.recorded_date = $2
            AND t.artist_id = s.artist_id AND ${aScope}`,
        aParams
      );
      const ar = await client.query(
        `UPDATE artist_stats s SET recorded_date = $2
          WHERE s.recorded_date = $1 AND ${aScope}`,
        aParams
      );
      artistMoved = ar.rowCount;
    }

    await client.query('COMMIT');
    console.log(`[move-day] ${from} → ${to}${artistId ? ' / ' + artistId : ''}: ${moved.rowCount} stream rows, ${artistMoved} artist rows.`);
    res.json({ success: true, stream_rows: moved.rowCount, artist_rows: artistMoved });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('Admin move-day error:', err);
    res.status(500).json({ error: 'Move failed — rolled back, nothing changed.' });
  } finally {
    if (client) client.release();
  }
});

// Admin: reload the in-memory roster + hidden-song caches from the DB without a
// redeploy (e.g. after fixing rows straight in Neon).
app.post('/api/admin/refresh-caches', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await Promise.all([refreshActiveArtistsCache(), refreshHiddenSongsCache(), refreshExtraArtistSongsCache(), refreshAlbumTrackPinsCache(), refreshAlbumHiddenTracksCache()]);
    res.json({ success: true, artists: allArtistsCache.length, hidden_songs: hiddenSongsCache.length });
  } catch (err) {
    console.error('Admin refresh-caches error:', err);
    res.status(500).json({ error: 'Failed to refresh caches.' });
  }
});

// Admin: move a song to another artist's dashboard bucket (fix collab
// attribution without a redeploy). If the song is still flagged is_featured a
// later scrape that sees it as an own-album track can reassign it — the
// response surfaces that flag so the panel can warn.
app.patch('/api/admin/songs/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id).replace('spotify:track:', '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return res.status(400).json({ error: 'Invalid song id.' });
  const target = String(req.body?.primary_artist || '').replace('spotify:artist:', '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(target)) return res.status(400).json({ error: 'Invalid artist id.' });
  if (req.adminRole === 'secadmin') {
    if (target === '31TPClRtHm23RisEBtV3X7') {
      return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
    }
    const isJt = await isJtSong(id);
    if (isJt) {
      return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
    }
  }
  try {
    const r = await dbQuery(
      `UPDATE songs SET primary_artist = $1 WHERE id = $2 RETURNING is_featured`,
      [`spotify:artist:${target}`, id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Song not found.' });
    res.json({ success: true, is_featured: r.rows[0].is_featured });
  } catch (err) {
    console.error('Admin song-bucket error:', err);
    res.status(500).json({ error: 'Failed to move song.' });
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
  // Live totals (precomputed in ogStatsCache) make the shared link say something
  // concrete — "18.2B streams · +7.4M/day" — instead of a generic blurb. Falls
  // back to plain text on a cache miss so a link never breaks.
  const ogStats = og ? ogStatsCache.get(aId) : null;
  let title = og ? `${og.name} — Spotify Streams` : 'Spotify Streams — Fan Dashboard';
  let desc = og
    ? `${og.name}'s live Spotify stream counts, daily gains, and milestones — updated daily.`
    : 'Live Spotify stream counts, daily gains, and milestones for your favorite artists — updated daily.';
  if (og && ogStats) {
    title = `${og.name} — ${fmtStreamsShort(ogStats.total)} Spotify Streams`;
    desc = `${fmtStreamsShort(ogStats.total)} total streams · +${fmtStreamsShort(ogStats.daily)}/day. ${og.name}'s live counts, daily gains & milestones — updated daily.`;
  }
  // Default (no ?artist=) → neutral branded 1200×630 banner, NOT a single artist
  // photo. Per-artist links still use that artist's image. og-default.png is a
  // proper landscape card so summary_large_image doesn't crop a portrait.
  let img = (og && og.image_url) ? og.image_url : '/images/og-default.png';
  if (img.startsWith('/')) img = baseUrl + img;
  const pageUrl = baseUrl + req.originalUrl;
  const ogEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Only the default banner has known 1200×630 dimensions; per-artist Spotify
  // photos are square, so we don't claim a size for them.
  const isDefaultImg = !(og && og.image_url);
  const dimTags = isDefaultImg
    ? `\n  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">`
    : '';
  const ogTags = `
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Spotify Streams — Fan Dashboard">
  <meta property="og:title" content="${ogEsc(title)}">
  <meta property="og:description" content="${ogEsc(desc)}">
  <meta property="og:image" content="${ogEsc(img)}">${dimTags}
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

// Admin: get all extra artist song links
app.get('/api/admin/extra-artist-songs', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery("SELECT artist_id, song_id FROM extra_artist_songs");
    res.json(r.rows);
  } catch (err) {
    console.error('Fetch extra-artist-songs error:', err);
    res.status(500).json({ error: 'Failed to load extra artist song links.' });
  }
});

// Admin: add an extra artist song link
app.post('/api/admin/extra-artist-songs', requireAdmin, async (req, res) => {
  const { artist_id, song_id } = req.body || {};
  const cleanSongId = String(song_id || '').replace('spotify:track:', '').trim();
  const cleanArtistId = String(artist_id || '').replace('spotify:artist:', '').trim();
  
  if (!/^[A-Za-z0-9]{22}$/.test(cleanSongId)) return res.status(400).json({ error: 'Invalid song ID.' });
  if (!/^[A-Za-z0-9]{22}$/.test(cleanArtistId)) return res.status(400).json({ error: 'Invalid artist ID.' });
  
  if (req.adminRole === 'secadmin') {
    if (cleanArtistId === '31TPClRtHm23RisEBtV3X7') {
      return res.status(403).json({ error: 'secadmin is not allowed to link songs to Justin Timberlake.' });
    }
    const isJt = await isJtSong(cleanSongId);
    if (isJt) {
      return res.status(403).json({ error: 'secadmin is not allowed to link Justin Timberlake songs.' });
    }
  }
  
  try {
    await dbQuery(
      "INSERT INTO extra_artist_songs (artist_id, song_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [cleanArtistId, cleanSongId]
    );
    await refreshExtraArtistSongsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Add extra-artist-song error:', err);
    res.status(500).json({ error: 'Failed to link song.' });
  }
});

// Admin: remove an extra artist song link
app.delete('/api/admin/extra-artist-songs', requireAdmin, async (req, res) => {
  const { artist_id, song_id } = req.body || {};
  const cleanSongId = String(song_id || '').replace('spotify:track:', '').trim();
  const cleanArtistId = String(artist_id || '').replace('spotify:artist:', '').trim();
  
  if (!/^[A-Za-z0-9]{22}$/.test(cleanSongId)) return res.status(400).json({ error: 'Invalid song ID.' });
  if (!/^[A-Za-z0-9]{22}$/.test(cleanArtistId)) return res.status(400).json({ error: 'Invalid artist ID.' });
  
  if (req.adminRole === 'secadmin') {
    if (cleanArtistId === '31TPClRtHm23RisEBtV3X7') {
      return res.status(403).json({ error: 'secadmin is not allowed to modify Justin Timberlake links.' });
    }
    const isJt = await isJtSong(cleanSongId);
    if (isJt) {
      return res.status(403).json({ error: 'secadmin is not allowed to modify Justin Timberlake links.' });
    }
  }
  
  try {
    await dbQuery(
      "DELETE FROM extra_artist_songs WHERE artist_id = $1 AND song_id = $2",
      [cleanArtistId, cleanSongId]
    );
    await refreshExtraArtistSongsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete extra-artist-song error:', err);
    res.status(500).json({ error: 'Failed to unlink song.' });
  }
});

// ---- Admin: album tracklist overrides (migration 019, display-only) ----------
// Pins: show a song under a chosen album's tracklist. Album-hides: drop a song
// from album tracklists/totals while keeping it in the artist's overall total.
// Both are display-only (no canonical/total change). secadmin can't touch JT.

app.get('/api/admin/album-track-pins', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT p.song_id, p.album_id, p.note, s.title AS song_title, a.title AS album_title
         FROM album_track_pins p
         LEFT JOIN songs s ON s.id = p.song_id
         LEFT JOIN albums a ON a.id = p.album_id
         ORDER BY p.created_at DESC`);
    res.json(r.rows);
  } catch (err) {
    console.error('Fetch album-track-pins error:', err);
    res.status(500).json({ error: 'Failed to load album pins.' });
  }
});

app.post('/api/admin/album-track-pins', requireAdmin, async (req, res) => {
  const songId = String(req.body?.song_id || '').replace('spotify:track:', '').trim();
  const albumId = String(req.body?.album_id || '').replace('spotify:album:', '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 200) || null;
  if (!/^[A-Za-z0-9]{22}$/.test(songId)) return res.status(400).json({ error: 'Invalid song ID.' });
  if (!/^[A-Za-z0-9]{22}$/.test(albumId)) return res.status(400).json({ error: 'Invalid album ID.' });
  if (req.adminRole === 'secadmin' && await isJtSong(songId)) {
    return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
  }
  try {
    const alb = await dbQuery('SELECT 1 FROM albums WHERE id = $1', [albumId]);
    if (alb.rowCount === 0) return res.status(400).json({ error: 'No such album id in the catalog.' });
    await dbQuery(
      `INSERT INTO album_track_pins (song_id, album_id, note) VALUES ($1, $2, $3)
       ON CONFLICT (song_id) DO UPDATE SET album_id = $2, note = $3`,
      [songId, albumId, note]);
    await refreshAlbumTrackPinsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Add album-track-pin error:', err);
    res.status(500).json({ error: 'Failed to pin track.' });
  }
});

app.delete('/api/admin/album-track-pins/:songId', requireAdmin, async (req, res) => {
  const songId = String(req.params.songId).replace('spotify:track:', '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(songId)) return res.status(400).json({ error: 'Invalid song ID.' });
  if (req.adminRole === 'secadmin' && await isJtSong(songId)) {
    return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
  }
  try {
    await dbQuery('DELETE FROM album_track_pins WHERE song_id = $1', [songId]);
    await refreshAlbumTrackPinsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete album-track-pin error:', err);
    res.status(500).json({ error: 'Failed to unpin track.' });
  }
});

app.get('/api/admin/album-hidden-tracks', requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT h.song_id, h.note, s.title AS song_title
         FROM album_hidden_tracks h LEFT JOIN songs s ON s.id = h.song_id
         ORDER BY h.created_at DESC`);
    res.json(r.rows);
  } catch (err) {
    console.error('Fetch album-hidden-tracks error:', err);
    res.status(500).json({ error: 'Failed to load album-hidden tracks.' });
  }
});

app.post('/api/admin/album-hidden-tracks', requireAdmin, async (req, res) => {
  const songId = String(req.body?.song_id || '').replace('spotify:track:', '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 200) || null;
  if (!/^[A-Za-z0-9]{22}$/.test(songId)) return res.status(400).json({ error: 'Invalid song ID.' });
  if (req.adminRole === 'secadmin' && await isJtSong(songId)) {
    return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
  }
  try {
    await dbQuery(
      `INSERT INTO album_hidden_tracks (song_id, note) VALUES ($1, $2)
       ON CONFLICT (song_id) DO UPDATE SET note = $2`,
      [songId, note]);
    await refreshAlbumHiddenTracksCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Add album-hidden-track error:', err);
    res.status(500).json({ error: 'Failed to hide track from album.' });
  }
});

app.delete('/api/admin/album-hidden-tracks/:songId', requireAdmin, async (req, res) => {
  const songId = String(req.params.songId).replace('spotify:track:', '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(songId)) return res.status(400).json({ error: 'Invalid song ID.' });
  if (req.adminRole === 'secadmin' && await isJtSong(songId)) {
    return res.status(403).json({ error: 'secadmin is not allowed to edit Justin Timberlake.' });
  }
  try {
    await dbQuery('DELETE FROM album_hidden_tracks WHERE song_id = $1', [songId]);
    await refreshAlbumHiddenTracksCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete album-hidden-track error:', err);
    res.status(500).json({ error: 'Failed to unhide track.' });
  }
});

// Protected Static Files
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// Catch-all redirect to home
app.get('*', requireAuth, (req, res) => {
  res.redirect('/');
});

app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  await refreshRosterCaches();
  // OG preview stats depend on the roster cache above being populated first.
  refreshOgStatsCache();
});
