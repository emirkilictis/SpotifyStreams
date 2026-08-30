// Global State
let allSongs = [];
let allAlbums = [];
let filteredSongs = [];
let searchFilter = '';
let albumSearchFilter = '';
let albumSortField = 'streams-desc';
let typeFilter = 'all'; // 'all' | 'lead' | 'featured'
let currentSortField = 'streams'; // 'rank' | 'title' | 'album' | 'duration' | 'streams' | 'gain'
let currentSortDirection = 'desc';
let activeView = 'songs'; // 'songs' | 'albums' | 'milestones'
let milestoneFilter = 'all'; // 'all' | 'songs' | 'albums'
let lastAchievedMilestonesRawData = [];
let songsExpanded = false; // when false, the songs table shows only the top N rows
const SONGS_COLLAPSED_LIMIT = 15;
let currentArtist = null; // set when artist is picked
let currentArtistName = ''; // display name of picked artist
let currentAlbumMeta = null; // { albumId, title, releaseDate, coverUrl } of open album modal
let currentSongMeta = null; // { songId, title, albumTitle, coverUrl, cumulative, dailyGain, avg7d, yearEndProj, nextMilestone, etaText, percent } of open song modal
let activeSongChart = null;
let activeAlbumChart = null;
let activeSongHistory = [];
let activeAlbumHistory = [];
let activeAlbumId = null;
let songChartType = 'cumulative'; // 'cumulative' | 'daily'
let songChartRange = '30'; // '7' | '30' | 'all'
let albumChartRange = '30'; // '7' | '30' | 'all'
let showDetailedAnalysis = false;
let loadingAlbumHistory = false;
let currentArtistStats = null; // cached stats for the current artist
let currentArtistRawStats = null; // cached daily/cumulative stats from /api/stats

// Artists that should only show the Albums view (no Songs tab)
const ALBUM_ONLY_ARTISTS = new Set([
  '1HY2Jd0NmPuamShAr6KMms', // Lady Gaga
  '6qqNVTkY8uBg9cP3Jd7DAH', // Billie Eilish
  '66CXWjxzNUsdJxJ2JdwvnR', // Ariana Grande
]);

// Escape a string for safe HTML interpolation (element text or attribute
// values). Titles like `… From "Toy Story 5"` otherwise terminate the
// attribute early and leak garbage attributes / break inline handlers.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Escape a string for a single-quoted JS literal inside an inline handler.
// The handler string must still go through escHtml when placed in an attribute.
function escJs(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Elements
const tbody = document.getElementById('songs-tbody');
const searchInput = document.getElementById('search-input');
const filterButtons = document.querySelectorAll('.filter-btn');
const sortHeaders = document.querySelectorAll('th.sortable');

// Stats Elements
const totalStreamsEl = document.getElementById('total-streams');
const monthlyListenersEl = document.getElementById('monthly-listeners');
const monthlyListenersChangeEl = document.getElementById('monthly-listeners-change');
const monthlyListenersPeakEl = document.getElementById('monthly-listeners-peak');
const followersEl = document.getElementById('followers');
const followersChangeEl = document.getElementById('followers-change');

// Artist Profile Hero Elements
const artistProfileName = document.getElementById('artist-profile-name');
const artistHeroAvatar = document.getElementById('artist-hero-avatar');
const artistHeroBanner = document.getElementById('artist-hero-banner');
const heroListeners = document.getElementById('hero-listeners');
const heroFollowers = document.getElementById('hero-followers');
const heroRank = document.getElementById('hero-rank');
const heroRankContainer = document.getElementById('hero-rank-container');
const heroRankSep = document.getElementById('hero-rank-sep');

// Achieved milestones section
const achievedSection = document.getElementById('achieved-milestones-section');
const achievedToggleBtn = document.getElementById('achieved-toggle-btn');
const achievedCountEl = document.getElementById('achieved-count');
const achievedListEl = document.getElementById('achieved-list');
const leadStreamsEl = document.getElementById('lead-streams');
const featStreamsEl = document.getElementById('feat-streams');
const soloStreamsEl = document.getElementById('solo-streams');
// Share-of-total labels sitting next to each breakdown number.
const leadStreamsPctEl = document.getElementById('lead-streams-pct');
const featStreamsPctEl = document.getElementById('feat-streams-pct');
const soloStreamsPctEl = document.getElementById('solo-streams-pct');
const leadDailyPctEl = document.getElementById('lead-daily-pct');
const featDailyPctEl = document.getElementById('feat-daily-pct');
const dailyStreamsEl = document.getElementById('daily-streams');
const totalSongsEl = document.getElementById('total-songs');
const lastUpdateEl = document.getElementById('last-update');
const statsGrid = document.querySelector('.stats-grid');

// View Toggle Elements
const viewToggleBtns = document.querySelectorAll('.view-toggle-btn');
const viewToggleBar = document.querySelector('.view-toggle-bar');
const songsToggleBtn = document.querySelector('.view-toggle-btn[data-view="songs"]');
const songsViewSection = document.getElementById('songs-view-section');
const albumsViewSection = document.getElementById('albums-view-section');
const albumsContainer = document.getElementById('albums-container');
const albumSearchInput = document.getElementById('album-search-input');
const albumSortSelect = document.getElementById('album-sort-select');
const songsShowAllBtn = document.getElementById('songs-showall-btn');

// Total Streams breakdown (Lead / Solo / Featured) toggle
const breakdownToggle = document.getElementById('breakdown-toggle');
const streamsBreakdown = document.getElementById('streams-breakdown');

// Daily Streams breakdown (Lead / Featured) toggle
const dailyBreakdownToggle = document.getElementById('daily-breakdown-toggle');
const dailyStreamsBreakdown = document.getElementById('daily-streams-breakdown');
const dailyRemovedEl = document.getElementById('daily-removed');
const leadDailyStreamsEl = document.getElementById('lead-daily-streams');
const featDailyStreamsEl = document.getElementById('feat-daily-streams');

// Modal Elements
const albumModal = document.getElementById('album-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalDownloadBtn = document.getElementById('modal-download-btn');

// Song Modal Elements
const songModal = document.getElementById('song-modal');
const songModalCloseBtn = document.getElementById('song-modal-close-btn');
const modalSongCover = document.getElementById('modal-song-cover');
const modalSongTitle = document.getElementById('modal-song-title');
const modalSongSubtitle = document.getElementById('modal-song-subtitle');
const modalSongStreams = document.getElementById('modal-song-streams');
const modalSongGain = document.getElementById('modal-song-gain');
const modalSongDuration = document.getElementById('modal-song-duration');
const songModalNextMilestone = document.getElementById('song-modal-next-milestone');
const songModalMilestoneEta = document.getElementById('song-modal-milestone-eta');
const songModalMilestoneProgress = document.getElementById('song-modal-milestone-progress');
const songModalMilestonePercent = document.getElementById('song-modal-milestone-percent');
const songModalSpotifyLink = document.getElementById('song-modal-spotify-link');
const openSongCardBtn = document.getElementById('open-song-card-btn');

// Song Card Modal Elements
const songCardModal = document.getElementById('song-card-modal');
const songCardEl = document.getElementById('song-card');
const songCardCloseBtn = document.getElementById('song-card-close-btn');
const songCardDownloadBtn = document.getElementById('song-card-download-btn');

// Milestones Section Elements
const milestonesSection = document.getElementById('milestones-section');
const milestonesGrid = document.getElementById('milestones-grid');
const milestoneFilterButtons = document.querySelectorAll('.milestone-filter-btn');

// Formatting Helpers
function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';   // guard: never render literal "NaN"
  return n.toLocaleString('en-US');
}

function formatShortNumber(val) {
  if (val === null || val === undefined) return '0';
  const num = Number(val);
  if (num >= 1000000000) {
    return (num / 1000000000).toFixed(2) + 'B';
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

// Streams Spotify TOOK BACK, always as a red negative: −3.132.704.
// The correction shaves the history down, so the day itself reads +0 — true,
// but it says nothing about what happened. This is the number that does.
function formatRemoved(n) {
  const v = Math.abs(Number(n) || 0);
  return `−${formatNumber(v)}`;
}

function getYearEndProjection(cumulative, dailyGain) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const yearEnd = new Date(currentYear, 11, 31); // Dec 31
  const diffTime = Math.max(0, yearEnd - now);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  const dailyAvg = Number(dailyGain) > 0 ? Number(dailyGain) : 0;
  const projected = Number(cumulative) + (dailyAvg * diffDays);
  return projected;
}

// Day-over-day change for an artist-stat card (monthly listeners / followers).
// null => no previous snapshot yet (hide it).
function setStatDelta(el, change) {
  if (!el) return;
  if (change === null || change === undefined) {
    el.textContent = '';
    el.className = 'stat-delta';
    return;
  }
  const n = Number(change);
  if (n > 0) {
    el.textContent = `▲ ${formatNumber(n)}`;
    el.className = 'stat-delta gain-positive';
  } else if (n < 0) {
    el.textContent = `▼ ${formatNumber(Math.abs(n))}`;
    el.className = 'stat-delta gain-negative';
  } else {
    el.textContent = '— 0';
    el.className = 'stat-delta gain-neutral';
  }
}

// All-time high monthly listeners. Hidden entirely for artists with no peak on
// record. When today's figure IS the peak, say so instead of printing the same
// number twice.
function setListenersPeak(peak, current) {
  if (!monthlyListenersPeakEl) return;
  const value = Number(peak?.value);
  if (!peak || !Number.isFinite(value) || value <= 0) {
    monthlyListenersPeakEl.classList.add('hidden');
    monthlyListenersPeakEl.textContent = '';
    monthlyListenersPeakEl.removeAttribute('title');
    return;
  }
  const cur = Number(current);
  const atPeak = Number.isFinite(cur) && cur >= value;
  monthlyListenersPeakEl.textContent = atPeak
    ? `★ Peak ${formatNumber(value)} — all-time high`
    : `★ Peak ${formatNumber(value)}`;
  monthlyListenersPeakEl.title = peak.date
    ? `Peak reached on ${formatDate(peak.date)}`
    : 'Peak reached before tracking started';
  monthlyListenersPeakEl.classList.toggle('at-peak', atPeak);
  monthlyListenersPeakEl.classList.remove('hidden');
}

// "part of whole" as a percentage, for the Lead / Solo / Featured breakdowns.
// One decimal below 10% so a small featured share doesn't collapse to "0%".
function setSharePct(el, part, whole) {
  if (!el) return;
  const p = Number(part);
  const w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) {
    el.textContent = '';
    return;
  }
  const pct = (p / w) * 100;
  el.textContent = `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

function formatDuration(ms) {
  if (!ms) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Convert a #rrggbb / #rgb hex color to an "r, g, b" triplet for use inside
// rgba(). We avoid CSS color-mix()/color(srgb ...) because html2canvas 1.4.1
// cannot parse those and the Save Card export throws on them.
function hexToRgbTriplet(hex) {
  if (!hex) return '30, 215, 96';
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  if (isNaN(num) || h.length !== 6) return '30, 215, 96';
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  // parseLocalDate, not new Date(): a bare "2026-07-28" parses as UTC midnight,
  // which renders as the 27th for anyone west of Greenwich.
  const d = parseLocalDate(dateStr);
  if (isNaN(d.getTime())) return String(dateStr).slice(0, 10);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Axis label for the history charts. formatDate() gives "June 28, 2024", which
// the charts used to cut to 10 characters — printing "June 28, 2" on every tick.
function formatChartDate(dateStr) {
  const d = parseLocalDate(dateStr);
  if (isNaN(d.getTime())) return String(dateStr).slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

// Spotify's playcounts run a day behind: the number scraped on the 28th is the
// catalogue as of the 27th, so the gain between two scrapes belongs to the
// earlier day.
//
// APPLIED ONLY TO THE LISA / JT STATS CARDS for now. Those are captions on a
// single day's numbers, which is where the off-by-one actually misleads a
// reader. Everything else — the last-update chip, chart axes, share-card
// captions, achieved-milestone dates, the admin panel — still shows the raw
// scrape date, so what the site says keeps matching what recorded_date says
// when something needs debugging. Set to 0 to drop the shift entirely.
const STREAM_DATE_OFFSET_DAYS = -1;

// ---------------------------------------------------------------------------
// Editorial policy: JT's pages never print a negative stream figure.
//
// Same stance as the Compare card's anti-drag guard — this is a fan dashboard
// and his numbers are its subject. When Spotify takes streams back, the loss is
// still recorded and still corrected in the database, so every TOTAL on the
// site stays truthful; what's suppressed is the red "−X" caption announcing it.
// A day that lost streams reads as a day that gained nothing.
//
// Deliberately keyed to the artist, not to the number: every other artist shows
// their removals in full.
// ---------------------------------------------------------------------------
const NO_NEGATIVE_ARTIST_ID = '31TPClRtHm23RisEBtV3X7';   // Justin Timberlake
const showsNegatives = () => currentArtist !== NO_NEGATIVE_ARTIST_ID;

// Artists whose Daily Streams card still carries the red removal caption. For
// everyone else it is suppressed there (it named no track, so it read as a
// catalogue-wide loss); the per-song removals are unaffected either way.
const SHOWS_DAILY_REMOVAL = new Set([
  '3LHYvj5ZejV1NLqncEObSJ',   // Vaelis (Monarch)
]);

// Returns a YYYY-MM-DD string so downstream formatters stay on a local date.
function toStreamDay(dateStr) {
  if (!dateStr || !STREAM_DATE_OFFSET_DAYS) return dateStr;
  const d = parseLocalDate(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + STREAM_DATE_OFFSET_DAYS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


function filterHistoryByRange(history, range) {
  if (!history || history.length === 0) return [];
  if (range === 'all') return history;

  const maxDateMs = Math.max(...history.map(row => new Date(row.recorded_date).getTime()).filter(t => !isNaN(t)));
  const baseDate = maxDateMs > 0 ? new Date(maxDateMs) : new Date();

  const cutoffDate = new Date(baseDate);
  cutoffDate.setDate(baseDate.getDate() - parseInt(range));

  return history.filter(row => {
    const d = new Date(row.recorded_date);
    return !isNaN(d.getTime()) && d >= cutoffDate;
  });
}

// ---- Skeleton / empty-state helpers ----
function skeletonRows(count, cols) {
  let html = '';
  for (let i = 0; i < count; i++) {
    let cells = `<td><div class="skeleton-cell-flex"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line" style="width:${50 + (i * 7) % 40}%"></div></div></td>`;
    for (let c = 1; c < cols; c++) {
      cells += `<td><div class="skeleton skeleton-line" style="width:${45 + (i * 11 + c * 13) % 45}%;margin-left:auto"></div></td>`;
    }
    html += `<tr class="skeleton-row">${cells}</tr>`;
  }
  return html;
}
function skeletonAlbumRows(count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div class="album-row glass skeleton-album">
      <div class="skeleton skeleton-thumb"></div>
      <div class="skel-lines">
        <div class="skeleton skeleton-line" style="width:${55 + (i * 9) % 35}%"></div>
        <div class="skeleton skeleton-line" style="width:${30 + (i * 7) % 25}%;height:9px"></div>
      </div>
    </div>`;
  }
  return html;
}
function emptyState(title, sub, accentColor) {
  const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
  const titleStyle = accentColor ? ` style="color:${accentColor}"` : '';
  return `<div class="empty-state">${icon}<div class="empty-title"${titleStyle}>${title}</div>${sub ? `<div class="empty-sub">${sub}</div>` : ''}</div>`;
}

// Fetch Songs and Stats
async function fetchData() {
  // Capture the artist this load is for. Every await below is a window for the
  // user to switch artists; a stale response landing late would overwrite the
  // new artist's data (Taylor's songs shown under Olivia's header) — so bail
  // whenever the selection changed mid-flight.
  const artist = currentArtist;
  try {
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;

    // Show skeleton rows in the songs table while loading.
    const songsTbodyEl = document.getElementById('songs-tbody');
    if (songsTbodyEl) songsTbodyEl.innerHTML = skeletonRows(8, 5);

    // Fetch stats
    const statsRes = await fetch(`/api/stats?artist=${artist}`, { headers });
    if (statsRes.status === 401) {
      window.location.href = '/login';
      return;
    }
    const statsData = await statsRes.json();
    if (artist !== currentArtist) return; // switched away while loading
    currentArtistRawStats = statsData;
    totalStreamsEl.textContent = formatNumber(statsData.total_streams);
    leadStreamsEl.textContent = formatNumber(statsData.lead_streams);
    featStreamsEl.textContent = formatNumber(statsData.feat_streams);
    soloStreamsEl.textContent = formatNumber(statsData.solo_streams);

    // Each slice as a share of the total. Lead + Featured = 100%; Solo is a
    // subset of Lead, so it isn't part of that split and can overlap it.
    setSharePct(leadStreamsPctEl, statsData.lead_streams, statsData.total_streams);
    setSharePct(featStreamsPctEl, statsData.feat_streams, statsData.total_streams);
    setSharePct(soloStreamsPctEl, statsData.solo_streams, statsData.total_streams);

    // Bind daily streams. Show the raw daily streams (daily gain).
    const dailyGain = Number(statsData.daily_gain);
    dailyStreamsEl.textContent = (dailyGain > 0 ? '+' : '') + formatNumber(dailyGain);

    // Lead / Featured split of the daily gain (mirrors the Total Streams breakdown).
    if (leadDailyStreamsEl) {
      const leadDaily = Number(statsData.lead_daily_gain);
      leadDailyStreamsEl.textContent = (leadDaily > 0 ? '+' : '') + formatNumber(leadDaily);
    }
    if (featDailyStreamsEl) {
      const featDaily = Number(statsData.feat_daily_gain);
      featDailyStreamsEl.textContent = (featDaily > 0 ? '+' : '') + formatNumber(featDaily);
    }
    setSharePct(leadDailyPctEl, statsData.lead_daily_gain, dailyGain);
    setSharePct(featDailyPctEl, statsData.feat_daily_gain, dailyGain);

    // The daily headline does not announce removals — a catalogue-wide
    // "−17,783,672 removed by Spotify" reads as if the artist lost that many
    // streams today, when it is really one song's history being trued up to
    // what Spotify now reports. Everywhere else the removal still shows, per
    // song, where it names the track it belongs to.
    //
    // Vaelis is the deliberate exception: a small catalogue where a removal is
    // a real event worth seeing at a glance, not noise buried under a number
    // in the billions.
    if (dailyRemovedEl) {
      const removed = SHOWS_DAILY_REMOVAL.has(currentArtist)
        ? (Number(statsData.removed_streams) || 0)
        : 0;
      if (removed < 0) {
        dailyRemovedEl.textContent = `${formatRemoved(removed)} removed by Spotify`;
        dailyRemovedEl.title = statsData.removed_on
          ? `Spotify took streams back from this catalogue (${formatDate(statsData.removed_on)})`
          : 'Spotify took streams back from this catalogue';
        dailyRemovedEl.classList.remove('hidden');
      } else {
        dailyRemovedEl.classList.add('hidden');
      }
    }
    
    totalSongsEl.textContent = statsData.total_songs ?? '0';
    lastUpdateEl.textContent = formatDate(statsData.last_update);

    // Fetch artist-level stats (monthly listeners)
    try {
      const artistStatsRes = await fetch(`/api/artist-stats?artist=${artist}`, { headers });
      if (artist !== currentArtist) return; // switched away while loading
      if (artistStatsRes.ok) {
        const artistStats = await artistStatsRes.json();
        currentArtistStats = artistStats;
        const ml = artistStats.latest?.monthly_listeners;
        monthlyListenersEl.textContent = (ml !== null && ml !== undefined) ? formatNumber(ml) : '-';
        setStatDelta(monthlyListenersChangeEl, artistStats.latest?.monthly_listeners_change);
        setListenersPeak(artistStats.peak, ml);
        const fol = artistStats.latest?.followers;
        if (followersEl) followersEl.textContent = (fol !== null && fol !== undefined) ? formatNumber(fol) : '-';
        setStatDelta(followersChangeEl, artistStats.latest?.followers_change);

        // Bind to Artist Profile Hero elements
        if (heroListeners) heroListeners.textContent = (ml !== null && ml !== undefined) ? formatNumber(ml) : '-';
        if (heroFollowers) heroFollowers.textContent = (fol !== null && fol !== undefined) ? formatNumber(fol) : '-';
        
        const rank = artistStats.latest?.world_rank;
        if (rank && Number(rank) > 0) {
          if (heroRank) heroRank.textContent = `#${formatNumber(rank)}`;
          if (heroRankContainer) heroRankContainer.style.display = '';
          if (heroRankSep) heroRankSep.style.display = '';
        } else {
          if (heroRankContainer) heroRankContainer.style.display = 'none';
          if (heroRankSep) heroRankSep.style.display = 'none';
        }
      } else {
        monthlyListenersEl.textContent = '-';
        setStatDelta(monthlyListenersChangeEl, null);
        setListenersPeak(null);
        if (followersEl) followersEl.textContent = '-';
        setStatDelta(followersChangeEl, null);

        // Reset Hero
        if (heroListeners) heroListeners.textContent = '-';
        if (heroFollowers) heroFollowers.textContent = '-';
        if (heroRankContainer) heroRankContainer.style.display = 'none';
        if (heroRankSep) heroRankSep.style.display = 'none';
      }
    } catch (e) {
      monthlyListenersEl.textContent = '-';
      setStatDelta(monthlyListenersChangeEl, null);
      setListenersPeak(null);
      if (followersEl) followersEl.textContent = '-';
      setStatDelta(followersChangeEl, null);

      // Reset Hero
      if (heroListeners) heroListeners.textContent = '-';
      if (heroFollowers) heroFollowers.textContent = '-';
      if (heroRankContainer) heroRankContainer.style.display = 'none';
      if (heroRankSep) heroRankSep.style.display = 'none';
    }

    // Fetch achieved milestones (separate collapsible section)
    fetchAchievedMilestones(headers);

    // Fetch songs
    const songsRes = await fetch(`/api/songs?artist=${artist}`, { headers });
    const songsData = await songsRes.json();
    if (artist !== currentArtist) return; // switched away while loading

    // Sort initially by cumulative streams desc and assign a global rank
    songsData.sort((a, b) => Number(b.cumulative) - Number(a.cumulative));
    allSongs = songsData.map((song, index) => ({
      ...song,
      rank: index + 1
    }));
    
    renderSongs();
    renderMilestones();
    // If the X post generator is open it was built before these arrived.
    if (window._refreshTwitterPreview) window._refreshTwitterPreview();
    // Same for the stats card, which is a pure snapshot of the loaded data.
    if (statsCardModal && !statsCardModal.classList.contains('hidden')) openStatsCard();
    fetchTrending(artist, headers);
  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color: var(--accent-red);">Failed to load dashboard data!</td></tr>`;
  }
}

// Trending Now — songs surging above their own baseline (see /api/trending).
// Fire-and-forget after the main load; hides its section when nothing qualifies.
async function fetchTrending(artist, headers) {
  const section = document.getElementById('trending-section');
  const strip = document.getElementById('trending-strip');
  if (!section || !strip) return;
  section.classList.add('hidden'); // clear any previous artist's strip while loading
  try {
    const res = await fetch(`/api/trending?artist=${artist}`, { headers });
    if (artist !== currentArtist) return; // switched away while loading
    if (!res.ok) return;
    const rows = await res.json();
    renderTrending(Array.isArray(rows) ? rows : []);
  } catch (_) { /* trending is non-critical — leave the section hidden */ }
}

function renderTrending(rows) {
  const section = document.getElementById('trending-section');
  const strip = document.getElementById('trending-strip');
  if (!section || !strip) return;
  if (!rows.length) { section.classList.add('hidden'); strip.innerHTML = ''; return; }
  const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2748%27 height=%2748%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%231db954%27 stroke-width=%271.5%27 style=%27background:%23181818%27><circle cx=%2712%27 cy=%2712%27 r=%2710%27/><circle cx=%2712%27 cy=%2712%27 r=%273%27/><path d=%27M12 9v6%27/></svg>`;
  strip.innerHTML = rows.map(t => {
    const cover = escHtml(t.album_cover_url || '') || fallbackSvg;
    const lift = Number(t.lift_pct) || 0;
    const recent = Number(t.recent_avg) || 0;
    return `
      <button class="trending-card" onclick="openSongById('${t.id}')" title="${escHtml(t.title)} — normally +${formatNumber(Number(t.base_avg) || 0)}/day">
        <div class="trending-cover">
          <img src="${cover}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallbackSvg}'">
          <span class="trending-badge">▲ ${lift}%</span>
        </div>
        <div class="trending-meta">
          <span class="trending-song">${escHtml(t.title)}</span>
          <span class="trending-gain">+${formatNumber(recent)}<span class="trending-per">/day</span></span>
        </div>
      </button>`;
  }).join('');
  section.classList.remove('hidden');
}

// Fetch Albums
async function fetchAlbumsData() {
  const artist = currentArtist; // same stale-response guard as fetchData
  try {
    albumsContainer.innerHTML = skeletonAlbumRows(6);

    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;

    const res = await fetch(`/api/albums?artist=${artist}`, { headers });
    const albums = await res.json();
    if (artist !== currentArtist) return; // switched away while loading
    allAlbums = albums;

    if (viewToggleBar) {
      // Album-only artists have no songs list, but they still get a Milestones
      // tab — so show the bar (Albums + Milestones) and just hide "Songs List".
      const albumOnly = ALBUM_ONLY_ARTISTS.has(currentArtist);
      if (songsToggleBtn) songsToggleBtn.style.display = albumOnly ? 'none' : '';
      viewToggleBar.style.display = allAlbums.length > 0 ? 'flex' : 'none';
    }
    
    renderAlbums();
    renderMilestones();
  } catch (err) {
    console.error('Error fetching albums:', err);
    albumsContainer.innerHTML = `<div class="table-empty" style="color: var(--accent-red);">Failed to load albums!</div>`;
  }
}

// Render Songs Table
function renderSongs() {
  // 1) Filter
  filteredSongs = allSongs.filter(song => {
    // Search filter
    const titleMatch = song.title.toLowerCase().includes(searchFilter.toLowerCase());
    const albumMatch = song.album_title && song.album_title.toLowerCase().includes(searchFilter.toLowerCase());
    const matchesSearch = titleMatch || albumMatch;

    // Type filter
    let matchesType = true;
    if (typeFilter === 'lead') {
      matchesType = !song.is_featured;
    } else if (typeFilter === 'solo') {
      matchesType = song.is_solo;
    } else if (typeFilter === 'featured') {
      matchesType = song.is_featured;
    }

    return matchesSearch && matchesType;
  });

  // 2) Sort
  const LISA_TRACK_ORDER = [
    'born again',
    'rockstar',
    'elastigirl',
    'thunder',
    'new woman',
    'futw(ft)',
    'rapunzel(ft)',
    'moonlit floor',
    'when im with you',
    'badgrrrl',
    'lifestyle',
    'chill',
    'dream',
    'futw(solo)',
    'rapunzel(solo)',
    'lalisa',
    'money',
    'sg',
    'shoong!',
    'priceless',
    'bad angel',
    'goals',
    'rockstar(v)',
    'moonlit floor(v)',
    'born again(v)'
  ];

  function getLisaOrderIndex(title) {
    const t = title.toLowerCase();
    
    // Exact mapping matches
    if (t.includes('born again') && (t.includes('remix') || t.includes('purple disco'))) return 26; // Born Again(v)
    if (t.includes('born again')) return 0;
    
    if (t.includes('rockstar') && (t.includes('remix') || t.includes('instrumental') || t.includes('edit') || t.includes('version'))) return 24; // Rockstar(v)
    if (t.includes('rockstar')) return 1;
    
    if (t.includes('elastigirl')) return 2;
    if (t.includes('thunder')) return 3;
    if (t.includes('new woman')) return 4;
    
    if (t.includes('fxck up the world') && t.includes('future')) return 5; // FUTW(ft)
    if (t.includes('fxck up the world')) return 15; // FUTW(solo)
    
    if (t.includes('rapunzel') && t.includes('megan')) return 6; // Rapunzel(ft)
    if (t.includes('rapunzel')) return 16; // Rapunzel(solo)
    
    if (t.includes('moonlit floor') && (t.includes('remix') || t.includes('santa'))) return 25; // Moonlit Floor(v)
    if (t.includes('moonlit floor')) return 7;
    
    if (t.includes('when i\'m with you') || t.includes('when im with you')) return 8;
    if (t.includes('badgrrrl')) return 9;
    if (t.includes('lifestyle')) return 10;
    if (t.includes('chill')) return 11;
    if (t.includes('dream')) return 12;
    
    if (t.includes('lalisa') && !t.includes('instrumental')) return 17;
    if (t.includes('money') && !t.includes('instrumental')) return 18;
    
    if (t.includes('sg')) return 19;
    if (t.includes('shoong')) return 20;
    if (t.includes('priceless')) return 21;
    if (t.includes('bad angel')) return 22;
    if (t.includes('goals')) return 23;
    
    return 99; // Default fallback for any other
  }

  filteredSongs.sort((a, b) => {
    let comparison = 0;
    if (currentSortField === 'rank') {
      comparison = a.rank - b.rank;
    } else if (currentSortField === 'title') {
      comparison = a.title.localeCompare(b.title);
    } else if (currentSortField === 'album') {
      const albumA = a.album_title || '';
      const albumB = b.album_title || '';
      comparison = albumA.localeCompare(albumB);
    } else if (currentSortField === 'duration') {
      comparison = (a.duration_ms || 0) - (b.duration_ms || 0);
    } else if (currentSortField === 'streams') {
      comparison = Number(a.cumulative) - Number(b.cumulative);
    } else if (currentSortField === 'gain') {
      comparison = Number(a.daily_gain) - Number(b.daily_gain);
    }

    return currentSortDirection === 'asc' ? comparison : -comparison;
  });

  // 3) Generate HTML
  if (filteredSongs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5">${emptyState('No songs found', 'No tracks match your search. Try a different title.')}</td></tr>`;
    if (songsShowAllBtn) songsShowAllBtn.hidden = true;
    return;
  }

  // Show only the top N rows unless the user expanded the full list. Search and
  // sort still run over the entire dataset above; this only trims the display.
  const visibleSongs = songsExpanded ? filteredSongs : filteredSongs.slice(0, SONGS_COLLAPSED_LIMIT);

  tbody.innerHTML = visibleSongs.map((song, idx) => {
    const isFeatured = song.is_featured;
    const isSolo = song.is_solo;
    const dailyGain = Number(song.daily_gain);

    let gainHtml = '<span class="gain-cell gain-neutral">-</span>';
    if (dailyGain > 0) {
      gainHtml = `<span class="gain-cell gain-positive">+${formatNumber(dailyGain)}</span>`;
    } else if (dailyGain < 0 && showsNegatives()) {
      gainHtml = `<span class="gain-cell" style="color: var(--accent-red);">${formatNumber(dailyGain)}</span>`;
    }

    // Raw last-day change. The daily_gain above comes from the running-max view
    // so it never goes negative; this surfaces a genuine playcount DROP (pulled
    // streams / bad snapshot) — shown ONLY when it's actually negative.
    const realChange = showsNegatives() ? Number(song.real_daily_change) : 0;
    if (realChange < 0) {
      gainHtml += `<span class="real-drop" title="Raw last-day change, without the running-max shield — this song's playcount went down">▼ ${formatNumber(Math.abs(realChange))}</span>`;
    }

    // A confirmed removal replaces the day's "+0" as the row's headline number:
    // on that day, losing 3.13M is the story, not gaining nothing.
    const removed = showsNegatives() ? (Number(song.removed_streams) || 0) : 0;
    if (removed < 0) {
      const when = song.removed_on ? formatDate(song.removed_on) : '';
      gainHtml = `<span class="gain-cell gain-removed" title="Spotify removed streams from this song${when ? ` (${when})` : ''}">${formatRemoved(removed)}</span>`;
    }

    let badgeClass = 'badge-lead';
    let badgeText = 'Lead';
    if (isFeatured) {
      badgeClass = 'badge-feat';
      badgeText = 'Featured';
    } else if (isSolo) {
      badgeClass = 'badge-solo';
      badgeText = 'Solo';
    }

    return `
      <tr class="${isFeatured ? 'featured-row' : ''}">
        <td><strong>${idx + 1}</strong></td>
        <td>
          <div class="song-title-cell">
            <span class="song-title song-link" onclick="openSongById('${song.id}')">${escHtml(song.title)}</span>
            <div class="badge-wrapper">
              <span class="badge ${badgeClass}">
                ${badgeText}
              </span>
            </div>
          </div>
        </td>
        <td>${formatDuration(song.duration_ms)}</td>
        <td><span class="streams-count">${formatNumber(song.cumulative)}</span></td>
        <td>${gainHtml}</td>
      </tr>
    `;
  }).join('');

  // 4) Show-all toggle: only when the filtered list exceeds the collapsed limit.
  if (songsShowAllBtn) {
    const hidden = filteredSongs.length <= SONGS_COLLAPSED_LIMIT;
    songsShowAllBtn.hidden = hidden;
    if (!hidden) {
      songsShowAllBtn.textContent = songsExpanded
        ? 'Show less'
        : `Show all ${filteredSongs.length} songs`;
    }
  }
}

// Album Cover Art URLs
const ALBUM_COVERS = {
  '0tcExuDWMQdBbwSpqN8Ku2': 'https://i.scdn.co/image/ab67616d0000b273c68f26a3d34fbd0faed2b473', // FutureSex/LoveSounds
  '6QPkyl04rXwTGlGlcYaRoW': 'https://i.scdn.co/image/ab67616d0000b273346a5742374ab4cf9ed32dee', // Justified
  '0O82niJ0NpcptYRxogeEZu': 'https://i.scdn.co/image/ab67616d0000b27356d5fb0cc9cec001d8ae0c8c', // The 20/20 Experience
  '5lYzReGzcSNF0Gx47wm6qU': 'https://i.scdn.co/image/ab67616d0000b273ef074183c3e34d4f80348e98', // The 20/20 Experience - 2 of 2
  '01l3jTY261V3CESZR4dABz': 'https://i.scdn.co/image/ab67616d0000b273d444296aa0ca8fada177e430', // Man of the Woods
  '716B2iWcwoKolCXrqwLGQh': 'https://i.scdn.co/image/ab67616d0000b2730c03eb908cc6baece50c2426'  // Everything I Thought It Was
};

