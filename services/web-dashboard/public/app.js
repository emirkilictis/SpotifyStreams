// Global State
let allSongs = [];
let allAlbums = [];
let filteredSongs = [];
let searchFilter = '';
let typeFilter = 'all'; // 'all' | 'lead' | 'featured'
let currentSortField = 'streams'; // 'rank' | 'title' | 'album' | 'duration' | 'streams' | 'gain'
let currentSortDirection = 'desc';
let activeView = 'songs'; // 'songs' | 'albums'
let currentArtist = null; // set when artist is picked
let activeSongChart = null;
let activeAlbumChart = null;
let activeSongHistory = [];
let activeAlbumHistory = [];
let activeAlbumId = null;
let songChartType = 'cumulative'; // 'cumulative' | 'daily'
let songChartRange = '30'; // '7' | '30' | 'all'
let albumChartRange = '30'; // '7' | '30' | 'all'

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
const songsViewSection = document.getElementById('songs-view-section');
const albumsViewSection = document.getElementById('albums-view-section');
const albumsContainer = document.getElementById('albums-container');

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

// Formatting Helpers
function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return Number(num).toLocaleString('en-US');
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

// Fetch Songs and Stats
async function fetchData() {
  try {
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;

    // Fetch stats
    const statsRes = await fetch(`/api/stats?artist=${currentArtist}`, { headers });
    if (statsRes.status === 401) {
      window.location.href = '/login';
      return;
    }
    const statsData = await statsRes.json();
    totalStreamsEl.textContent = formatNumber(statsData.total_streams);
    leadStreamsEl.textContent = formatNumber(statsData.lead_streams);
    featStreamsEl.textContent = formatNumber(statsData.feat_streams);
    soloStreamsEl.textContent = formatNumber(statsData.solo_streams);
    
    // Bind daily streams total
    const dailyGainTotal = Number(statsData.daily_gain);
    dailyStreamsEl.textContent = (dailyGainTotal > 0 ? '+' : '') + formatNumber(dailyGainTotal);
    
    totalSongsEl.textContent = statsData.total_songs;
    lastUpdateEl.textContent = formatDate(statsData.last_update);

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
    albumsContainer.innerHTML = '<div class="table-loading">Loading albums...</div>';
    
    const headers = {};
    if (jcPasscode) headers['X-JC-Passcode'] = jcPasscode;
    
    const res = await fetch(`/api/albums?artist=${currentArtist}`, { headers });
    allAlbums = await res.json();
    
    if (viewToggleBar) {
      if (ALBUM_ONLY_ARTISTS.has(currentArtist)) {
        viewToggleBar.style.display = 'none';
      } else {
        viewToggleBar.style.display = allAlbums.length > 0 ? 'flex' : 'none';
      }
    }
    
    renderAlbums();
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
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">No songs found matching search criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredSongs.map((song, idx) => {
    const isFeatured = song.is_featured;
    const isSolo = song.is_solo;
    const dailyGain = Number(song.daily_gain);
    
    let gainHtml = '<span class="gain-cell gain-neutral">-</span>';
    if (dailyGain > 0) {
      gainHtml = `<span class="gain-cell gain-positive">+${formatNumber(dailyGain)}</span>`;
    } else if (dailyGain < 0) {
      gainHtml = `<span class="gain-cell" style="color: var(--accent-red);">${formatNumber(dailyGain)}</span>`;
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
  if (allAlbums.length === 0) {
    albumsContainer.innerHTML = '<div class="table-empty">No albums found in database.</div>';
    return;
  }

  albumsContainer.innerHTML = allAlbums.map(album => {
    const totalStreams = Number(album.total_streams);
    const dailyGain = Number(album.daily_gain);
    const albumTitleEscaped = album.album_title.replace(/'/g, "\\'");
    const dateFormatted = album.release_date || '';
    const coverUrl = album.image_url || ALBUM_COVERS[album.album_id] || '';
    const imgHtml = coverUrl 
      ? `<div class="album-cover-wrapper"><img src="${coverUrl}" alt="${album.album_title}" class="album-cover-img" crossorigin="anonymous" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100\\' height=\\'100\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'%231db954\\' stroke-width=\\'1.5\\' style=\\'background:%23121212\\'><circle cx=\\'12\\' cy=\\'12\\' r=\\'10\\'/><circle cx=\\'12\\' cy=\\'12\\' r=\\'3\\'/><path d=\\'M12 9v6\\'/></svg>'"></div>`
      : `<div class="album-cover-wrapper fallback-cover"><div class="vinyl-record"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="music-icon"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 9v6"></path></svg></div></div>`;
    const coverUrlEscaped = coverUrl ? coverUrl.replace(/'/g, "\\'") : '';
    
    return `
      <div class="album-card glass" onclick="openAlbumById('${album.album_id}', '${albumTitleEscaped}', '${dateFormatted}', '${coverUrlEscaped}')">
        ${imgHtml}
        <div class="album-card-content">
          <div class="album-card-header">
            <h3>${album.album_title}</h3>
            <span class="date">${formatDate(album.release_date)}</span>
          </div>
          <div class="album-card-stats">
            <div class="album-stat">
              <span class="label">Streams</span>
              <span class="value">${formatNumber(totalStreams)}</span>
            </div>
            <div class="album-stat">
              <span class="label">Daily</span>
              <span class="value gain-positive">${dailyGain > 0 ? '+' : ''}${formatNumber(dailyGain)}</span>
            </div>
            <div class="album-stat" style="grid-column: span 2;">
              <span class="tracks">${album.track_count} tracked songs</span>
            </div>
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
  
  // Apply album theme
  const theme = ALBUM_THEMES[albumId] || DEFAULT_THEME;
  modalCard.style.setProperty('--album-accent', theme.accent);
  modalCard.style.setProperty('--album-accent-rgb', hexToRgbTriplet(theme.accent));
  modalCard.style.setProperty('--album-glow', theme.glow);
  modalCard.style.background = `linear-gradient(165deg, ${theme.gradStart} 0%, ${theme.gradEnd} 100%)`;
  modalCard.style.borderColor = theme.accent + '30';
  modalCard.style.boxShadow = `0 25px 60px rgba(0,0,0,0.7), 0 0 80px ${theme.glow}`;

  // Show modal layout
  albumModal.classList.remove('hidden');
  modalCard.scrollTop = 0; // Reset scroll position to top
  modalTbody.innerHTML = `<tr><td colspan="6" class="table-loading">Loading album tracks...</td></tr>`;
  
  if (title) {
    modalTitle.textContent = title;
    modalTitle.style.color = theme.accent;
    modalSubtitle.textContent = releaseDate ? `Released on ${formatDate(releaseDate)}` : '';
  }

  // Set cover art
  const modalCoverUrl = coverUrl || ALBUM_COVERS[albumId] || '';
  if (modalCoverUrl) {
    modalCover.crossOrigin = 'anonymous';
    modalCover.src = modalCoverUrl;
    modalCover.classList.remove('hidden');
    modalCover.style.boxShadow = `0 8px 32px ${theme.glow}`;
  } else {
    modalCover.removeAttribute('crossorigin');
    modalCover.src = 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%231db954\' stroke-width=\'1.5\' style=\'background:%23121212\'><circle cx=\'12\' cy=\'12\' r=\'10\'/><circle cx=\'12\' cy=\'12\' r=\'3\'/><path d=\'M12 9v6\'/></svg>';
    modalCover.classList.remove('hidden');
    modalCover.style.boxShadow = `0 8px 32px ${theme.glow}`;
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

    try {
      const historyRes = await fetch(`/api/albums/${albumId}/history`, { headers });
      activeAlbumHistory = await historyRes.json();
      
      // Reset range selector tab
      albumChartRange = '30';
      const albumRangeBtns = document.querySelectorAll('#album-modal .album-range-toggle-btn');
      albumRangeBtns.forEach(btn => {
        if (btn.dataset.range === '30') btn.classList.add('active');
        else btn.classList.remove('active');
      });

      renderAlbumChart();
    } catch (chartErr) {
      console.error('Error rendering album history chart:', chartErr);
    }
    
    if (songs.length > 0) {
      if (!title) {
        const sampleSong = allSongs.find(s => s.album_id === albumId);
        modalTitle.textContent = sampleSong ? sampleSong.album_title : 'Album Tracks';
        modalTitle.style.color = theme.accent;
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
      modalStreams.style.color = theme.accent;
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
            trendHtml = `<span class="trend-cell trend-up" style="color: ${theme.accent};">▲ ${pctStr}%</span>`;
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
      modalTbody.innerHTML = `<tr><td colspan="6" class="table-empty">No tracked songs found in this album.</td></tr>`;
    }
  } catch (err) {
    console.error('Error loading album details:', err);
    modalTbody.innerHTML = `<tr><td colspan="6" class="table-empty" style="color: var(--accent-red);">Failed to load album tracks!</td></tr>`;
  }
};

function renderAlbumChart() {
  const albumChartSection = document.getElementById('album-chart-section');
  const albumChartContainer = document.getElementById('album-chart');
  if (!albumChartContainer) return;

  if (activeAlbumChart) {
    activeAlbumChart.destroy();
    activeAlbumChart = null;
  }

  if (activeAlbumHistory && activeAlbumHistory.length > 0 && albumChartSection) {
    albumChartSection.classList.remove('hidden');
    
    // Filter history by range
    const filteredHistory = filterHistoryByRange(activeAlbumHistory, albumChartRange);

    const dates = filteredHistory.map(row => formatDate(row.recorded_date).slice(0, 10));
    const dataPoints = filteredHistory.map(row => Number(row.cumulative));
    
    const theme = ALBUM_THEMES[activeAlbumId] || DEFAULT_THEME;

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
    
    activeAlbumChart = new ApexCharts(albumChartContainer, options);
    activeAlbumChart.render();
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
    const rowCount = modalCard.querySelectorAll('.modal-table tbody tr').length || 10;
    const virtualHeight = Math.max(2000, 600 + rowCount * 60);

    const canvas = await html2canvas(modalCard, {
      backgroundColor: '#080c14', // Match dashboard background color
      scale: isMobile ? 1.0 : 2, // Set to 1.0 to avoid iOS canvas size limit crashes
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
        }

        // Force desktop-level sizes inside the cloned modal header for capture
        const clonedCover = clonedDoc.getElementById('modal-album-cover');
        if (clonedCover) {
          clonedCover.style.setProperty('width', '130px', 'important');
          clonedCover.style.setProperty('height', '130px', 'important');
          clonedCover.style.setProperty('border-radius', '10px', 'important');
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

        // Clean up backdrop filter on all elements inside the cloned tree
        const glassElements = clonedDoc.querySelectorAll('.glass');
        glassElements.forEach(el => {
          el.style.backdropFilter = 'none';
          el.style.webkitBackdropFilter = 'none';
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
    alert('Görsel oluşturulamadı. Lütfen tekrar deneyin.');
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

// View Toggle Handler
viewToggleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    viewToggleBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeView = btn.dataset.view;
    
    if (activeView === 'songs') {
      songsViewSection.classList.remove('hidden');
      albumsViewSection.classList.add('hidden');
    } else {
      songsViewSection.classList.add('hidden');
      albumsViewSection.classList.remove('hidden');
      fetchAlbumsData();
    }
  });
});

// Search handler
searchInput.addEventListener('input', (e) => {
  searchFilter = e.target.value;
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

// Milestones Engine
function getNextMilestone(streams) {
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
  return Math.ceil(streams / 1000000000) * 1000000000;
}

function formatMilestoneName(val) {
  if (val >= 1000000000) {
    return (val / 1000000000).toFixed(1).replace('.0', '') + ' Billion';
  }
  return (val / 1000000).toFixed(0) + ' Million';
}

function renderMilestones() {
  if (!allSongs || allSongs.length === 0) {
    milestonesSection.classList.add('hidden');
    return;
  }

  // Calculate milestone stats for each song
  const songMilestones = allSongs
    .filter(song => Number(song.cumulative) > 0)
    .map(song => {
      const cumulative = Number(song.cumulative);
      const dailyGain = Number(song.daily_gain);
      const nextMilestone = getNextMilestone(cumulative);
      const percent = (cumulative / nextMilestone) * 100;
      const dailyAvg = dailyGain > 0 ? dailyGain : 1;
      const daysRemaining = Math.max(1, Math.ceil((nextMilestone - cumulative) / dailyAvg));
      return {
        ...song,
        nextMilestone,
        percent,
        daysRemaining
      };
    });

  // Sort by percentage completed desc
  songMilestones.sort((a, b) => b.percent - a.percent);

  // Take top 4 closest
  const topMilestones = songMilestones.slice(0, 4);

  if (topMilestones.length === 0) {
    milestonesSection.classList.add('hidden');
    return;
  }

  milestonesSection.classList.remove('hidden');
  milestonesGrid.innerHTML = topMilestones.map(item => {
    const isFeatured = item.is_featured;
    const isSolo = item.is_solo;
    let badgeClass = 'badge-lead';
    let badgeText = 'Lead';
    if (isFeatured) {
      badgeClass = 'badge-feat';
      badgeText = 'Featured';
    } else if (isSolo) {
      badgeClass = 'badge-solo';
      badgeText = 'Solo';
    }
    
    let etaText = `${item.daysRemaining} days left`;
    if (item.daysRemaining > 365) {
      etaText = `${(item.daysRemaining / 365).toFixed(1)} years left`;
    } else if (item.daysRemaining === 1) {
      etaText = `1 day left`;
    }
    
    return `
      <div class="milestone-card glass" onclick="openSongById('${item.id}')" style="cursor: pointer;">
        <div class="milestone-card-header">
          <h4 title="${item.title}">${item.title}</h4>
          <span class="eta-badge">${etaText}</span>
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
      </div>
    `;
  }).join('');
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
    seriesName = 'Daily Gain';
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

// Artist Theme Configurations (accent, accentHover, accentGlow, borderGlow, bgGradient)
const ARTIST_THEMES = {
  '31TPClRtHm23RisEBtV3X7': { // Justin Timberlake
    accent: '#1ed760',
    accentHover: '#1db954',
    accentGlow: 'rgba(30, 215, 96, 0.4)',
    borderGlow: 'rgba(30, 215, 96, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #111a2e 0%, #080c14 100%)'
  },
  '5L1lO4eRHmJ7a0Q6csE5cT': { // LISA - Yellow
    accent: '#ffd700',
    accentHover: '#e5c100',
    accentGlow: 'rgba(255, 215, 0, 0.4)',
    borderGlow: 'rgba(255, 215, 0, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #2e2610 0%, #080c14 100%)'
  },
  '1HY2Jd0NmPuamShAr6KMms': { // Lady Gaga - Pink
    accent: '#ff52a2',
    accentHover: '#e03b85',
    accentGlow: 'rgba(255, 82, 162, 0.4)',
    borderGlow: 'rgba(255, 82, 162, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #301422 0%, #080c14 100%)'
  },
  '6qqNVTkY8uBg9cP3Jd7DAH': { // Billie Eilish - Lime Green
    accent: '#bad80a',
    accentHover: '#a2be09',
    accentGlow: 'rgba(186, 216, 10, 0.4)',
    borderGlow: 'rgba(186, 216, 10, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #1c240e 0%, #080c14 100%)'
  },
  '66CXWjxzNUsdJxJ2JdwvnR': { // Ariana Grande - Lavender
    accent: '#b39ddb',
    accentHover: '#9575cd',
    accentGlow: 'rgba(179, 157, 219, 0.4)',
    borderGlow: 'rgba(179, 157, 219, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #1c142b 0%, #080c14 100%)'
  },
  '6Ff53KvcvAj5U7Z1vojB5o': { // *NSYNC - Frosted Blue
    accent: '#3498db',
    accentHover: '#2980b9',
    accentGlow: 'rgba(52, 152, 219, 0.4)',
    borderGlow: 'rgba(52, 152, 219, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #112036 0%, #080c14 100%)'
  },
  '3p3U04w2DaiBzuYMZnYr00': { // JC Chasez - Crimson Red
    accent: '#e74c3c',
    accentHover: '#c0392b',
    accentGlow: 'rgba(231, 76, 60, 0.4)',
    borderGlow: 'rgba(231, 76, 60, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #291212 0%, #080c14 100%)'
  },
  '3LHYvj5ZejV1NLqncEObSJ': { // Vaelis - Indigo/Purple
    accent: '#8b5cf6',
    accentHover: '#7c3aed',
    accentGlow: 'rgba(139, 92, 246, 0.4)',
    borderGlow: 'rgba(139, 92, 246, 0.3)',
    bgGradient: 'radial-gradient(circle at 50% 0%, #1c1236 0%, #080c14 100%)'
  }
};

function applyArtistTheme(artistId) {
  const theme = ARTIST_THEMES[artistId] || ARTIST_THEMES['31TPClRtHm23RisEBtV3X7'];
  document.documentElement.style.setProperty('--accent-green', theme.accent);
  document.documentElement.style.setProperty('--accent-green-hover', theme.accentHover);
  document.documentElement.style.setProperty('--accent-green-glow', theme.accentGlow);
  document.documentElement.style.setProperty('--card-border-glow', theme.borderGlow);
  document.documentElement.style.setProperty('--bg-gradient', theme.bgGradient);
}

// Artist Selector Handler
const artistSelector = document.getElementById('artist-selector');
const dashboardTitle = document.getElementById('dashboard-title');
if (artistSelector) {
  artistSelector.addEventListener('change', async (e) => {
    currentArtist = e.target.value;
    
    // Apply dynamic artist theme colors
    applyArtistTheme(currentArtist);
    
    // Update Document and Dashboard Header Title dynamically
    const selectedName = artistSelector.options[artistSelector.selectedIndex].text;
    if (dashboardTitle) {
      dashboardTitle.textContent = `${selectedName} Spotify Streams`;
    }
    document.title = `${selectedName} Spotify Streams - Fan Dashboard`;
    
    // For album-only artists (Gaga, Billie, Ariana), force active view to 'albums'
    if (ALBUM_ONLY_ARTISTS.has(currentArtist)) {
      if (statsGrid) statsGrid.classList.add('hidden');
      activeView = 'albums';
      viewToggleBtns.forEach(b => {
        if (b.dataset.view === 'albums') b.classList.add('active');
        else b.classList.remove('active');
      });
      songsViewSection.classList.add('hidden');
      albumsViewSection.classList.remove('hidden');
      await fetchData();
      await fetchAlbumsData();
    } else {
      if (statsGrid) statsGrid.classList.remove('hidden');
      activeView = 'songs';
      viewToggleBtns.forEach(b => {
        if (b.dataset.view === 'songs') b.classList.add('active');
        else b.classList.remove('active');
      });
      songsViewSection.classList.remove('hidden');
      albumsViewSection.classList.add('hidden');
      await fetchData();
      await fetchAlbumsData();
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
  
  // Apply dynamic artist theme colors
  applyArtistTheme(artistId);
  
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
    activeView = 'albums';
    viewToggleBtns.forEach(b => {
      if (b.dataset.view === 'albums') b.classList.add('active');
      else b.classList.remove('active');
    });
    songsViewSection.classList.add('hidden');
    albumsViewSection.classList.remove('hidden');
    await fetchData();
    await fetchAlbumsData();
  } else {
    if (statsGrid) statsGrid.classList.remove('hidden');
    activeView = 'songs';
    viewToggleBtns.forEach(b => {
      if (b.dataset.view === 'songs') b.classList.add('active');
      else b.classList.remove('active');
    });
    songsViewSection.classList.remove('hidden');
    albumsViewSection.classList.add('hidden');
    await fetchData();
    await fetchAlbumsData();
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
function addJcToDropdown() {
  const artistSelector = document.getElementById('artist-selector');
  if (artistSelector) {
    const exists = Array.from(artistSelector.options).some(opt => opt.value === '3p3U04w2DaiBzuYMZnYr00');
    if (!exists) {
      const option = document.createElement('option');
      option.value = '3p3U04w2DaiBzuYMZnYr00';
      option.text = 'JC Chasez';
      artistSelector.appendChild(option);
    }
  }
}

// Function to unlock JC Chasez UI elements
function unlockJcChasezUI() {
  const jcCard = document.getElementById('jc-card');
  const jcImgWrap = document.getElementById('jc-img-wrap');
  const jcCardTitle = document.getElementById('jc-card-title');
  
  if (jcCard) {
    jcCard.classList.remove('locked-card');
    jcCard.dataset.name = 'JC Chasez';
  }
  
  if (jcImgWrap) {
    jcImgWrap.classList.remove('locked-img-wrap');
    jcImgWrap.innerHTML = `
      <img src="https://i.scdn.co/image/ab6761610000e5eb784d1c3b5bb30c5db83c8fe2" alt="JC Chasez" class="picker-card-img" loading="eager" crossorigin="anonymous">
      <div class="picker-card-overlay"></div>
    `;
  }
  
  if (jcCardTitle) {
    jcCardTitle.textContent = 'JC Chasez';
  }
  
  addJcToDropdown();
}

let jcUnlocked = false;
let jcPasscode = '';

// Picker card click handlers
document.querySelectorAll('.picker-card').forEach(card => {
  card.addEventListener('click', async () => {
    const artistId = card.dataset.artist;
    const artistName = card.dataset.name;
    
    if (artistId === '3p3U04w2DaiBzuYMZnYr00') {
      if (jcUnlocked) {
        enterDashboard(artistId, 'JC Chasez');
      } else {
        const code = prompt("Gizli sanatçıyı açmak için erişim kodunu girin:");
        if (code) {
          try {
            const res = await fetch('/api/verify-jc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ passcode: code })
            });
            const data = await res.json();
            if (data.success) {
              jcPasscode = code;
              jcUnlocked = true;
              unlockJcChasezUI();
              enterDashboard(artistId, 'JC Chasez');
            } else {
              alert("Geçersiz kod!");
            }
          } catch (err) {
            console.error('Error verifying JC code:', err);
            alert('Sunucuyla iletişim kurulamadı.');
          }
        }
      }
    } else {
      enterDashboard(artistId, artistName);
    }
  });
});

// Back to picker button
if (backToPickerBtn) {
  backToPickerBtn.addEventListener('click', showPicker);
}

// Do NOT auto-load — wait for picker selection

function showMobileImageOverlay(imageUrl, albumTitle) {
  const overlay = document.createElement('div');
  overlay.id = 'mobile-image-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(4, 6, 10, 0.85)';
  overlay.style.backdropFilter = 'blur(16px)';
  overlay.style.webkitBackdropFilter = 'blur(16px)';
  overlay.style.zIndex = '9999';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.padding = '24px';
  overlay.style.boxSizing = 'border-box';

  overlay.innerHTML = `
    <div style="text-align: center; margin-bottom: 20px; color: #fff; max-width: 90%;">
      <h3 style="margin: 0 0 8px 0; font-family: 'Outfit', sans-serif; font-size: 1.4rem; font-weight: 700; color: #1db954;">Görsel Hazır!</h3>
      <p style="margin: 0; font-size: 0.95rem; opacity: 0.9; font-family: 'Inter', sans-serif; line-height: 1.5;">
        Görseli kaydetmek için resmin üzerine <strong>basılı tutun</strong> ve <strong>"Fotoğraflara Ekle"</strong> veya <strong>"Resmi Kaydet"</strong> seçeneğini seçin.
      </p>
    </div>
    <div style="max-width: 100%; max-height: 60vh; overflow-y: auto; border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1); background: #080c14;">
      <img src="${imageUrl}" alt="${albumTitle}" style="width: 100%; height: auto; display: block; border-radius: 16px;">
    </div>
    <button id="close-mobile-overlay" style="margin-top: 25px; padding: 12px 32px; border: none; background: linear-gradient(135deg, rgba(29, 185, 84, 0.2) 0%, rgba(29, 185, 84, 0.1) 100%); color: #1db954; border-radius: 24px; font-weight: 700; cursor: pointer; font-family: 'Outfit', sans-serif; border: 1px solid rgba(29, 185, 84, 0.4); box-shadow: 0 4px 12px rgba(29, 185, 84, 0.15); transition: all 0.2s; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px;">
      Kapat
    </button>
  `;

  document.body.appendChild(overlay);

  document.getElementById('close-mobile-overlay').addEventListener('click', () => {
    overlay.remove();
    if (imageUrl && imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
  });
}


