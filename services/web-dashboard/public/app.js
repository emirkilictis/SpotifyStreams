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

// Elements
const tbody = document.getElementById('songs-tbody');
const searchInput = document.getElementById('search-input');
const filterButtons = document.querySelectorAll('.filter-btn');
const sortHeaders = document.querySelectorAll('th.sortable');

// Stats Elements
const totalStreamsEl = document.getElementById('total-streams');
const monthlyListenersEl = document.getElementById('monthly-listeners');
const monthlyListenersChangeEl = document.getElementById('monthly-listeners-change');
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
const leadDailyStreamsEl = document.getElementById('lead-daily-streams');
const featDailyStreamsEl = document.getElementById('feat-daily-streams');

// Modal Elements
const albumModal = document.getElementById('album-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalDownloadBtn = document.getElementById('modal-download-btn');

// Song Modal Elements
const songModal = document.getElementById('song-modal');
const songModalCloseBtn = document.getElementById('song-modal-close-btn');
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
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr.slice(0, 10);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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
  try {
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;

    // Show skeleton rows in the songs table while loading.
    const songsTbodyEl = document.getElementById('songs-tbody');
    if (songsTbodyEl) songsTbodyEl.innerHTML = skeletonRows(8, 5);

    // Fetch stats
    const statsRes = await fetch(`/api/stats?artist=${currentArtist}`, { headers });
    if (statsRes.status === 401) {
      window.location.href = '/login';
      return;
    }
    const statsData = await statsRes.json();
    currentArtistRawStats = statsData;
    totalStreamsEl.textContent = formatNumber(statsData.total_streams);
    leadStreamsEl.textContent = formatNumber(statsData.lead_streams);
    featStreamsEl.textContent = formatNumber(statsData.feat_streams);
    soloStreamsEl.textContent = formatNumber(statsData.solo_streams);
    
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
    
    totalSongsEl.textContent = statsData.total_songs ?? '0';
    lastUpdateEl.textContent = formatDate(statsData.last_update);

    // Fetch artist-level stats (monthly listeners)
    try {
      const artistStatsRes = await fetch(`/api/artist-stats?artist=${currentArtist}`, { headers });
      if (artistStatsRes.ok) {
        const artistStats = await artistStatsRes.json();
        currentArtistStats = artistStats;
        const ml = artistStats.latest?.monthly_listeners;
        monthlyListenersEl.textContent = (ml !== null && ml !== undefined) ? formatNumber(ml) : '-';
        setStatDelta(monthlyListenersChangeEl, artistStats.latest?.monthly_listeners_change);
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
    const songsRes = await fetch(`/api/songs?artist=${currentArtist}`, { headers });
    const songsData = await songsRes.json();
    
    // Sort initially by cumulative streams desc and assign a global rank
    songsData.sort((a, b) => Number(b.cumulative) - Number(a.cumulative));
    allSongs = songsData.map((song, index) => ({
      ...song,
      rank: index + 1
    }));
    
    renderSongs();
    renderMilestones();
  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color: var(--accent-red);">Failed to load dashboard data!</td></tr>`;
  }
}

// Fetch Albums
async function fetchAlbumsData() {
  try {
    albumsContainer.innerHTML = skeletonAlbumRows(6);
    
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;
    
    const res = await fetch(`/api/albums?artist=${currentArtist}`, { headers });
    allAlbums = await res.json();
    
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
    } else if (dailyGain < 0) {
      gainHtml = `<span class="gain-cell" style="color: var(--accent-red);">${formatNumber(dailyGain)}</span>`;
    }

    // Raw last-day change. The daily_gain above comes from the running-max view
    // so it never goes negative; this surfaces a genuine playcount DROP (pulled
    // streams / bad snapshot) — shown ONLY when it's actually negative.
    const realChange = Number(song.real_daily_change);
    if (realChange < 0) {
      gainHtml += `<span class="real-drop" title="Gerçek son-gün değişimi (running-max kalkanı olmadan) — bu şarkıda stream düşüşü tespit edildi">▼ ${formatNumber(Math.abs(realChange))}</span>`;
    }

    const albumEscaped = song.album_title ? song.album_title.replace(/'/g, "\\'") : '';
    const dateFormatted = song.release_date || '';

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
            <span class="song-title song-link" onclick="openSongById('${song.id}')">${song.title}</span>
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
    const albumTitleEscaped = album.album_title.replace(/'/g, "\\'");
    const dateFormatted = album.release_date || '';
    const coverUrl = album.image_url || ALBUM_COVERS[album.album_id] || '';
    const coverUrlEscaped = coverUrl ? coverUrl.replace(/'/g, "\\'") : '';
    const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56' viewBox='0 0 24 24' fill='none' stroke='%231db954' stroke-width='1.5' style='background:%23181818'><circle cx='12' cy='12' r='10'/><circle cx='12' cy='12' r='3'/><path d='M12 9v6'/></svg>`;
    const gainClass = dailyGain > 0 ? 'gain-positive' : (dailyGain < 0 ? 'gain-negative' : 'gain-neutral');

    return `
      <div class="album-row glass" onclick="openAlbumById('${album.album_id}', '${albumTitleEscaped}', '${dateFormatted}', '${coverUrlEscaped}')">
        <div class="album-row-cover">
          <img src="${coverUrl || fallbackSvg}" alt="${album.album_title}" class="album-row-cover-img" onerror="this.onerror=null;this.src='${fallbackSvg}'">
        </div>
        <div class="album-row-info">
          <h3 class="album-row-title">${album.album_title}</h3>
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

  // Auto-theme the modal AND the save-card from the album cover's dominant colour.
  // The cover already loads with crossOrigin='anonymous', so we can sample its
  // pixels on a canvas and pick the most vibrant one as the accent. If the image
  // is CORS-tainted or has no usable colour we silently keep the artist theme.
  if (modalCoverUrl) {
    const themeFromCover = () => {
      try {
        const n = 24, cv = document.createElement('canvas');
        cv.width = n; cv.height = n;
        const cx = cv.getContext('2d');
        cx.drawImage(modalCover, 0, 0, n, n);
        const d = cx.getImageData(0, 0, n, n).data;
        let best = null, bestScore = -1, rs = 0, gs = 0, bs = 0, cnt = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (d[i + 3] < 128) continue;
          rs += r; gs += g; bs += b; cnt++;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const score = (mx === 0 ? 0 : (mx - mn) / mx) * mx; // saturated AND bright
          if (mx > 40 && mx < 245 && score > bestScore) { bestScore = score; best = [r, g, b]; }
        }
        if (!best && cnt) best = [Math.round(rs / cnt), Math.round(gs / cnt), Math.round(bs / cnt)];
        if (!best) return;
        const hx = (c) => c.toString(16).padStart(2, '0');
        const th = deriveThemeFromAccent(`#${hx(best[0])}${hx(best[1])}${hx(best[2])}`);
        modalCard.style.setProperty('--album-accent', th.accent);
        modalCard.style.setProperty('--album-accent-rgb', hexToRgbTriplet(th.accent));
        modalCard.style.setProperty('--album-glow', th.accentGlow);
        modalCard.style.background = th.bgGradient;
        modalCard.style.borderColor = th.accent + '30';
        modalCard.style.boxShadow = `0 25px 60px rgba(0,0,0,0.7), 0 0 80px ${th.accentGlow}`;
        modalTitle.style.color = th.accent;
        modalCover.style.boxShadow = `0 8px 32px ${th.accentGlow}`;
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
      modalStreams.style.color = artistTheme.accent;
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
            <td><span class="song-title song-link" onclick="openSongById('${s.id}')">${s.title}</span></td>
            <td>${formatDuration(s.duration_ms)}</td>
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

    const dates = filteredHistory.map(row => formatDate(row.recorded_date).slice(0, 10));
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
          // Disable the per-artist theme tint in the capture. The colored radial
          // gradient (Christina's washed the card out — "siyahlığı yok, fazla
          // beyazlamış") robs the shared card of the deep-black look it should have.
          // Force a flat near-black background so every artist's save-card is dark.
          clonedCard.style.setProperty('background', '#070b11', 'important');
        }

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
    // Strip trailing " - <version>" descriptors.
    // NOTE: "Instrumental" is intentionally NOT stripped — it distinguishes a
    // real alternate version and must stay visible (e.g. "Rockstar - Instrumental").
    .replace(/\s*-\s*(?:Radio\s+Edit|Radio\s+Version|Radio\s+Mix|Single\s+Version|Edit|Remastered(?:\s+\d{4})?|\d{4}\s+Remaster|Main\s+Version)\b.*$/gi, '')
    // Strip trailing parenthetical version descriptors (Instrumental kept on purpose)
    .replace(/\s*[\(\[](?:Radio\s+Edit|Remastered|Live|Main\s+Version|Deluxe(?:\s+Version)?)[\)\]]/gi, '')
    // Medley / prelude / interlude cleanups (JT tracklist)
    .replace(/Medley:\s*/gi, '')
    .replace(/\s*\((?:Prelude|Interlude)\)/gi, '');

  return clean.replace(/\s{2,}/g, ' ').trim();
}

function cleanAlbumTitle(title) {
  if (!title) return '';
  let clean = title
    .replace(/\s*\((?:Deluxe Edition|Deluxe|Expanded Edition|Expanded|Special Edition|Special)\)/gi, '')
    .replace(/\s*-\s*(?:Deluxe Edition|Deluxe|Expanded Edition|Expanded|Special Edition|Special)/gi, '');
  return clean.trim();
}

async function openDailyCard() {
  if (!currentAlbumMeta || !dailyCardEl) return;
  const { albumId, title, coverUrl } = currentAlbumMeta;
  const theme = ARTIST_THEMES[currentArtist] || ARTIST_THEMES['31TPClRtHm23RisEBtV3X7'];

  dailyCardModal.classList.remove('hidden');
  dailyCardEl.style.setProperty('--dc-accent', theme.accent);
  dailyCardEl.style.setProperty('--dc-accent-rgb', hexToRgbTriplet(theme.accent));
  dailyCardEl.style.background = theme.bgGradient;
  dailyCardEl.style.borderColor = theme.accent + '40';
  dailyCardEl.style.boxShadow = `0 25px 60px rgba(0,0,0,0.6), 0 0 70px ${theme.accentGlow}`;
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
          <td class="${c.cls}">${c.txt}</td>
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
            <td class="${totalCls}">${totalChange > 0 ? '+' : ''}${formatNumber(totalChange)}</td>
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
      backgroundColor: '#080c14',
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
        const dailyAvg = dailyGain > 0 ? dailyGain : 1;
        const daysRemaining = Math.max(1, Math.ceil((nextMilestone - cumulative) / dailyAvg));
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
        const dailyAvg = dailyGain > 0 ? dailyGain : 1;
        const daysRemaining = Math.max(1, Math.ceil((nextMilestone - cumulative) / dailyAvg));
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
    let etaText = `${item.daysRemaining} days left`;
    if (item.daysRemaining > 365) {
      etaText = `${(item.daysRemaining / 365).toFixed(1)} years left`;
    } else if (item.daysRemaining === 1) {
      etaText = `1 day left`;
    }
    
    const isAlbum = item.type === 'album';
    const badgeHtml = isAlbum
      ? `<span class="milestone-type-badge type-album">💿 Album</span>`
      : `<span class="milestone-type-badge type-song">🎵 Song</span>`;
      
    const clickHandler = isAlbum
      ? `openAlbumById('${item.id}', '${item.title.replace(/'/g, "\\'")}', '${item.release_date}', '${item.image_url.replace(/'/g, "\\'")}')`
      : `openSongById('${item.id}')`;
    
    const projectedVal = getYearEndProjection(item.cumulative, item.daily_gain);
    return `
      <div class="milestone-card glass" onclick="${clickHandler}" style="cursor: pointer;">
        <div class="milestone-card-header">
          <h4 title="${item.title}">${item.title}</h4>
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
if (tcValueEl) tcValueEl.addEventListener('input', computeTargetEta);

// ===== Achieved Milestones (separate collapsible log) =====
async function fetchAchievedMilestones(headers) {
  if (!achievedSection) return;
  try {
    const res = await fetch(`/api/milestones-reached?artist=${currentArtist}`, { headers });
    if (!res.ok) { achievedSection.classList.add('hidden'); return; }
    const rows = await res.json();
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
  
  // Filter by milestoneFilter
  const filtered = rows.filter(r => {
    if (milestoneFilter === 'all') return true;
    return r.type === milestoneFilter;
  });
  
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
        <span class="achieved-song" title="${r.title}">${r.title}</span>
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
  modalSongTitle.textContent = song.title;
  modalSongSubtitle.textContent = song.album_title || 'Single';
  modalSongStreams.textContent = formatNumber(song.cumulative);
  modalSongGain.textContent = (Number(song.daily_gain) > 0 ? '+' : '') + formatNumber(song.daily_gain);
  modalSongDuration.textContent = formatDuration(song.duration_ms);
  
  // Spotify Link
  songModalSpotifyLink.href = `https://open.spotify.com/track/${song.id}`;
  
  // Milestone Progress
  const cumulative = Number(song.cumulative);
  const dailyGain = Number(song.daily_gain);
  
  // Year-End Projection
  const songProj = getYearEndProjection(cumulative, dailyGain);
  const modalSongProjection = document.getElementById('modal-song-projection');
  if (modalSongProjection) {
    modalSongProjection.textContent = formatNumber(Math.round(songProj));
  }
  const nextMilestone = getNextMilestone(cumulative);
  const percent = (cumulative / nextMilestone) * 100;
  const dailyAvg = dailyGain > 0 ? dailyGain : 1;
  const daysRemaining = Math.max(1, Math.ceil((nextMilestone - cumulative) / dailyAvg));

  songModalNextMilestone.textContent = formatMilestoneName(nextMilestone);
  
  let etaText = `ETA: ${daysRemaining} days remaining`;
  if (daysRemaining > 365) {
    etaText = `ETA: ${(daysRemaining / 365).toFixed(1)} years remaining`;
  } else if (daysRemaining === 1) {
    etaText = `ETA: 1 day remaining`;
  }
  songModalMilestoneEta.textContent = etaText;
  songModalMilestoneProgress.style.width = `${percent.toFixed(1)}%`;
  songModalMilestonePercent.textContent = `${percent.toFixed(1)}% completed`;

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

  const dates = filteredHistory.map(row => formatDate(row.recorded_date).slice(0, 10));
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

function applyArtistTheme(artistId) {
  const theme = ARTIST_THEMES[artistId] || ARTIST_THEMES['31TPClRtHm23RisEBtV3X7'];
  document.documentElement.style.setProperty('--accent-green', theme.accent);
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

// Artist Selector Handler
const artistSelector = document.getElementById('artist-selector');
const dashboardTitle = document.getElementById('dashboard-title');
if (artistSelector) {
  artistSelector.addEventListener('change', async (e) => {
    currentArtist = e.target.value;
    currentArtistName = e.target.options[e.target.selectedIndex]?.text || currentArtistName;

    // Reset album controls
    albumSearchFilter = '';
    albumSortField = 'streams-desc';
    if (albumSearchInput) albumSearchInput.value = '';
    if (albumSortSelect) albumSortSelect.value = 'streams-desc';

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

// Enter dashboard for a specific artist
async function enterDashboard(artistId, artistName) {
  currentArtist = artistId;
  currentArtistName = artistName || '';

  // Reset album controls
  albumSearchFilter = '';
  albumSortField = 'streams-desc';
  if (albumSearchInput) albumSearchInput.value = '';
  if (albumSortSelect) albumSortSelect.value = 'streams-desc';
  
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
  applyArtistTheme('31TPClRtHm23RisEBtV3X7'); // Reset to default Spotify green on the picker
  window.scrollTo(0, 0);
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

// Picker card click handlers using event delegation
const pickerGridContainer = document.querySelector('.picker-grid');
if (pickerGridContainer) {
  pickerGridContainer.addEventListener('click', async (e) => {
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
  });
}

// Build (or rebuild) the picker cards + dropdown from currentRoster, honouring
// the admin `locked` flag and any artists unlocked this session. Called once by
// applyRoster and again whenever an artist is unlocked.
function renderPickerRoster() {
  const roster = currentRoster;
  const grid = document.querySelector('.picker-grid');
  if (grid) {
    grid.classList.add('roster-ready');   // reveal now that we have the live roster
    grid.innerHTML = '';
    roster.forEach(a => {
      const locked = isArtistLocked(a.artist_id);
      const card = document.createElement('button');
      card.className = locked ? 'picker-card locked-card' : 'picker-card';
      card.dataset.artist = a.artist_id;
      card.dataset.realName = a.name;
      card.dataset.name = locked ? 'Locked Artist' : a.name;

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
            <h3>Locked Artist</h3>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div class="picker-card-img-wrap">
            <img src="${a.image_url || '/images/default.jpg'}" alt="${a.name}" class="picker-card-img" loading="eager">
            <div class="picker-card-overlay"></div>
          </div>
          <div class="picker-card-info">
            <h3>${a.name}</h3>
          </div>
        `;
      }
      grid.appendChild(card);
    });
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
  // Background tint: very dark version of accent for the hero gradient
  const tr = Math.min(255, Math.round(r * 0.18));
  const tg = Math.min(255, Math.round(g * 0.18));
  const tb = Math.min(255, Math.round(b * 0.18));
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

  async function updateSync(data) {
    const status = data.status || 'idle';
    const active = status === 'scraping' || status === 'deduping';
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

  // Poll every 10 seconds
  setInterval(checkScraperStatus, 10000);
})();

// ===== Twitter Post Generator =====
(function initTwitterPostGenerator() {
  const twitterPostBtn = document.getElementById('twitter-post-btn');
  const twitterPostModal = document.getElementById('twitter-post-modal');
  const closeBtn = document.getElementById('twitter-post-close-btn');
  const cancelBtn = document.getElementById('twitter-post-cancel-btn');
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
      const d = new Date(currentArtistRawStats.last_update);
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

  function updateCharCounter(len) {
    charCounter.textContent = `${len} / 280`;
    if (len > 280) {
      charCounter.classList.add('exceeded');
    } else {
      charCounter.classList.remove('exceeded');
    }
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

  // The scraper ingests singles & remix bundles as their own "albums", which
  // floods the picker. Only surface entries with a real album's worth of tracks.
  const MIN_ALBUM_TRACKS = 6;

  let mode = 'artists';
  let canDownload = false;
  let selAlbumA = '';   // chosen album id, left side
  let selAlbumB = '';   // chosen album id, right side
  const artistDataCache = new Map(); // id -> { totalStreams, songs, daily, ml, followers }
  const albumsCache = new Map();     // artistId -> [albums]

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

  function render() {
    if (mode === 'artists') renderArtists();
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
    [aArtist, bArtist, aAlbArtist, bAlbArtist].forEach(enhanceArtistSelect);
    fillArtistSelect(aArtist, 'Select artist', true);
    fillArtistSelect(bArtist, 'Select artist', true);
    fillArtistSelect(aAlbArtist, 'Select artist', false);
    fillArtistSelect(bAlbArtist, 'Select artist', false);
    selAlbumA = ''; selAlbumB = '';
    if (!aAlbArtist.value) aAlbList.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`;
    if (!bAlbArtist.value) bAlbList.innerHTML = `<div class="cmp-album-empty">Pick an artist first.</div>`;
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
  dlBtn.addEventListener('click', downloadCard);
})();