// Album Theme Colors (accent, gradient start, gradient end, text glow)
const ALBUM_THEMES = {
  '0tcExuDWMQdBbwSpqN8Ku2': { accent: '#e74c3c', gradStart: '#2e1212', gradEnd: '#0d0d1a', glow: 'rgba(231, 76, 60, 0.3)' },   // FutureSex — red
  '6QPkyl04rXwTGlGlcYaRoW': { accent: '#3498db', gradStart: '#0f2133', gradEnd: '#0d0d1a', glow: 'rgba(52, 152, 219, 0.3)' },  // Justified — blue
  '0O82niJ0NpcptYRxogeEZu': { accent: '#f1c40f', gradStart: '#2e2810', gradEnd: '#0d0d1a', glow: 'rgba(241, 196, 15, 0.3)' },  // 20/20 — gold
  '5lYzReGzcSNF0Gx47wm6qU': { accent: '#d4a017', gradStart: '#2a2210', gradEnd: '#0d0d1a', glow: 'rgba(212, 160, 23, 0.3)' },  // 20/20 pt2 — dark gold
  '01l3jTY261V3CESZR4dABz': { accent: '#74b49b', gradStart: '#162920', gradEnd: '#0d0d1a', glow: 'rgba(116, 180, 155, 0.3)' },  // MOTW — forest green
  '716B2iWcwoKolCXrqwLGQh': { accent: '#e67e22', gradStart: '#2e1e0d', gradEnd: '#0d0d1a', glow: 'rgba(230, 126, 34, 0.3)' },  // EITW — orange
};
const DEFAULT_THEME = { accent: '#1db954', gradStart: '#162016', gradEnd: '#0d0d1a', glow: 'rgba(29, 185, 84, 0.3)' };

// Render Albums Grid
function renderAlbums() {
  if (!allAlbums || allAlbums.length === 0) {
    albumsContainer.innerHTML = emptyState('No albums yet', 'Albums will appear here once they\'re tracked.');
    return;
  }

  // 1) Filter based on search filter
  const filteredAlbums = allAlbums.filter(album => {
    const title = album.album_title || '';
    return title.toLowerCase().includes(albumSearchFilter.toLowerCase());
  });

  if (filteredAlbums.length === 0) {
    albumsContainer.innerHTML = emptyState('No matching albums', `Nothing matches “${albumSearchFilter}”. Try a different search.`);
    return;
  }

  // 2) Sort based on albumSortField
  filteredAlbums.sort((a, b) => {
    switch (albumSortField) {
      case 'streams-desc':
        return Number(b.total_streams || 0) - Number(a.total_streams || 0);
      case 'streams-asc':
        return Number(a.total_streams || 0) - Number(b.total_streams || 0);
      case 'daily-desc':
        return Number(b.daily_gain || 0) - Number(a.daily_gain || 0);
      case 'daily-asc':
        return Number(a.daily_gain || 0) - Number(b.daily_gain || 0);
      case 'date-desc': {
        const dateA = a.release_date ? new Date(a.release_date) : new Date(0);
        const dateB = b.release_date ? new Date(b.release_date) : new Date(0);
        return dateB - dateA;
      }
      case 'date-asc': {
        const dateA = a.release_date ? new Date(a.release_date) : new Date(0);
        const dateB = b.release_date ? new Date(b.release_date) : new Date(0);
        return dateA - dateB;
      }
      case 'title-asc':
        return (a.album_title || '').localeCompare(b.album_title || '', undefined, { sensitivity: 'base' });
      case 'title-desc':
        return (b.album_title || '').localeCompare(a.album_title || '', undefined, { sensitivity: 'base' });
      default:
        return Number(b.total_streams || 0) - Number(a.total_streams || 0);
    }
  });

  albumsContainer.innerHTML = filteredAlbums.map(album => {
    const totalStreams = Number(album.total_streams);
    const dailyGain = Number(album.daily_gain);
    const dateFormatted = album.release_date || '';
    const coverUrl = album.image_url || ALBUM_COVERS[album.album_id] || '';
    // Quotes are %-encoded so the data URI survives both the src attribute and
    // the single-quoted JS string inside onerror (raw ' broke the fallback).
    const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2756%27 height=%2756%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%231db954%27 stroke-width=%271.5%27 style=%27background:%23181818%27><circle cx=%2712%27 cy=%2712%27 r=%2710%27/><circle cx=%2712%27 cy=%2712%27 r=%273%27/><path d=%27M12 9v6%27/></svg>`;
    const gainClass = dailyGain > 0 ? 'gain-positive' : (dailyGain < 0 ? 'gain-negative' : 'gain-neutral');
    const clickHandler = `openAlbumById('${album.album_id}', '${escJs(album.album_title)}', '${dateFormatted}', '${escJs(coverUrl)}')`;

    return `
      <div class="album-row glass" onclick="${escHtml(clickHandler)}">
        <div class="album-row-cover">
          <img src="${escHtml(coverUrl) || fallbackSvg}" alt="${escHtml(album.album_title)}" class="album-row-cover-img" onerror="this.onerror=null;this.src='${fallbackSvg}'">
        </div>
        <div class="album-row-info">
          <h3 class="album-row-title">${escHtml(album.album_title)}</h3>
          <span class="album-row-sub">${formatDate(album.release_date)} · ${album.track_count} songs</span>
        </div>
        <div class="album-row-stats">
          <div class="album-row-stat">
            <span class="label">Streams</span>
            <span class="value">${formatNumber(totalStreams)}</span>
          </div>
          <div class="album-row-stat">
            <span class="label">Daily</span>
            <span class="value ${gainClass}">${dailyGain > 0 ? '+' : ''}${formatNumber(dailyGain)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Open Album Detail Modal Sheet
window.openAlbumById = async function(albumId, title = null, releaseDate = null, coverUrl = null) {
  const modalTitle = document.getElementById('modal-album-title');
  const modalSubtitle = document.getElementById('modal-album-subtitle');
  const modalStreams = document.getElementById('modal-album-streams');
  const modalGain = document.getElementById('modal-album-gain');
  const modalTracks = document.getElementById('modal-album-tracks');
  const modalTbody = document.getElementById('modal-songs-tbody');
  const modalCover = document.getElementById('modal-album-cover');
  const modalCard = document.querySelector('.modal-card');
  
  // Apply selected artist theme instead of album theme
  const artistTheme = ARTIST_THEMES[currentArtist] || ARTIST_THEMES['31TPClRtHm23RisEBtV3X7'];
  modalCard.style.setProperty('--album-accent', artistTheme.accent);
  modalCard.style.setProperty('--album-accent-rgb', hexToRgbTriplet(artistTheme.accent));
  modalCard.style.setProperty('--album-glow', artistTheme.accentGlow);
  modalCard.style.background = artistTheme.bgGradient;
  modalCard.style.borderColor = artistTheme.accent + '30';
  modalCard.style.boxShadow = `0 25px 60px rgba(0,0,0,0.7), 0 0 80px ${artistTheme.accentGlow}`;

  // Remember which album is open (used by the Daily Card generator)
  currentAlbumMeta = { albumId, title, releaseDate, coverUrl };

  // Show modal layout
  albumModal.classList.remove('hidden');
  modalCard.scrollTop = 0; // Reset scroll position to top
  modalTbody.innerHTML = skeletonRows(5, 6);
  
  if (title) {
    modalTitle.textContent = title;
    modalTitle.style.color = artistTheme.accent;
    modalSubtitle.textContent = releaseDate ? `Released on ${formatDate(releaseDate)}` : '';
  }

  // Set cover art
  const modalCoverUrl = coverUrl || ALBUM_COVERS[albumId] || '';
  if (modalCoverUrl) {
    modalCover.crossOrigin = 'anonymous';
    modalCover.src = modalCoverUrl;
    modalCover.classList.remove('hidden');
    modalCover.style.boxShadow = `0 8px 32px ${artistTheme.accentGlow}`;
  } else {
    modalCover.removeAttribute('crossorigin');
    modalCover.src = 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%231db954\' stroke-width=\'1.5\' style=\'background:%23121212\'><circle cx=\'12\' cy=\'12\' r=\'10\'/><circle cx=\'12\' cy=\'12\' r=\'3\'/><path d=\'M12 9v6\'/></svg>';
    modalCover.classList.remove('hidden');
    modalCover.style.boxShadow = `0 8px 32px ${artistTheme.accentGlow}`;
  }

  // Auto-theme the modal AND the save-card from the album cover's DOMINANT colour.
  // The cover loads with crossOrigin='anonymous', so we sample it on a canvas. We
  // bucket pixels by coarse colour and take the most COMMON one (not the single
  // most vibrant pixel — that picked a stray warm tone off Justified's blue cover),
  // then punch a muted dominant up into a usable accent. CORS-tainted / colourless
  // covers silently keep the artist theme.
  if (modalCoverUrl) {
    const themeFromCover = () => {
      try {
        const n = 56, cv = document.createElement('canvas');
        cv.width = n; cv.height = n;
        const cx = cv.getContext('2d');
        cx.drawImage(modalCover, 0, 0, n, n);
        const d = cx.getImageData(0, 0, n, n).data;
        const buckets = new Map(); // coarse colour -> { c, r, g, b }
        let totalPixels = 0;
        let coloredPixels = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (d[i + 3] < 128) continue;
          totalPixels++;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          // Skip shadows/near-black, blown highlights, and greys with no real hue.
          // They punch up into muddy noise — a dark grey jacket on Justified's blue
          // cover became dusty rose. Keep only pixels that carry an actual colour.
          if (mx < 55 || mn > 230 || (mx ? (mx - mn) / mx : 0) < 0.10) continue;
          // Skip skin tones (YCbCr range) so a dark/monochrome cover dominated by a
          // face (FutureSex/LoveSounds) doesn't theme flesh-coloured — fall back to
          // the artist accent instead. Doesn't touch blues/greens/cool covers.
          const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
          if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) continue;
          coloredPixels++;
          const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
          const e = buckets.get(key) || { c: 0, r: 0, g: 0, b: 0 };
          e.c++; e.r += r; e.g += g; e.b += b; buckets.set(key, e);
        }
        const coloredRatio = totalPixels > 0 ? (coloredPixels / totalPixels) : 0;
        console.log('Album theme extraction stats:', { albumId, title, totalPixels, coloredPixels, coloredRatio });
        let th;
        if (coloredRatio < 0.05 || coloredPixels === 0) {
          th = deriveThemeFromAccent('#ffffff');
        } else {
          // Most COMMON of the genuinely-coloured pixels = the cover's real hue.
          let best = null, bestC = -1;
          for (const e of buckets.values()) {
            if (e.c > bestC) { bestC = e.c; best = [e.r / e.c, e.g / e.c, e.b / e.c]; }
          }
          if (!best) {
            th = deriveThemeFromAccent('#ffffff');
          } else {
            // Punch a muted dominant up: amplify saturation around the grey axis and
            // lift brightness, keeping the hue, so e.g. a grey-blue sky reads as blue.
            const avg = (best[0] + best[1] + best[2]) / 3, f = 1.35;
            let r = avg + (best[0] - avg) * f, g = avg + (best[1] - avg) * f, b = avg + (best[2] - avg) * f;
            const mx = Math.max(r, g, b);
            if (mx > 0 && mx < 188) { const s = 188 / mx; r *= s; g *= s; b *= s; }
            const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
            const hx = (c) => cl(c).toString(16).padStart(2, '0');
            th = deriveThemeFromAccent(`#${hx(r)}${hx(g)}${hx(b)}`);
          }
        }
        modalCard.style.setProperty('--album-accent', th.accent);
        modalCard.style.setProperty('--album-accent-rgb', hexToRgbTriplet(th.accent));
        modalCard.style.setProperty('--album-glow', th.accentGlow);
        modalCard.style.background = th.bgGradient;
        modalCard.style.borderColor = th.accent + '30';
        modalCard.style.boxShadow = `0 25px 60px rgba(0,0,0,0.7), 0 0 80px ${th.accentGlow}`;
        modalTitle.style.color = th.accent;
        modalCover.style.boxShadow = `0 8px 32px ${th.accentGlow}`;
        modalStreams.style.color = th.accent; // big TOTAL number follows the cover too
      } catch (_) { /* CORS-tainted / no pixels → keep the artist theme */ }
    };
    if (modalCover.complete && modalCover.naturalWidth) themeFromCover();
    else modalCover.addEventListener('load', themeFromCover, { once: true });
  }

  try {
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;
    const res = await fetch(`/api/albums/${albumId}/songs`, { headers });
    const songs = await res.json();
    
    // Add these songs to allSongs if they aren't already there (helps with opening song details modal)
    songs.forEach(s => {
      if (!allSongs.some(existing => existing.id === s.id)) {
        allSongs.push({
          id: s.id,
          title: s.title,
          duration_ms: s.duration_ms,
          cumulative: s.cumulative,
          daily_gain: s.daily_gain,
          album_id: albumId,
          album_title: title || 'Album',
          is_featured: s.is_featured,
          is_solo: s.is_solo || false
        });
      }
    });

    // Fetch Album History for Chart
    const albumChartSection = document.getElementById('album-chart-section');
    if (albumChartSection) albumChartSection.classList.add('hidden');
    
    if (activeAlbumChart) {
      activeAlbumChart.destroy();
      activeAlbumChart = null;
    }

    activeAlbumId = albumId;
    activeAlbumHistory = [];
    showDetailedAnalysis = false;

    // Reset toggle button
    const toggleBtn = document.getElementById('toggle-detailed-analysis-btn');
    if (toggleBtn) {
      toggleBtn.classList.remove('active');
      const chevron = toggleBtn.querySelector('.chevron-icon');
      if (chevron) chevron.style.transform = 'rotate(0deg)';
      const textSpan = toggleBtn.querySelector('span');
      if (textSpan) textSpan.textContent = 'Detailed Analysis';
    }

    loadingAlbumHistory = true;
    try {
      const historyRes = await fetch(`/api/albums/${albumId}/history`, { headers });
      activeAlbumHistory = await historyRes.json();
      loadingAlbumHistory = false;
      
      // Reset range selector tab
      albumChartRange = '30';
      const albumRangeBtns = document.querySelectorAll('#album-modal .album-range-toggle-btn');
      albumRangeBtns.forEach(btn => {
        if (btn.dataset.range === '30') btn.classList.add('active');
        else btn.classList.remove('active');
      });

      renderAlbumChart();
    } catch (chartErr) {
      loadingAlbumHistory = false;
      console.error('Error rendering album history chart:', chartErr);
      renderAlbumChart();
    }
    
    if (songs.length > 0) {
      if (!title) {
        const sampleSong = allSongs.find(s => s.album_id === albumId);
        modalTitle.textContent = sampleSong ? sampleSong.album_title : 'Album Tracks';
        modalTitle.style.color = artistTheme.accent;
        modalSubtitle.textContent = sampleSong && sampleSong.release_date ? `Released on ${formatDate(sampleSong.release_date)}` : '';
      }
      
      // Calculate totals
      let totalStreams = 0;
      let totalGain = 0;
      songs.forEach(s => {
        totalStreams += Number(s.cumulative || 0);
        totalGain += Number(s.daily_gain || 0);
      });
      
      modalStreams.textContent = formatNumber(totalStreams);
      // Use the active accent — the cover theme (if it loaded) put the album's own
      // colour on --album-accent; otherwise this is the artist accent.
      modalStreams.style.color = modalCard.style.getPropertyValue('--album-accent').trim() || artistTheme.accent;
      modalGain.textContent = (totalGain > 0 ? '+' : '') + formatNumber(totalGain);
      modalTracks.textContent = songs.length;


      // Populate Table with trend column
      modalTbody.innerHTML = songs.map((s, idx) => {
        const dailyGain = Number(s.daily_gain);
        const prevGain = Number(s.prev_daily_gain);

        // Daily gain display
        let gainHtml = '<span class="gain-cell gain-neutral">-</span>';
        if (dailyGain > 0) {
          gainHtml = `<span class="gain-cell gain-positive">+${formatNumber(dailyGain)}</span>`;
        } else if (dailyGain < 0) {
          gainHtml = `<span class="gain-cell" style="color: var(--accent-red);">${formatNumber(dailyGain)}</span>`;
        }

        // Percentage change vs previous day
        let trendHtml = '<span class="trend-cell trend-neutral">—</span>';
        if (prevGain && prevGain !== 0 && dailyGain !== 0) {
          const pctChange = ((dailyGain - prevGain) / Math.abs(prevGain)) * 100;
          const pctStr = Math.abs(pctChange).toFixed(1);
          if (pctChange > 0.5) {
            trendHtml = `<span class="trend-cell trend-up">▲ ${pctStr}%</span>`;
          } else if (pctChange < -0.5) {
            trendHtml = `<span class="trend-cell trend-down">▼ ${pctStr}%</span>`;
          } else {
            trendHtml = `<span class="trend-cell trend-flat">● ${pctStr}%</span>`;
          }
        }

        return `
          <tr>
            <td><strong>${idx + 1}</strong></td>
            <td><span class="song-title song-link" onclick="openSongById('${s.id}')">${escHtml(s.title)}</span></td>
            <td class="col-duration">${formatDuration(s.duration_ms)}</td>
            <td><span class="streams-count">${formatNumber(s.cumulative)}</span></td>
            <td>${gainHtml}</td>
            <td>${trendHtml}</td>
          </tr>
        `;
      }).join('');
    } else {
      modalTbody.innerHTML = `<tr><td colspan="6">${emptyState('No tracked songs', 'This album has no tracked songs yet.')}</td></tr>`;
    }
  } catch (err) {
    console.error('Error loading album details:', err);
    modalTbody.innerHTML = `<tr><td colspan="6" class="table-empty" style="color: var(--accent-red);">Failed to load album tracks!</td></tr>`;
  }
};

function renderAlbumChart() {
  const albumChartSection = document.getElementById('album-chart-section');
  const albumChartContainer = document.getElementById('album-chart');
  const chartToggleBar = albumChartSection ? albumChartSection.querySelector('.chart-toggle-bar') : null;
  if (!albumChartContainer) return;

  if (activeAlbumChart) {
    activeAlbumChart.destroy();
    activeAlbumChart = null;
  }

  if (showDetailedAnalysis && albumChartSection) {
    albumChartSection.classList.remove('hidden');

    if (loadingAlbumHistory) {
      if (chartToggleBar) chartToggleBar.style.display = 'none';
      albumChartContainer.innerHTML = `
        <div class="chart-loading" style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 200px; color: var(--text-secondary); gap: 12px;">
          <div class="spinner" style="width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--album-accent, var(--accent-green)); border-radius: 50%; animation: spinner 1s linear infinite;"></div>
          <span>Loading streaming history...</span>
        </div>
      `;
      return;
    }

    if (!activeAlbumHistory || activeAlbumHistory.length === 0) {
      if (chartToggleBar) chartToggleBar.style.display = 'none';
      albumChartContainer.innerHTML = `
        <div class="chart-empty" style="display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--text-secondary);">
          No streaming history available for this album.
        </div>
      `;
      return;
    }

    // Show the toggle bar since we have data
    if (chartToggleBar) chartToggleBar.style.display = 'flex';
    albumChartContainer.innerHTML = ''; // Clear container
    
    // Filter history by range
    const filteredHistory = filterHistoryByRange(activeAlbumHistory, albumChartRange);

    const dates = filteredHistory.map(row => formatChartDate(row.recorded_date));
    const dataPoints = filteredHistory.map(row => Number(row.cumulative));
    
    const artistTheme = ARTIST_THEMES[currentArtist] || ARTIST_THEMES['31TPClRtHm23RisEBtV3X7'];

    const options = {
      series: [{
        name: 'Total Streams',
        data: dataPoints
      }],
      chart: {
        type: 'area',
        height: 200,
        background: 'transparent',
        foreColor: '#94a3b8',
        toolbar: { show: false }
      },
      colors: [artistTheme.accent],
      fill: {
        type: 'gradient',
        gradient: {
          shadeIntensity: 1,
          opacityFrom: 0.4,
          opacityTo: 0.02,
          stops: [0, 100]
        }
      },
      dataLabels: { enabled: false },
      stroke: {
        curve: 'smooth',
        width: 3
      },
      xaxis: {
        categories: dates,
        // Category axes print EVERY label by default; with a backfilled artist
        // that is 700+ dates crushed into 400px. Cap the count instead.
        tickAmount: Math.min(8, Math.max(2, dates.length - 1)),
        labels: { rotate: -45, rotateAlways: false, hideOverlappingLabels: true, trim: false },
        axisBorder: { show: false },
        axisTicks: { show: false },
        tooltip: { enabled: false }
      },
      yaxis: {
        labels: {
          formatter: function (val) {
            if (val >= 1000000000) return (val / 1000000000).toFixed(1) + 'B';
            if (val >= 1000000) return (val / 1000000).toFixed(0) + 'M';
            return val.toLocaleString();
          }
        }
      },
      grid: {
        borderColor: 'rgba(255,255,255,0.04)',
        strokeDashArray: 4
      },
      tooltip: {
        theme: 'dark',
        x: { show: true },
        y: {
          formatter: function (val) {
            return val.toLocaleString();
          }
        }
      }
    };
    
    // Slight delay to ensure DOM has updated display none -> block before ApexCharts computes dimensions
    setTimeout(() => {
      if (!showDetailedAnalysis) return; // Guard against rapid toggling
      if (activeAlbumChart) {
        activeAlbumChart.destroy();
      }
      activeAlbumChart = new ApexCharts(albumChartContainer, options);
      activeAlbumChart.render();
    }, 50);
  } else if (albumChartSection) {
    albumChartSection.classList.add('hidden');
  }
}

// Bind Album Range Selector Elements
const albumRangeBtns = document.querySelectorAll('#album-modal .album-range-toggle-btn');
albumRangeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    albumRangeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    albumChartRange = btn.dataset.range;
    renderAlbumChart();
  });
});

// Bind Toggle Detailed Analysis Button
const toggleDetailedAnalysisBtn = document.getElementById('toggle-detailed-analysis-btn');
if (toggleDetailedAnalysisBtn) {
  toggleDetailedAnalysisBtn.addEventListener('click', () => {
    showDetailedAnalysis = !showDetailedAnalysis;
    
    // Toggle active class for custom styles
    if (showDetailedAnalysis) {
      toggleDetailedAnalysisBtn.classList.add('active');
    } else {
      toggleDetailedAnalysisBtn.classList.remove('active');
    }

    const chevron = toggleDetailedAnalysisBtn.querySelector('.chevron-icon');
    if (chevron) {
      chevron.style.transform = showDetailedAnalysis ? 'rotate(180deg)' : 'rotate(0deg)';
    }

    const textSpan = toggleDetailedAnalysisBtn.querySelector('span');
    if (textSpan) {
      textSpan.textContent = showDetailedAnalysis ? 'Hide Analysis' : 'Detailed Analysis';
    }

    renderAlbumChart();

    if (showDetailedAnalysis) {
      const modalBody = document.querySelector('#album-modal .modal-card');
      if (modalBody) {
        setTimeout(() => {
          modalBody.scrollTo({ top: modalBody.scrollHeight, behavior: 'smooth' });
        }, 100);
      }
    }
  });
}

// Close Modal
function closeModal() {
  albumModal.classList.add('hidden');
  if (activeAlbumChart) {
    activeAlbumChart.destroy();
    activeAlbumChart = null;
  }
  // Reset theme styles
  const modalCard = document.querySelector('.modal-card');
  if (modalCard) {
    modalCard.style.background = '';
    modalCard.style.borderColor = '';
    modalCard.style.boxShadow = '';
  }
}

modalCloseBtn.addEventListener('click', closeModal);
albumModal.addEventListener('click', (e) => {
  if (e.target === albumModal) closeModal();
});

// ---- Centralised modal UX: Escape to close + body scroll-lock ----
// Lock background scrolling whenever any modal backdrop is visible, and close
// the topmost open modal on Escape. Watches the three modals' class changes so
// every open/close path is covered without touching each opener.
(function initModalUX() {
  const modals = ['album-modal', 'song-modal', 'feedback-modal']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!modals.length) return;

  const isOpen = (m) => m && !m.classList.contains('hidden');
  const syncScrollLock = () => {
    document.body.classList.toggle('modal-open', modals.some(isOpen));
  };

  const obs = new MutationObserver(syncScrollLock);
  modals.forEach((m) => obs.observe(m, { attributes: true, attributeFilter: ['class'] }));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Close only the first open modal; each modal owns its own cleanup.
    if (isOpen(albumModal)) return closeModal();
    if (isOpen(songModal)) return closeSongModal();
    // feedback modal handles its own Escape in initFeedbackForm()
  });
})();

// Download Modal as Image (Twitter Share Card)
// ===== Site notice =====
// Kısa süreli bir duyuru satırı. İki tasarım kararı var ve ikisi de kasıtlı:
//
//  1. KENDİ KENDİNE SONA ERİYOR. `until` gününden sonra hiç görünmüyor, yani
//     dönüşte birinin gidip kapatması gerekmiyor — unutulup aylarca "tatilde"
//     yazan bir site kalmıyor geriye.
//  2. SESSİZ. Sabit değil (sayfayla kayıyor), rengi ikincil, yazısı küçük ve
//     kapatınca bir daha açılmıyor. Ziyaretçi rakamlara bakmaya geldi; bu satır
//     onun önüne geçmemeli.
//
// Kapatmak için metni boşaltmak yeterli.
const SITE_NOTICE = {
  text: '',   // bos = duyuru yok (tatil notu 2026-08-28'de kaldirildi)
  until: '2026-08-29',
  key: 'site-notice-vacation-2026-08',   // değişince kapatanlara tekrar gösterilir
};

(function initSiteNotice() {
  const el = document.getElementById('site-notice');
  const textEl = document.getElementById('site-notice-text');
  const closeBtn = document.getElementById('site-notice-close');
  if (!el || !textEl || !closeBtn) return;
  if (!SITE_NOTICE.text || !SITE_NOTICE.text.trim()) return;

  // Bitiş gününün SONUNA kadar göster (o gün de dahil).
  const bitis = new Date(`${SITE_NOTICE.until}T23:59:59Z`);
  if (Number.isFinite(bitis.getTime()) && Date.now() > bitis.getTime()) return;

  try { if (localStorage.getItem(SITE_NOTICE.key) === 'dismissed') return; } catch {}

  textEl.textContent = SITE_NOTICE.text;
  el.classList.remove('hidden');
  closeBtn.addEventListener('click', () => {
    el.classList.add('hidden');
    try { localStorage.setItem(SITE_NOTICE.key, 'dismissed'); } catch {}
  });
})();

// html2canvas clones the ENTIRE document before it rasterises anything, so every
// card export also copies the 268-row songs table sitting behind the modal —
// none of which is drawn. That clone is the cost, not the pixels: on JT's page
// rendering took the same ~2.8s at scale 1 as at scale 2, and the whole export
// ran about four seconds on a desktop (far worse on a phone).
//
// Skipping every subtree that neither contains nor lives inside the card halves
// it — 4.0s to 2.0s, measured on the stats card. Safe only because each call
// below already pins width/windowWidth: without those, dropping the rest of the
// page changes layout and the canvas comes out a different size.
function ignoreOutside(rootEl) {
  const head = document.head;
  return (el) => {
    try {
      // NEVER drop <head>: the clone gets its CSS from there, and a card
      // rendered without stylesheets is a blank rectangle, not a faster export.
      if (head && (el === head || head.contains(el))) return false;
      return !rootEl.contains(el) && !el.contains(rootEl);
    } catch { return false; }
  };
}

async function downloadModalAsImage() {
  const modalCard = document.querySelector('.modal-card');
  if (!modalCard) return;

  const closeBtn = document.getElementById('modal-close-btn');
  const downloadBtn = document.getElementById('modal-download-btn');
  const backdrop = document.getElementById('album-modal');
  
  // Hide UI buttons from card capture
  if (closeBtn) closeBtn.style.visibility = 'hidden';
  if (downloadBtn) downloadBtn.style.visibility = 'hidden';

  // Save original scroll/overflow styles so we can restore them later
  const origMaxHeight = modalCard.style.maxHeight;
  const origOverflow = modalCard.style.overflow;
  const origBackdropOverflow = backdrop ? backdrop.style.overflow : '';

  // Temporarily expand the modal to show ALL tracks (remove scroll constraints)
  modalCard.style.maxHeight = 'none';
  modalCard.style.overflow = 'visible';
  if (backdrop) backdrop.style.overflow = 'visible';

  const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);

  // Make sure the cover image is fully decoded before capture. If it is
  // broken or blocked by CORS, hide it so html2canvas does not choke on it.
  const coverImg = document.getElementById('modal-album-cover');
  let coverHiddenForCapture = false;
  if (coverImg && coverImg.src) {
    try {
      await coverImg.decode();
    } catch (e) {
      coverImg.style.visibility = 'hidden';
      coverHiddenForCapture = true;
    }
    if (!coverHiddenForCapture && !coverImg.naturalWidth) {
      coverImg.style.visibility = 'hidden';
      coverHiddenForCapture = true;
    }
  }

  try {
    // Web fonts still loading render as blank text in the capture.
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 3000))]);
    }

    const rowCount = modalCard.querySelectorAll('.modal-table tbody tr').length || 10;
    const virtualHeight = Math.max(2000, 600 + rowCount * 60);

    // Render as sharp as the device allows. iOS Safari caps canvases at roughly
    // 16.7M pixels — pick the largest scale (≤2) whose 800px-wide canvas fits,
    // instead of a blanket 1.0 that comes out blurry on 3x Retina phones.
    const estimatedHeight = 600 + rowCount * 60;
    const mobileScale = Math.max(1, Math.min(2, Math.sqrt(16000000 / (800 * estimatedHeight))));

    const canvas = await html2canvas(modalCard, {
      ignoreElements: ignoreOutside(modalCard.closest('.modal-backdrop') || modalCard),
      backgroundColor: '#080c14', // Match dashboard background color
      scale: isMobile ? mobileScale : 2,
      useCORS: true, // Allow external Spotify cover image domains
      imageTimeout: 15000, // Don't hang forever on a slow cover image
      logging: false,
      scrollX: 0,
      scrollY: 0,
      width: 800, // Force canvas width to match the card width (800px)
      windowWidth: 900, // Virtual window width for desktop viewport
      windowHeight: virtualHeight, // Virtual window height to fit all tracks without clipping
      onclone: (clonedDoc) => {
        // Change position of backdrop from fixed to absolute to avoid scroll offsets
        const clonedBackdrop = clonedDoc.getElementById('album-modal');
        if (clonedBackdrop) {
          clonedBackdrop.style.setProperty('position', 'absolute', 'important');
          clonedBackdrop.style.setProperty('top', '0', 'important');
          clonedBackdrop.style.setProperty('left', '0', 'important');
          clonedBackdrop.style.setProperty('width', '100%', 'important');
          clonedBackdrop.style.setProperty('height', '100%', 'important');
          clonedBackdrop.style.setProperty('backdrop-filter', 'none', 'important');
          clonedBackdrop.style.setProperty('webkit-backdrop-filter', 'none', 'important');
        }
        
        const clonedCard = clonedDoc.querySelector('.modal-card');
        if (clonedCard) {
          clonedCard.style.setProperty('position', 'relative', 'important');
          clonedCard.style.setProperty('max-height', 'none', 'important');
          clonedCard.style.setProperty('overflow', 'visible', 'important');
          clonedCard.style.setProperty('backdrop-filter', 'none', 'important');
          clonedCard.style.setProperty('webkit-backdrop-filter', 'none', 'important');
          clonedCard.style.setProperty('margin', '0 auto', 'important');
          clonedCard.style.setProperty('width', '800px', 'important');
          clonedCard.style.setProperty('max-width', '800px', 'important');
          clonedCard.style.setProperty('padding', '36px', 'important');
          // Drop the themed neon glow (0 0 80px accentGlow) — html2canvas renders it
          // as a smeared neon halo (especially on mobile). Keep only a clean drop shadow.
          clonedCard.style.setProperty('box-shadow', '0 25px 60px rgba(0, 0, 0, 0.6)', 'important');
          // Preserve the original background gradient of the album/artist theme in the capture
          const origBg = modalCard.style.background;
          if (origBg) {
            clonedCard.style.setProperty('background', origBg, 'important');
          } else {
            clonedCard.style.setProperty('background', '#070b11', 'important');
          }
        }

        // Drop the Duration column from the shared image — track lengths are
        // noise on a stream-count card and just steal width from the numbers
        // people actually share. It stays in the live modal.
        clonedDoc.querySelectorAll('.modal-table .col-duration').forEach(cell => cell.remove());

        // Force desktop-level sizes inside the cloned modal header for capture
        const clonedCover = clonedDoc.getElementById('modal-album-cover');
        if (clonedCover) {
          clonedCover.style.setProperty('width', '130px', 'important');
          clonedCover.style.setProperty('height', '130px', 'important');
          clonedCover.style.setProperty('border-radius', '10px', 'important');
          // Remove the cover's themed glow so it doesn't bleed a neon halo into the image.
          clonedCover.style.setProperty('box-shadow', 'none', 'important');
        }

        const clonedHeaderFlex = clonedDoc.querySelector('.modal-header-flex');
        if (clonedHeaderFlex) {
          clonedHeaderFlex.style.setProperty('flex-direction', 'row', 'important');
          clonedHeaderFlex.style.setProperty('align-items', 'center', 'important');
          clonedHeaderFlex.style.setProperty('text-align', 'left', 'important');
          clonedHeaderFlex.style.setProperty('gap', '28px', 'important');
          clonedHeaderFlex.style.setProperty('margin-bottom', '0', 'important');
        }

        const clonedTitle = clonedDoc.getElementById('modal-album-title');
        if (clonedTitle) {
          clonedTitle.style.setProperty('font-size', '1.8rem', 'important');
          clonedTitle.style.setProperty('white-space', 'normal', 'important');
          clonedTitle.style.setProperty('overflow', 'visible', 'important');
          clonedTitle.style.setProperty('text-overflow', 'clip', 'important');
        }

        const clonedSubtitle = clonedDoc.getElementById('modal-album-subtitle');
        if (clonedSubtitle) {
          clonedSubtitle.style.setProperty('font-size', '0.95rem', 'important');
          clonedSubtitle.style.setProperty('margin-bottom', '20px', 'important');
        }

        const clonedStats = clonedDoc.querySelector('.modal-stats');
        if (clonedStats) {
          clonedStats.style.setProperty('flex-direction', 'row', 'important');
          clonedStats.style.setProperty('gap', '32px', 'important');
          clonedStats.style.setProperty('padding', '16px 24px', 'important');
          clonedStats.style.setProperty('margin-top', '0', 'important');
        }

        const clonedStatBoxes = clonedDoc.querySelectorAll('.modal-stat-box');
        clonedStatBoxes.forEach(box => {
          const label = box.querySelector('.label');
          const value = box.querySelector('.value');
          if (label) label.style.setProperty('font-size', '0.75rem', 'important');
          if (value) value.style.setProperty('font-size', '1.4rem', 'important');
        });

        // Ensure all table columns (including hidden ones like Duration) are visible in capture
        const clonedTableHeaders = clonedDoc.querySelectorAll('.modal-table th');
        clonedTableHeaders.forEach(th => {
          th.style.setProperty('display', 'table-cell', 'important');
          th.style.setProperty('padding', '12px 14px', 'important');
          th.style.setProperty('font-size', '0.8rem', 'important');
        });

        const clonedTableCells = clonedDoc.querySelectorAll('.modal-table td');
        clonedTableCells.forEach(td => {
          td.style.setProperty('display', 'table-cell', 'important');
          td.style.setProperty('padding', '14px', 'important');
          td.style.setProperty('font-size', '0.9rem', 'important');
        });

        const clonedSongTitles = clonedDoc.querySelectorAll('.modal-table td .song-title');
        clonedSongTitles.forEach(el => el.style.setProperty('font-size', '0.9rem', 'important'));

        const clonedStreams = clonedDoc.querySelectorAll('.modal-table td .streams-count');
        clonedStreams.forEach(el => el.style.setProperty('font-size', '0.9rem', 'important'));

        const clonedGains = clonedDoc.querySelectorAll('.modal-table td .gain-cell');
        clonedGains.forEach(el => el.style.setProperty('font-size', '0.9rem', 'important'));

        // UI controls (Detailed Analysis / Daily Card) don't belong in the shared image
        const clonedToggles = clonedDoc.querySelector('.detailed-analysis-toggle-container');
        if (clonedToggles) clonedToggles.style.setProperty('display', 'none', 'important');

        // Frost the INNER glass panels (the stats box etc.) — but NOT the card
        // itself. The .modal-card also carries the `glass` class, so selecting all
        // `.glass` overwrote the flat near-black card background we set above with a
        // navy slate, washing the whole card out ("siyah kısım beyazlaşıyor"). Excluding
        // .modal-card keeps the card deep black (#070b11), so the panels and the pink
        // accents pop against it. Tint the panel borders with the artist accent so the
        // "pink lines" read clearly instead of a faint white hairline.
        let accentRgb = '29, 185, 84';
        try {
          const a = (clonedCard && clonedCard.style.getPropertyValue('--album-accent').trim()) || '';
          if (a) accentRgb = hexToRgbTriplet(a);
        } catch (_) {}
        const glassElements = clonedDoc.querySelectorAll('.glass:not(.modal-card)');
        glassElements.forEach(el => {
          el.style.backdropFilter = 'none';
          el.style.webkitBackdropFilter = 'none';
          el.style.setProperty('background', 'rgba(24, 32, 49, 0.97)', 'important');
          el.style.setProperty('border-color', `rgba(${accentRgb}, 0.45)`, 'important');
        });
      }
    });

    const albumTitle = document.getElementById('modal-album-title').textContent || 'album';
    const fileName = `${albumTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_streams.png`;

    // Prefer toBlob + object URL: a tall card as a base64 data URL is huge and
    // crashes iOS Safari. Fall back to toDataURL where toBlob is unavailable.
    let url = null;
    if (canvas.toBlob) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) url = URL.createObjectURL(blob);
    }
    if (!url) url = canvas.toDataURL('image/png');

    if (isMobile) {
      showMobileImageOverlay(url, albumTitle);
    } else {
      const link = document.createElement('a');
      link.download = fileName;
      link.href = url;
      link.click();
      // Free the object URL shortly after the download has been triggered.
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (err) {
    console.error('Failed to save image:', err);
    alert('Could not generate the image. Please try again.');
  } finally {
    // Restore the cover image visibility if we hid it for capture
    if (coverHiddenForCapture && coverImg) coverImg.style.visibility = '';

    // Restore original scroll/overflow styles
    modalCard.style.maxHeight = origMaxHeight;
    modalCard.style.overflow = origOverflow;
    if (backdrop) backdrop.style.overflow = origBackdropOverflow;

    // Show UI buttons again
    if (closeBtn) closeBtn.style.visibility = 'visible';
    if (downloadBtn) downloadBtn.style.visibility = 'visible';
  }
}

modalDownloadBtn.addEventListener('click', downloadModalAsImage);

// ===== Daily Share Card (Spotify-Numbers style, our theme) =====
const dailyCardModal = document.getElementById('daily-card-modal');
const dailyCardEl = document.getElementById('daily-card');
const openDailyCardBtn = document.getElementById('open-daily-card-btn');
const dailyCardCloseBtn = document.getElementById('daily-card-close-btn');
const dailyCardDownloadBtn = document.getElementById('daily-card-download-btn');

// ===== Share-card colour themes =====
// The card used to inherit whatever the artist theme was, which looks wrong for
// a lot of artists (pale accents, muddy gradients). The user picks the look now;
// "Artist" keeps the old behaviour and stays the default.
// `page` is the flat colour html2canvas paints behind the card — it must match
// the gradient's end colour or the rounded corners come out with a dark halo.
const CARD_THEMES = [
  { id: 'artist', name: 'Artist' },
  { id: 'midnight', name: 'Midnight', accent: '#1ed760', bg: 'radial-gradient(circle at 50% 0%, #131d33 0%, #080c14 100%)', page: '#080c14', glow: 'rgba(30,215,96,0.35)' },
  { id: 'noir', name: 'Noir', accent: '#f4f4f5', bg: 'linear-gradient(165deg, #1c1c1e 0%, #0a0a0b 100%)', page: '#0a0a0b', glow: 'rgba(255,255,255,0.18)' },
  { id: 'ocean', name: 'Ocean', accent: '#38bdf8', bg: 'radial-gradient(circle at 50% 0%, #0d2438 0%, #060d16 100%)', page: '#060d16', glow: 'rgba(56,189,248,0.35)' },
  { id: 'violet', name: 'Violet', accent: '#a78bfa', bg: 'radial-gradient(circle at 50% 0%, #1e1636 0%, #0a0713 100%)', page: '#0a0713', glow: 'rgba(167,139,250,0.35)' },
  { id: 'rose', name: 'Rose', accent: '#fb7185', bg: 'radial-gradient(circle at 50% 0%, #2e1220 0%, #120810 100%)', page: '#120810', glow: 'rgba(251,113,133,0.35)' },
  { id: 'sunset', name: 'Sunset', accent: '#fb923c', bg: 'linear-gradient(165deg, #341a12 0%, #140b09 100%)', page: '#140b09', glow: 'rgba(251,146,60,0.35)' },
  { id: 'gold', name: 'Gold', accent: '#e5b567', bg: 'linear-gradient(165deg, #241d10 0%, #0d0a06 100%)', page: '#0d0a06', glow: 'rgba(229,181,103,0.32)' },
  { id: 'paper', name: 'Paper', light: true, accent: '#1a8f4c', bg: 'linear-gradient(165deg, #ffffff 0%, #eef1f5 100%)', page: '#eef1f5', glow: 'rgba(0,0,0,0.12)' },
  { id: 'cream', name: 'Cream', light: true, accent: '#b4622a', bg: 'linear-gradient(165deg, #fbf6ec 0%, #f0e6d6 100%)', page: '#f0e6d6', glow: 'rgba(180,98,42,0.18)' },
];

const CARD_THEME_KEY = 'dc_card_theme';
let cardThemeId = 'artist';
try { cardThemeId = localStorage.getItem(CARD_THEME_KEY) || 'artist'; } catch (e) { /* private mode */ }
if (!CARD_THEMES.some((t) => t.id === cardThemeId)) cardThemeId = 'artist';

function resolveCardTheme(id) {
  if (id === 'artist' || !id) {
    const a = ARTIST_THEMES[currentArtist] || LANDING_THEME;
    return { id: 'artist', name: 'Artist', accent: a.accent, bg: a.bgGradient, page: '#080c14', glow: a.accentGlow };
  }
  return CARD_THEMES.find((t) => t.id === id) || resolveCardTheme('artist');
}

function applyCardTheme(el, theme) {
  if (!el) return;
  el.classList.toggle('dc-light', !!theme.light);
  el.style.setProperty('--dc-accent', theme.accent);
  el.style.setProperty('--dc-accent-rgb', hexToRgbTriplet(theme.accent));
  el.style.background = theme.bg;
  el.style.borderColor = theme.light ? 'rgba(0,0,0,0.10)' : theme.accent + '40';
  el.style.boxShadow = `0 25px 60px rgba(0,0,0,0.6), 0 0 70px ${theme.glow || theme.accent + '55'}`;
}

// Repaint whichever card is on screen and sync every picker's active state.
function refreshCardThemes() {
  const theme = resolveCardTheme(cardThemeId);
  applyCardTheme(dailyCardEl, theme);
  applyCardTheme(songCardEl, theme);
  document.querySelectorAll('.dc-theme-swatch').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === cardThemeId);
    if (b.dataset.theme === 'artist') {
      // The Artist swatch follows the artist you're currently viewing.
      const a = resolveCardTheme('artist');
      b.style.setProperty('--sw-accent', a.accent);
      b.style.setProperty('--sw-bg', '#111a2e');
    }
  });
}

function buildCardThemePickers() {
  document.querySelectorAll('[data-theme-picker]').forEach((container) => {
    if (container.dataset.built) return;
    container.dataset.built = '1';
    container.innerHTML = CARD_THEMES.map((t) => {
      const r = t.id === 'artist' ? resolveCardTheme('artist') : t;
      const swBg = t.light ? (t.page || '#f2f2f2') : '#111a2e';
      return `<button type="button" class="dc-theme-swatch" data-theme="${t.id}" title="${t.name}" aria-label="${t.name} theme"
                style="--sw-accent:${r.accent};--sw-bg:${swBg};"></button>`;
    }).join('');
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.dc-theme-swatch');
      if (!btn) return;
      cardThemeId = btn.dataset.theme;
      try { localStorage.setItem(CARD_THEME_KEY, cardThemeId); } catch (err) { /* private mode */ }
      refreshCardThemes();
    });
  });
  refreshCardThemes();
}
// NOTE: not called at load time on purpose — ARTIST_THEMES/LANDING_THEME are
// `const`s declared further down, so touching them here would hit the temporal
// dead zone. The pickers are built when a card is first opened.

// Parse a YYYY-MM-DD (or any date string) into a LOCAL Date — avoids the UTC
// midnight shift that makes the calendar day jump by one in some timezones.
function parseLocalDate(dateStr) {
  if (!dateStr) return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateStr);
}

function formatCardDate(dateStr) {
  // IMPORTANT: never fall back to "today" — the card must show the date the
  // stats are actually from, not the day it was downloaded.
  if (!dateStr) return '';
  // Parse a plain YYYY-MM-DD as a LOCAL calendar date so the displayed day
  // never shifts by a timezone offset (new Date("2026-06-04") is UTC midnight).
  let d;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (m) {
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    d = new Date(dateStr);
  }
  if (isNaN(d.getTime())) return '';
  const base = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  return `${base} • ${weekday}`; // "June 1, 2026 • MONDAY"
}

function dcChangeCell(change, base) {
  // change: today_daily - yesterday_daily ; base: yesterday_daily (for %)
  if (base === null || base === undefined || base === 0 || change === null) {
    return { txt: '—', pct: '—', cls: 'dc-muted' };
  }
  const pct = (change / Math.abs(base)) * 100;
  const cls = change > 0 ? 'dc-pos' : (change < 0 ? 'dc-neg' : 'dc-muted');
  const arrow = change > 0 ? '+' : '';
  return {
    txt: `${arrow}${formatNumber(change)}`,
    pct: `${pct > 0 ? '▲' : (pct < 0 ? '▼' : '●')} ${Math.abs(pct).toFixed(2)}%`,
    cls
  };
}

function cleanTrackTitle(title) {
  if (!title) return '';
  let clean = title
    // Strip parenthetical / bracketed artist credits ONLY:
    // (feat. X), (featuring X), (ft. X), (with X), [feat. X] ...
    // The credit keyword must be followed by whitespace so real words like
    // "With" inside a title (e.g. "Die With a Smile") are never touched.
    .replace(/\s*[\(\[](?:feat|featuring|ft|with)\.?\s[^)\]]*[\)\]]/gi, '')
    // Strip ONLY what does not change which recording this is.
    //
    // A radio edit is a different cut with its own playcount, and so are the
    // single/main versions — stripping those made two separate rows read the
    // same. On JT's card six pairs collapsed into one line each: Mirrors and
    // "Mirrors - Radio Edit" (1.6B and 135M) both showed as "Mirrors", and the
    // same for Señorita, Not a Bad Thing, TKO, LoveStoned and Falling Down.
    // A card that prints two different numbers under one name is worse than a
    // card with a longer name, so the version tag stays.
    //
    // Remastered stays stripped: it is the same performance, remastered, and
    // showing it would add noise without telling anyone anything new.
    // "Instrumental" was already kept for exactly this reason.
    .replace(/\s*-\s*(?:Remastered(?:\s+\d{4})?|\d{4}\s+Remaster)\b.*$/gi, '')
    // Bracketed: only album packaging goes. "(Live)" identifies a recording —
    // "Mirrors (Live)" is not "Mirrors" — so it stays too.
    .replace(/\s*[\(\[](?:Remastered|Deluxe(?:\s+Version)?)[\)\]]/gi, '')
    // Medley / prelude / interlude cleanups (JT tracklist)
    .replace(/Medley:\s*/gi, '')
    .replace(/\s*\((?:Prelude|Interlude)\)/gi, '');

  return clean.replace(/\s{2,}/g, ' ').trim();
}

function cleanAlbumTitle(title) {
  if (!title) return '';
  let clean = title
    .replace(/\s*\((?:Deluxe|Expanded|Special)(?:\s+(?:Edition|Version))?\)/gi, '')
    .replace(/\s*-\s*(?:Deluxe|Expanded|Special)(?:\s+(?:Edition|Version))?\b/gi, '');
  return clean.trim();
}

async function openDailyCard() {
  if (!currentAlbumMeta || !dailyCardEl) return;
  const { albumId, title, coverUrl } = currentAlbumMeta;

  dailyCardModal.classList.remove('hidden');
  buildCardThemePickers();   // idempotent; also applies the saved colour theme
  dailyCardEl.innerHTML = `<div class="dc-total" style="padding:30px 0;text-align:center;">Loading…</div>`;

  try {
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;
    const res = await fetch(`/api/albums/${albumId}/songs`, { headers });
    const songs = await res.json();
    if (!Array.isArray(songs) || songs.length === 0) {
      dailyCardEl.innerHTML = `<div class="dc-total" style="padding:30px 0;text-align:center;">No track data.</div>`;
      return;
    }

    // Apply compact / super-compact layout classes based on song count
    if (songs.length > 15) {
      dailyCardEl.classList.add('dc-super-compact');
      dailyCardEl.classList.remove('dc-compact');
    } else if (songs.length > 10) {
      dailyCardEl.classList.add('dc-compact');
      dailyCardEl.classList.remove('dc-super-compact');
    } else {
      dailyCardEl.classList.remove('dc-compact', 'dc-super-compact');
    }

    // Totals
    let totalDaily = 0, totalPrev = 0, totalCum = 0;
    let recordedDate = null;
    songs.forEach(s => {
      totalDaily += Number(s.daily_gain || 0);
      totalPrev += Number(s.prev_daily_gain || 0);
      totalCum += Number(s.cumulative || 0);
      if (s.recorded_date && (!recordedDate || s.recorded_date > recordedDate)) recordedDate = s.recorded_date;
    });
    // Fallback: if the song rows carry no recorded_date, use the latest date from
    // the already-loaded album history — never the day the card was downloaded.
    if (!recordedDate && Array.isArray(activeAlbumHistory) && activeAlbumHistory.length) {
      const lastHist = activeAlbumHistory[activeAlbumHistory.length - 1];
      if (lastHist && lastHist.recorded_date) recordedDate = lastHist.recorded_date;
    }
    const totalChange = totalDaily - totalPrev;
    const totalPctNum = totalPrev ? (totalChange / Math.abs(totalPrev)) * 100 : 0;
    const totalBadgeCls = totalChange > 0 ? 'up' : (totalChange < 0 ? 'down' : 'flat');
    const totalBadgeArrow = totalChange > 0 ? '▲' : (totalChange < 0 ? '▼' : '●');

    // Order rows so the main version comes first and the Instrumental sits last,
    // with other variants (Extended, Sped Up, Slowed Down, ...) in between.
    // Albums of distinct songs are unaffected (they're all "base", so the
    // original track_number order from the API is preserved by the stable sort).
    const dcOrderKey = (t) => {
      const lower = String(t || '').toLowerCase();
      if (lower.includes('instrumental')) return 2;                 // always last
      if (/[-(\[]\s*(extended|sped\s*up|slowed(\s*down)?|remix|radio\s*edit|edit|version|acoustic|live)/i.test(lower)) return 1; // variants
      return 0;                                                     // base / main version
    };
    const orderedSongs = songs
      .map((s, i) => ({ s, i }))
      .sort((a, b) => {
        const ka = dcOrderKey(a.s.title), kb = dcOrderKey(b.s.title);
        if (ka !== kb) return ka - kb;
        return a.i - b.i; // stable within a group → keep the API's track order
      })
      .map((x) => x.s);

    const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = orderedSongs.map((s, i) => {
      const daily = Number(s.daily_gain || 0);
      const prev = (s.prev_daily_gain === null || s.prev_daily_gain === undefined) ? null : Number(s.prev_daily_gain);
      const change = prev === null ? null : daily - prev;
      const c = dcChangeCell(change, prev);
      const star = s.is_featured ? '<span class="dc-star">✦</span>' : '';
      return `
        <tr>
          <td class="dc-rank">${i + 1}</td>
          <td class="dc-track" title="${esc(s.title)}">${star}${esc(cleanTrackTitle(s.title))}</td>
          <td>${formatNumber(daily)}</td>
          <td class="${c.cls}">${c.txt}<span class="dc-pct-inline">${c.pct}</span></td>
          <td class="${c.cls}">${c.pct}</td>
          <td class="dc-totalcol">${formatNumber(s.cumulative)}</td>
        </tr>`;
    }).join('');

    const totalCls = totalChange > 0 ? 'dc-pos' : (totalChange < 0 ? 'dc-neg' : 'dc-muted');
    dailyCardEl.innerHTML = `
      <div class="dc-header">
        ${coverUrl ? `<img class="dc-cover" src="${coverUrl}" crossorigin="anonymous" alt="">` : ''}
        <div class="dc-head-text">
          <div class="dc-album">${esc(cleanAlbumTitle(title)) || 'Album'}</div>
          <div class="dc-artist">${esc((currentArtistName || '').toUpperCase())}</div>
          <div class="dc-date">${formatCardDate(recordedDate)}</div>
        </div>
      </div>
      <div class="dc-divider"></div>
      <div class="dc-big-label">DAILY STREAMS</div>
      <div class="dc-big-row">
        <div class="dc-daily-num">+${formatNumber(totalDaily)}</div>
        <div class="dc-badge ${totalBadgeCls}">${totalBadgeArrow} ${Math.abs(totalPctNum).toFixed(2)}%</div>
      </div>
      <div class="dc-total">Total streams · <b>${formatNumber(totalCum)}</b></div>
      <table class="dc-table">
        <thead>
          <tr>
            <th class="dc-rank">#</th>
            <th class="dc-left">Track</th>
            <th>Daily</th>
            <th>Change</th>
            <th>%</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td class="dc-rank"></td>
            <td class="dc-left">TOTAL</td>
            <td>${formatNumber(totalDaily)}</td>
            <td class="${totalCls}">${totalChange > 0 ? '+' : ''}${formatNumber(totalChange)}<span class="dc-pct-inline">${totalBadgeArrow} ${Math.abs(totalPctNum).toFixed(2)}%</span></td>
            <td class="${totalCls}">${totalBadgeArrow} ${Math.abs(totalPctNum).toFixed(2)}%</td>
            <td class="dc-totalcol">${formatNumber(totalCum)}</td>
          </tr>
        </tfoot>
      </table>
      <div class="dc-footer"><span class="dc-dot"></span><b>${esc(currentArtistName || '')}</b> Spotify Streams — Fan Dashboard</div>
    `;
  } catch (e) {
    dailyCardEl.innerHTML = `<div class="dc-total" style="padding:30px 0;text-align:center;">Failed to load.</div>`;
  }
}

async function downloadDailyCard() {
  if (!dailyCardEl) return;
  const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
  const cover = dailyCardEl.querySelector('.dc-cover');
  if (cover && cover.src) {
    try { await cover.decode(); } catch (e) { cover.style.visibility = 'hidden'; }
    if (cover.style.visibility !== 'hidden' && !cover.naturalWidth) cover.style.visibility = 'hidden';
  }
  try {
    // Always render the PNG at the full desktop card width so the exported
    // image looks identical regardless of the (possibly narrow) mobile preview.
    const canvas = await html2canvas(dailyCardEl, {
      ignoreElements: ignoreOutside(dailyCardModal || dailyCardEl),
      // Match the chosen card theme's base colour, otherwise a light card gets
      // dark corners where the rounded border is anti-aliased.
      backgroundColor: resolveCardTheme(cardThemeId).page || '#080c14',
      // The daily card is small (600px wide) — full 2x fits well under the
      // iOS canvas area limit and keeps text sharp on Retina screens.
      scale: 2,
      useCORS: true,
      imageTimeout: 15000,
      logging: false,
      width: 600,
      windowWidth: 700,
      onclone: (clonedDoc) => {
        const card = clonedDoc.getElementById('daily-card');
        if (card) {
          card.style.setProperty('width', '600px', 'important');
          card.style.setProperty('max-width', '600px', 'important');
          if (card.classList.contains('dc-super-compact')) {
            card.style.setProperty('padding', '16px 18px', 'important');
          } else if (card.classList.contains('dc-compact')) {
            card.style.setProperty('padding', '20px 22px', 'important');
          } else {
            card.style.setProperty('padding', '26px 28px', 'important');
          }
        }
        // Force every table column visible at desktop size (the mobile preview
        // may hide the % column to fit the screen).
        clonedDoc.querySelectorAll('#daily-card .dc-table th, #daily-card .dc-table td')
          .forEach(c => c.style.setProperty('display', 'table-cell', 'important'));
        // ...and drop the stacked mobile-only % line, since the real % column
        // is back. Without this the export would show the value twice.
        clonedDoc.querySelectorAll('#daily-card .dc-pct-inline')
          .forEach(c => c.style.setProperty('display', 'none', 'important'));
      }
    });
    const name = (currentAlbumMeta?.title || 'album').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const fileName = `daily_${name}.png`;

    let url = null;
    if (canvas.toBlob) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) url = URL.createObjectURL(blob);
    }
    if (!url) url = canvas.toDataURL('image/png');

    if (isMobile) {
      // iOS Safari ignores programmatic downloads — show the long-press overlay.
      showMobileImageOverlay(url, currentAlbumMeta?.title || 'album');
    } else {
      const link = document.createElement('a');
      link.download = fileName;
      link.href = url;
      link.click();
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (e) {
    console.error('Daily card export failed:', e);
    alert('Could not generate the image. Please try again.');
  } finally {
    if (cover) cover.style.visibility = 'visible';
  }
}

if (openDailyCardBtn) openDailyCardBtn.addEventListener('click', openDailyCard);
if (dailyCardCloseBtn) dailyCardCloseBtn.addEventListener('click', () => dailyCardModal.classList.add('hidden'));
if (dailyCardDownloadBtn) dailyCardDownloadBtn.addEventListener('click', downloadDailyCard);
if (dailyCardModal) dailyCardModal.addEventListener('click', (e) => { if (e.target === dailyCardModal) dailyCardModal.classList.add('hidden'); });

// ===== LISA Daily Streams Card =====
// A LISA-only recreation of the era-grouped daily table her fans post: one row
// per "song" as that scene counts them (all Rockstar edits collapse into a
// single "Rockstar(versions)" line), black subtotal bands per era, grand total
// at the bottom. Every number still comes straight from our own snapshots.
const LISA_ARTIST_ID = '5L1lO4eRHmJ7a0Q6csE5cT';
const LISA_PHOTO = 'https://i.scdn.co/image/ab6761610000e5eb5cd3b3af8b72e32be78571ec';

// Display order + grouping. `key` is what lisaCardKey() maps a track title to;
// several tracks can share a key, in which case their numbers are summed.
const LISA_CARD_ROWS = [
  { key: 'born-again',       label: 'Born Again',              group: 'alterego' },
  { key: 'rockstar',         label: 'Rockstar',                group: 'alterego' },
  { key: 'elastigirl',       label: 'Elastigirl',              group: 'alterego' },
  { key: 'thunder',          label: 'Thunder',                 group: 'alterego' },
  { key: 'new-woman',        label: 'New Woman',               group: 'alterego' },
  { key: 'futw-ft',          label: 'FUTW(ft.)',               group: 'alterego' },
  { key: 'rapunzel-ft',      label: 'Rapunzel(ft.)',           group: 'alterego' },
  { key: 'moonlit',          label: 'Moonlit Floor',           group: 'alterego' },
  { key: 'when-im-with-you', label: 'When Im With You',        group: 'alterego' },
  { key: 'badgrrrl',         label: 'Badgrrrl',                group: 'alterego' },
  { key: 'lifestyle',        label: 'Lifestyle',               group: 'alterego' },
  { key: 'chill',            label: 'Chill',                   group: 'alterego' },
  { key: 'dream',            label: 'Dream',                   group: 'alterego' },
  { key: 'futw-solo',        label: 'FUTW(Solo ver.)',         group: 'alterego' },
  { key: 'rapunzel-solo',    label: 'Rapunzel(Solo ver.)',     group: 'alterego' },
  { key: 'lalisa',           label: 'Lalisa',                  group: 'lalisa' },
  { key: 'money',            label: 'Money',                   group: 'lalisa' },
  { key: 'sg',               label: 'SG',                      group: 'other' },
  { key: 'shoong',           label: 'Shoong!',                 group: 'other' },
  { key: 'priceless',        label: 'priceless',               group: 'other' },
  { key: 'bad-angel',        label: 'Bad Angel',               group: 'other' },
  { key: 'goals',            label: 'Goals',                   group: 'other' },
  { key: 'rockstar-v',       label: 'Rockstar(versions)',      group: 'other' },
  { key: 'moonlit-v',        label: 'Moonlit Floor(versions)', group: 'other' },
  { key: 'born-again-v',     label: 'Born Again(versions)',    group: 'other' },
];

// Titles as they read on a card: cleanTrackTitle drops the credits, this also
// drops soundtrack tags — CAN'T STOP THE FEELING! carries a 38-character
// "(from DreamWorks Animation's ...)" tail that ellipsises into noise.
function statsCardLabel(title) {
  return cleanTrackTitle(title)
    .replace(/\s*[\(\[]\s*from\s[^)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*from\s+["\u201c].*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Order matters: every variant test has to come before its parent title.
function lisaCardKey(title) {
  const t = String(title || '').toLowerCase();
  const isVariant = /remix|instrumental|sped\s*up|slowed|extended|radio\s*edit|live|acoustic|purple disco|santa/.test(t);

  if (t.includes('born again')) return isVariant ? 'born-again-v' : 'born-again';
  if (t.includes('rockstar')) return isVariant ? 'rockstar-v' : 'rockstar';
  if (t.includes('moonlit floor')) return isVariant ? 'moonlit-v' : 'moonlit';
  if (t.includes('elastigirl')) return 'elastigirl';
  if (t.includes('thunder')) return 'thunder';
  if (t.includes('new woman')) return 'new-woman';
  // The featured cut credits Future; the other one is her solo re-record.
  if (t.includes('fxck up the world')) return t.includes('future') ? 'futw-ft' : 'futw-solo';
  if (t.includes('rapunzel')) return t.includes('megan') ? 'rapunzel-ft' : 'rapunzel-solo';
  if (t.includes("when i'm with you") || t.includes('when im with you')) return 'when-im-with-you';
  if (t.includes('badgrrrl')) return 'badgrrrl';
  if (t.includes('lifestyle')) return 'lifestyle';
  if (t.includes('chill')) return 'chill';
  if (t.includes('dream')) return 'dream';
  if (t.includes('lalisa')) return 'lalisa';
  if (t.includes('money')) return 'money';
  if (/\bsg\b/.test(t)) return 'sg';
  if (t.includes('shoong')) return 'shoong';
  if (t.includes('priceless')) return 'priceless';
  if (t.includes('bad angel')) return 'bad-angel';
  if (t.includes('goals')) return 'goals';
  return null;
}

// Space-separated thousands, matching the layout these cards reproduce — with a
// NO-BREAK space (U+00A0). The thin space it used before is breakable, so a
// long total wrapped and left a lone digit on the next line; U+202F fixes the
// break but Outfit has no glyph for it and the groups collapse together.
const lcNum = (n) => Number(n || 0).toLocaleString('en-US').replace(/,/g, ' ');

function lcDelta(change, prev) {
  if (!prev) return { txt: '—', pct: '—', cls: 'lc-flat' };
  const pct = (change / Math.abs(prev)) * 100;
  const cls = change > 0 ? 'lc-pos' : (change < 0 ? 'lc-neg' : 'lc-flat');
  const sign = change > 0 ? '+' : (change < 0 ? '−' : '');
  return {
    txt: `${sign}${lcNum(Math.abs(change))}`,
    pct: `${pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1).replace('.', ',')}%`,
    cls,
  };
}

// ===== Catalogue card: albums + top tracks =====
// The default card for every artist (LISA has her own era-grouped one): all of
// their albums, then their biggest tracks, then the catalogue total. It paints
// itself from whatever accent that artist's dashboard theme uses.
const JT_ARTIST_ID = '31TPClRtHm23RisEBtV3X7';
const CARD_TOP_TRACKS = 30;
// Discographies vary wildly — JT has 6 albums, Stray Kids have dozens. Without a
// ceiling the card renders 3000px tall and stops being shareable. Everything up
// to this many albums is shown in full; past it the band says what was cut.
const CARD_MAX_ALBUMS = 20;

// The albums section is supposed to be the artist's records, but Spotify files
// singles, maxi-singles, remix packs and hits compilations as albums too — and
// they distort the list badly, because a compilation claims every song on it.
// Britney's "The Singles Collection" outranks every real album she made at
// 10.4B, and Billie's top ten is half one-track singles.
//
// There is no album_type column to lean on, so this is title + size based:
const CARD_NON_ALBUM_RE = /(\bremix(es|ed)?\b|greatest hits|\bsingles?\s+collection\b|\bbest of\b|\banthology\b|\bessential\b|\bcompilation\b|\bhits\b|\bb-sides?\b|\bkaraoke\b|\blive\s+(at|from|in)\b)/i;
const CARD_MIN_ALBUM_TRACKS = 5;    // fewer than this is a single or an EP-sized release
// A short release named after one of its own songs, where that song accounts for
// nearly all of it, is a single ("Lucky": 7 tracks, share 1.00). Deliberately
// capped at a low track count: share alone is NOT a discriminator, because a
// real album edition can also read 1.00 when its other tracks are deduped away
// (Britney's 11-track "Oops!... I Did It Again" does exactly that). Losing a
// real album is far worse than keeping a maxi-single, so this stays narrow.
const CARD_TITLE_TRACK_SHARE = 0.9;
const CARD_SINGLE_MAX_TRACKS = 8;

// The handful the rules above genuinely cannot reach: remix maxi-singles long
// enough to look like a short album, with nothing in the title to give them
// away. Nothing we store separates these from a real record — Spotify's own
// album_type would, and if that ever gets scraped this list should go.
const CARD_EXCLUDED_ALBUM_IDS = new Set([
  '1pciBzMaZtpYkvWAsmKt6S',   // Britney — "Stronger" (13 remix tracks)
  '5Du1IWrvNrIkyaYQjmhAe6',   // Britney — "Don't Let Me Be The Last To Know" (10)
]);

// Normalised form for matching an album title against the song titles.
const cardTitleKey = (t) => String(t || '')
  .toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function isCatalogueAlbum(album, songStreamsByTitle) {
  if (CARD_EXCLUDED_ALBUM_IDS.has(album.album_id)) return false;
  if (CARD_NON_ALBUM_RE.test(album.album_title || '')) return false;
  // track_count is how many canonical songs we track on it, which is what makes
  // a single look like a single here; 0 means unknown, so don't judge it.
  const n = Number(album.track_count || 0);
  if (n && n < CARD_MIN_ALBUM_TRACKS) return false;
  if (n && n <= CARD_SINGLE_MAX_TRACKS) {
    const titleTrack = songStreamsByTitle.get(cardTitleKey(album.album_title)) || 0;
    const total = Number(album.total_streams || 0);
    if (titleTrack && total && titleTrack / total >= CARD_TITLE_TRACK_SHARE) return false;
  }
  return true;
}

// Spotify carries the same record several times over (standard / deluxe / an
// anniversary reissue), and they arrive as separate albums with separate
// totals. Three "Oops!... I Did It Again" rows say nothing that one doesn't, so
// keep the biggest edition of each and drop the rest.
function dedupeAlbumEditions(rows) {
  const best = new Map();
  for (const a of rows) {
    const key = cardTitleKey(cleanAlbumTitle(a.label) || a.label);
    const prev = best.get(key);
    if (!prev || a.cum > prev.cum) best.set(key, a);
  }
  return rows.filter((a) => best.get(cardTitleKey(cleanAlbumTitle(a.label) || a.label)) === a);
}

// ===== Versions section =====
// After the top tracks, the card lists the songs that exist in more than one
// tracked form — remixes, sped-up edits, live cuts, solo re-records — with the
// combined line for each. They are separate songs (see the remix rule: a remix
// is its own record, not double counting), so this is a view, not a merge.
const CARD_MAX_VERSION_GROUPS = 10;
// A single song can carry a dozen club mixes ("4 Minutes" does), which buries
// the section. Only the biggest few are listed; the subtotal underneath still
// covers every version, which is what the ALL VERSIONS label promises.
const CARD_MAX_VERSION_ROWS = 6;

// The qualifier a version carries, either bracketed or after a dash. Nothing
// else in the title is touched, so two genuinely different songs never collide.
//
// "solo" and a bare "version" are deliberately NOT here. Her scene counts the
// solo re-records as songs in their own right — Rapunzel (Kiki Solo Version)
// and FXCK UP THE WORLD (Vixi Solo Version) are entries, not versions of the
// featured cuts — which is also how the signature card lists them.
const CARD_VERSION_TAG_RE = /(remix|\bmix\b|instrumental|sped\s*up|speed\s*up|slowed|extended|radio\s*(edit|version)|\bedit\b|\blive\b|acoustic|remaster|reprise|demo|a\s?cappella|piano|orchestral)/i;

// The label for a version row. statsCardLabel is no use here: cleanTrackTitle
// strips exactly the suffixes that tell the versions apart (Radio Edit, Live,
// Remastered), so two rows would read identically. Drop the credits and the
// soundtrack tail, keep every version descriptor.
function cardVersionLabel(title) {
  return String(title || '')
    .replace(/\s*[\(\[](?:feat|featuring|ft|with)\.?\s[^)\]]*[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*from\s[^)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*from\s+["“].*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Base title: drop every bracketed group and any trailing " - <qualifier>",
// leaving the song as it would be named without its version tag.
function cardVersionBase(label) {
  return String(label || '')
    .replace(/\s*[\(\[][^)\]]*[\)\]]/g, ' ')
    .replace(/\s*[-–—]\s+[^-–—]*$/, ' ')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// True when the title says which version it is. Every bracketed group counts,
// not just the first: "Moonlit Floor (Kiss Me) - Santa Baby Remix" opens with a
// bracket that is part of the song's name, and the tag comes after it.
function cardHasVersionTag(label) {
  const s = String(label || '');
  const parts = [];
  const brackets = /[\(\[]([^)\]]*)[\)\]]/g;
  let m;
  while ((m = brackets.exec(s)) !== null) parts.push(m[1]);
  const dash = s.match(/[-–—]\s+(.*)$/);
  if (dash) parts.push(dash[1]);
  return parts.some((p) => CARD_VERSION_TAG_RE.test(p));
}

// How a combined line is named: "Rockstar (versions)". A song that already ends
// in a bracket loses it rather than carrying two — "Moonlit Floor (versions)",
// which is how the signature card writes it too.
const cardVersionsLabel = (name) =>
  `${String(name || '').replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/, '').trim()} (versions)`;

// The song a version belongs to, as it should read: the version label with its
// tag taken off. Only used when a song is present through its versions alone.
function cardVersionParentLabel(label) {
  return String(label || '')
    .replace(/\s*[-–—]\s+[^-–—]*$/, '')
    .replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/, '')
    .trim();
}

// Splits a catalogue into songs and versions-of-songs. A row whose title
// carries a version tag is a version of whatever shares its base title;
// everything else is a song, including the solo re-records.
//
// Each group carries the combined figures for its versions ONLY — the original
// is a song and stands on its own line, exactly as on the posters this
// reproduces: "Rockstar", and separately "Rockstar (versions)".
function cardVersionGroups(tracks, rank) {
  const groups = new Map();
  for (const t of tracks) {
    const base = cardVersionBase(t.vlabel);
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, { songs: [], versions: [] });
    const g = groups.get(base);
    (cardHasVersionTag(t.vlabel) ? g.versions : g.songs).push(t);
  }
  const out = [];
  for (const [, g] of groups) {
    if (!g.versions.length) continue;
    const total = g.versions.reduce((acc, r) => {
      acc.cum += r.cum; acc.daily += r.daily; acc.prev += r.prev; return acc;
    }, { cum: 0, daily: 0, prev: 0 });
    const versions = [...g.versions].sort(rank);
    // Named after the song itself; if we only carry its versions, after them.
    const parent = [...g.songs].sort(rank)[0];
    out.push({
      name: parent ? parent.label : cardVersionParentLabel(versions[0].vlabel),
      versions,
      total,
    });
  }
  return out.sort((a, b) => rank(a.total, b.total));
}

// Which column orders the sortable cards. Governs both sections so the albums
// and the tracks are always ranked by the same thing.
let statsCardSort = 'total';   // 'total' | 'daily'
// Built lazily: ARTIST_THEMES / HERO_IMAGE_VERSION are consts declared further
// down, so reading them at this point in the file hits the temporal dead zone
// and kills the whole script before any of the element lookups below it run.
function cardPhotoUrl() {
  const img = (ARTIST_THEMES[currentArtist] || {}).img || '/images/default.jpg';
  // Local files can be hot-swapped; bust the cache the same way the hero does.
  return img.startsWith('/') ? `${img}?v=${HERO_IMAGE_VERSION}` : img;
}

function renderCatalogueCard() {
  if (!statsCardEl) return;
  const songsReady = Array.isArray(allSongs) && allSongs.length > 0;
  if (!songsReady) {
    statsCardEl.innerHTML = '<div class="lc-note" style="text-align:center;padding:28px 0;">Still loading the catalogue…</div>';
    return;
  }

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Four columns, not five: the change and its percentage are one idea, so they
  // share a cell with the percentage set back. Fifty rows of five numeric
  // columns is what made this card hard to read.
  const row = (label, r, cls) => {
    const d = lcDelta(r.daily - r.prev, r.prev);
    return `<tr${cls ? ` class="${cls}"` : ''}>
      <td class="lc-song" title="${esc(label)}">${esc(label)}</td>
      <td>${lcNum(r.cum)}</td>
      <td>${lcNum(r.daily)}</td>
      <td class="${d.cls}">${d.txt}<span class="lc-pct">${d.pct}</span></td>
    </tr>`;
  };
  const band = (label) => `<tr class="lc-group lc-band"><td class="lc-song" colspan="4">${esc(label)}</td></tr>`;

  let recordedDate = null;
  for (const song of allSongs) {
    if (song.recorded_date && (!recordedDate || song.recorded_date > recordedDate)) recordedDate = song.recorded_date;
  }

  const byDaily = statsCardSort === 'daily';
  const rank = (a, b) => (byDaily ? b.daily - a.daily : b.cum - a.cum);

  // --- Albums (singles / remix packs / hits compilations filtered out) ---
  const songStreamsByTitle = new Map();
  for (const sg of allSongs) {
    const k = cardTitleKey(sg.title);
    songStreamsByTitle.set(k, Math.max(songStreamsByTitle.get(k) || 0, Number(sg.cumulative || 0)));
  }
  const dedupedInput = (Array.isArray(allAlbums) ? allAlbums : [])
    .filter((a) => isCatalogueAlbum(a, songStreamsByTitle))
    .map((a) => ({
      label: cleanAlbumTitle(a.album_title) || a.album_title,
      cum: Number(a.total_streams || 0),
      daily: Number(a.daily_gain || 0),
      prev: Number(a.prev_daily_gain || 0),
    }))
    .filter((a) => a.cum > 0);
  const allAlbumRows = dedupeAlbumEditions(dedupedInput).sort(rank);
  const albums = allAlbumRows.slice(0, CARD_MAX_ALBUMS);

  // --- Tracks. Two labels per song: the display one, and a version-accurate
  // one (cleanTrackTitle strips the very suffixes that identify a version). ---
  const trackRows = allSongs.map((sg) => ({
    label: statsCardLabel(sg.title) || sg.title,
    vlabel: cardVersionLabel(sg.title) || sg.title,
    cum: Number(sg.cumulative || 0),
    daily: Number(sg.daily_gain || 0),
    prev: Number(sg.prev_daily_gain || 0),
  }));

  // --- Versions. LISA only: her scene counts versions as their own thing,
  // which is why her signature card carries a Rockstar(versions) line at all.
  // The other artists' cards were never meant to have this, and on a catalogue
  // like JT's — six SexyBack club mixes, twelve of "4 Minutes" — it swamps the
  // card. Computed over the whole catalogue, not just the top tracks. ---
  const allVersionGroups = currentArtist === LISA_ARTIST_ID
    ? cardVersionGroups(trackRows, rank)
    : [];
  const versionGroups = allVersionGroups.slice(0, CARD_MAX_VERSION_GROUPS);

  // Where versions are counted, they leave the track list and come back as one
  // "<Song> (versions)" line carrying their combined figures — which is how
  // these posters read: the song on its own line, its versions on the next.
  const versionRowSet = new Set();
  for (const g of allVersionGroups) for (const v of g.versions) versionRowSet.add(v);
  const trackPool = allVersionGroups.length
    ? [
      ...trackRows.filter((t) => !versionRowSet.has(t)),
      ...allVersionGroups.map((g) => ({ label: cardVersionsLabel(g.name), ...g.total })),
    ]
    : trackRows;
  const tracks = [...trackPool].sort(rank).slice(0, CARD_TOP_TRACKS);

  // --- Catalogue total: every tracked song, not the album sum. Albums overlap
  // (deluxe editions, compilations), so adding them up would double-count. ---
  const overall = allSongs.reduce((acc, sg) => {
    acc.cum += Number(sg.cumulative || 0);
    acc.daily += Number(sg.daily_gain || 0);
    acc.prev += Number(sg.prev_daily_gain || 0);
    return acc;
  }, { cum: 0, daily: 0, prev: 0 });

  // Say what the ranking is — the card gets shared without the picker next to it,
  // and say so out loud when the album list had to be trimmed.
  const byLabel = byDaily ? 'BY DAILY' : 'BY TOTAL';
  const albumBand = allAlbumRows.length > albums.length
    ? `ALBUMS · TOP ${albums.length} OF ${allAlbumRows.length} · ${byLabel}`
    : `ALBUMS (${albums.length}) · ${byLabel}`;
  let html = band(albumBand);
  for (const a of albums) html += row(a.label, a);
  // Folding versions away can leave fewer than the cap, and "TOP 25" of 25 is a
  // strange thing to say.
  html += band(tracks.length < trackPool.length
    ? `TOP ${tracks.length} TRACKS · ${byLabel}`
    : `TRACKS (${tracks.length}) · ${byLabel}`);
  for (const t of tracks) html += row(t.label, t);
  // The breakdown behind those combined lines. Set in smaller type: it is
  // reference, not the headline, and at full size it took over the card.
  if (versionGroups.length) {
    html += band(allVersionGroups.length > versionGroups.length
      ? `VERSIONS · TOP ${versionGroups.length} OF ${allVersionGroups.length} · ${byLabel}`
      : `VERSIONS (${versionGroups.length}) · ${byLabel}`);
    for (const g of versionGroups) {
      for (const v of g.versions.slice(0, CARD_MAX_VERSION_ROWS)) html += row(v.vlabel, v, 'lc-v');
      const hidden = g.versions.length - CARD_MAX_VERSION_ROWS;
      if (hidden > 0) {
        html += `<tr class="lc-more"><td class="lc-song" colspan="4">+ ${hidden} more version${hidden > 1 ? 's' : ''}</td></tr>`;
      }
      html += row(cardVersionsLabel(g.name), g.total, 'lc-v lc-group');
    }
  }
  html += row('OVERALL', overall, 'lc-group lc-final');

  const dateStr = recordedDate
    ? parseLocalDate(toStreamDay(recordedDate)).toLocaleDateString('en-GB').replace(/\//g, '.')
    : '';

  statsCardEl.innerHTML = `
    <div class="lc-head">
      <img class="lc-photo" src="${cardPhotoUrl()}" crossorigin="anonymous" alt="">
      <div class="lc-head-band">
        <div class="lc-title">${esc(currentArtistName || 'Artist')}</div>
        <div class="lc-sub">Spotify streams${dateStr ? ` · ${dateStr}` : ''}</div>
        <div class="lc-kpis">
          <div class="lc-kpi"><span>Total</span><b>${lcNum(overall.cum)}</b></div>
          <div class="lc-kpi"><span>Daily</span><b>${lcNum(overall.daily)}</b></div>
          <div class="lc-kpi"><span>Catalogue</span><b>${lcNum(allSongs.length)} songs · ${lcNum(allAlbumRows.length)} albums</b></div>
        </div>
      </div>
    </div>
    <table class="lc-table">
      <colgroup>
        <col class="lc-c-song"><col class="lc-c-overall"><col class="lc-c-daily"><col class="lc-c-delta">
      </colgroup>
      <thead>
        <tr><th>Title</th><th>Total</th><th>Daily</th><th>Change</th></tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
    <div class="lc-note">Album rows overlap (deluxe editions share tracks) — OVERALL is the catalogue total, not their sum.</div>
  `;
}

const statsCardModal = document.getElementById('stats-card-modal');
const statsCardEl = document.getElementById('stats-card');
const statsCardBtn = document.getElementById('stats-card-btn');
const statsCardCloseBtn = document.getElementById('stats-card-close-btn');
const statsCardDownloadBtn = document.getElementById('stats-card-download-btn');
const statsCardSortWrap = document.getElementById('stats-card-sort-wrap');
const statsCardSortSel = document.getElementById('stats-card-sort');
const statsCardStyleWrap = document.getElementById('stats-card-style-wrap');
const statsCardStyleSel = document.getElementById('stats-card-style');

// Artists with a bespoke card can switch to the standard catalogue layout the
// rest of the roster gets. Meaningless for everyone else, whose only card IS
// the catalogue one — the picker stays hidden there.
let statsCardStyle = 'signature';   // 'signature' | 'catalogue'

// Every artist gets the catalogue card; a few have a bespoke one instead.
// The config supplies the palette class, the flat colour html2canvas paints
// behind the card, and the renderer.
const STATS_CARD_OVERRIDES = {
  [LISA_ARTIST_ID]: {
    theme: 'theme-lisa', bg: '#f5d67a', render: renderLisaCard,
    // Her catalogue card is the same quiet layout as everyone else's, wearing
    // her own skin: the gold page, the black rules and the serif head her
    // signature card is known for (see .theme-lisa-cat). `accented: false`
    // because that palette is fixed in CSS, not derived from her dashboard
    // accent — gold-on-gold would vanish.
    catalogue: { theme: 'theme-artist theme-lisa-cat', bg: '#f5d67a', accented: false },
  },
};
const CATALOGUE_CARD_CONF = {
  theme: 'theme-artist', bg: '#080c14', render: renderCatalogueCard, sortable: true, accented: true,
};

function statsCardConfig(artistId) {
  const id = artistId === undefined ? currentArtist : artistId;
  if (!id) return null;               // on the picker there is nothing to draw
  const override = STATS_CARD_OVERRIDES[id];
  if (override && statsCardStyle === 'signature') return override;
  // An artist can dress the catalogue card in their own palette without
  // reimplementing it — everything not named in `catalogue` is the default.
  return override && override.catalogue
    ? { ...CATALOGUE_CARD_CONF, ...override.catalogue }
    : CATALOGUE_CARD_CONF;
}

// The catalogue card borrows the artist's accent. Nothing sits on a solid
// accent fill any more — the accent is a rule, a label colour and a 10% wash —
// so the accent alone is enough; the ink stays the card's own.
function applyStatsCardAccent(el, artistId) {
  const accent = (ARTIST_THEMES[artistId] || LANDING_THEME).accent || '#1ed760';
  el.style.setProperty('--sc-accent', accent);
  el.style.setProperty('--sc-accent-rgb', hexToRgbTriplet(accent));
}

// Called from applyArtistTheme, which every artist-switch path goes through
// (deep link, picker card, header dropdown).
function syncStatsCardButton(artistId) {
  if (!statsCardBtn) return;
  const id = artistId === undefined ? currentArtist : artistId;
  const has = !!statsCardConfig(id);
  statsCardBtn.classList.toggle('hidden', !has);
  if (!has && statsCardModal) statsCardModal.classList.add('hidden');
}

function renderLisaCard() {
  if (!statsCardEl) return;
  if (!Array.isArray(allSongs) || allSongs.length === 0) {
    statsCardEl.innerHTML = '<div class="lc-note" style="text-align:center;padding:28px 0;">Still loading her tracks…</div>';
    return;
  }

  // Fold every tracked song into its display row.
  const buckets = new Map();
  const extras = [];   // anything the mapping doesn't know about (a new release)
  let recordedDate = null;
  for (const song of allSongs) {
    if (song.recorded_date && (!recordedDate || song.recorded_date > recordedDate)) recordedDate = song.recorded_date;
    const key = lisaCardKey(song.title);
    const cum = Number(song.cumulative || 0);
    const daily = Number(song.daily_gain || 0);
    const prev = Number(song.prev_daily_gain || 0);
    if (!key) {
      // Never silently drop a track — an unmapped one gets its own row so the
      // OVERALL line still equals her real total.
      extras.push({ label: statsCardLabel(song.title), cum, daily, prev, group: 'other' });
      continue;
    }
    const b = buckets.get(key) || { cum: 0, daily: 0, prev: 0 };
    b.cum += cum; b.daily += daily; b.prev += prev;
    buckets.set(key, b);
  }

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const dataRow = (label, r) => {
    const d = lcDelta(r.daily - r.prev, r.prev);
    return `<tr>
      <td class="lc-song" title="${esc(label)}">${esc(label)}</td>
      <td>${lcNum(r.cum)}</td>
      <td>${lcNum(r.daily)}</td>
      <td class="${d.cls}">${d.txt}</td>
      <td class="${d.cls}">${d.pct}</td>
    </tr>`;
  };
  const groupRow = (label, t) => {
    const d = lcDelta(t.daily - t.prev, t.prev);
    return `<tr class="lc-group">
      <td class="lc-song">${esc(label)}</td>
      <td>${lcNum(t.cum)}</td>
      <td>${lcNum(t.daily)}</td>
      <td class="${d.cls}">${d.txt}</td>
      <td class="${d.cls}">${d.pct}</td>
    </tr>`;
  };

  const totals = { alterego: { cum: 0, daily: 0, prev: 0 }, lalisa: { cum: 0, daily: 0, prev: 0 }, all: { cum: 0, daily: 0, prev: 0 } };
  const add = (acc, r) => { acc.cum += r.cum; acc.daily += r.daily; acc.prev += r.prev; };

  let html = '';
  let prevGroup = null;
  for (const def of LISA_CARD_ROWS) {
    const r = buckets.get(def.key);
    // Close the previous era with its black subtotal band before starting a new one.
    if (prevGroup && def.group !== prevGroup && totals[prevGroup]) {
      html += groupRow(prevGroup === 'alterego' ? 'ALTER EGO' : 'LALISA', totals[prevGroup]);
    }
    prevGroup = def.group;
    if (!r) continue;   // track not in our data (yet) — skip the row entirely
    html += dataRow(def.label, r);
    add(totals.all, r);
    if (totals[def.group]) add(totals[def.group], r);
  }
  for (const x of extras) { html += dataRow(x.label, x); add(totals.all, x); }
  html += groupRow('OVERALL', totals.all);

  const dateStr = recordedDate
    ? parseLocalDate(toStreamDay(recordedDate)).toLocaleDateString('en-GB').replace(/\//g, '.')
    : '';

  statsCardEl.innerHTML = `
    <div class="lc-head">
      <img class="lc-photo" src="${LISA_PHOTO}" crossorigin="anonymous" alt="">
      <div class="lc-head-band">
        <div class="lc-title">Lisa Daily Streams On Spotify</div>
        <div class="lc-date">${dateStr}</div>
        <div class="lc-era">Alter Ego: ${lcNum(totals.alterego.daily)}</div>
        <div class="lc-era">Lalisa:&nbsp; ${lcNum(totals.lalisa.daily)}</div>
        <div class="lc-era">Total: ${lcNum(totals.all.daily)}</div>
      </div>
    </div>
    <table class="lc-table">
      <colgroup>
        <col class="lc-c-song"><col class="lc-c-overall"><col class="lc-c-daily">
        <col class="lc-c-delta"><col class="lc-c-pct">
      </colgroup>
      <thead>
        <tr><th>song</th><th>overall</th><th>Daily</th><th colspan="2">+/-</th></tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
  `;
}

// These are fixed-width poster layouts; on a narrow screen we scale the whole
// thing rather than reflow it (see the media query). Recomputed on open/resize.
function statsCardWidth() {
  if (!statsCardEl) return 700;
  const declared = parseFloat(getComputedStyle(statsCardEl).getPropertyValue('--sc-width'));
  return Number.isFinite(declared) && declared > 0 ? declared : 700;
}

function fitStatsCard() {
  if (!statsCardEl || !statsCardModal || statsCardModal.classList.contains('hidden')) return;
  const shell = statsCardEl.parentElement;
  const avail = shell ? shell.clientWidth : 0;
  const natural = statsCardWidth();
  if (avail && avail < natural) {
    statsCardEl.style.setProperty('--lc-zoom', String(Math.max(0.25, avail / natural)));
  } else {
    statsCardEl.style.removeProperty('--lc-zoom');
  }
}

// Paint the card in the current config's palette and re-run its renderer. Both
// pickers go through here, so switching layout also swaps the theme.
function drawStatsCard() {
  const conf = statsCardConfig(currentArtist);
  if (!conf || !statsCardEl) return;
  // Palette is per artist; drop whatever the previous one left behind.
  statsCardEl.className = 'stats-card ' + conf.theme;
  statsCardEl.removeAttribute('style');
  if (conf.accented) applyStatsCardAccent(statsCardEl, currentArtist);
  if (statsCardSortWrap) statsCardSortWrap.classList.toggle('hidden', !conf.sortable);
  if (statsCardSortSel) statsCardSortSel.value = statsCardSort;
  if (statsCardStyleWrap) {
    statsCardStyleWrap.classList.toggle('hidden', !STATS_CARD_OVERRIDES[currentArtist]);
  }
  if (statsCardStyleSel) statsCardStyleSel.value = statsCardStyle;
  conf.render();
  fitStatsCard();
}

function openStatsCard() {
  if (!statsCardModal || !statsCardConfig(currentArtist)) return;
  statsCardModal.classList.remove('hidden');
  drawStatsCard();
}

window.addEventListener('resize', fitStatsCard);

async function downloadStatsCard() {
  if (!statsCardEl) return;
  const conf = statsCardConfig(currentArtist) || {};
  const width = statsCardWidth();
  const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
  const photo = statsCardEl.querySelector('.lc-photo');
  if (photo && photo.src) {
    try { await photo.decode(); } catch (e) { photo.style.visibility = 'hidden'; }
    if (photo.style.visibility !== 'hidden' && !photo.naturalWidth) photo.style.visibility = 'hidden';
  }
  try {
    const canvas = await html2canvas(statsCardEl, {
      ignoreElements: ignoreOutside(statsCardModal || statsCardEl),
      backgroundColor: conf.bg || '#080c14',
      scale: 2,
      useCORS: true,
      imageTimeout: 15000,
      logging: false,
      width,
      windowWidth: width + 120,
      onclone: (clonedDoc) => {
        const card = clonedDoc.getElementById('stats-card');
        if (card) {
          card.style.setProperty('width', `${width}px`, 'important');
          card.style.setProperty('max-width', `${width}px`, 'important');
          // Undo the phone preview's shrink — the PNG is always full size.
          card.style.setProperty('zoom', '1', 'important');
        }
      },
    });
    let url = null;
    if (canvas.toBlob) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) url = URL.createObjectURL(blob);
    }
    if (!url) url = canvas.toDataURL('image/png');

    const fileBase = (currentArtistName || 'artist').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    if (isMobile) {
      showMobileImageOverlay(url, `${currentArtistName || 'Artist'} daily streams`);
    } else {
      const link = document.createElement('a');
      link.download = `${fileBase}_daily_streams.png`;
      link.href = url;
      link.click();
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (e) {
    console.error('Stats card export failed:', e);
    alert('Could not generate the image. Please try again.');
  } finally {
    if (photo) photo.style.visibility = 'visible';
  }
}

if (statsCardSortSel) statsCardSortSel.addEventListener('change', () => {
  statsCardSort = statsCardSortSel.value === 'daily' ? 'daily' : 'total';
  drawStatsCard();
});
if (statsCardStyleSel) statsCardStyleSel.addEventListener('change', () => {
  statsCardStyle = statsCardStyleSel.value === 'catalogue' ? 'catalogue' : 'signature';
  drawStatsCard();
});
if (statsCardBtn) statsCardBtn.addEventListener('click', openStatsCard);
if (statsCardCloseBtn) statsCardCloseBtn.addEventListener('click', () => statsCardModal.classList.add('hidden'));
if (statsCardDownloadBtn) statsCardDownloadBtn.addEventListener('click', downloadStatsCard);
if (statsCardModal) statsCardModal.addEventListener('click', (e) => { if (e.target === statsCardModal) statsCardModal.classList.add('hidden'); });

// ===== Song Share Card =====
async function openSongCard() {
  if (!currentSongMeta || !songCardEl) return;
  // Year-end projection is opt-in (off by default) — it's a noisy estimate, so
  // most fans share the cleaner card without it. The toggle in the action bar
  // re-renders the card when flipped.
  const yearEndToggle = document.getElementById('sc-yearend-toggle');
  const showYearEndProj = !!(yearEndToggle && yearEndToggle.checked);

  songCardModal.classList.remove('hidden');
  buildCardThemePickers();   // idempotent; also applies the saved colour theme
  songCardEl.innerHTML = `<div class="dc-total" style="padding:30px 0;text-align:center;">Loading…</div>`;

  let percentChange = 0;
  let changeClass = 'dc-muted';
  let badgeArrow = '●';
  let badgeClass = 'flat';
  
  if (Array.isArray(activeSongHistory) && activeSongHistory.length >= 2) {
    const today = activeSongHistory[activeSongHistory.length - 1];
    const yesterday = activeSongHistory[activeSongHistory.length - 2];
    const todayGain = Number(today.daily_gain || 0);
    const yesterdayGain = Number(yesterday.daily_gain || 0);
    const change = todayGain - yesterdayGain;
    
    if (yesterdayGain > 0) {
      percentChange = (change / yesterdayGain) * 100;
    }
    
    if (change > 0) {
      changeClass = 'dc-pos';
      badgeArrow = '▲';
      badgeClass = 'up';
    } else if (change < 0) {
      changeClass = 'dc-neg';
      badgeArrow = '▼';
      badgeClass = 'down';
    }
  }

  let recordedDate = null;
  if (Array.isArray(activeSongHistory) && activeSongHistory.length) {
    recordedDate = activeSongHistory[activeSongHistory.length - 1].recorded_date;
  }

  const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
  songCardEl.innerHTML = `
    <div class="dc-header">
      ${currentSongMeta.coverUrl ? `<img class="dc-cover" src="${currentSongMeta.coverUrl}" crossorigin="anonymous" alt="">` : ''}
      <div class="dc-head-text">
        <div class="dc-album">${esc(cleanTrackTitle(currentSongMeta.title))}</div>
        <div class="dc-artist">${esc((currentArtistName || '').toUpperCase())}</div>
        <div class="dc-date">${formatCardDate(recordedDate)}</div>
      </div>
    </div>
    <div class="dc-divider"></div>
    <div class="dc-big-label">DAILY STREAMS</div>
    <div class="dc-big-row">
      <div class="dc-daily-num">+${formatNumber(currentSongMeta.dailyGain)}</div>
      <div class="dc-badge ${badgeClass}">${badgeArrow} ${Math.abs(percentChange).toFixed(2)}%</div>
    </div>
    <div class="dc-total" style="margin-bottom: 8px;">Total streams · <b>${formatNumber(currentSongMeta.cumulative)}</b></div>
    
    <div class="sc-stats-grid" style="${showYearEndProj ? '' : 'grid-template-columns: 1fr;'}">
      <div class="sc-stat-box">
        <span class="sc-stat-label">7D Avg Pace</span>
        <span class="sc-stat-val">+${formatNumber(currentSongMeta.avg7d)}</span>
      </div>
      ${showYearEndProj ? `
      <div class="sc-stat-box">
        <span class="sc-stat-label">Year-End Proj.</span>
        <span class="sc-stat-val">${formatNumber(currentSongMeta.yearEndProj)}</span>
      </div>` : ''}
    </div>
    
    <div class="sc-milestone-section">
      <div class="sc-milestone-header">
        <span class="sc-milestone-label">Next Milestone: <b>${formatMilestoneName(currentSongMeta.nextMilestone)}</b></span>
        <span class="sc-milestone-eta">${currentSongMeta.etaText}</span>
      </div>
      <div class="sc-progress-bar-container">
        <div class="sc-progress-bar" style="width: ${Math.min(100, currentSongMeta.percent).toFixed(1)}%;"></div>
      </div>
      <div class="sc-progress-percent">${currentSongMeta.percent.toFixed(1)}% completed</div>
    </div>
    
    <div class="dc-footer" style="margin-top: 24px;"><span class="dc-dot"></span><b>${esc(currentArtistName || '')}</b> Spotify Streams — Fan Dashboard</div>
  `;
}

async function downloadSongCard() {
  if (!songCardEl) return;
  const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
  const cover = songCardEl.querySelector('.dc-cover');
  if (cover && cover.src) {
    try { await cover.decode(); } catch (e) { cover.style.visibility = 'hidden'; }
    if (cover.style.visibility !== 'hidden' && !cover.naturalWidth) cover.style.visibility = 'hidden';
  }
  try {
    const canvas = await html2canvas(songCardEl, {
      ignoreElements: ignoreOutside(songCardEl.closest('.modal-backdrop') || songCardEl),
      backgroundColor: resolveCardTheme(cardThemeId).page || '#080c14',
      scale: 2,
      useCORS: true,
      imageTimeout: 15000,
      logging: false,
      width: 600,
      windowWidth: 700,
      onclone: (clonedDoc) => {
        const card = clonedDoc.getElementById('song-card');
        if (card) {
          card.style.setProperty('width', '600px', 'important');
          card.style.setProperty('max-width', '600px', 'important');
          card.style.setProperty('padding', '26px 28px', 'important');
        }
      }
    });
    const name = (currentSongMeta?.title || 'song').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const fileName = `daily_${name}.png`;

    let url = null;
    if (canvas.toBlob) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) url = URL.createObjectURL(blob);
    }
    if (!url) url = canvas.toDataURL('image/png');

    if (isMobile) {
      showMobileImageOverlay(url, currentSongMeta?.title || 'song');
    } else {
      const link = document.createElement('a');
      link.download = fileName;
      link.href = url;
      link.click();
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (e) {
    console.error('Song card export failed:', e);
    alert('Could not generate the image. Please try again.');
  } finally {
    if (cover) cover.style.visibility = 'visible';
  }
}

if (openSongCardBtn) openSongCardBtn.addEventListener('click', openSongCard);

// Song modal -> Time Machine, opened straight on this track's day-by-day past.
// The song modal closes behind it: two stacked modals showing the same song's
// history would just fight over the screen.
const songTimeMachineBtn = document.getElementById('song-timemachine-btn');
if (songTimeMachineBtn) {
  songTimeMachineBtn.addEventListener('click', () => {
    if (!currentSongMeta || typeof window.openTimeMachineForSong !== 'function') return;
    closeSongModal();
    window.openTimeMachineForSong(
      currentSongMeta.songId,
      currentSongMeta.title,
      currentSongMeta.albumTitle
    );
  });
}
const scYearEndToggle = document.getElementById('sc-yearend-toggle');
if (scYearEndToggle) scYearEndToggle.addEventListener('change', () => { if (currentSongMeta) openSongCard(); });
if (songCardCloseBtn) songCardCloseBtn.addEventListener('click', () => songCardModal.classList.add('hidden'));
if (songCardDownloadBtn) songCardDownloadBtn.addEventListener('click', downloadSongCard);
if (songCardModal) songCardModal.addEventListener('click', (e) => { if (e.target === songCardModal) songCardModal.classList.add('hidden'); });

// Centralized view switcher: shows exactly one of songs / albums / milestones
// and syncs the toggle buttons' active state.
function setActiveView(view) {
  activeView = view;
  viewToggleBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  songsViewSection.classList.toggle('hidden', view !== 'songs');
  albumsViewSection.classList.toggle('hidden', view !== 'albums');
  if (milestonesSection) milestonesSection.classList.toggle('hidden', view !== 'milestones');
}

// View Toggle Handler
viewToggleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    setActiveView(btn.dataset.view);
    if (btn.dataset.view === 'albums') fetchAlbumsData();
  });
});

// Show-all / show-less toggle for the songs table
if (songsShowAllBtn) {
  songsShowAllBtn.addEventListener('click', () => {
    songsExpanded = !songsExpanded;
    renderSongs();
  });
}

// Total Streams breakdown (Lead / Solo / Featured) toggle
if (breakdownToggle && streamsBreakdown) {
  breakdownToggle.addEventListener('click', () => {
    const collapsed = streamsBreakdown.classList.toggle('collapsed');
    breakdownToggle.setAttribute('aria-expanded', String(!collapsed));
    const chevron = breakdownToggle.querySelector('.chevron-icon');
    if (chevron) chevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(180deg)';
  });
}

// Daily Streams breakdown (Lead / Featured) toggle
if (dailyBreakdownToggle && dailyStreamsBreakdown) {
  dailyBreakdownToggle.addEventListener('click', () => {
    const collapsed = dailyStreamsBreakdown.classList.toggle('collapsed');
    dailyBreakdownToggle.setAttribute('aria-expanded', String(!collapsed));
    const chevron = dailyBreakdownToggle.querySelector('.chevron-icon');
    if (chevron) chevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(180deg)';
  });
}

// Search handler
searchInput.addEventListener('input', (e) => {
  searchFilter = e.target.value;
  songsExpanded = false; // new search starts collapsed so top matches are visible
  renderSongs();
});

// Filter button handlers
filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    filterButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    typeFilter = btn.dataset.filter;
    renderSongs();
  });
});

// Milestone Filter button handlers
if (milestoneFilterButtons) {
  milestoneFilterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      milestoneFilterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      milestoneFilter = btn.dataset.filter;
      renderMilestones();
      renderAchievedMilestones(lastAchievedMilestonesRawData);
    });
  });
}

// Sortable headers handler
sortHeaders.forEach(th => {
  th.addEventListener('click', () => {
    const field = th.dataset.sort;
    
    if (currentSortField === field) {
      currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      currentSortField = field;
      currentSortDirection = (field === 'title' || field === 'album') ? 'asc' : 'desc';
    }
    
    sortHeaders.forEach(header => {
      header.classList.remove('active');
      const icon = header.querySelector('.sort-icon');
      if (icon) icon.textContent = '';
    });
    
    th.classList.add('active');
    const icon = th.querySelector('.sort-icon');
    if (icon) {
      icon.textContent = currentSortDirection === 'asc' ? '▲' : '▼';
    }
    
    renderSongs();
  });
});

// Album Search and Sort handlers
if (albumSearchInput) {
  albumSearchInput.addEventListener('input', (e) => {
    albumSearchFilter = e.target.value;
    renderAlbums();
  });
}

if (albumSortSelect) {
  albumSortSelect.addEventListener('change', (e) => {
    albumSortField = e.target.value;
    renderAlbums();
  });
}

// Milestones Engine
function getNextMilestone(streams) {
  if (currentArtist === '3LHYvj5ZejV1NLqncEObSJ') {
    // Custom small milestones for Vaelis
    const vaelisMilestones = [
      1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000,
      15000, 20000, 25000, 50000, 100000, 250000, 500000, 1000000
    ];
    for (let m of vaelisMilestones) {
      if (streams < m) return m;
    }
    // Beyond the ladder: next whole million, always strictly greater.
    let next = Math.ceil(streams / 1000000) * 1000000;
    if (next <= streams) next += 1000000;
    return next;
  }

  const milestones = [
    10000000, 25000000, 50000000,
    100000000, 200000000, 300000000, 400000000, 500000000,
    600000000, 700000000, 800000000, 900000000, 1000000000,
    1200000000, 1500000000, 1800000000, 2000000000, 2500000000,
    3000000000, 3500000000, 4000000000, 4500000000, 5000000000
  ];
  for (let m of milestones) {
    if (streams < m) return m;
  }
  // Beyond the table: next whole billion, always strictly greater than current.
  let next = Math.ceil(streams / 1000000000) * 1000000000;
  if (next <= streams) next += 1000000000;
  return next;
}

function formatMilestoneName(val) {
  if (val >= 1000000000) {
    return (val / 1000000000).toFixed(1).replace('.0', '') + ' Billion';
  }
  if (val >= 1000000) {
    return (val / 1000000).toFixed(0) + ' Million';
  }
  if (val >= 1000) {
    return (val / 1000).toFixed(0) + ' Thousand';
  }
  return val.toString();
}

// Use the smoothed 7-day average rate when available. Spotify's daily updates
// swing hard across the week (weekend up, Monday down — sometimes 200k apart for
// JT), so a single day's gain makes ETAs jump around. A 7-day window contains one
// of each weekday, so it's seasonally complete. Falls back to the latest daily
// gain when no average exists yet (e.g. a freshly tracked song).
function effectiveDailyRate(obj) {
  if (!obj) return 0;
  const avg = Number(obj.daily_avg_7d);
  if (Number.isFinite(avg) && avg > 0) return avg;
  return Number(obj.daily_gain) || 0;
}

function renderMilestones() {
  // Keep the target calculator's picker in sync with the current artist's data.
  populateTargetCalc();
  // Visibility is controlled by the view switcher (Milestones tab); here we
  // only populate the grid, falling back to an empty state when there's nothing.
  if ((!allSongs || allSongs.length === 0) && (!allAlbums || allAlbums.length === 0)) {
    milestonesGrid.innerHTML = emptyState('No milestone data yet', 'Upcoming milestones appear once streaming data is tracked.');
    return;
  }

  let mergedMilestones = [];

  // 1) Calculate milestone stats for songs (if not filtering out songs)
  if (milestoneFilter === 'all' || milestoneFilter === 'songs') {
    const songMilestones = allSongs
      .filter(song => Number(song.cumulative) > 0)
      .map(song => {
        const cumulative = Number(song.cumulative);
        const dailyGain = effectiveDailyRate(song);
        const nextMilestone = getNextMilestone(cumulative);
        const percent = (cumulative / nextMilestone) * 100;
        // No placeholder rate: a stalled track divided by 1 stream/day produced
        // "1447.0 years left", which reads like a real forecast. null = unknown.
        const daysRemaining = dailyGain > 0
          ? Math.max(1, Math.ceil((nextMilestone - cumulative) / dailyGain))
          : null;
        return {
          id: song.id,
          title: song.title,
          cumulative,
          daily_gain: dailyGain,
          nextMilestone,
          percent,
          daysRemaining,
          type: 'song'
        };
      });
    mergedMilestones = mergedMilestones.concat(songMilestones);
  }

  // 2) Calculate milestone stats for albums (if not filtering out albums)
  if (milestoneFilter === 'all' || milestoneFilter === 'albums') {
    const albumMilestones = allAlbums
      .filter(album => Number(album.total_streams) > 0)
      .map(album => {
        const cumulative = Number(album.total_streams);
        const dailyGain = effectiveDailyRate(album);
        const nextMilestone = getNextMilestone(cumulative);
        const percent = (cumulative / nextMilestone) * 100;
        const daysRemaining = dailyGain > 0
          ? Math.max(1, Math.ceil((nextMilestone - cumulative) / dailyGain))
          : null;
        return {
          id: album.album_id,
          title: album.album_title,
          cumulative,
          daily_gain: dailyGain,
          nextMilestone,
          percent,
          daysRemaining,
          type: 'album',
          release_date: album.release_date || '',
          image_url: album.image_url || ''
        };
      });
    mergedMilestones = mergedMilestones.concat(albumMilestones);
  }

  // Sort by percentage completed desc
  mergedMilestones.sort((a, b) => b.percent - a.percent);

  // Dedicated tab now, so show a fuller list of the closest milestones.
  const topMilestones = mergedMilestones.slice(0, 18);

  if (topMilestones.length === 0) {
    milestonesGrid.innerHTML = emptyState('No upcoming milestones', 'Nothing matches this filter right now.');
    return;
  }

  milestonesGrid.innerHTML = topMilestones.map(item => {
    let etaText;
    if (item.daysRemaining === null) {
      etaText = 'no recent growth';
    } else if (item.daysRemaining > 365) {
      etaText = `${(item.daysRemaining / 365).toFixed(1)} years left`;
    } else if (item.daysRemaining === 1) {
      etaText = `1 day left`;
    } else {
      etaText = `${item.daysRemaining} days left`;
    }
    
    const isAlbum = item.type === 'album';
    const badgeHtml = isAlbum
      ? `<span class="milestone-type-badge type-album">💿 Album</span>`
      : `<span class="milestone-type-badge type-song">🎵 Song</span>`;
      
    const clickHandler = isAlbum
      ? `openAlbumById('${item.id}', '${escJs(item.title)}', '${item.release_date}', '${escJs(item.image_url)}')`
      : `openSongById('${item.id}')`;

    const projectedVal = getYearEndProjection(item.cumulative, item.daily_gain);
    return `
      <div class="milestone-card glass" onclick="${escHtml(clickHandler)}" style="cursor: pointer;">
        <div class="milestone-card-header">
          <h4 title="${escHtml(item.title)}">${escHtml(item.title)}</h4>
          <span class="eta-badge">${etaText}</span>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; margin-top: -4px;">
          ${badgeHtml}
        </div>
        <div class="milestone-target">
          Target: <strong>${formatMilestoneName(item.nextMilestone)}</strong>
        </div>
        <div class="milestone-progress-bar-container">
          <div class="milestone-progress-bar" style="width: ${item.percent.toFixed(1)}%;"></div>
        </div>
        <div class="milestone-percent-completed">
          ${item.percent.toFixed(1)}% (${formatNumber(item.cumulative)})
        </div>
        <div class="milestone-projection" style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; display: flex; justify-content: space-between;">
          <span>Dec 31 Projection:</span>
          <strong style="color: var(--text-primary);">${formatShortNumber(projectedVal)}</strong>
        </div>
      </div>
    `;
  }).join('');
}

// ===== Target Calculator: days-to-go for a custom stream goal =====
const tcItemEl = document.getElementById('tc-item');       // search input (combobox)
const tcOptionsEl = document.getElementById('tc-options'); // filtered dropdown list
const tcValueEl = document.getElementById('tc-value');
const tcResultEl = document.getElementById('tc-result');

// Searchable picker state. The old native <select> made finding one song among
// hundreds a scroll-fest; this is a type-to-filter combobox instead. tcSelected
// keeps the chosen "song:ID"/"album:ID" value so the ETA logic is unchanged.
let tcItems = [];        // [{ value, title, kind:'song'|'album', streams }]
let tcSelected = '';     // currently chosen value (or '' when nothing picked)
let tcActiveIdx = -1;    // keyboard-highlighted row in the open list
const tcEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Parse "500M", "1.5b", "750,000,000", "750000000" -> number (or NaN).
function parseTargetInput(raw) {
  if (!raw) return NaN;
  const s = String(raw).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([kmb])?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const mult = m[2] === 'b' ? 1e9 : m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1;
  return n * mult;
}

// Build the song/album list from the in-memory data, preserving any selection.
function populateTargetCalc() {
  if (!tcItemEl) return;
  const songs = (allSongs || []).filter(s => Number(s.cumulative) > 0)
    .sort((a, b) => Number(b.cumulative) - Number(a.cumulative));
  const albums = (allAlbums || []).filter(a => Number(a.total_streams) > 0)
    .sort((a, b) => Number(b.total_streams) - Number(a.total_streams));
  tcItems = [
    ...songs.map(s => ({ value: `song:${s.id}`, title: s.title, kind: 'song', streams: Number(s.cumulative) })),
    ...albums.map(a => ({ value: `album:${a.album_id}`, title: a.album_title, kind: 'album', streams: Number(a.total_streams) })),
  ];
  // Keep the field showing the previously-picked item's title after a data refresh.
  const cur = tcItems.find(it => it.value === tcSelected);
  if (cur) tcItemEl.value = cur.title;
  else tcSelected = '';
  computeTargetEta();
}

// Render up to 60 matches for the current query into the dropdown.
function renderTcOptions(query) {
  if (!tcOptionsEl) return;
  const q = (query || '').trim().toLowerCase();
  const matches = (q ? tcItems.filter(it => it.title.toLowerCase().includes(q)) : tcItems).slice(0, 60);
  tcOptionsEl._matches = matches;
  tcActiveIdx = -1;
  if (!matches.length) {
    tcOptionsEl.innerHTML = `<div class="tc-opt-empty">No song or album matches “${tcEsc(query)}”.</div>`;
  } else {
    tcOptionsEl.innerHTML = matches.map((it, i) => `
      <div class="tc-opt${it.value === tcSelected ? ' selected' : ''}" role="option" data-idx="${i}">
        <span class="tc-opt-icon">${it.kind === 'song' ? '🎵' : '💿'}</span>
        <span class="tc-opt-title">${tcEsc(it.title)}</span>
        <span class="tc-opt-streams">${formatShortNumber(it.streams)}</span>
      </div>`).join('');
  }
  showTcOptions();
}

function showTcOptions() {
  if (!tcOptionsEl) return;
  tcOptionsEl.classList.remove('hidden');
  tcItemEl.setAttribute('aria-expanded', 'true');
}
function hideTcOptions() {
  if (!tcOptionsEl) return;
  tcOptionsEl.classList.add('hidden');
  tcItemEl.setAttribute('aria-expanded', 'false');
  tcActiveIdx = -1;
}

// Commit a pick: store its value, show its title in the field, run the ETA.
function selectTcItem(idx) {
  const matches = tcOptionsEl._matches || [];
  const it = matches[idx];
  if (!it) return;
  tcSelected = it.value;
  tcItemEl.value = it.title;
  hideTcOptions();
  computeTargetEta();
}

function highlightTc() {
  [...tcOptionsEl.children].forEach((c, i) => c.classList.toggle('active', i === tcActiveIdx));
  const act = tcOptionsEl.children[tcActiveIdx];
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

function computeTargetEta() {
  if (!tcResultEl) return;
  const sel = tcSelected;
  if (!sel) { tcResultEl.innerHTML = ''; return; }
  const [type, id] = sel.split(/:(.+)/);

  let cumulative = 0, dailyGain = 0, name = '';
  if (type === 'song') {
    const s = (allSongs || []).find(x => x.id === id);
    if (s) { cumulative = Number(s.cumulative); dailyGain = effectiveDailyRate(s); name = s.title; }
  } else {
    const a = (allAlbums || []).find(x => x.album_id === id);
    if (a) { cumulative = Number(a.total_streams); dailyGain = effectiveDailyRate(a); name = a.album_title; }
  }

  const target = parseTargetInput(tcValueEl.value);
  if (!tcValueEl.value.trim()) { tcResultEl.innerHTML = ''; return; }
  if (!Number.isFinite(target) || target <= 0) {
    tcResultEl.innerHTML = `<span class="tc-warn">Enter a number like 500M, 1.5B or 750000000.</span>`;
    return;
  }

  if (target <= cumulative) {
    tcResultEl.innerHTML = `<span class="tc-done">✓ Already past it — currently at <strong>${formatNumber(cumulative)}</strong>.</span>`;
    return;
  }

  const remaining = target - cumulative;
  if (!(dailyGain > 0)) {
    tcResultEl.innerHTML = `<span class="tc-warn">Needs <strong>${formatNumber(remaining)}</strong> more, but there’s no recent growth to estimate from.</span>`;
    return;
  }

  const days = Math.ceil(remaining / dailyGain);
  const reachDate = new Date();
  reachDate.setDate(reachDate.getDate() + days);
  const dateStr = reachDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  let etaText = `${formatNumber(days)} days`;
  if (days > 365) etaText = `${(days / 365).toFixed(1)} years (${formatNumber(days)} days)`;
  else if (days === 1) etaText = `1 day`;

  tcResultEl.innerHTML = `
    <div class="tc-eta"><span class="tc-eta-num">${etaText}</span> <span class="tc-eta-label">to reach ${formatShortNumber(target)}</span></div>
    <div class="tc-detail">
      <span>Reaches on <strong>${dateStr}</strong></span>
      <span>Needs <strong>${formatNumber(remaining)}</strong> more · at <strong>+${formatShortNumber(dailyGain)}/day</strong> <span class="tc-rate-note">(7-day avg)</span></span>
    </div>`;
}

if (tcItemEl) {
  // Show the full list on focus (sorted by streams) so browsing is one tap away.
  tcItemEl.addEventListener('focus', () => renderTcOptions(''));
  // Typing filters the list and clears any prior pick until a row is chosen.
  tcItemEl.addEventListener('input', () => {
    tcSelected = '';
    renderTcOptions(tcItemEl.value);
    computeTargetEta();
  });
  tcItemEl.addEventListener('keydown', (e) => {
    const open = tcOptionsEl && !tcOptionsEl.classList.contains('hidden');
    const matches = (tcOptionsEl && tcOptionsEl._matches) || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { renderTcOptions(tcItemEl.value); return; }
      tcActiveIdx = Math.min(tcActiveIdx + 1, matches.length - 1);
      highlightTc();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      tcActiveIdx = Math.max(tcActiveIdx - 1, 0);
      highlightTc();
    } else if (e.key === 'Enter') {
      if (open && tcActiveIdx >= 0) { e.preventDefault(); selectTcItem(tcActiveIdx); }
    } else if (e.key === 'Escape') {
      hideTcOptions();
    }
  });
  // Close when focus leaves the combobox (small delay so a click can land first).
  tcItemEl.addEventListener('blur', () => setTimeout(hideTcOptions, 120));
}
if (tcOptionsEl) {
  // mousedown (not click) so it fires before the input's blur hides the list.
  tcOptionsEl.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.tc-opt');
    if (!opt) return;
    e.preventDefault();
    selectTcItem(Number(opt.dataset.idx));
  });
}
// Live-format tc-value as thousands-grouped digits while typing (750000000 -> 750,000,000).
// Only applies to plain integer input — "500m"/"1.5b" suffixed shorthand is left untouched
// since grouping doesn't make sense there. parseTargetInput already strips commas back out.
function formatTcValueDigits(raw) {
  const stripped = raw.replace(/,/g, '');
  return /^[0-9]+$/.test(stripped) ? Number(stripped).toLocaleString('en-US') : stripped;
}
if (tcValueEl) tcValueEl.addEventListener('input', () => {
  const before = tcValueEl.value;
  const caret = tcValueEl.selectionStart;
  const digitsBeforeCaret = before.slice(0, caret).replace(/[^0-9]/g, '').length;
  const formatted = formatTcValueDigits(before);
  if (formatted !== before) {
    tcValueEl.value = formatted;
    let count = 0, pos = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
      if (/[0-9]/.test(formatted[i])) count++;
      if (count >= digitsBeforeCaret) { pos = i + 1; break; }
    }
    tcValueEl.setSelectionRange(pos, pos);
  }
  computeTargetEta();
});

// ===== Achieved Milestones (separate collapsible log) =====
async function fetchAchievedMilestones(headers) {
  if (!achievedSection) return;
  const artist = currentArtist; // same stale-response guard as fetchData
  try {
    const res = await fetch(`/api/milestones-reached?artist=${artist}`, { headers });
    if (!res.ok) { achievedSection.classList.add('hidden'); return; }
    const rows = await res.json();
    if (artist !== currentArtist) return; // switched away while loading
    lastAchievedMilestonesRawData = rows;
    renderAchievedMilestones(rows);
  } catch (e) {
    achievedSection.classList.add('hidden');
  }
}

function renderAchievedMilestones(rows) {
  if (!achievedSection || !achievedListEl) return;
  if (!Array.isArray(rows) || rows.length === 0) {
    achievedSection.classList.add('hidden');
    achievedListEl.innerHTML = '';
    return;
  }
  
  // Filter by milestoneFilter. The buttons use plural values ('songs'/'albums')
  // while the API rows carry singular types ('song'/'album') — map before
  // comparing, otherwise the filtered list is always empty and the whole
  // section vanishes when a filter is active.
  const wantType = milestoneFilter === 'songs' ? 'song'
    : milestoneFilter === 'albums' ? 'album' : null;
  const filtered = wantType ? rows.filter(r => r.type === wantType) : rows;
  
  if (filtered.length === 0) {
    achievedSection.classList.add('hidden');
    achievedListEl.innerHTML = '';
    return;
  }
  
  achievedSection.classList.remove('hidden');
  if (achievedCountEl) achievedCountEl.textContent = filtered.length;
  achievedListEl.innerHTML = filtered.map(r => {
    const isAlbum = r.type === 'album';
    const badgeHtml = isAlbum 
      ? `<span class="milestone-type-badge type-album">💿 Album</span>` 
      : `<span class="milestone-type-badge type-song">🎵 Song</span>`;
      
    return `
      <div class="achieved-row">
        <span class="achieved-milestone">${formatMilestoneName(Number(r.milestone))}</span>
        ${badgeHtml}
        <span class="achieved-song" title="${escHtml(r.title)}">${escHtml(r.title)}</span>
        <span class="achieved-date">${formatDate(r.reached_date)}</span>
      </div>
    `;
  }).join('');
}

if (achievedToggleBtn && achievedListEl) {
  achievedToggleBtn.addEventListener('click', () => {
    const collapsed = achievedListEl.classList.toggle('collapsed');
    achievedToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    const chevron = achievedToggleBtn.querySelector('.chevron-icon');
    if (chevron) chevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(180deg)';
  });
}

window.openSongById = async function(songId) {
  const song = allSongs.find(s => s.id === songId);
  if (!song) return;
  
  // Apply theme to modal
  const theme = ARTIST_THEMES[currentArtist] || ARTIST_THEMES['31TPClRtHm23RisEBtV3X7'];
  const songModalCard = document.querySelector('#song-modal .modal-card');
  songModalCard.style.setProperty('--album-accent', theme.accent);
  songModalCard.style.setProperty('--album-accent-rgb', hexToRgbTriplet(theme.accent));
  songModalCard.style.setProperty('--album-glow', theme.accentGlow);
  songModalCard.style.background = theme.bgGradient;
  songModalCard.style.borderColor = theme.accent + '30';
  songModalCard.style.boxShadow = `0 25px 60px rgba(0,0,0,0.7), 0 0 80px ${theme.accentGlow}`;

  // Populate basic info
  if (modalSongCover) {
    modalSongCover.src = song.album_cover_url || theme.img || '/images/default.jpg';
  }
  modalSongTitle.textContent = song.title;
  modalSongSubtitle.textContent = song.album_title || 'Single';
  modalSongStreams.textContent = formatNumber(song.cumulative);
  // Same rule as the songs table: a confirmed removal is the day's headline.
  const modalRemoved = showsNegatives() ? (Number(song.removed_streams) || 0) : 0;
  if (modalRemoved < 0) {
    modalSongGain.textContent = formatRemoved(modalRemoved);
    modalSongGain.classList.remove('gain-positive');
    modalSongGain.classList.add('gain-removed');
    modalSongGain.title = song.removed_on
      ? `Spotify removed streams from this song (${formatDate(song.removed_on)})`
      : 'Spotify removed streams from this song';
  } else {
    modalSongGain.textContent = (Number(song.daily_gain) > 0 ? '+' : '') + formatNumber(song.daily_gain);
    modalSongGain.classList.remove('gain-removed');
    modalSongGain.classList.add('gain-positive');
    modalSongGain.removeAttribute('title');
  }
  modalSongDuration.textContent = formatDuration(song.duration_ms);
  
  // Spotify Link
  songModalSpotifyLink.href = `https://open.spotify.com/track/${song.id}`;
  
  // Milestone Progress
  const cumulative = Number(song.cumulative);
  const dailyGain = Number(song.daily_gain);
  // Predict from the SAME smoothed rate the Milestones tab and the Target
  // Calculator use. Predicting off a single day made this modal disagree with
  // both of them for every song (Mirrors: 254 days here vs 240 days there), and
  // the share card printed a "7D Avg Pace" next to a projection derived from a
  // different number. dailyGain above stays raw — that's today's figure, shown
  // as-is, not a forecast.
  const predictRate = effectiveDailyRate(song);
  
  // Year-End Projection
  const songProj = getYearEndProjection(cumulative, predictRate);
  const modalSongProjection = document.getElementById('modal-song-projection');
  if (modalSongProjection) {
    modalSongProjection.textContent = formatNumber(Math.round(songProj));
  }
  const nextMilestone = getNextMilestone(cumulative);
  const percent = (cumulative / nextMilestone) * 100;
  const daysRemaining = predictRate > 0
    ? Math.max(1, Math.ceil((nextMilestone - cumulative) / predictRate))
    : null;

  songModalNextMilestone.textContent = formatMilestoneName(nextMilestone);
  
  // A stalled song used to divide by a placeholder rate of 1 stream/day, which
  // printed things like "ETA: 591.0 years remaining" as if it were a forecast.
  let etaText;
  if (daysRemaining === null) {
    etaText = 'ETA: no recent growth';
  } else if (daysRemaining > 365) {
    etaText = `ETA: ${(daysRemaining / 365).toFixed(1)} years remaining`;
  } else if (daysRemaining === 1) {
    etaText = `ETA: 1 day remaining`;
  } else {
    etaText = `ETA: ${daysRemaining} days remaining`;
  }
  songModalMilestoneEta.textContent = etaText;
  songModalMilestoneProgress.style.width = `${percent.toFixed(1)}%`;
  songModalMilestonePercent.textContent = `${percent.toFixed(1)}% completed`;

  // Store metadata for card rendering
  currentSongMeta = {
    songId: song.id,
    title: song.title,
    albumTitle: song.album_title || 'Single',
    coverUrl: song.album_cover_url || theme.img || '/images/default.jpg',
    cumulative: cumulative,
    dailyGain: dailyGain,
    avg7d: Number(song.daily_avg_7d || dailyGain || 0),
    yearEndProj: Math.round(songProj),
    nextMilestone: nextMilestone,
    etaText: etaText,
    percent: percent
  };

  // Show modal
  songModal.classList.remove('hidden');
  songModalCard.scrollTop = 0;

  // Fetch History for Chart
  try {
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;
    const historyRes = await fetch(`/api/songs/${songId}/history`, { headers });
    activeSongHistory = await historyRes.json();
    
    // Set default chart tab and range tab
    songChartType = 'cumulative';
    songChartRange = '30';
    const tabs = document.querySelectorAll('#song-modal .chart-toggle-btn');
    tabs.forEach(btn => {
      if (btn.dataset.chartType === 'cumulative') btn.classList.add('active');
      else btn.classList.remove('active');
    });

    const rangeBtns = document.querySelectorAll('#song-modal .range-toggle-btn');
    rangeBtns.forEach(btn => {
      if (btn.dataset.range === '30') btn.classList.add('active');
      else btn.classList.remove('active');
    });

    renderSongChart();
  } catch (err) {
    console.error('Error fetching song history:', err);
    document.getElementById('song-chart').innerHTML = `<div class="table-empty" style="color: var(--accent-red);">Failed to load history chart.</div>`;
  }
};

function renderSongChart() {
  if (!activeSongHistory || activeSongHistory.length === 0) {
    document.getElementById('song-chart').innerHTML = `<div class="table-empty">No streaming history available.</div>`;
    return;
  }

  // Destroy existing chart
  if (activeSongChart) {
    activeSongChart.destroy();
    activeSongChart = null;
  }

  const theme = ARTIST_THEMES[currentArtist] || ARTIST_THEMES['31TPClRtHm23RisEBtV3X7'];
  
  const filteredHistory = filterHistoryByRange(activeSongHistory, songChartRange);

  const dates = filteredHistory.map(row => formatChartDate(row.recorded_date));
  let dataPoints = [];
  let seriesName = '';
  
  if (songChartType === 'cumulative') {
    dataPoints = filteredHistory.map(row => Number(row.cumulative));
    seriesName = 'Total Streams';
  } else {
    dataPoints = filteredHistory.map(row => Number(row.daily_gain));
    seriesName = 'Daily Streams';
  }

  const options = {
    series: [{
      name: seriesName,
      data: dataPoints
    }],
    chart: {
      type: songChartType === 'cumulative' ? 'area' : 'bar',
      height: 280,
      background: 'transparent',
      foreColor: '#94a3b8',
      toolbar: { show: false }
    },
    colors: [theme.accent],
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.4,
        opacityTo: 0.02,
        stops: [0, 100]
      }
    },
    dataLabels: { enabled: false },
    stroke: {
      curve: 'smooth',
      width: 3
    },
    xaxis: {
      categories: dates,
      // See renderAlbumChart: cap the label count so a long history stays legible.
      tickAmount: Math.min(8, Math.max(2, dates.length - 1)),
      labels: { rotate: -45, rotateAlways: false, hideOverlappingLabels: true, trim: false },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tooltip: { enabled: false }
    },
    yaxis: {
      labels: {
        formatter: function (val) {
          if (val >= 1000000000) return (val / 1000000000).toFixed(1) + 'B';
          if (val >= 1000000) return (val / 1000000).toFixed(0) + 'M';
          return val.toLocaleString();
        }
      }
    },
    grid: {
      borderColor: 'rgba(255,255,255,0.04)',
      strokeDashArray: 4
    },
    tooltip: {
      theme: 'dark',
      x: { show: true },
      y: {
        formatter: function (val) {
          return val.toLocaleString();
        }
      }
    }
  };

  activeSongChart = new ApexCharts(document.querySelector('#song-chart'), options);
  activeSongChart.render();
}

function closeSongModal() {
  songModal.classList.add('hidden');
  if (activeSongChart) {
    activeSongChart.destroy();
    activeSongChart = null;
  }
}

// Bind Song Modal Close Elements
if (songModalCloseBtn) {
  songModalCloseBtn.addEventListener('click', closeSongModal);
}
if (songModal) {
  songModal.addEventListener('click', (e) => {
    if (e.target === songModal) closeSongModal();
  });
}

// Bind Song Chart Toggle Elements
const chartToggleBtns = document.querySelectorAll('#song-modal .chart-toggle-btn');
chartToggleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    chartToggleBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    songChartType = btn.dataset.chartType;
    renderSongChart();
  });
});

const rangeToggleBtns = document.querySelectorAll('#song-modal .range-toggle-btn');
rangeToggleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    rangeToggleBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    songChartRange = btn.dataset.range;
    renderSongChart();
  });
});

// Bump when a local hero image (e.g. /images/jt.jpg) is replaced so the browser
// fetches the new file instead of serving the cached one.
const HERO_IMAGE_VERSION = '20260614b';

// Artist Theme Configurations (accent, accentHover, accentGlow, borderGlow, bgGradient, img)
const ARTIST_THEMES = {
  '31TPClRtHm23RisEBtV3X7': { // Justin Timberlake
    accent: '#1ed760',
    accentHover: '#1db954',
    accentGlow: 'rgba(30, 215, 96, 0.4)',
    borderGlow: 'rgba(30, 215, 96, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #111a2e 0%, #080c14 100%)',
    img: '/images/jt.jpg'
  },
  '5L1lO4eRHmJ7a0Q6csE5cT': { // LISA - Yellow
    accent: '#ffd700',
    accentHover: '#e5c100',
    accentGlow: 'rgba(255, 215, 0, 0.4)',
    borderGlow: 'rgba(255, 215, 0, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #2e2610 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb5cd3b3af8b72e32be78571ec'
  },
  '1HY2Jd0NmPuamShAr6KMms': { // Lady Gaga - Pink
    accent: '#ff52a2',
    accentHover: '#e03b85',
    accentGlow: 'rgba(255, 82, 162, 0.4)',
    borderGlow: 'rgba(255, 82, 162, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #301422 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5ebaadc18cac8d48124357c38e6'
  },
  '6qqNVTkY8uBg9cP3Jd7DAH': { // Billie Eilish - Lime Green
    accent: '#bad80a',
    accentHover: '#a2be09',
    accentGlow: 'rgba(186, 216, 10, 0.4)',
    borderGlow: 'rgba(186, 216, 10, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #1c240e 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb4a21b4760d2ecb7b0dcdc8da'
  },
  '66CXWjxzNUsdJxJ2JdwvnR': { // Ariana Grande - Lavender
    accent: '#b39ddb',
    accentHover: '#9575cd',
    accentGlow: 'rgba(179, 157, 219, 0.4)',
    borderGlow: 'rgba(179, 157, 219, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #1c142b 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb766397ec42a573a53eb5fb87'
  },
  '6Ff53KvcvAj5U7Z1vojB5o': { // *NSYNC - Frosted Blue
    accent: '#3498db',
    accentHover: '#2980b9',
    accentGlow: 'rgba(52, 152, 219, 0.4)',
    borderGlow: 'rgba(52, 152, 219, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #112036 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb9414ef07d0ca697726912df1'
  },
  '3p3U04w2DaiBzuYMZnYr00': { // JC Chasez - Crimson Red
    accent: '#e74c3c',
    accentHover: '#c0392b',
    accentGlow: 'rgba(231, 76, 60, 0.4)',
    borderGlow: 'rgba(231, 76, 60, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #291212 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb784d1c3b5bb30c5db83c8fe2'
  },
  '3LHYvj5ZejV1NLqncEObSJ': { // Vaelis - Indigo/Purple
    accent: '#8b5cf6',
    accentHover: '#7c3aed',
    accentGlow: 'rgba(139, 92, 246, 0.4)',
    borderGlow: 'rgba(139, 92, 246, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #1c1236 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb05e2f96f53a2810f5dcdd6c1'
  },
  '2dIgFjalVxs4ThymZ67YCE': { // Stray Kids - Platinum/Cyber
    accent: '#e2e2e7',
    accentHover: '#c7c7cc',
    accentGlow: 'rgba(226, 226, 231, 0.4)',
    borderGlow: 'rgba(226, 226, 231, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #242428 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5ebf9887d2c9288f0e50a3fd69f'
  },
  '4UIOuc84ExWojcUzFGtb8W': { // Felix - Warm Gold/Amber
    accent: '#ffb703',
    accentHover: '#fb8500',
    accentGlow: 'rgba(255, 183, 3, 0.4)',
    borderGlow: 'rgba(255, 183, 3, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #2f2208 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb51e1a166ae0cc73d8ec19909'
  },
  '2W8yFh0Ga6Yf3jiayVxwkE': { // Dove Cameron - Lavender/Violet
    accent: '#b794f6',
    accentHover: '#9f7aea',
    accentGlow: 'rgba(183, 148, 246, 0.4)',
    borderGlow: 'rgba(183, 148, 246, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #241a33 0%, #080c14 100%)',
    img: 'https://i.scdn.co/image/ab6761610000e5eb0c5fcd837c1420d97f500ef9'
  }
};

// Neutral landing/default look — the original style.css :root values. Kept
// SEPARATE from any artist's theme so editing an artist (e.g. JT → blue) can't
// leak onto the picker or onto artists that don't have their own theme. Used
// both as the unknown-artist fallback and when returning to the picker.
const LANDING_THEME = {
  accent: '#1ed760',
  accentHover: '#1db954',
  accentGlow: 'rgba(30, 215, 96, 0.4)',
  borderGlow: 'rgba(30, 215, 96, 0.3)',
  bgGradient: 'radial-gradient(circle at 50% 0%, #111a2e 0%, #080c14 100%)'
};

function applyArtistTheme(artistId) {
  // Header extras that are artist-specific ride along with the theme switch.
  syncStatsCardButton(artistId);
  if (typeof syncNotifyButton === 'function') syncNotifyButton();
  const theme = ARTIST_THEMES[artistId] || LANDING_THEME;
  document.documentElement.style.setProperty('--accent-green', theme.accent);
  document.documentElement.style.setProperty('--accent-green-rgb', hexToRgbTriplet(theme.accent));
  document.documentElement.style.setProperty('--accent-green-hover', theme.accentHover);
  document.documentElement.style.setProperty('--accent-green-glow', theme.accentGlow);
  document.documentElement.style.setProperty('--card-border-glow', theme.borderGlow);
  document.documentElement.style.setProperty('--bg-gradient', theme.bgGradient);

  // Update Profile Hero card
  if (artistProfileName) {
    artistProfileName.textContent = currentArtistName || 'Artist';
  }
  if (theme.img) {
    // Local images can be hot-swapped; bust the browser cache so a new file shows immediately.
    const isLocal = theme.img.startsWith('/');
    const src = isLocal ? `${theme.img}?v=${HERO_IMAGE_VERSION}` : theme.img;
    if (artistHeroAvatar) {
      artistHeroAvatar.src = src;
      artistHeroAvatar.alt = currentArtistName || 'Artist';
    }
    if (artistHeroBanner) {
      artistHeroBanner.style.backgroundImage = `url('${src}')`;
    }
  }
}

// Fade the dashboard content + show a themed spinner while an artist's data loads.
const dashboardMain = document.querySelector('.dashboard-container');
function setDashboardLoading(on) {
  if (dashboardMain) dashboardMain.classList.toggle('is-loading', on);
}

// Reset every per-artist control back to its default when the artist changes,
// so one artist's picks never leak into the next: the songs search / Solo-
// Featured filter / column sort, the album search + sort, the milestone
// filter, and the Target Calculator's picked item (its box used to keep the
// previous artist's song title).
function resetArtistScopedControls() {
  // Songs list controls
  searchFilter = '';
  if (searchInput) searchInput.value = '';
  typeFilter = 'all';
  filterButtons.forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  songsExpanded = false;
  currentSortField = 'streams';
  currentSortDirection = 'desc';
  sortHeaders.forEach(th => {
    th.classList.toggle('active', th.dataset.sort === 'streams');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = th.dataset.sort === 'streams' ? '▼' : '';
  });

  // Album list controls
  albumSearchFilter = '';
  albumSortField = 'streams-desc';
  if (albumSearchInput) albumSearchInput.value = '';
  if (albumSortSelect) albumSortSelect.value = 'streams-desc';

  // Milestone filter buttons
  milestoneFilter = 'all';
  if (milestoneFilterButtons) {
    milestoneFilterButtons.forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  }

  // Target Calculator
  tcSelected = '';
  if (tcItemEl) tcItemEl.value = '';
  if (tcValueEl) tcValueEl.value = '';
  if (tcResultEl) tcResultEl.innerHTML = '';
  hideTcOptions();
}

// Artist Selector Handler
const artistSelector = document.getElementById('artist-selector');
const dashboardTitle = document.getElementById('dashboard-title');
if (artistSelector) {
  artistSelector.addEventListener('change', async (e) => {
    currentArtist = e.target.value;
    currentArtistName = e.target.options[e.target.selectedIndex]?.text || currentArtistName;

    resetArtistScopedControls();

    // Apply dynamic artist theme colors
    applyArtistTheme(currentArtist);
    
    // Update Document and Dashboard Header Title dynamically
    const selectedName = artistSelector.options[artistSelector.selectedIndex].text;
    if (dashboardTitle) {
      dashboardTitle.textContent = `${selectedName} Spotify Streams`;
    }
    document.title = `${selectedName} Spotify Streams - Fan Dashboard`;
    // Patch OG meta tags for the new artist
    if (window._patchOgForArtist) window._patchOgForArtist(currentArtist, selectedName);
    
    // For album-only artists (Gaga, Billie, Ariana), force active view to 'albums'
    if (ALBUM_ONLY_ARTISTS.has(currentArtist)) {
      if (statsGrid) statsGrid.classList.add('hidden');
      setActiveView('albums');
    } else {
      if (statsGrid) statsGrid.classList.remove('hidden');
      setActiveView('songs');
    }
    setDashboardLoading(true);
    try {
      await Promise.all([fetchData(), fetchAlbumsData()]);
    } finally {
      setDashboardLoading(false);
    }
  });
}

// ========== Artist Picker Logic ==========
const pickerSection = document.getElementById('artist-picker');
const dashboardWrapper = document.getElementById('dashboard-wrapper');
const backToPickerBtn = document.getElementById('back-to-picker-btn');
const artistSearchInput = document.getElementById('artist-search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
let artistSearchQuery = '';

// ===== Picker kategori filtresi + "yeni eklendi" rozeti =====
// Etiketler tracked_artists.categories'ten geliyor ve bir sanatci birden fazla
// tasiyabiliyor (LISA hem female hem kpop). Filtre TEK secim: kesisim degil,
// tek kova. Etiketsiz sanatcilar yalnizca "All"da gorunur — yanlis bir kovaya
// koymaktansa filtresiz birakmak dogru.
let artistCategoryFilter = 'all';

// ===== Favoriler =====
// Ziyaretcilerin cogu birkac sanatci icin geliyor ve her seferinde 57 kartlik
// gridden onlari ariyordu. Favoriler listenin EN USTUNE sabitleniyor, boylece
// hicbir tiklama gerekmeden gorunuyorlar.
//
// Once tek bir "acilis sanatcisi" yapmistim: site dogrudan o sanatciya
// aciliyordu. Coklu favori daha iyi cikti — insanlar tek sanatci takip etmiyor,
// ve otomatik yonlendirme gride donmeyi zorlastirdigi icin kilitli hissettiren
// bir tarafi vardi. Burada yonlendirme yok; sadece erisim kisaliyor.
//
// Tercih tarayicida (localStorage) duruyor: sitenin hesap sistemi yok ve bir
// favori listesi icin hesap istemek ozellikten buyuk bir bedel olurdu.
const FAVORITES_KEY = 'favorite-artists';

function getFavorites() {
  try {
    const ham = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    return Array.isArray(ham) ? ham.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function setFavorites(list) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...new Set(list)])); } catch {}
}
function isFavorite(id) { return getFavorites().includes(id); }
function toggleFavorite(id) {
  const f = getFavorites();
  setFavorites(f.includes(id) ? f.filter(x => x !== id) : [...f, id]);
}

// Buton etiketi her zaman GORUNTULENEN sanatciya gore.
function syncFavoriteBtn() {
  const btn = document.getElementById('favorite-btn');
  const label = document.getElementById('favorite-btn-label');
  if (!btn || !label || !currentArtist) return;
  const fav = isFavorite(currentArtist);
  btn.classList.toggle('fav-active', fav);
  label.textContent = fav ? 'Favorited' : 'Add to favorites';
  btn.title = fav ? 'Remove from your favorites' : 'Pin this artist to the top of the list';
}

const KATEGORI_ETIKET = { female: 'Female', male: 'Male', kpop: 'K-pop', latin: 'Latin', ai: 'AI' };
const KATEGORI_SIRA = ['female', 'male', 'kpop', 'latin', 'ai'];

// Kac gun "yeni" sayilir. Iki hafta: bir donusu kacirsan bile duyuruyu
// goruyorsun, ama Eylul'de hala "yeni" diye durmuyor.
const YENI_GUN = 14;

function yeniMi(a) {
  if (!a || !a.added_on) return false;
  const eklendi = new Date(`${a.added_on}T12:00:00Z`).getTime();
  if (!Number.isFinite(eklendi)) return false;
  return (Date.now() - eklendi) < YENI_GUN * 864e5;
}

function renderPickerFilters() {
  const wrap = document.getElementById('picker-filters');
  if (!wrap) return;
  // Yalnizca gercekten kullanilan etiketler icin cip cikar: bos bir "AI"
  // sekmesi tiklandiginda bos ekran demek.
  const mevcut = new Set();
  (currentRoster || []).forEach(a => (a.categories || []).forEach(c => mevcut.add(c)));
  // Bilinenler once ve sabit sirada; rosterda gecen ama burada tanimli olmayan
  // etiketler arkadan alfabetik. Admin panelinden yeni bir kategori eklendiginde
  // cip kod degistirmeden beliriyor — aksi halde etiket DB'de olur, sitede
  // gorunmezdi.
  const bilinen = KATEGORI_SIRA.filter(c => mevcut.has(c));
  const digerleri = [...mevcut].filter(c => !KATEGORI_SIRA.includes(c)).sort();
  const cipler = [['all', 'All']].concat(
    [...bilinen, ...digerleri].map(c => [c, KATEGORI_ETIKET[c] || c])
  );
  if (cipler.length < 2) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = cipler.map(([id, label]) => {
    const say = id === 'all'
      ? (currentRoster || []).length
      : (currentRoster || []).filter(a => (a.categories || []).includes(id)).length;
    const aktif = artistCategoryFilter === id;
    return `<button type="button" role="tab" aria-selected="${aktif}" class="picker-filter${aktif ? ' active' : ''}" data-cat="${escHtml(id)}">${escHtml(label)}<span class="picker-filter-count">${say}</span></button>`;
  }).join('');
  wrap.querySelectorAll('.picker-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      artistCategoryFilter = btn.dataset.cat;
      renderPickerRoster();
    });
  });
}

function renderNewArtistsNote() {
  const el = document.getElementById('new-artists-note');
  if (!el) return;
  const yeniler = (currentRoster || []).filter(yeniMi)
    .sort((a, b) => String(b.added_on).localeCompare(String(a.added_on)));
  if (!yeniler.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  // En fazla bes isim. Yogun bir haftada on iki isim tek satirda duvar oluyor
  // ve duyuru olmaktan cikiyor; gerisi sayiya iniyor, hepsi zaten gridde NEW
  // rozetiyle duruyor.
  const GOSTER = 5;
  const adlar = yeniler.slice(0, GOSTER).map(a => escHtml(a.name)).join(', ');
  const kalan = yeniler.length - GOSTER;
  el.classList.remove('hidden');
  el.innerHTML = `<span class="new-artists-tag">NEW</span>` +
    `<span>Just added: ${adlar}${kalan > 0 ? ` and ${kalan} more` : ''}</span>`;
}

// Enter dashboard for a specific artist
async function enterDashboard(artistId, artistName) {
  currentArtist = artistId;
  currentArtistName = artistName || '';

  resetArtistScopedControls();

  // Apply dynamic artist theme colors
  applyArtistTheme(artistId);
  // Patch OG meta tags for the selected artist
  if (window._patchOgForArtist) window._patchOgForArtist(artistId, artistName);
  
  // Update dropdown to match
  if (artistSelector) {
    artistSelector.value = artistId;
  }
  
  // Update titles
  if (dashboardTitle) {
    dashboardTitle.textContent = `${artistName} Spotify Streams`;
  }
  document.title = `${artistName} Spotify Streams - Fan Dashboard`;
  
  // Hide picker, show dashboard
  pickerSection.classList.add('hidden');
  dashboardWrapper.classList.remove('hidden');
  
  // Set correct view based on artist type
  if (ALBUM_ONLY_ARTISTS.has(currentArtist)) {
    if (statsGrid) statsGrid.classList.add('hidden');
    setActiveView('albums');
  } else {
    if (statsGrid) statsGrid.classList.remove('hidden');
    setActiveView('songs');
  }
  syncFavoriteBtn();
  setDashboardLoading(true);
  try {
    await Promise.all([fetchData(), fetchAlbumsData()]);
  } finally {
    setDashboardLoading(false);
  }

  // Scroll to top
  window.scrollTo(0, 0);
}

// Go back to picker
function showPicker() {
  dashboardWrapper.classList.add('hidden');
  pickerSection.classList.remove('hidden');
  applyArtistTheme(null); // Reset to the neutral landing theme (NOT any artist's theme)
  window.scrollTo(0, 0);

  if (artistSearchInput) {
    artistSearchInput.value = '';
    artistSearchQuery = '';
  }
  if (clearSearchBtn) {
    clearSearchBtn.classList.add('hidden');
  }
  renderPickerRoster();
}

// Function to dynamically add JC Chasez to the dropdown selector
// (The old JC-specific addJcToDropdown / unlockJcChasezUI helpers were removed:
// locking is now generic — renderPickerRoster() rebuilds the cards + dropdown
// for any artist after unlock, driven by the admin `locked` flag.)

// Lock state is driven by the admin roster `locked` flag (not a hardcoded id),
// so locking/unlocking ANY artist in the panel takes effect. `unlockedArtists`
// holds the ids the user has unlocked this session with the access code.
let currentRoster = [];
const unlockedArtists = new Set();
// Sent as the X-JC-Passcode header on authed API calls so the server serves
// locked-artist data after the user enters a valid access code.
let jcPasscode = '';
const rosterEntry = (id) => currentRoster.find(a => a.artist_id === id);
const isArtistLocked = (id) => {
  const a = rosterEntry(id);
  return !!(a && a.locked) && !unlockedArtists.has(id);
};

// Picker card click handlers using event delegation.
// Ayni isleyici IKI kaba baglaniyor: ana grid ve favoriler serisi. Favori
// kartlari ayri bir kapta durdugu icin sadece grid'e baglamak onlari
// tiklanamaz birakirdi.
const pickerGridContainer = document.querySelector('.picker-grid');
const pickerCardClick = (() => {
  const handler = async (e) => {
    // Yildiz karti ACMAZ. Ayni kabin icinde durdugu icin tiklama once buraya
    // dusuyor; yakalayip durdurmazsak favorileme her seferinde sanatci
    // sayfasina da girerdi.
    const star = e.target.closest('.picker-fav');
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      const id = star.closest('.picker-card')?.dataset.artist;
      if (!id) return;
      toggleFavorite(id);
      syncFavoriteBtn();     // sanatci sayfasindaki buton da tutarli kalsin
      renderPickerRoster();  // seri + kartlarin yildizi yeniden cizilsin
      return;
    }
    const card = e.target.closest('.picker-card');
    if (!card) return;
    const artistId = card.dataset.artist;
    // The visible name is masked to "Locked Artist" while locked; the real one
    // is kept in data-real-name so we can pass it through after unlocking.
    const realName = card.dataset.realName || card.dataset.name;

    if (!isArtistLocked(artistId)) {
      enterDashboard(artistId, realName);
      return;
    }

    const code = prompt("Enter the access code to unlock this artist:");
    if (!code) return;
    try {
      const res = await fetch('/api/verify-jc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: code })
      });
      const data = await res.json();
      if (data.success) {
        jcPasscode = code;             // carry the code on subsequent authed API calls
        unlockedArtists.add(artistId);
        renderPickerRoster();          // reveal the card + add it to the dropdown
        enterDashboard(artistId, realName);
      } else {
        alert("Invalid code!");
      }
    } catch (err) {
      console.error('Error verifying access code:', err);
      alert('Could not reach the server.');
    }
  };
  return handler;
})();
const pickerCardKeydown = (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!e.target.closest('.picker-fav')) return;
  e.preventDefault();
  pickerCardClick(e);
};
if (pickerGridContainer) {
  pickerGridContainer.addEventListener('click', pickerCardClick);
  pickerGridContainer.addEventListener('keydown', pickerCardKeydown);
}
const favoritesGridContainer = document.getElementById('favorites-grid');
if (favoritesGridContainer) {
  favoritesGridContainer.addEventListener('click', pickerCardClick);
  favoritesGridContainer.addEventListener('keydown', pickerCardKeydown);
}

// Build (or rebuild) the picker cards + dropdown from currentRoster, honouring
// the admin `locked` flag and any artists unlocked this session. Called once by
// applyRoster and again whenever an artist is unlocked.
// Tek bir picker karti uretir. Iki yerde kart basiliyor (favoriler serisi
// ve ana grid), bu yuzden ayri bir fonksiyon: ikisini kopyalayip birinde
// duzeltme yapmayi unutmak, farkli davranan iki kart demek olurdu.
function buildPickerCard(a, index) {
    const locked = isArtistLocked(a.artist_id);
    const card = document.createElement('button');
    card.className = locked ? 'picker-card locked-card' : 'picker-card';
    card.dataset.artist = a.artist_id;
    card.dataset.realName = a.name;
    card.dataset.name = locked ? 'Locked Artist' : a.name;
    const accent = /^#[0-9a-f]{6}$/i.test(a.accent || '') ? a.accent : '#1ed760';
    card.style.setProperty('--picker-artist-accent', locked ? '#a855f7' : accent);
    // Without this the card is an unlabelled <button> — screen readers and
    // keyboard users get "button" and nothing else.
    card.setAttribute('aria-label', locked ? 'Locked artist' : a.name);

    if (locked) {
      card.innerHTML = `
        <div class="picker-card-img-wrap locked-img-wrap">
          <div class="lock-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lock-svg">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>
          <div class="picker-card-overlay"></div>
        </div>
        <div class="picker-card-info">
          <span class="picker-card-accent" aria-hidden="true"></span>
          <h3>Locked Artist</h3>
        </div>
      `;
    } else {
      // Only the first visible row is render-critical. With 40+ artists,
      // eagerly downloading every avatar delays the picker for no benefit.
      const loading = index < 6 ? 'eager' : 'lazy';
      const fetchPriority = index < 6 ? 'high' : 'low';
      card.innerHTML = `
        <div class="picker-card-img-wrap">
          <img src="${escHtml(a.image_url || '/images/default.jpg')}" alt="${escHtml(a.name)}" class="picker-card-img" loading="${loading}" fetchpriority="${fetchPriority}" decoding="async">
          <div class="picker-card-overlay"></div>
          ${yeniMi(a) ? '<span class="picker-new-badge">NEW</span>' : ''}
          <span class="picker-fav${isFavorite(a.artist_id) ? ' is-fav' : ''}"
                role="button" tabindex="0"
                aria-pressed="${isFavorite(a.artist_id)}"
                aria-label="${isFavorite(a.artist_id) ? 'Remove from favorites' : 'Add to favorites'}"
                title="${isFavorite(a.artist_id) ? 'Remove from favorites' : 'Add to favorites'}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2.5 15 9 22 9.7 16.8 14.3 18.4 21 12 17.4 5.6 21 7.2 14.3 2 9.7 9 9"></polygon></svg>
          </span>
        </div>
        <div class="picker-card-info">
          <span class="picker-card-accent" aria-hidden="true"></span>
          <h3>${escHtml(a.name)}</h3>
        </div>
      `;
    }
  return card;
}

// Favori serisi. Ana gridin USTUNDE duruyor ve arama/kategori filtresinden
// etkilenmiyor: favoriler kisisel bir kisayol, gecici bir filtrenin altinda
// kaybolmamali.
function renderFavorites() {
  const bolum = document.getElementById('favorites-section');
  const grid = document.getElementById('favorites-grid');
  if (!bolum || !grid) return;
  const favler = getFavorites();
  const roster = currentRoster || [];
  // Kaldirilmis/pasif/kilitli favoriler sessizce dusuyor — kirik bir kayit
  // yuzunden kimse tiklanamayan bir kart gormemeli.
  const kartlar = favler
    .map(id => roster.find(a => a.artist_id === id))
    .filter(a => a && a.active !== false && !isArtistLocked(a.artist_id));
  // Favori YOKKEN de bolumu gosteriyoruz, tek satirlik bir ipucuyla. Eskiden
  // gizleniyordu ve ozellik ancak zaten kullaniyorsan gorunur oluyordu: yeni
  // gelen biri boyle bir sey oldugunu anlayamiyordu. Ilk favoriden sonra ipucu
  // kendiliginden kayboluyor.
  const ipucu = bolum.querySelector('.favorites-empty');
  bolum.classList.remove('hidden');
  if (!kartlar.length) {
    grid.innerHTML = '';
    if (ipucu) ipucu.classList.remove('hidden');
    return;
  }
  if (ipucu) ipucu.classList.add('hidden');
  grid.innerHTML = '';
  kartlar.forEach((a, i) => grid.appendChild(buildPickerCard(a, i)));
}

function renderPickerRoster() {
  const roster = currentRoster;
  // Cipler ve duyuru da roster'dan turuyor; ayni yerden guncellenince
  // sayilar listeyle her zaman tutarli kaliyor.
  renderFavorites();
  renderPickerFilters();
  renderNewArtistsNote();
  const grid = document.querySelector('.picker-grid');
  if (grid) {
    grid.classList.add('roster-ready');   // reveal now that we have the live roster
    grid.innerHTML = '';

    const filteredRoster = roster.filter(a => {
      if (artistCategoryFilter !== 'all' &&
          !(a.categories || []).includes(artistCategoryFilter)) return false;
      const query = artistSearchQuery.toLowerCase().trim();
      if (!query) return true;
      const nameMatch = a.name.toLowerCase().includes(query);
      const lockedMatch = isArtistLocked(a.artist_id) && 'locked artist'.includes(query);
      return nameMatch || lockedMatch;
    });

    if (filteredRoster.length === 0) {
      grid.innerHTML = artistSearchQuery.trim()
        ? `<div class="picker-no-results">No artists found matching "${escHtml(artistSearchQuery)}"</div>`
        : `<div class="picker-no-results">No artists in this category yet</div>`;
    } else {
      filteredRoster.forEach((a, index) => {
        grid.appendChild(buildPickerCard(a, index));
      });
    }
  }

  const artistSelector = document.getElementById('artist-selector');
  if (artistSelector) {
    artistSelector.innerHTML = '';
    roster.forEach(a => {
      if (!isArtistLocked(a.artist_id)) {
        const option = document.createElement('option');
        option.value = a.artist_id;
        option.text = a.name;
        artistSelector.appendChild(option);
      }
    });
    if (currentArtist) artistSelector.value = currentArtist;
  }
}

// Back to picker button
if (backToPickerBtn) {
  backToPickerBtn.addEventListener('click', showPicker);
}

// Favori butonu. Ayni buton hem ekler hem cikarir — ayri bir "kaldir"
// kontrolu, tercihi geri almanin zor oldugu izlenimini verir.
const favoriteBtn = document.getElementById('favorite-btn');
if (favoriteBtn) {
  favoriteBtn.addEventListener('click', () => {
    if (!currentArtist) return;
    toggleFavorite(currentArtist);
    // Geri bildirim etiketin kendisi: "Add to favorites" → "Favorited".
    syncFavoriteBtn();
    renderFavorites();   // gride donuldugunde seri guncel olsun
  });
}

// Search input filter binding
if (artistSearchInput) {
  artistSearchInput.addEventListener('input', (e) => {
    artistSearchQuery = e.target.value;
    if (clearSearchBtn) {
      if (artistSearchQuery) {
        clearSearchBtn.classList.remove('hidden');
      } else {
        clearSearchBtn.classList.add('hidden');
      }
    }
    renderPickerRoster();
  });
}

// Clear search button binding
if (clearSearchBtn) {
  clearSearchBtn.addEventListener('click', () => {
    if (artistSearchInput) {
      artistSearchInput.value = '';
      artistSearchQuery = '';
      clearSearchBtn.classList.add('hidden');
      renderPickerRoster();
      artistSearchInput.focus();
    }
  });
}

// ---- Apply the admin-managed roster (/api/artists) over the static picker,
// dropdown and themes. Progressive enhancement: the page already works with the
// hardcoded markup; this just patches names / images / accents / order /
// album-only to match what's been edited in the admin panel. Locked artists (JC)
// are left untouched so the lock isn't bypassed. Fails silently on any error, so
// the hardcoded values always remain as a fallback.

// Derive full theme palette from a single hex accent colour.
// Keeps hover/glow/gradient in sync when admin changes only the accent.
function deriveThemeFromAccent(hex) {
  // Parse #rrggbb or #rgb into { r, g, b }
  let r, g, b;
  const h = hex.replace('#', '');
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  // Hover: darken by ~12 %
  const dr = Math.max(0, Math.round(r * 0.88));
  const dg = Math.max(0, Math.round(g * 0.88));
  const db = Math.max(0, Math.round(b * 0.88));
  const toHex = n => n.toString(16).padStart(2, '0');
  // Background tint: dark version of accent for the hero gradient. Bumped
  // 0.18 -> 0.24 — the cover-extracted save-card background read a shade too dark.
  let tr = Math.min(255, Math.round(r * 0.24));
  let tg = Math.min(255, Math.round(g * 0.24));
  let tb = Math.min(255, Math.round(b * 0.24));
  // Perceptual floor: a flat 0.24 scale leaves BLUE tints far darker to the eye
  // than warm ones (blue's luma weight is 0.07 vs 0.72 for green), so blue-cover
  // cards (Justified, 20/20) read murky while warm covers (FS/LS) glow. Lift only
  // tints below the target luma — warm covers already clear it and stay untouched.
  const TINT_TARGET_LUMA = 40;
  const luma = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb;
  if (luma > 0 && luma < TINT_TARGET_LUMA) {
    const s = TINT_TARGET_LUMA / luma;
    tr = Math.min(255, Math.round(tr * s));
    tg = Math.min(255, Math.round(tg * s));
    tb = Math.min(255, Math.round(tb * s));
  }
  return {
    accent:      hex,
    accentHover: `#${toHex(dr)}${toHex(dg)}${toHex(db)}`,
    accentGlow:  `rgba(${r}, ${g}, ${b}, 0.4)`,
    borderGlow:  `rgba(${r}, ${g}, ${b}, 0.3)`,
    bgGradient:  `radial-gradient(circle at 50% 0%, rgb(${tr},${tg},${tb}) 0%, #080c14 100%)`,
  };
}

(async function applyRoster() {
  // If we can't load the live roster, reveal the static fallback cards so the
  // picker isn't left invisible (the grid starts hidden to avoid the old-order
  // flash — see .picker-grid in style.css).
  const revealStaticFallback = () =>
    document.querySelector('.picker-grid')?.classList.add('roster-ready');

  let roster;
  try {
    const res = await fetch('/api/artists');
    if (!res.ok) { revealStaticFallback(); return; }
    roster = await res.json();
  } catch { revealStaticFallback(); return; }
  if (!Array.isArray(roster) || !roster.length) { revealStaticFallback(); return; }

  const byId = {};
  roster.forEach(a => { byId[a.artist_id] = a; });
  const order = (id) => (byId[id]?.sort_order ?? 999);

  // Rebuild the album-only set so admin toggles take effect.
  ALBUM_ONLY_ARTISTS.clear();
  roster.forEach(a => {
    if (a.album_only) ALBUM_ONLY_ARTISTS.add(a.artist_id);

    // Dynamic theme initialization if it doesn't exist.
    if (!ARTIST_THEMES[a.artist_id]) {
      ARTIST_THEMES[a.artist_id] = {
        accent: '#1ed760',
        accentHover: '#1db954',
        accentGlow: 'rgba(30, 215, 96, 0.4)',
        borderGlow: 'rgba(30, 215, 96, 0.3)',
        bgGradient: 'radial-gradient(circle at 50% 0%, #111a2e 0%, #080c14 100%)',
        img: a.image_url || '/images/default.jpg'
      };
    }

    const th = ARTIST_THEMES[a.artist_id];
    if (a.image_url) th.img = a.image_url;
    if (a.accent) {
      const derived = deriveThemeFromAccent(a.accent);
      th.accent      = derived.accent;
      th.accentHover = derived.accentHover;
      th.accentGlow  = derived.accentGlow;
      th.borderGlow  = derived.borderGlow;
      th.bgGradient  = derived.bgGradient;
    }
  });

  // Build the picker cards + dropdown from the roster (lock-aware, re-renderable).
  currentRoster = roster;
  renderPickerRoster();

  // Deep-link: a shared /?artist=<id> link (the per-artist OG share card) should
  // open that artist's dashboard directly instead of dropping the visitor on the
  // picker. Only auto-enter active, unlocked artists; locked ones still need the code.
  try {
    const want = (new URLSearchParams(location.search).get('artist') || '')
      .replace('spotify:artist:', '').trim();
    const a = want && byId[want];
    if (a && a.active !== false && !isArtistLocked(want)) {
      enterDashboard(want, a.name);
    }
  } catch (_) { /* on any error the picker remains as the fallback */ }

  // ---- Adım 4: OG meta tag patch ----
  // Patch og:image + og:title for the currently selected artist (if any).
  // Also sets up a hook so switching artists later also updates OG tags.
  function patchOgForArtist(artistId, artistName) {
    const a = byId[artistId];
    if (!a) return;
    const ogImage = document.querySelector('meta[property="og:image"]');
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc  = document.querySelector('meta[property="og:description"]');
    if (ogImage && a.image_url) ogImage.setAttribute('content', a.image_url);
    if (ogTitle && artistName)  ogTitle.setAttribute('content', `${artistName} Spotify Streams — Fan Dashboard`);
    if (ogDesc  && artistName)  ogDesc.setAttribute('content',  `Live Spotify stream counts, daily gains and milestone tracking for ${artistName}.`);
  }
  // Patch immediately if an artist is already selected (e.g. back from picker).
  if (currentArtist) patchOgForArtist(currentArtist, currentArtistName);
  // Expose so artistSelector change handler can call it after applyRoster runs.
  window._patchOgForArtist = patchOgForArtist;
})();

// Do NOT auto-load — wait for picker selection

function showMobileImageOverlay(imageUrl, albumTitle) {
  const overlay = document.createElement('div');
  overlay.id = 'mobile-image-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  // Fully opaque: iOS Safari doesn't always honor backdrop-filter here, and the
  // capture-expanded modal behind would bleed through a translucent backdrop.
  overlay.style.backgroundColor = '#04060a';
  overlay.style.zIndex = '9999';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.padding = '24px';
  overlay.style.boxSizing = 'border-box';

  overlay.innerHTML = `
    <div style="text-align: center; margin-bottom: 20px; color: #fff; max-width: 90%;">
      <h3 style="margin: 0 0 8px 0; font-family: 'Outfit', sans-serif; font-size: 1.4rem; font-weight: 700; color: #1db954;">Image Ready!</h3>
      <p style="margin: 0; font-size: 0.95rem; opacity: 0.9; font-family: 'Inter', sans-serif; line-height: 1.5;">
        To save it, <strong>press and hold</strong> the image and choose <strong>"Add to Photos"</strong> or <strong>"Save Image"</strong>.
      </p>
    </div>
    <div style="max-width: 100%; max-height: 60vh; overflow-y: auto; border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1); background: #080c14;">
      <img src="${imageUrl}" alt="${albumTitle}" style="width: 100%; height: auto; display: block; border-radius: 16px;">
    </div>
    <button id="close-mobile-overlay" style="margin-top: 25px; padding: 12px 32px; border: none; background: linear-gradient(135deg, rgba(29, 185, 84, 0.2) 0%, rgba(29, 185, 84, 0.1) 100%); color: #1db954; border-radius: 24px; font-weight: 700; cursor: pointer; font-family: 'Outfit', sans-serif; border: 1px solid rgba(29, 185, 84, 0.4); box-shadow: 0 4px 12px rgba(29, 185, 84, 0.15); transition: all 0.2s; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px;">
      Close
    </button>
  `;

  document.body.appendChild(overlay);

  // Lock the page behind the overlay — on iOS the body keeps scrolling under
  // fixed overlays, exposing the capture-expanded modal.
  const origBodyOverflow = document.body.style.overflow;
  const origHtmlOverflow = document.documentElement.style.overflow;
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';

  document.getElementById('close-mobile-overlay').addEventListener('click', () => {
    overlay.remove();
    document.body.style.overflow = origBodyOverflow;
    document.documentElement.style.overflow = origHtmlOverflow;
    if (imageUrl && imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
  });
}

// ---- Feedback / request form ----
(function initFeedbackForm() {
  const fab = document.getElementById('feedback-fab');
  const modal = document.getElementById('feedback-modal');
  const closeBtn = document.getElementById('feedback-close-btn');
  const form = document.getElementById('feedback-form');
  const messageEl = document.getElementById('feedback-message');
  const contactEl = document.getElementById('feedback-contact');
  const submitBtn = document.getElementById('feedback-submit');
  const statusEl = document.getElementById('feedback-status');
  if (!fab || !modal || !form) return;

  const open = () => {
    modal.classList.remove('hidden');
    statusEl.textContent = '';
    statusEl.className = 'feedback-status';
    setTimeout(() => messageEl.focus(), 50);
  };
  const close = () => modal.classList.add('hidden');

  fab.addEventListener('click', open);
  closeBtn.addEventListener('click', close);

  // On phones the button is pinned over the right-hand DAILY column, so it
  // permanently covers one row's number. Hide it while the reader is scrolling
  // DOWN a list and bring it back the moment they scroll up or reach the top —
  // the desktop layout has room to spare, so leave it alone there.
  const smallScreen = window.matchMedia('(max-width: 768px)');
  let lastScrollY = window.scrollY;
  let scrollTicking = false;
  const syncFabVisibility = () => {
    scrollTicking = false;
    if (!smallScreen.matches) { fab.classList.remove('fab-hidden'); return; }
    const y = window.scrollY;
    const delta = y - lastScrollY;
    // Ignore sub-pixel jitter and rubber-band overscroll at the very top.
    if (Math.abs(delta) < 6) return;
    lastScrollY = y;
    fab.classList.toggle('fab-hidden', delta > 0 && y > 120);
  };
  window.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(syncFabVisibility);
  }, { passive: true });
  // A modal opening/closing changes the scroll context — never leave it stranded.
  smallScreen.addEventListener('change', () => fab.classList.remove('fab-hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = messageEl.value.trim();
    if (message.length < 3) {
      statusEl.textContent = 'Please write a few words.';
      statusEl.className = 'feedback-status err';
      return;
    }
    submitBtn.disabled = true;
    statusEl.textContent = 'Sending...';
    statusEl.className = 'feedback-status';
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          contact: contactEl.value.trim(),
          artist: currentArtist || '',
          page: location.pathname + location.search,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        statusEl.textContent = 'Thanks! Got it. 💚';
        statusEl.className = 'feedback-status ok';
        form.reset();
        setTimeout(close, 1400);
      } else {
        statusEl.textContent = data.error || 'Could not send, please try again later.';
        statusEl.className = 'feedback-status err';
      }
    } catch {
      statusEl.textContent = 'Connection error, please try again later.';
      statusEl.className = 'feedback-status err';
    } finally {
      submitBtn.disabled = false;
    }
  });
})();

// ---- Scraper Status Polling & Overlay ----
(function initScraperStatus() {
  const banner = document.getElementById('sync-banner');
  const bannerText = document.getElementById('sync-banner-text');
  if (!banner) return;

  let lastStatus = 'idle';
  let lastSelectedDate = null; // last seen snapshot date for the viewed artist

  async function checkScraperStatus() {
    try {
      const res = await fetch('/api/scraper-status');
      if (!res.ok) { await updateSync({ status: 'idle', artists: [] }); return; }
      await updateSync(await res.json());
    } catch (err) {
      console.error('Failed to fetch scraper status:', err);
      await updateSync({ status: 'idle', artists: [] });
    }
  }

  const dayOf = (d) => (d ? String(d).slice(0, 10) : null);

  // Work out, from the per-artist snapshot dates, whether the artist the user is
  // currently looking at is already up to date for this run. The scrape updates
  // artists one by one, so the "leading edge" is the newest snapshot date across
  // the roster; an artist already at that date is done and safe to view.
  function selectedInfo(data) {
    const arts = Array.isArray(data.artists) ? data.artists : [];
    let maxDate = null;
    for (const a of arts) {
      const d = dayOf(a.last_date);
      if (d && (!maxDate || d > maxDate)) maxDate = d;
    }
    const sel = arts.find(a => a.artist_id === currentArtist) || null;
    const selDate = sel ? dayOf(sel.last_date) : null;
    return { maxDate, sel, selDate, selectedFresh: !!(selDate && maxDate && selDate >= maxDate) };
  }

  async function reloadCurrent() {
    if (!currentArtist) return;
    setDashboardLoading(true);
    try { await Promise.all([fetchData(), fetchAlbumsData()]); }
    catch (err) { console.error('Failed to reload data:', err); }
    finally { setDashboardLoading(false); }
  }

  // Drives the poll cadence below — fast only while a scrape is in flight.
  let syncIsActive = false;

  async function updateSync(data) {
    const status = data.status || 'idle';
    const active = status === 'scraping' || status === 'deduping';
    syncIsActive = active;
    const { sel, selDate, selectedFresh } = selectedInfo(data);

    if (active) {
      let msg, fresh = false;
      if (status === 'deduping') {
        msg = 'Merging duplicates & finalizing — refreshing shortly…';
      } else if (sel && selectedFresh) {
        msg = `<span class="check">✓</span> ${(currentArtistName || 'This artist')} is up to date — syncing other artists…`;
        fresh = true;
      } else if (sel) {
        msg = `Syncing ${(currentArtistName || 'this artist')}’s latest playcounts…`;
      } else {
        msg = 'Syncing Spotify playcounts…';
      }
      bannerText.innerHTML = msg;
      banner.classList.toggle('fresh', fresh);
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    // Refresh the dashboard the moment the *viewed* artist's data lands — either
    // when the whole run finishes, or mid-run when this artist's snapshot date
    // advances (so a ready artist shows immediately without waiting for the rest).
    const finishedRun = (lastStatus === 'scraping' || lastStatus === 'deduping') && status === 'idle';
    const becameFresh = currentArtist && selDate && lastSelectedDate && selDate > lastSelectedDate;
    if (currentArtist && (finishedRun || becameFresh)) {
      console.log('[sync] viewed artist data updated, reloading…');
      await reloadCurrent();
    }

    lastStatus = status;
    if (selDate) lastSelectedDate = selDate;
  }

  // Check immediately on load
  checkScraperStatus();

  // Adaptive polling: fast while a scrape is in flight, unobtrusive when it
  // isn't, and asleep while the tab is in the background.
  //
  // The idle end of this ladder used to climb to 15 minutes and then stop
  // outright, because on Neon every poll from every open tab kept a metered
  // compute awake and a forgotten tab could burn the monthly allowance on its
  // own. Supabase does not bill for wake time, so that tradeoff is gone — and
  // it cost real usability: a tab left open went dead, so a sync you started
  // could finish without the page ever noticing. Idle now settles at a minute
  // and keeps going.
  const POLL_ACTIVE_MS = 10000;          // a scrape is in flight
  const POLL_IDLE_STEPS = [15000, 30000, 60000];  // 15s -> 30s -> 60s, then hold
  let pollTimer = null;
  let idleStep = 0;

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (document.hidden) return;         // resumed by visibilitychange below
    if (syncIsActive) idleStep = 0;
    // Hold at the slowest idle step instead of giving up, so an open tab keeps
    // noticing scrapes that start while nobody is looking at it.
    const step = Math.min(idleStep++, POLL_IDLE_STEPS.length - 1);
    const delay = syncIsActive ? POLL_ACTIVE_MS : POLL_IDLE_STEPS[step];
    pollTimer = setTimeout(async () => {
      await checkScraperStatus();
      schedulePoll();
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); return; }
    // Back in view: catch up once, then restart the ladder from the top.
    idleStep = 0;
    checkScraperStatus().finally(schedulePoll);
  });

  schedulePoll();
})();

// ===== Twitter Post Generator =====
(function initTwitterPostGenerator() {
  const twitterPostBtn = document.getElementById('twitter-post-btn');
  const twitterPostModal = document.getElementById('twitter-post-modal');
  const closeBtn = document.getElementById('twitter-post-close-btn');
  // The markup calls this one 'tp-cancel-btn'; the old lookup used a name that
  // doesn't exist, so getElementById returned null and the `if (cancelBtn)`
  // guard silently skipped the listener — the Close button did nothing.
  const cancelBtn = document.getElementById('tp-cancel-btn');
  const copyBtn = document.getElementById('tp-copy-btn');
  const copyBtnText = document.getElementById('tp-copy-btn-text');
  const postBtn = document.getElementById('tp-post-btn');
  const previewTextarea = document.getElementById('tp-preview-textarea');
  const songsSelect = document.getElementById('tp-songs-select');
  const includeDaily = document.getElementById('tp-include-daily');
  const includeMl = document.getElementById('tp-include-ml');
  const includeFol = document.getElementById('tp-include-fol');
  const includeDate = document.getElementById('tp-include-date');
  const useEmojis = document.getElementById('tp-use-emojis');
  const charCounter = document.getElementById('tp-char-counter');

  if (!twitterPostModal) return;

  function generateTwitterPostText() {
    if (!currentArtistName) return '';
    
    const songsLimit = songsSelect.value;
    const isDailyChecked = includeDaily.checked;
    const isMlChecked = includeMl.checked;
    const isFolChecked = includeFol.checked;
    const isDateChecked = includeDate.checked;
    const emojisChecked = useEmojis.checked;
    
    let lines = [];
    
    // Title Header
    let titleStr = '';
    if (emojisChecked) {
      titleStr += '🎵 ';
    }
    titleStr += `${currentArtistName} Spotify Stats`;
    
    if (isDateChecked && currentArtistRawStats && currentArtistRawStats.last_update) {
      const d = parseLocalDate(currentArtistRawStats.last_update);
      if (!isNaN(d.getTime())) {
        const dateFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        titleStr += ` (${dateFormatted})`;
      }
    }
    titleStr += ':';
    lines.push(titleStr);
    lines.push('');
    
    // Songs List (sorted by daily streams / gain descending)
    if (songsLimit !== 'none' && allSongs && allSongs.length > 0) {
      const limitNum = parseInt(songsLimit, 10);
      // Sort copy of songs by daily_gain desc
      const sortedByDaily = [...allSongs].sort((a, b) => Number(b.daily_gain) - Number(a.daily_gain));
      const topSongs = sortedByDaily.slice(0, limitNum);
      
      if (topSongs.length > 0) {
        lines.push(emojisChecked ? `🏆 Top Daily Streamed Songs:` : `Top Daily Streamed Songs:`);
        topSongs.forEach((song, i) => {
          const title = cleanTrackTitle(song.title);
          const dailyGain = Number(song.daily_gain);
          const formattedDaily = dailyGain > 0 ? `+${formatNumber(dailyGain)}` : formatNumber(dailyGain);
          lines.push(`${i + 1}. ${title}: ${formattedDaily}`);
        });
        lines.push('');
      }
    }
    
    // Stats (Listeners, Followers, Total Daily)
    if (isDailyChecked && currentArtistRawStats) {
      const totalDaily = Number(currentArtistRawStats.daily_gain || 0);
      const formattedTotalDaily = totalDaily > 0 ? `+${formatNumber(totalDaily)}` : formatNumber(totalDaily);
      lines.push(`${emojisChecked ? '📈 ' : ''}Total Daily Streams: ${formattedTotalDaily}`);
    }
    
    if (isMlChecked && currentArtistStats && currentArtistStats.latest) {
      const ml = currentArtistStats.latest.monthly_listeners;
      const mlChange = currentArtistStats.latest.monthly_listeners_change;
      let mlStr = `${emojisChecked ? '👥 ' : ''}Monthly Listeners: ${ml !== null && ml !== undefined ? formatNumber(ml) : '-'}`;
      if (mlChange !== null && mlChange !== undefined) {
        const arrow = mlChange > 0 ? '+' : '';
        mlStr += ` (${arrow}${formatNumber(mlChange)})`;
      }
      lines.push(mlStr);
    }
    
    if (isFolChecked && currentArtistStats && currentArtistStats.latest) {
      const fol = currentArtistStats.latest.followers;
      const folChange = currentArtistStats.latest.followers_change;
      let folStr = `${emojisChecked ? '👥 ' : ''}Followers: ${fol !== null && fol !== undefined ? formatNumber(fol) : '-'}`;
      if (folChange !== null && folChange !== undefined) {
        const arrow = folChange > 0 ? '+' : '';
        folStr += ` (${arrow}${formatNumber(folChange)})`;
      }
      lines.push(folStr);
    }
    
    return lines.join('\n').trim();
  }

  function updatePreview() {
    const text = generateTwitterPostText();
    previewTextarea.value = text;
    updateCharCounter(text.length);
  }

  // The song list loads after the artist stats, so opening the modal early used
  // to produce a post with the header and totals but NO songs — and nothing ever
  // regenerated it. fetchData() calls this once the songs land.
  window._refreshTwitterPreview = () => {
    if (!twitterPostModal.classList.contains('hidden')) updatePreview();
  };

  // 280 is the free-tier limit; X Premium allows far more. A Top 20 list blows
  // past 280 every time, so say WHY it's red instead of just flagging it — the
  // post is still perfectly postable on a Premium account.
  const X_FREE_LIMIT = 280;
  const X_PREMIUM_LIMIT = 25000;

  function updateCharCounter(len) {
    const over = len > X_FREE_LIMIT;
    charCounter.textContent = over
      ? `${formatNumber(len)} / ${X_FREE_LIMIT} · needs X Premium`
      : `${len} / ${X_FREE_LIMIT}`;
    charCounter.classList.toggle('exceeded', over);
    // Past Premium's own ceiling it isn't postable at all — that's a real error.
    charCounter.classList.toggle('hard-exceeded', len > X_PREMIUM_LIMIT);
  }

  function openTwitterPostModal() {
    if (!currentArtistRawStats) {
      alert('Please wait until dashboard data is loaded.');
      return;
    }
    
    updatePreview();
    twitterPostModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeTwitterPostModal() {
    twitterPostModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  async function handleCopy() {
    const text = previewTextarea.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      
      // Success feedback
      const origText = copyBtnText.textContent;
      copyBtnText.textContent = 'Copied! ✓';
      const origBg = copyBtn.style.background;
      const origColor = copyBtn.style.color;
      copyBtn.style.background = 'var(--accent-green)';
      copyBtn.style.color = '#000000';
      
      setTimeout(() => {
        copyBtnText.textContent = origText;
        copyBtn.style.background = origBg;
        copyBtn.style.color = origColor;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard.');
    }
  }

  function handlePost() {
    const text = previewTextarea.value;
    // The default (top 10 + all stats) runs well past 280 characters, and X
    // silently refuses to pre-fill an over-length tweet — so say it here.
    if (text.length > 280) {
      const ok = confirm(
        `This post is ${text.length} characters — X allows 280.\n\n` +
        'Open it anyway? (Trim the text, or pick fewer songs, to stay under the limit.)'
      );
      if (!ok) return;
    }
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // Event Listeners
  if (twitterPostBtn) twitterPostBtn.addEventListener('click', openTwitterPostModal);
  if (closeBtn) closeBtn.addEventListener('click', closeTwitterPostModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeTwitterPostModal);
  if (copyBtn) copyBtn.addEventListener('click', handleCopy);
  if (postBtn) postBtn.addEventListener('click', handlePost);

  // Close on backdrop click
  twitterPostModal.addEventListener('click', (e) => {
    if (e.target === twitterPostModal) closeTwitterPostModal();
  });

  // Close on ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !twitterPostModal.classList.contains('hidden')) {
      closeTwitterPostModal();
    }
  });

  // Option changes trigger regeneration
  songsSelect.addEventListener('change', updatePreview);
  includeDaily.addEventListener('change', updatePreview);
  includeMl.addEventListener('change', updatePreview);
  includeFol.addEventListener('change', updatePreview);
  includeDate.addEventListener('change', updatePreview);
  useEmojis.addEventListener('change', updatePreview);

  // Textarea manual edits update char counter
  previewTextarea.addEventListener('input', () => {
    updateCharCounter(previewTextarea.value.length);
  });
})();

/* ============================================================
   COMPARE — side-by-side "showdown" card with screenshot export.
   JT is protected: he can never be shown losing to a bigger artist
   (or album). The card simply refuses to render that matchup.
   ============================================================ */
(function compareModule() {
  const JT_ID = '31TPClRtHm23RisEBtV3X7';

  const overlay = document.getElementById('compare-overlay');
  const openBtn = document.getElementById('open-compare-btn');
  if (!overlay || !openBtn) return;

  const closeBtn   = document.getElementById('compare-close-btn');
  const cardEl     = document.getElementById('compare-card');
  const dlBtn      = document.getElementById('compare-download-btn');
  const modeBtns   = overlay.querySelectorAll('.cmp-mode-btn');
  const pickersArtists = document.getElementById('cmp-pickers-artists');
  const pickersAlbums  = document.getElementById('cmp-pickers-albums');

  const aArtist = document.getElementById('cmp-a-artist');
  const bArtist = document.getElementById('cmp-b-artist');
  const aAlbArtist = document.getElementById('cmp-a-alb-artist');
  const bAlbArtist = document.getElementById('cmp-b-alb-artist');
  const aAlbList = document.getElementById('cmp-a-album-list');
  const bAlbList = document.getElementById('cmp-b-album-list');
  const pickersSongs   = document.getElementById('cmp-pickers-songs');
  const aSongArtist = document.getElementById('cmp-a-song-artist');
  const bSongArtist = document.getElementById('cmp-b-song-artist');
  const aSongList = document.getElementById('cmp-a-song-list');
  const bSongList = document.getElementById('cmp-b-song-list');
  const aSongSearch = document.getElementById('cmp-a-song-search');
  const bSongSearch = document.getElementById('cmp-b-song-search');

  // The scraper ingests singles & remix bundles as their own "albums", which
  // floods the picker. Only surface entries with a real album's worth of tracks.
  const MIN_ALBUM_TRACKS = 6;

  let mode = 'artists';
  let canDownload = false;
  let selAlbumA = '';   // chosen album id, left side
  let selAlbumB = '';   // chosen album id, right side
  let selSongA = '';    // chosen track id, left side
  let selSongB = '';    // chosen track id, right side
  const artistDataCache = new Map(); // id -> { totalStreams, songs, daily, ml, followers }
  const albumsCache = new Map();     // artistId -> [albums]
  const songsCache = new Map();      // artistId -> [songs], streams-desc from the API

  // A catch-all artist can carry hundreds of tracks; painting them all makes the
  // picker crawl. Show the biggest ones and let the search box reach the rest.
  const SONG_LIST_LIMIT = 60;

  const cesc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const headers = () => (jcPasscode ? { 'X-JC-Passcode': jcPasscode } : {});

  // Non-locked roster only — the locked artist never enters a comparison.
  function roster() {
    return (currentRoster || []).filter(a => !isArtistLocked(a.artist_id));
  }
  function artistName(id) {
    const a = (currentRoster || []).find(x => x.artist_id === id);
    return a ? a.name : 'Artist';
  }
  function artistImg(id) {
    const a = (currentRoster || []).find(x => x.artist_id === id);
    return (ARTIST_THEMES[id] && ARTIST_THEMES[id].img) || (a && a.image_url) || '/images/default.jpg';
  }
  // Route remote images through our same-origin proxy so html2canvas can export
  // the card without cross-origin canvas tainting. Local/inline URLs pass through.
  function proxied(url) {
    if (!url) return '';
    if (url.startsWith('/') || url.startsWith('data:') || url.startsWith(location.origin)) return url;
    return '/api/img-proxy?u=' + encodeURIComponent(url);
  }

  // Album-only artists (Taylor, Billie, …) only have their albums tracked, not
  // their full catalogue — so an artist-level "total streams" comparison would be
  // partial and misleading. Drop them from the Artists-mode dropdowns; they stay
  // available in Albums mode, where per-album totals ARE complete.
  function fillArtistSelect(sel, placeholder, excludeAlbumOnly) {
    if (!sel) return;
    const prev = sel.value;
    const list = roster().filter(a => !(excludeAlbumOnly && a.album_only));
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      list.map(a => `<option value="${a.artist_id}">${cesc(a.name)}</option>`).join('');
    if (prev && list.some(a => a.artist_id === prev)) sel.value = prev;
    if (sel._comboSync) sel._comboSync();
  }

  // Replace a native <select> with a searchable, avatar-rich combobox while
  // keeping the <select> as the hidden source of truth — every reader still
  // uses `sel.value` and the `change` event, so render()/wiring is untouched.
  const chevronSVG = '<svg class="cmp-combo-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  function enhanceArtistSelect(sel) {
    if (!sel || sel.dataset.comboified) return;
    sel.dataset.comboified = '1';
    sel.classList.add('cmp-combo-native');   // visually hidden, stays in DOM/form

    const wrap = document.createElement('div');
    wrap.className = 'cmp-combo';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cmp-combo-trigger';
    const panel = document.createElement('div');
    panel.className = 'cmp-combo-panel hidden';
    panel.innerHTML =
      '<div class="cmp-combo-search-wrap">' +
        '<input type="text" class="cmp-combo-search" placeholder="Search artist…" autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="cmp-combo-list" role="listbox"></div>';
    wrap.appendChild(trigger);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);
    // Portal the panel to <body>: the compare modal has transform + backdrop-filter,
    // which would make a position:fixed child anchor to the modal (not the viewport)
    // and mis-place the dropdown on desktop. As a body child it has no such ancestor.
    document.body.appendChild(panel);

    const searchInput = panel.querySelector('.cmp-combo-search');
    const listEl = panel.querySelector('.cmp-combo-list');

    const placeholderText = () => {
      const ph = sel.querySelector('option[value=""]');
      return ph ? ph.textContent : 'Select artist';
    };
    function syncTrigger() {
      const v = sel.value;
      const opt = v && Array.from(sel.options).find(o => o.value === v);
      if (!opt) {
        trigger.classList.remove('has-val');
        trigger.innerHTML = '<span class="cmp-combo-ph">' + cesc(placeholderText()) + '</span>' + chevronSVG;
        return;
      }
      trigger.classList.add('has-val');
      trigger.innerHTML =
        '<img class="cmp-combo-ava" src="' + proxied(artistImg(v)) + '" alt="" onerror="this.src=\'/images/default.jpg\'">' +
        '<span class="cmp-combo-name">' + cesc(opt.textContent) + '</span>' + chevronSVG;
    }
    function buildRows(filter) {
      const f = (filter || '').trim().toLowerCase();
      const opts = Array.from(sel.options).filter(o => o.value &&
        (!f || o.textContent.toLowerCase().includes(f)));
      if (!opts.length) { listEl.innerHTML = '<div class="cmp-combo-empty">No artists</div>'; return; }
      listEl.innerHTML = opts.map(o =>
        '<button type="button" class="cmp-combo-row' + (o.value === sel.value ? ' selected' : '') + '" data-val="' + cesc(o.value) + '">' +
          '<img class="cmp-combo-ava" src="' + proxied(artistImg(o.value)) + '" alt="" loading="lazy" onerror="this.src=\'/images/default.jpg\'">' +
          '<span class="cmp-combo-name">' + cesc(o.textContent) + '</span>' +
        '</button>').join('');
    }
    // The panel is position:fixed so it escapes the modal's overflow:auto
    // clipping; anchor it to the trigger and flip upward when there's no room.
    const modalScroller = sel.closest('.compare-modal') || sel.closest('.modal-card');
    function positionPanel() {
      const r = trigger.getBoundingClientRect();
      const gap = 6, margin = 10;
      panel.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8))) + 'px';
      panel.style.width = Math.round(r.width) + 'px';
      const spaceBelow = window.innerHeight - r.bottom - gap - margin;
      const spaceAbove = r.top - gap - margin;
      if (spaceBelow < 180 && spaceAbove > spaceBelow) {
        panel.style.top = 'auto';
        panel.style.bottom = Math.round(window.innerHeight - r.top + gap) + 'px';
        panel.style.maxHeight = Math.max(140, Math.round(spaceAbove)) + 'px';
      } else {
        panel.style.bottom = 'auto';
        panel.style.top = Math.round(r.bottom + gap) + 'px';
        panel.style.maxHeight = Math.max(140, Math.round(spaceBelow)) + 'px';
      }
    }
    const onReflow = () => { if (!panel.classList.contains('hidden')) positionPanel(); };
    function open() {
      buildRows('');
      searchInput.value = '';
      panel.classList.remove('hidden');
      wrap.classList.add('open');
      positionPanel();
      requestAnimationFrame(positionPanel);  // re-measure once layout/scrollbars settle
      window.addEventListener('resize', onReflow);
      if (modalScroller) modalScroller.addEventListener('scroll', onReflow, { passive: true });
      setTimeout(() => searchInput.focus(), 0);
    }
    function close() {
      panel.classList.add('hidden');
      wrap.classList.remove('open');
      window.removeEventListener('resize', onReflow);
      if (modalScroller) modalScroller.removeEventListener('scroll', onReflow);
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.contains('hidden') ? open() : close();
    });
    searchInput.addEventListener('input', () => buildRows(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); trigger.focus(); }
      else if (e.key === 'Enter') {
        const first = listEl.querySelector('.cmp-combo-row');
        if (first) first.click();
        e.preventDefault();
      }
    });
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.cmp-combo-row');
      if (!row) return;
      sel.value = row.dataset.val;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      syncTrigger();
      close();
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target) && !panel.contains(e.target)) close(); });

    sel._comboSync = syncTrigger;
    syncTrigger();
  }

  async function fetchArtistData(id) {
    if (artistDataCache.has(id)) return artistDataCache.get(id);
    const h = headers();
    const [statsRes, asRes] = await Promise.all([
      fetch(`/api/stats?artist=${id}`, { headers: h }),
      fetch(`/api/artist-stats?artist=${id}`, { headers: h }),
    ]);
    const stats = await statsRes.json();
    const as = await asRes.json().catch(() => ({}));
    const latest = (as && as.latest) || {};
    const data = {
      totalStreams: Number(stats.total_streams) || 0,
      songs: Number(stats.total_songs) || 0,
      // Use the latest-day gain (daily_gain), matching the main dashboard's
      // headline "Daily Streams". The 7-day average blends in older days, which
      // made the comparator show numbers that didn't match the rest of the app.
      daily: Number(stats.daily_gain) || 0,
      ml: latest.monthly_listeners != null ? Number(latest.monthly_listeners) : 0,
      followers: latest.followers != null ? Number(latest.followers) : 0,
    };
    artistDataCache.set(id, data);
    return data;
  }

  async function fetchAlbums(id) {
    if (albumsCache.has(id)) return albumsCache.get(id);
    const res = await fetch(`/api/albums?artist=${id}`, { headers: headers() });
    const list = await res.json().catch(() => []);
    const arr = Array.isArray(list) ? list : [];
    albumsCache.set(id, arr);
    return arr;
  }

  async function fetchSongs(id) {
    if (songsCache.has(id)) return songsCache.get(id);
    const res = await fetch(`/api/songs?artist=${id}`, { headers: headers() });
    const list = await res.json().catch(() => []);
    const arr = Array.isArray(list) ? list : [];
    songsCache.set(id, arr);
    return arr;
  }

  function setEmpty(msg) {
    cardEl.innerHTML = `<div class="cc-empty">${cesc(msg)}</div>`;
    setDownloadable(false);
  }
  function setDownloadable(ok) {
    canDownload = ok;
    dlBtn.disabled = !ok;
  }

  // Side-by-side row. The bigger number is tinted green so the reader can see
  // who leads on each metric at a glance — but there's no overall "winner"
  // verdict; they draw their own conclusions. Pass highlight=false to skip
  // tinting (e.g. release year, where "bigger" isn't "better").
  function metricRow(label, aVal, bVal, fmt, highlight) {
    const f = fmt || ((v) => formatShortNumber(Number(v) || 0));
    const na = Number(aVal), nb = Number(bVal);
    const cmp = highlight !== false && Number.isFinite(na) && Number.isFinite(nb);
    const aWin = cmp && na > nb, bWin = cmp && nb > na;
    return `<div class="cc-metric">
      <span class="cc-mval cc-left ${aWin ? 'win' : ''}">${f(aVal)}</span>
      <span class="cc-mlabel">${cesc(label)}</span>
      <span class="cc-mval cc-right ${bWin ? 'win' : ''}">${f(bVal)}</span>
    </div>`;
  }

  // Anti-drag guard, disguised as a generic load error so it reads as an
  // unintentional glitch rather than a deliberate block — it must NOT name the
  // artists/albums or reveal who out-streams whom (a screenshot of the old
  // "X is protected, Y out-streams him" wording could be used to drag JT).
  function shieldHTML(/* protectedName, biggerName intentionally unused */) {
    return `<div class="cc-shield cc-shield-error">
      <div class="cc-shield-icon">⚠️</div>
      <div class="cc-shield-title">Couldn't load this comparison</div>
      <div class="cc-shield-body">Something went wrong while crunching the numbers for this matchup. Please try a different pairing or check back in a bit.</div>
    </div>`;
  }

  // ---------- ARTIST comparison ----------
  async function renderArtists() {
    const idA = aArtist.value, idB = bArtist.value;
    if (!idA || !idB) { setEmpty('Pick two artists to compare.'); return; }
    if (idA === idB) { setEmpty('Pick two different artists.'); return; }
    cardEl.innerHTML = `<div class="cc-empty">Loading…</div>`;
    setDownloadable(false);
    let dA, dB;
    try {
      [dA, dB] = await Promise.all([fetchArtistData(idA), fetchArtistData(idB)]);
    } catch { setEmpty('Could not load stats. Try again.'); return; }

    const nameA = artistName(idA), nameB = artistName(idB);

    // JT anti-drag guard (by total catalogue streams — the headline metric).
    // Momentum exception: if JT trails on total but leads on DAILY, the matchup
    // flatters him (he's out-streaming them right now / catching up), so let it
    // show. Only shield when JT trails on total AND is not ahead on daily.
    if (idA === JT_ID && dB.totalStreams > dA.totalStreams && dA.daily <= dB.daily) {
      cardEl.innerHTML = shieldHTML(nameA, nameB); setDownloadable(false); return;
    }
    if (idB === JT_ID && dA.totalStreams > dB.totalStreams && dB.daily <= dA.daily) {
      cardEl.innerHTML = shieldHTML(nameB, nameA); setDownloadable(false); return;
    }

    const aWin = dA.totalStreams > dB.totalStreams;
    const bWin = dB.totalStreams > dA.totalStreams;

    cardEl.innerHTML = `
      <div class="cc-head">Stream Comparison</div>
      <div class="cc-vs-row">
        <div class="cc-side">
          <img class="cc-avatar" src="${cesc(proxied(artistImg(idA)))}" alt="">
          <div class="cc-name">${cesc(nameA)}</div>
          <div class="cc-bignum ${aWin ? 'win' : ''}">${formatShortNumber(dA.totalStreams)}</div>
          <div class="cc-bigsub">Total Streams</div>
        </div>
        <div class="cc-vs">VS</div>
        <div class="cc-side">
          <img class="cc-avatar" src="${cesc(proxied(artistImg(idB)))}" alt="">
          <div class="cc-name">${cesc(nameB)}</div>
          <div class="cc-bignum ${bWin ? 'win' : ''}">${formatShortNumber(dB.totalStreams)}</div>
          <div class="cc-bigsub">Total Streams</div>
        </div>
      </div>
      <div class="cc-metrics">
        ${metricRow('Monthly Listeners', dA.ml, dB.ml)}
        ${metricRow('Followers', dA.followers, dB.followers)}
        ${metricRow('Daily Streams', dA.daily, dB.daily)}
        ${metricRow('Songs', dA.songs, dB.songs, formatNumber)}
      </div>
      <div class="cc-foot">Spotify Streams — Fan Dashboard</div>
    `;
    setDownloadable(true);
  }

  // ---------- ALBUM comparison ----------
  function pickAlbum(list, id) { return (list || []).find(x => x.album_id === id); }
  function yearOf(d) { return d ? String(d).slice(0, 4) : '—'; }

  // Render the clickable, cover-art album picker for one side. Singles/remix
  // bundles (fewer than MIN_ALBUM_TRACKS tracks) are filtered out.
  async function renderAlbumList(listEl, artistId, side) {
    if (!artistId) { listEl.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`; return; }
    listEl.innerHTML = `<div class="cmp-album-empty">Loading…</div>`;
    let list = [];
    try { list = await fetchAlbums(artistId); } catch {}
    const albums = list.filter(a => (Number(a.track_count) || 0) >= MIN_ALBUM_TRACKS);
    if (!albums.length) {
      listEl.innerHTML = `<div class="cmp-album-empty">No full-length albums tracked for this artist.</div>`;
      return;
    }
    const selId = side === 'a' ? selAlbumA : selAlbumB;
    listEl.innerHTML = albums.map(a => `
      <button type="button" class="cmp-alb-row ${a.album_id === selId ? 'selected' : ''}" data-id="${cesc(a.album_id)}">
        <img class="cmp-alb-thumb" src="${cesc(proxied(a.image_url))}" alt="" loading="lazy">
        <span class="cmp-alb-meta">
          <span class="cmp-alb-title">${cesc(a.album_title)}</span>
          <span class="cmp-alb-year">${yearOf(a.release_date)} · ${formatNumber(a.track_count)} tracks</span>
        </span>
      </button>`).join('');
  }

  function onAlbumPick(listEl, side, e) {
    const row = e.target.closest('.cmp-alb-row');
    if (!row) return;
    const id = row.dataset.id;
    if (side === 'a') selAlbumA = id; else selAlbumB = id;
    listEl.querySelectorAll('.cmp-alb-row').forEach(r => r.classList.toggle('selected', r === row));
    render();
  }

  async function renderAlbums() {
    const artA = aAlbArtist.value, artB = bAlbArtist.value;
    const albIdA = selAlbumA, albIdB = selAlbumB;
    if (!artA || !artB || !albIdA || !albIdB) { setEmpty('Pick an album on each side.'); return; }
    cardEl.innerHTML = `<div class="cc-empty">Loading…</div>`;
    setDownloadable(false);
    let listA, listB;
    try {
      [listA, listB] = await Promise.all([fetchAlbums(artA), fetchAlbums(artB)]);
    } catch { setEmpty('Could not load albums. Try again.'); return; }
    const alA = pickAlbum(listA, albIdA), alB = pickAlbum(listB, albIdB);
    if (!alA || !alB) { setEmpty('Could not find one of the albums.'); return; }

    const tA = Number(alA.total_streams) || 0, tB = Number(alB.total_streams) || 0;
    const dlA = Number(alA.daily_gain) || 0, dlB = Number(alB.daily_gain) || 0;

    // JT anti-drag guard for albums — only against OTHER artists. JT comparing
    // his own albums to each other is allowed (no outstream risk to himself).
    // Same momentum exception as the artist guard: if JT's album trails on total
    // but leads on DAILY, let it show — only shield when it also trails on daily.
    const jtVsJt = artA === JT_ID && artB === JT_ID;
    if (!jtVsJt) {
      if (artA === JT_ID && tB > tA && dlA <= dlB) {
        cardEl.innerHTML = shieldHTML(`${artistName(artA)}'s "${alA.album_title}"`, `"${alB.album_title}"`);
        setDownloadable(false); return;
      }
      if (artB === JT_ID && tA > tB && dlB <= dlA) {
        cardEl.innerHTML = shieldHTML(`${artistName(artB)}'s "${alB.album_title}"`, `"${alA.album_title}"`);
        setDownloadable(false); return;
      }
    }

    const aWin = tA > tB, bWin = tB > tA;

    cardEl.innerHTML = `
      <div class="cc-head">Album Comparison</div>
      <div class="cc-vs-row">
        <div class="cc-side">
          <img class="cc-avatar cc-square" src="${cesc(proxied(alA.image_url))}" alt="">
          <div class="cc-name">${cesc(alA.album_title)}</div>
          <div class="cc-subname">${cesc(artistName(artA))}</div>
          <div class="cc-bignum ${aWin ? 'win' : ''}">${formatShortNumber(tA)}</div>
          <div class="cc-bigsub">Total Streams</div>
        </div>
        <div class="cc-vs">VS</div>
        <div class="cc-side">
          <img class="cc-avatar cc-square" src="${cesc(proxied(alB.image_url))}" alt="">
          <div class="cc-name">${cesc(alB.album_title)}</div>
          <div class="cc-subname">${cesc(artistName(artB))}</div>
          <div class="cc-bignum ${bWin ? 'win' : ''}">${formatShortNumber(tB)}</div>
          <div class="cc-bigsub">Total Streams</div>
        </div>
      </div>
      <div class="cc-metrics">
        ${metricRow('Daily Streams', alA.daily_gain, alB.daily_gain)}
        ${metricRow('Tracks', alA.track_count, alB.track_count, formatNumber)}
        ${metricRow('Released', yearOf(alA.release_date), yearOf(alB.release_date), (v) => cesc(v), false)}
      </div>
      <div class="cc-foot">Spotify Streams — Fan Dashboard</div>
    `;
    setDownloadable(true);
  }

  // ---------- SONG comparison ----------
  function pickSong(list, id) { return (list || []).find(x => x.id === id); }

  // One side's track picker. The list is already streams-desc from /api/songs,
  // so the untyped view is "this artist's biggest tracks".
  async function renderSongList(listEl, artistId, side, filter) {
    if (!artistId) { listEl.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`; return; }
    listEl.innerHTML = `<div class="cmp-album-empty">Loading…</div>`;
    let list = [];
    try { list = await fetchSongs(artistId); } catch {}
    const f = (filter || '').trim().toLowerCase();
    const matched = f
      ? list.filter(s => String(s.title || '').toLowerCase().includes(f)
                      || String(s.album_title || '').toLowerCase().includes(f))
      : list;
    if (!matched.length) {
      listEl.innerHTML = `<div class="cmp-album-empty">${f ? 'No track matches that search.' : 'No tracks tracked for this artist.'}</div>`;
      return;
    }
    const shown = matched.slice(0, SONG_LIST_LIMIT);
    const selId = side === 'a' ? selSongA : selSongB;
    listEl.innerHTML = shown.map(s => `
      <button type="button" class="cmp-alb-row ${s.id === selId ? 'selected' : ''}" data-id="${cesc(s.id)}">
        <img class="cmp-alb-thumb" src="${cesc(proxied(s.album_cover_url))}" alt="" loading="lazy">
        <span class="cmp-alb-meta">
          <span class="cmp-alb-title">${cesc(s.title)}</span>
          <span class="cmp-alb-year">${formatShortNumber(s.cumulative)} streams</span>
        </span>
      </button>`).join('') +
      (matched.length > shown.length
        ? `<div class="cmp-album-empty">+${formatNumber(matched.length - shown.length)} more — search to narrow.</div>`
        : '');
  }

  function onSongPick(listEl, side, e) {
    const row = e.target.closest('.cmp-alb-row');
    if (!row) return;
    if (side === 'a') selSongA = row.dataset.id; else selSongB = row.dataset.id;
    listEl.querySelectorAll('.cmp-alb-row').forEach(r => r.classList.toggle('selected', r === row));
    render();
  }

  async function renderSongs() {
    const artA = aSongArtist.value, artB = bSongArtist.value;
    if (!artA || !artB || !selSongA || !selSongB) { setEmpty('Pick a song on each side.'); return; }
    cardEl.innerHTML = `<div class="cc-empty">Loading…</div>`;
    setDownloadable(false);
    let listA, listB;
    try {
      [listA, listB] = await Promise.all([fetchSongs(artA), fetchSongs(artB)]);
    } catch { setEmpty('Could not load songs. Try again.'); return; }
    const sA = pickSong(listA, selSongA), sB = pickSong(listB, selSongB);
    if (!sA || !sB) { setEmpty('Could not find one of the songs.'); return; }
    if (sA.id === sB.id) { setEmpty('Pick two different songs.'); return; }

    const tA = Number(sA.cumulative) || 0, tB = Number(sB.cumulative) || 0;
    const dlA = Number(sA.daily_gain) || 0, dlB = Number(sB.daily_gain) || 0;

    // Same JT anti-drag guard as the album mode, one level down: his track can
    // never be shown losing to another artist's. JT vs JT is his own catalogue,
    // so it's allowed; and the momentum exception stands — trailing on total but
    // leading on daily is a flattering matchup, so it renders.
    const jtVsJt = artA === JT_ID && artB === JT_ID;
    if (!jtVsJt) {
      if (artA === JT_ID && tB > tA && dlA <= dlB) {
        cardEl.innerHTML = shieldHTML(`${artistName(artA)}'s "${sA.title}"`, `"${sB.title}"`);
        setDownloadable(false); return;
      }
      if (artB === JT_ID && tA > tB && dlB <= dlA) {
        cardEl.innerHTML = shieldHTML(`${artistName(artB)}'s "${sB.title}"`, `"${sA.title}"`);
        setDownloadable(false); return;
      }
    }

    const aWin = tA > tB, bWin = tB > tA;
    // A single's "album" is the track's own name — printing it under the title
    // just repeats it, so fall back to the artist on that side.
    const subOf = (s, art) => {
      const alb = String(s.album_title || '');
      return alb && alb.toLowerCase() !== String(s.title || '').toLowerCase()
        ? `${artistName(art)} · ${alb}` : artistName(art);
    };

    cardEl.innerHTML = `
      <div class="cc-head">Song Comparison</div>
      <div class="cc-vs-row">
        <div class="cc-side">
          <img class="cc-avatar cc-square" src="${cesc(proxied(sA.album_cover_url))}" alt="">
          <div class="cc-name">${cesc(sA.title)}</div>
          <div class="cc-subname">${cesc(subOf(sA, artA))}</div>
          <div class="cc-bignum ${aWin ? 'win' : ''}">${formatShortNumber(tA)}</div>
          <div class="cc-bigsub">Total Streams</div>
        </div>
        <div class="cc-vs">VS</div>
        <div class="cc-side">
          <img class="cc-avatar cc-square" src="${cesc(proxied(sB.album_cover_url))}" alt="">
          <div class="cc-name">${cesc(sB.title)}</div>
          <div class="cc-subname">${cesc(subOf(sB, artB))}</div>
          <div class="cc-bignum ${bWin ? 'win' : ''}">${formatShortNumber(tB)}</div>
          <div class="cc-bigsub">Total Streams</div>
        </div>
      </div>
      <div class="cc-metrics">
        ${metricRow('Daily Streams', dlA, dlB)}
        ${metricRow('7-Day Average', sA.daily_avg_7d, sB.daily_avg_7d)}
        ${metricRow('Released', yearOf(sA.release_date), yearOf(sB.release_date), (v) => cesc(v), false)}
        ${metricRow('Length', sA.duration_ms, sB.duration_ms, (v) => formatDuration(Number(v)), false)}
      </div>
      <div class="cc-foot">Spotify Streams — Fan Dashboard</div>
    `;
    setDownloadable(true);
  }

  function render() {
    if (mode === 'artists') renderArtists();
    else if (mode === 'songs') renderSongs();
    else renderAlbums();
  }

  // ---------- Download (screenshot) ----------
  async function downloadCard() {
    if (!canDownload) return;
    const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
    const imgs = Array.from(cardEl.querySelectorAll('img'));
    await Promise.all(imgs.map(async (im) => {
      if (!im.src) { im.style.visibility = 'hidden'; return; }
      try { await im.decode(); } catch { im.style.visibility = 'hidden'; }
      if (im.style.visibility !== 'hidden' && !im.naturalWidth) im.style.visibility = 'hidden';
    }));
    try {
      const canvas = await html2canvas(cardEl, {
        ignoreElements: ignoreOutside(cardEl.closest('.modal-backdrop') || cardEl),
        backgroundColor: '#080c14',
        scale: 2,
        useCORS: true,
        imageTimeout: 15000,
        logging: false,
        width: 600,
        windowWidth: 700,
        onclone: (doc) => {
          const c = doc.getElementById('compare-card');
          if (c) {
            c.style.setProperty('width', '600px', 'important');
            c.style.setProperty('max-width', '600px', 'important');
            c.style.setProperty('padding', '26px 28px', 'important');
          }
        }
      });
      const fileName = `compare_${Date.now()}.png`;
      let url = null;
      if (canvas.toBlob) {
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        if (blob) url = URL.createObjectURL(blob);
      }
      if (!url) url = canvas.toDataURL('image/png');
      if (isMobile) {
        showMobileImageOverlay(url, 'comparison');
      } else {
        const link = document.createElement('a');
        link.download = fileName;
        link.href = url;
        link.click();
        if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (e) {
      console.error('Compare export failed:', e);
      alert('Could not generate the image. Please try again.');
    } finally {
      imgs.forEach(im => { im.style.visibility = 'visible'; });
    }
  }

  // ---------- Wiring ----------
  function openOverlay() {
    [aArtist, bArtist, aAlbArtist, bAlbArtist, aSongArtist, bSongArtist].forEach(enhanceArtistSelect);
    fillArtistSelect(aArtist, 'Select artist', true);
    fillArtistSelect(bArtist, 'Select artist', true);
    fillArtistSelect(aAlbArtist, 'Select artist', false);
    fillArtistSelect(bAlbArtist, 'Select artist', false);
    // Album-only artists stay in here too: their individual tracks are tracked
    // in full, so a per-song total is complete even when their catalogue isn't.
    fillArtistSelect(aSongArtist, 'Select artist', false);
    fillArtistSelect(bSongArtist, 'Select artist', false);
    selAlbumA = ''; selAlbumB = '';
    selSongA = ''; selSongB = '';
    if (aSongSearch) aSongSearch.value = '';
    if (bSongSearch) bSongSearch.value = '';
    if (!aAlbArtist.value) aAlbList.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`;
    if (!bAlbArtist.value) bAlbList.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`;
    if (!aSongArtist.value) aSongList.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`;
    if (!bSongArtist.value) bSongList.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`;
    setEmpty('Pick two to start.');
    overlay.classList.remove('hidden');
  }
  function closeOverlay() { overlay.classList.add('hidden'); }

  openBtn.addEventListener('click', openOverlay);
  closeBtn.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });

  modeBtns.forEach(btn => btn.addEventListener('click', () => {
    mode = btn.dataset.cmpmode;
    modeBtns.forEach(b => b.classList.toggle('active', b === btn));
    pickersArtists.classList.toggle('hidden', mode !== 'artists');
    pickersAlbums.classList.toggle('hidden', mode !== 'albums');
    pickersSongs.classList.toggle('hidden', mode !== 'songs');
    const note = document.getElementById('cmp-artists-note');
    if (note) note.classList.toggle('hidden', mode !== 'artists');
    setEmpty('Pick two to start.');
  }));

  aArtist.addEventListener('change', render);
  bArtist.addEventListener('change', render);
  aAlbArtist.addEventListener('change', async () => { selAlbumA = ''; await renderAlbumList(aAlbList, aAlbArtist.value, 'a'); render(); });
  bAlbArtist.addEventListener('change', async () => { selAlbumB = ''; await renderAlbumList(bAlbList, bAlbArtist.value, 'b'); render(); });
  aAlbList.addEventListener('click', (e) => onAlbumPick(aAlbList, 'a', e));
  bAlbList.addEventListener('click', (e) => onAlbumPick(bAlbList, 'b', e));

  aSongArtist.addEventListener('change', async () => {
    selSongA = ''; aSongSearch.value = '';
    await renderSongList(aSongList, aSongArtist.value, 'a', '');
    render();
  });
  bSongArtist.addEventListener('change', async () => {
    selSongB = ''; bSongSearch.value = '';
    await renderSongList(bSongList, bSongArtist.value, 'b', '');
    render();
  });
  // The song list is already in memory after the first fetch, so filtering on
  // every keystroke costs nothing but a re-paint.
  aSongSearch.addEventListener('input', () => renderSongList(aSongList, aSongArtist.value, 'a', aSongSearch.value));
  bSongSearch.addEventListener('input', () => renderSongList(bSongList, bSongArtist.value, 'b', bSongSearch.value));
  aSongList.addEventListener('click', (e) => onSongPick(aSongList, 'a', e));
  bSongList.addEventListener('click', (e) => onSongPick(bSongList, 'b', e));
  dlBtn.addEventListener('click', downloadCard);
})();



// ===========================================================================
// Time Machine — the artist's catalogue as it stood on a chosen day.
//
// The date the user picks is a STREAM day (what Spotify was counting that day),
// matching the share cards. The API keys on scrape dates, so every request
// converts stream day -> snapshot day on the way out and back again on the way
// in; with STREAM_DATE_OFFSET_DAYS = 0 both conversions become identities.
// ===========================================================================
(function timeMachine() {
  const modal = document.getElementById('timemachine-modal');
  const openBtn = document.getElementById('timemachine-btn');
  if (!modal || !openBtn) return;

  const closeBtn = document.getElementById('tm-close-btn');
  const dateInput = document.getElementById('tm-date');
  const prevBtn = document.getElementById('tm-prev-day');
  const nextBtn = document.getElementById('tm-next-day');
  const subtitle = document.getElementById('tm-subtitle');
  const resultEl = document.getElementById('tm-result');
  const presetBtns = modal.querySelectorAll('[data-tm-ago]');

  // Bumped on every load; a response whose id is stale gets dropped, so
  // hammering the day arrows can't paint an older day over a newer one.
  let reqId = 0;
  let loadedRange = null;
  let lastArtist = null;

  // Per-song drill-down: the day view we came from (so Back costs nothing), the
  // song currently opened, and a cache of the histories already fetched.
  let lastData = null;
  let lastDay = null;
  let detail = null;
  let detailReq = 0;
  const historyCache = new Map();   // song id -> full history, oldest first

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function shiftDay(dateStr, delta) {
    const d = parseLocalDate(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    d.setDate(d.getDate() + delta);
    return iso(d);
  }
  // Inverse of toStreamDay(): stream day -> the scrape that reported it.
  const toSnapshotDay = (streamDay) => shiftDay(streamDay, -STREAM_DATE_OFFSET_DAYS);

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));

  // Bounds come from the endpoint's own range (plain YYYY-MM-DD strings), NOT
  // from /api/stats.last_update — that one is a pg DATE, so its JSON form is a
  // timestamp that lands on the previous day under any TZ east of UTC. Until
  // the first response arrives we don't know the range, hence the today/null
  // fallbacks; the first load asks for "today" and the server clamps it to the
  // newest snapshot it actually has.
  const rangeDay = (key) => (loadedRange?.[key] ? toStreamDay(String(loadedRange[key]).slice(0, 10)) : null);
  const latestStreamDay = () => rangeDay('max_date') || iso(new Date());

  function clampToRange(streamDay) {
    const max = latestStreamDay();
    if (streamDay > max) return max;
    const min = rangeDay('min_date');
    if (min && streamDay < min) return min;
    return streamDay;
  }

  function applyBounds() {
    if (!dateInput) return;
    dateInput.max = latestStreamDay();
    const min = rangeDay('min_date');
    if (min) dateInput.min = min;
  }

  function pctOf(part, whole) {
    const p = Number(part);
    const w = Number(whole);
    if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return '';
    const v = (p / w) * 100;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;
  }

  function splitRow(label, value, total) {
    const share = pctOf(value, total);
    return `
      <div class="tm-split-row">
        <span class="tm-split-label">${label}</span>
        <span class="tm-split-value">${formatNumber(value)}</span>
        <span class="tm-split-pct">${share}</span>
      </div>`;
  }

  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatNumber(Math.abs(n))}`;
  const gainClass = (n) => (n > 0 ? 'gain-positive' : n < 0 ? 'gain-negative' : 'gain-neutral');

  // Monthly listeners on the chosen day. This comes from artist_stats rather
  // than the per-song snapshots, so it stands on its own: it renders even on a
  // `partial` day where the stream totals are withheld, and it carries its own
  // as_of date because the two tables can land on different days.
  function monthlyListenersHtml(ml, streamDay) {
    const value = Number(ml?.value);
    if (!Number.isFinite(value) || value <= 0) return '';
    const asOfStream = ml.as_of ? toStreamDay(String(ml.as_of).slice(0, 10)) : streamDay;

    let changeHtml = '';
    const change = ml.change == null ? null : Number(ml.change);
    if (change != null && Number.isFinite(change)) {
      // Usually the previous day, but a skipped scrape widens the gap — say the
      // span rather than calling a two-day move "that day". Unlike streams this
      // isn't divided down to a daily rate: monthly listeners is a rolling
      // 28-day figure, so a per-day slice of its movement would be made up.
      const gap = (ml.prev_date && ml.as_of)
        ? Math.round((parseLocalDate(ml.as_of) - parseLocalDate(ml.prev_date)) / 86400000)
        : 1;
      changeHtml = `
        <span class="${gainClass(change)}">${signed(change)}</span>
        <span class="tm-ml-note">${gap === 1 ? 'that day' : `over ${formatNumber(gap)} days`}</span>`;
    }

    // Same "and where is it now" framing the stream total gets above it.
    let sinceHtml = '';
    const latest = Number(ml.latest);
    if (Number.isFinite(latest) && latest > 0 && ml.latest_date && ml.latest_date !== ml.as_of) {
      const diff = latest - value;
      sinceHtml = `
        <div class="tm-ml-since">
          <span class="${gainClass(diff)}">${signed(diff)}</span>
          <span class="tm-ml-note">since then (${formatNumber(latest)} today)</span>
        </div>`;
    }

    return `
      <div class="tm-ml">
        <div class="tm-ml-main">
          <span class="tm-ml-label">Monthly listeners on ${esc(formatDate(asOfStream))}</span>
          <span class="tm-ml-value">${formatNumber(value)}</span>
          ${changeHtml ? `<span class="tm-ml-sub">${changeHtml}</span>` : ''}
        </div>
        ${sinceHtml}
      </div>`;
  }

  // The 30 days leading up to the chosen one, as clickable bars. This is the
  // answer to "what was the daily doing around here" — a single day's number
  // says nothing without the days on either side of it.
  function stripHtml(strip, anchorSnapDay) {
    const days = (strip || []).filter(d => d && d.day);
    if (days.length < 3) return '';                   // two bars isn't a shape
    const max = Math.max(...days.map(d => Number(d.daily) || 0));
    if (max <= 0) return '';
    const bars = days.map((d) => {
      const v = Number(d.daily) || 0;
      const sDay = toStreamDay(d.day);
      // A floor of 4% so a quiet day is still a target you can click.
      const h = Math.max(4, (v / max) * 100);
      return `<button type="button" class="tm-bar${d.day === anchorSnapDay ? ' is-anchor' : ''}"
        data-tm-day="${esc(sDay)}" title="${esc(formatDate(sDay))} · +${esc(formatNumber(v))}"
        aria-label="${esc(formatDate(sDay))}: ${esc(formatNumber(v))} streams">
        <span class="tm-bar-fill" style="height:${h.toFixed(1)}%"></span></button>`;
    }).join('');
    return `
      <div class="tm-strip">
        <div class="tm-strip-head">
          <span class="tm-strip-title">Daily streams into this day</span>
          <span class="tm-strip-peak">peak +${formatShortNumber(max)}</span>
        </div>
        <div class="tm-strip-bars">${bars}</div>
        <div class="tm-strip-axis">
          <span>${esc(formatChartDate(toStreamDay(days[0].day)))}</span>
          <span>${esc(formatChartDate(toStreamDay(days[days.length - 1].day)))}</span>
        </div>
      </div>`;
  }

  // "That day" as a headline in its own right, with the two comparisons that
  // give it meaning: the day before, and the month it sits in.
  function dailyTileHtml(data, firstDay) {
    const daily = Number(data.daily_gain) || 0;
    const strip = (data.daily_strip || []).filter(d => d && d.day);
    const anchorSnap = data.as_of ? String(data.as_of).slice(0, 10) : null;

    let vsPrev = '';
    const iAnchor = anchorSnap ? strip.findIndex(d => d.day === anchorSnap) : strip.length - 1;
    const prev = iAnchor > 0 ? strip[iAnchor - 1] : null;
    if (prev && !firstDay) {
      const p = Number(prev.daily) || 0;
      const diff = daily - p;
      if (p > 0) {
        const pct = Math.abs((diff / p) * 100);
        vsPrev = `<span class="${gainClass(diff)}">${signed(diff)}</span>
          <span class="tm-tile-note">vs the day before (${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%)</span>`;
      }
    }

    // Average across the strip, so "a big day" is judged against this artist's
    // own recent normal rather than against nothing.
    let vsAvg = '';
    if (strip.length >= 5 && daily > 0) {
      const avg = Math.round(strip.reduce((t, d) => t + (Number(d.daily) || 0), 0) / strip.length);
      if (avg > 0) {
        const over = ((daily - avg) / avg) * 100;
        const word = over >= 0 ? 'above' : 'below';
        vsAvg = `<span class="tm-tile-note">${Math.abs(over) < 1 ? 'right on' : `${Math.abs(over) >= 10 ? Math.round(Math.abs(over)) : Math.abs(over).toFixed(1)}% ${word}`} the ${strip.length}-day average (+${formatShortNumber(avg)})</span>`;
      }
    }

    return `
      <div class="tm-hero-tile tm-hero-daily">
        <span class="tm-headline-label">Streams that day</span>
        <span class="tm-headline-value gain-positive">${firstDay ? '—' : '+' + formatNumber(daily)}</span>
        ${firstDay
          ? `<span class="tm-headline-sub">first day on record</span>`
          : `<span class="tm-tile-sub">${vsPrev}</span>${vsAvg}`}
      </div>`;
  }

  function render(data, streamDay) {
    // Kept so the per-song drill-down can come back without refetching the day.
    lastData = data;
    lastDay = streamDay;
    detail = null;
    const total = Number(data.total_streams) || 0;
    if (!total) {
      const earliest = data.range?.min_date
        ? ` Earliest day on record is ${formatDate(toStreamDay(String(data.range.min_date).slice(0, 10)))}.`
        : '';
      resultEl.innerHTML = `<div class="tm-empty">No snapshot on or before ${esc(formatDate(streamDay))}.${esc(earliest)}</div>`;
      return;
    }

    // The snapshot we actually landed on. If the scraper skipped the requested
    // day, say so rather than quietly labelling older numbers with a newer date.
    const asOfStream = data.as_of ? toStreamDay(String(data.as_of).slice(0, 10)) : null;
    const stale = asOfStream && asOfStream !== streamDay;
    // The very first snapshot has nothing to diff against, and the scraper was
    // still discovering the catalogue that day — so neither the 0 gain nor the
    // track count means what it would on any later day. Say so.
    const firstDay = asOfStream && data.range?.min_date
      && asOfStream === toStreamDay(String(data.range.min_date).slice(0, 10));

    // Growth since that day, against the artist's live total.
    const today = Number(currentArtistRawStats?.total_streams) || 0;
    let sinceHtml = '';
    if (today > total) {
      const diff = today - total;
      const days = Math.max(1, Math.round((parseLocalDate(latestStreamDay()) - parseLocalDate(streamDay)) / 86400000));
      sinceHtml = `
        <div class="tm-since">
          <span class="gain-positive">+${formatNumber(diff)}</span>
          <span class="tm-since-note">since then (${pctOf(diff, total)} growth over ${formatNumber(days)} day${days === 1 ? '' : 's'})</span>
        </div>`;
    }

    const rows = (data.top_songs || []).map((s, i) => {
      // Singles carry the track's own name as the album — printing both just
      // repeats the title under itself.
      const album = String(s.album_title || '');
      const sub = album && album.toLowerCase() !== String(s.title || '').toLowerCase() ? album : '';
      return `
      <tr class="tm-row" data-song-id="${esc(s.id)}" data-song-title="${esc(s.title)}"
          data-song-album="${esc(sub)}" data-as-of="${esc(String(s.as_of || '').slice(0, 10))}"
          title="Day-by-day history up to this day">
        <td class="tm-rank">${i + 1}</td>
        <td>
          <div class="tm-song">
            <span class="tm-song-title">${esc(s.title)}</span>
            ${sub ? `<span class="tm-song-album">${esc(sub)}</span>` : ''}
          </div>
        </td>
        <td class="tm-num">${formatNumber(s.cumulative)}</td>
        <td class="tm-num tm-gain">${Number(s.daily_gain) > 0 ? '+' + formatNumber(s.daily_gain) : '—'}</td>
      </tr>`;
    }).join('');

    // Before full-catalogue coverage the per-song rows are real but their SUM
    // isn't the artist's total, so the headline and the splits are withheld
    // rather than shown with a caveat nobody reads.
    const partial = !!data.partial;
    const completeFromDay = data.complete_from
      ? toStreamDay(String(data.complete_from).slice(0, 10)) : null;

    resultEl.innerHTML = `
      ${partial ? `
        <div class="tm-warn">
          <strong>${esc(formatDate(streamDay))} — partial catalogue.</strong>
          Before ${esc(completeFromDay ? formatDate(completeFromDay) : 'full coverage')}
          only the ${formatNumber(data.total_songs)} tracks below have history — the rest of the
          discography isn't covered, so there's no artist total to show for this day.
          Each track's own number is exact.
        </div>` : `
      <div class="tm-hero">
        <div class="tm-hero-tile tm-hero-total">
          <span class="tm-headline-label">Total streams on ${esc(formatDate(streamDay))}</span>
          <span class="tm-headline-value">${formatNumber(total)}</span>
          <span class="tm-headline-sub">${formatNumber(data.total_songs)} tracks</span>
          ${sinceHtml}
        </div>
        ${dailyTileHtml(data, firstDay)}
      </div>
      ${stripHtml(data.daily_strip, data.as_of ? String(data.as_of).slice(0, 10) : null)}
      ${stale ? `<div class="tm-note">No scrape that day — showing the last one before it (${esc(formatDate(asOfStream))}).</div>` : ''}
      ${firstDay ? `<div class="tm-note">First day on record. There's no earlier snapshot to compare against, and the catalogue was still being discovered — later days are more complete.</div>` : ''}
      <div class="tm-splits">
        ${splitRow('Lead', data.lead_streams, total)}
        ${splitRow('Solo', data.solo_streams, total)}
        ${splitRow('Featured', data.feat_streams, total)}
      </div>`}
      ${monthlyListenersHtml(data.monthly_listeners, streamDay)}
      <div class="table-wrapper tm-table-wrap">
        <table class="modal-table tm-table">
          <thead>
            <tr><th>#</th><th>Song</th><th class="tm-num">Streams</th><th class="tm-num">That day</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Per-song drill-down: click a row in the day table and this song's own
  // day-by-day history unrolls BACKWARDS from the day you're standing on.
  // Days after that date are deliberately cut off — the Time Machine is a view
  // of the past from that date, so showing later days would break the illusion
  // (and duplicate the song modal, which already covers "up to today").
  // -------------------------------------------------------------------------
  const HISTORY_RANGES = [
    { key: '14', label: '14 days' },
    { key: '30', label: '30 days' },
    { key: '90', label: '90 days' },
    { key: '365', label: '1 year' },
    { key: 'all', label: 'All' },
  ];

  function detailHead(d, sub) {
    return `
      <div class="tm-detail-head">
        <button type="button" class="tm-back" data-tm-back>‹ Back</button>
        <div class="tm-detail-titles">
          <span class="tm-detail-title">${esc(d.title)}</span>
          ${sub ? `<span class="tm-detail-sub">${sub}</span>` : ''}
        </div>
      </div>`;
  }

  function dsum(label, value, note, cls) {
    return `
      <div class="tm-dsum">
        <span class="tm-dsum-label">${label}</span>
        <span class="tm-dsum-value ${cls || ''}">${value}</span>
        ${note ? `<span class="tm-dsum-note">${note}</span>` : ''}
      </div>`;
  }

  function renderDetail() {
    const d = detail;
    if (!d) return;
    const anchorStream = toStreamDay(d.anchor);
    const dayOf = (r) => String(r.recorded_date).slice(0, 10);
    // Snapshot days are plain YYYY-MM-DD, so a string compare is a date compare.
    const upto = (d.rows || []).filter((r) => dayOf(r) <= d.anchor);
    const head = detailHead(d, `${d.album ? esc(d.album) + ' · ' : ''}up to ${esc(formatDate(anchorStream))}`);
    if (!upto.length) {
      resultEl.innerHTML = head +
        `<div class="tm-empty">No history for this song on or before ${esc(formatDate(anchorStream))}.</div>`;
      return;
    }

    // Cut the window by DATE, not by row count: a stretch of skipped scrapes
    // would otherwise make "30 days" reach back three months. Every row shown
    // is a day INSIDE the window, and the row just before it (`base`) is the
    // total to measure the window's growth from — so the listed gains and the
    // "gained in view" figure describe the same stretch of days.
    let start = 0;
    if (d.range !== 'all') {
      const cutoff = shiftDay(d.anchor, -Number(d.range));
      const i = upto.findIndex((r) => dayOf(r) > cutoff);
      start = i < 0 ? Math.max(0, upto.length - 1) : i;
    }
    if (start >= upto.length - 1) start = Math.max(0, upto.length - 1);
    const base = start > 0 ? upto[start - 1] : null;
    const win = upto.slice(start);

    const last = win[win.length - 1];
    const from = base || win[0];
    const spanDays = Math.max(
      1,
      Math.round((parseLocalDate(dayOf(last)) - parseLocalDate(dayOf(from))) / 86400000)
    );
    // Exact, because it's read off the two cumulative totals rather than summed
    // from per-day rates that were themselves divided across gaps.
    const gainedInWindow = Math.max(0, (Number(last.cumulative) || 0) - (Number(from.cumulative) || 0));
    const perDay = gainedInWindow > 0 ? Math.round(gainedInWindow / spanDays) : null;

    const gains = win.map((r) => Number(r.daily_gain) || 0);
    const maxGain = Math.max(...gains, 0);
    const best = win.reduce((b, r) => ((Number(r.daily_gain) || 0) > (Number(b?.daily_gain) || 0) ? r : b), null);

    const rangeBtns = HISTORY_RANGES.map((r) => `
      <button type="button" class="tm-preset ${r.key === d.range ? 'active' : ''}" data-tm-hrange="${r.key}">${r.label}</button>`
    ).join('');

    const idx = new Map(upto.map((r, i) => [r, i]));
    const listRows = win.slice().reverse().map((r) => {   // newest first: it reads backwards
      const i = idx.get(r);
      const prev = i > 0 ? upto[i - 1] : null;
      const day = dayOf(r);
      const gain = Number(r.daily_gain) || 0;
      const span = prev
        ? Math.max(1, Math.round((parseLocalDate(day) - parseLocalDate(dayOf(prev))) / 86400000))
        : 1;
      const width = maxGain > 0 && gain > 0 ? Math.max(2, (gain / maxGain) * 100) : 0;
      return `
        <div class="tm-hrow ${day === d.anchor ? 'is-anchor' : ''}">
          <span class="tm-hdate">${esc(formatChartDate(toStreamDay(day)))}</span>
          <span class="tm-hbar"><span class="tm-hbar-fill" style="width:${width.toFixed(1)}%"></span></span>
          <span class="tm-hgain">${prev ? '+' + formatNumber(gain) : '—'}</span>
          <span class="tm-hspan">${span > 1 ? `/day · ${span}d gap` : ''}</span>
          <span class="tm-hcum">${formatNumber(r.cumulative)}</span>
        </div>`;
    }).join('');

    resultEl.innerHTML = `
      ${head}
      <div class="tm-detail-summary">
        ${dsum(`Total on ${esc(formatDate(anchorStream))}`, formatNumber(last.cumulative), 'streams')}
        ${dsum('That day', (Number(last.daily_gain) || 0) > 0 ? '+' + formatNumber(last.daily_gain) : '—', '', 'gain-positive')}
        ${dsum('Gained in view', '+' + formatNumber(gainedInWindow), `over ${formatNumber(spanDays)} day${spanDays === 1 ? '' : 's'}`, 'gain-positive')}
        ${perDay != null ? dsum('Average', '+' + formatNumber(perDay), 'per day') : ''}
        ${best && (Number(best.daily_gain) || 0) > 0
          ? dsum('Best day', '+' + formatNumber(best.daily_gain), esc(formatChartDate(toStreamDay(dayOf(best)))), 'gain-positive')
          : ''}
      </div>
      <div class="tm-detail-ranges">${rangeBtns}</div>
      <div class="tm-hlist">${listRows}</div>`;
  }

  // An anchor past the song's last snapshot would label the newest numbers with
  // a day they don't belong to — happens when the drill-down is opened straight
  // from the song modal, before any day has been loaded.
  function clampAnchor(d) {
    const rows = d.rows || [];
    if (!rows.length) return;
    const newest = String(rows[rows.length - 1].recorded_date).slice(0, 10);
    if (d.anchor > newest) d.anchor = newest;
    // Opened from the song modal the date picker is still blank — fill it in
    // with the day we landed on, so it isn't sitting there empty and Back has
    // a day to return to.
    if (!dateInput.value) dateInput.value = toStreamDay(d.anchor);
  }

  async function openDetail(songId, title, album, asOf) {
    if (!songId) return;
    const mine = ++detailReq;
    // asOf is the snapshot this song actually landed on for the chosen day; fall
    // back to the requested day when a row somehow arrives without one.
    detail = {
      songId,
      title,
      album,
      anchor: asOf || toSnapshotDay(lastDay || latestStreamDay()),
      range: '30',
      rows: historyCache.get(songId) || null,
    };
    if (detail.rows) { clampAnchor(detail); renderDetail(); return; }

    resultEl.innerHTML = detailHead(detail, '') + `<div class="tm-loading">Loading this song's history…</div>`;
    try {
      const h = {};
      if (jcPasscode) h['X-JC-Passcode'] = jcPasscode;
      const res = await fetch(`/api/songs/${encodeURIComponent(songId)}/history`, { headers: h });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      if (mine !== detailReq) return;                 // superseded by another click / a new day
      const list = Array.isArray(rows) ? rows : [];
      historyCache.set(songId, list);
      detail.rows = list;
      clampAnchor(detail);
      renderDetail();
    } catch (err) {
      if (mine !== detailReq) return;
      console.error('Time machine song history error:', err);
      resultEl.innerHTML = detailHead(detail, '') +
        `<div class="tm-empty">Couldn't load this song's history. Try again.</div>`;
    }
  }

  function backToDay() {
    detailReq++;                                       // drop any in-flight history
    detail = null;
    if (lastData) render(lastData, lastDay);
    else load(lastDay);
  }

  resultEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-tm-back]')) { backToDay(); return; }
    const bar = e.target.closest('[data-tm-day]');
    if (bar) { go(bar.dataset.tmDay); return; }
    const rangeBtn = e.target.closest('[data-tm-hrange]');
    if (rangeBtn && detail) { detail.range = rangeBtn.dataset.tmHrange; renderDetail(); return; }
    const row = e.target.closest('.tm-row');
    if (row) openDetail(row.dataset.songId, row.dataset.songTitle, row.dataset.songAlbum, row.dataset.asOf);
  });

  // streamDay === null means "whatever the newest snapshot is" — used on open,
  // before we know the artist's range. `snapped` guards the one-shot re-clamp
  // below so it can never bounce between two out-of-range days.
  async function load(streamDay, snapped) {
    if (!currentArtist) return;
    const artist = currentArtist;
    const mine = ++reqId;
    resultEl.innerHTML = `<div class="tm-loading">Loading ${esc(streamDay ? formatDate(streamDay) : 'the latest day')}…</div>`;
    try {
      const headers = {};
      if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;
      const asked = streamDay ? toSnapshotDay(streamDay) : iso(new Date());
      const res = await fetch(
        `/api/streams-on?artist=${encodeURIComponent(artist)}&date=${asked}`,
        { headers }
      );
      if (mine !== reqId || artist !== currentArtist) return; // superseded
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (mine !== reqId || artist !== currentArtist) return;
      loadedRange = data.range || loadedRange;
      applyBounds();
      // This response may be the first time we know the artist's range — a
      // preset clicked before it landed could have jumped past either end
      // (e.g. "1y ago" for an artist we've only tracked since May). Snap back
      // to the boundary and load that instead of showing an empty day.
      if (streamDay && !snapped) {
        const clamped = clampToRange(streamDay);
        if (clamped !== streamDay) return load(clamped, true);
      }
      // On the "latest" load, the day is whatever came back.
      const shownDay = streamDay
        || (data.as_of ? toStreamDay(String(data.as_of).slice(0, 10)) : latestStreamDay());
      dateInput.value = shownDay;
      render(data, shownDay);
    } catch (err) {
      if (mine !== reqId) return;
      console.error('Time machine error:', err);
      resultEl.innerHTML = `<div class="tm-empty">Couldn't load that day. Try again.</div>`;
    }
  }

  // The input updates immediately so the arrows feel instant, but the query
  // waits — clicking through a week otherwise fires a full aggregate per click,
  // and every one of those is Neon compute we don't need to spend.
  let goTimer = null;
  function go(streamDay) {
    const clamped = clampToRange(streamDay);
    dateInput.value = clamped;
    clearTimeout(goTimer);
    goTimer = setTimeout(() => load(clamped), 180);
  }

  function showModal() {
    // A different artist means a different history, so the cached range and the
    // previously shown day are both meaningless — start from their latest day.
    if (lastArtist !== currentArtist) {
      lastArtist = currentArtist;
      loadedRange = null;
      dateInput.value = '';
      dateInput.removeAttribute('min');
      resultEl.innerHTML = '';
    }
    applyBounds();
    modal.classList.remove('hidden');
    if (subtitle) {
      subtitle.textContent = STREAM_DATE_OFFSET_DAYS
        ? 'Streaming days — the totals Spotify was showing on that date.'
        : 'Totals as recorded on that date.';
    }
  }

  function open() {
    showModal();
    // No day chosen yet (first open, or a fresh artist) → ask for the newest.
    if (dateInput.value) go(dateInput.value);
    else load(null);
  }

  // Entry point from the song modal: skip the day view and land straight in this
  // song's history. Back still walks up to the full day, loading it then.
  window.openTimeMachineForSong = function (songId, title, album) {
    if (!songId) return;
    showModal();
    // Cancel anything the day view has in flight so a late response can't paint
    // over the history we're about to show.
    reqId++;
    clearTimeout(goTimer);
    const sub = album && album.toLowerCase() !== String(title || '').toLowerCase() ? album : '';
    openDetail(songId, title, sub, toSnapshotDay(dateInput.value || latestStreamDay()));
  };

  function close() {
    clearTimeout(goTimer);
    modal.classList.add('hidden');
  }

  openBtn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || modal.classList.contains('hidden')) return;
    // Inside a song's history, Escape steps back to the day first — closing the
    // whole modal from two levels down loses the day you'd navigated to.
    if (detail) backToDay(); else close();
  });

  dateInput.addEventListener('change', () => { if (dateInput.value) go(dateInput.value); });
  if (prevBtn) prevBtn.addEventListener('click', () => go(shiftDay(dateInput.value || latestStreamDay(), -1)));
  if (nextBtn) nextBtn.addEventListener('click', () => go(shiftDay(dateInput.value || latestStreamDay(), 1)));
  presetBtns.forEach((btn) => btn.addEventListener('click', () => {
    go(shiftDay(latestStreamDay(), -Number(btn.dataset.tmAgo || 0)));
  }));
})();

// ===== Push notifications =====
// One permission prompt, then per-artist follows: the bell in the header turns
// this artist's daily-rollover notification on or off. The subscription itself
// belongs to the browser, so the follow list is stored server-side against its
// push endpoint — that way it survives a reload and reads correctly if the same
// browser opens a different artist.
//
// iOS only delivers push to a site added to the home screen, so on an
// uninstalled iPhone the button explains that instead of failing silently.
const notifyBtn = document.getElementById('notify-btn');
const notifyBtnLabel = document.getElementById('notify-btn-label');

let pushConfig = null;          // { enabled, publicKey }
let pushFollowing = null;       // Set of artist ids this browser follows
let pushSubscription = null;    // the browser's PushSubscription, once we have one

const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// iOS/iPadOS Safari: push exists only in an installed (standalone) web app.
const iosNeedsInstall = () => {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
};

// VAPID keys travel as base64url; the subscribe call wants raw bytes.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function pushInit() {
  if (!notifyBtn) return;
  if (!pushSupported()) return;                 // button stays hidden
  try {
    const r = await fetch('/api/push/config');
    pushConfig = await r.json();
  } catch (e) {
    return;
  }
  if (!pushConfig || !pushConfig.enabled) return;

  notifyBtn.classList.remove('hidden');
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    pushSubscription = await reg.pushManager.getSubscription();
    if (pushSubscription) {
      const res = await fetch(`/api/push/follows?endpoint=${encodeURIComponent(pushSubscription.endpoint)}`);
      const data = await res.json();
      pushFollowing = new Set(data.following || []);
    } else {
      pushFollowing = new Set();
    }
  } catch (e) {
    console.warn('Push init failed:', e);
    pushFollowing = new Set();
  }
  syncNotifyButton();
}

function syncNotifyButton() {
  if (!notifyBtn || !pushConfig || !pushConfig.enabled) return;
  // On the artist picker there is no artist to follow.
  if (!currentArtist) { notifyBtn.classList.add('hidden'); return; }
  notifyBtn.classList.remove('hidden');
  const on = pushFollowing && pushFollowing.has(currentArtist);
  notifyBtn.classList.toggle('notify-on', !!on);
  if (notifyBtnLabel) notifyBtnLabel.textContent = on ? 'Notifying' : 'Notify me';
  notifyBtn.title = on
    ? `You'll get a notification when ${currentArtistName || 'this artist'}'s daily numbers land — click to stop`
    : `Get notified when ${currentArtistName || 'this artist'}'s daily numbers land`;
}

// Persist the whole follow list on every change: the server replaces what it
// has for this endpoint, so the browser is always the source of truth and a
// half-applied change can't leave a stale follow behind.
async function pushSaveFollows() {
  if (!pushSubscription) return;
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: pushSubscription.toJSON(),
      artists: [...pushFollowing],
    }),
  });
}

async function toggleNotify() {
  if (!pushConfig || !pushConfig.enabled || !currentArtist) return;
  if (iosNeedsInstall()) {
    // Kilavuz tam bu an icin yazildi: adimlar orada, ekran goruntusuz ama
    // sirasiyla. Uyariyi okuyup ne yapacagini bilemeyen kisiyi bos birakmak
    // yerine dogrudan oraya goturuyoruz.
    if (confirm('On iPhone and iPad, notifications only work once the site is added to your home screen.\n\nOpen the guide for the steps?')) {
      window.location.href = '/guide.html#notifications';
    }
    return;
  }
  notifyBtn.disabled = true;
  try {
    if (!pushSubscription) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert(permission === 'denied'
          ? 'Notifications are blocked for this site. Turn them back on in your browser settings to follow an artist.'
          : 'Notifications were not enabled.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      pushSubscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushConfig.publicKey),
      });
      pushFollowing = pushFollowing || new Set();
    }

    if (pushFollowing.has(currentArtist)) pushFollowing.delete(currentArtist);
    else pushFollowing.add(currentArtist);

    await pushSaveFollows();
    syncNotifyButton();
  } catch (e) {
    console.error('Notification toggle failed:', e);
    alert('Could not change your notification setting. Please try again.');
  } finally {
    notifyBtn.disabled = false;
  }
}

if (notifyBtn) notifyBtn.addEventListener('click', toggleNotify);
pushInit();
