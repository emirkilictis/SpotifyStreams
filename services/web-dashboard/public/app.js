// Global State
let allSongs = [];
let allAlbums = [];
let filteredSongs = [];
let searchFilter = '';
let typeFilter = 'all'; // 'all' | 'solo' | 'featured'
let currentSortField = 'streams'; // 'rank' | 'title' | 'album' | 'duration' | 'streams' | 'gain'
let currentSortDirection = 'desc';
let activeView = 'songs'; // 'songs' | 'albums'

// Elements
const tbody = document.getElementById('songs-tbody');
const searchInput = document.getElementById('search-input');
const filterButtons = document.querySelectorAll('.filter-btn');
const sortHeaders = document.querySelectorAll('th.sortable');

// Stats Elements
const totalStreamsEl = document.getElementById('total-streams');
const leadStreamsEl = document.getElementById('lead-streams');
const featStreamsEl = document.getElementById('feat-streams');
const dailyStreamsEl = document.getElementById('daily-streams');
const totalSongsEl = document.getElementById('total-songs');
const lastUpdateEl = document.getElementById('last-update');

// View Toggle Elements
const viewToggleBtns = document.querySelectorAll('.view-toggle-btn');
const songsViewSection = document.getElementById('songs-view-section');
const albumsViewSection = document.getElementById('albums-view-section');
const albumsContainer = document.getElementById('albums-container');

// Modal Elements
const albumModal = document.getElementById('album-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');

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

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr.slice(0, 10);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Fetch Songs and Stats
async function fetchData() {
  try {
    // Fetch stats
    const statsRes = await fetch('/api/stats');
    if (statsRes.status === 401) {
      window.location.href = '/login';
      return;
    }
    const statsData = await statsRes.json();
    totalStreamsEl.textContent = formatNumber(statsData.total_streams);
    leadStreamsEl.textContent = formatNumber(statsData.lead_streams);
    featStreamsEl.textContent = formatNumber(statsData.feat_streams);
    
    // Bind daily streams total
    const dailyGainTotal = Number(statsData.daily_gain);
    dailyStreamsEl.textContent = (dailyGainTotal > 0 ? '+' : '') + formatNumber(dailyGainTotal);
    
    totalSongsEl.textContent = statsData.total_songs;
    lastUpdateEl.textContent = formatDate(statsData.last_update);

    // Fetch songs
    const songsRes = await fetch('/api/songs');
    const songsData = await songsRes.json();
    
    // Sort initially by cumulative streams desc and assign a global rank
    songsData.sort((a, b) => Number(b.cumulative) - Number(a.cumulative));
    allSongs = songsData.map((song, index) => ({
      ...song,
      rank: index + 1
    }));
    
    renderSongs();
  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty" style="color: var(--accent-red);">Failed to load dashboard data!</td></tr>`;
  }
}

// Fetch Albums
async function fetchAlbumsData() {
  try {
    albumsContainer.innerHTML = '<div class="table-loading">Loading albums...</div>';
    const res = await fetch('/api/albums');
    allAlbums = await res.json();
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
    if (typeFilter === 'solo') {
      matchesType = !song.is_featured;
    } else if (typeFilter === 'featured') {
      matchesType = song.is_featured;
    }

    return matchesSearch && matchesType;
  });

  // 2) Sort
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
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No songs found matching search criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredSongs.map(song => {
    const isFeatured = song.is_featured;
    const dailyGain = Number(song.daily_gain);
    
    let gainHtml = '<span class="gain-cell gain-neutral">-</span>';
    if (dailyGain > 0) {
      gainHtml = `<span class="gain-cell gain-positive">+${formatNumber(dailyGain)}</span>`;
    } else if (dailyGain < 0) {
      gainHtml = `<span class="gain-cell" style="color: var(--accent-red);">${formatNumber(dailyGain)}</span>`;
    }

    const albumEscaped = song.album_title ? song.album_title.replace(/'/g, "\\'") : '';
    const dateFormatted = song.release_date || '';

    return `
      <tr class="${isFeatured ? 'featured-row' : ''}">
        <td><strong>${song.rank}</strong></td>
        <td>
          <div class="song-title-cell">
            <span class="song-title">${song.title}</span>
            <div class="badge-wrapper">
              <span class="badge ${isFeatured ? 'badge-feat' : 'badge-solo'}">
                ${isFeatured ? 'Featured' : 'Solo'}
              </span>
            </div>
          </div>
        </td>
        <td>
          <span 
            class="album-title" 
            style="cursor: pointer; text-decoration: underline; transition: color 0.2s;"
            onmouseover="this.style.color='var(--accent-green)'"
            onmouseout="this.style.color=''"
            onclick="openAlbumById('${song.album_id}', '${albumEscaped}', '${dateFormatted}')"
          >
            ${song.album_title || '-'}
          </span>
        </td>
        <td>${formatDuration(song.duration_ms)}</td>
        <td><span class="streams-count">${formatNumber(song.cumulative)}</span></td>
        <td>${gainHtml}</td>
      </tr>
    `;
  }).join('');
}

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
    
    return `
      <div class="album-card glass" onclick="openAlbumById('${album.album_id}', '${albumTitleEscaped}', '${dateFormatted}')">
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
    `;
  }).join('');
}

// Open Album Detail Modal Sheet
window.openAlbumById = async function(albumId, title = null, releaseDate = null) {
  const modalTitle = document.getElementById('modal-album-title');
  const modalSubtitle = document.getElementById('modal-album-subtitle');
  const modalStreams = document.getElementById('modal-album-streams');
  const modalGain = document.getElementById('modal-album-gain');
  const modalTracks = document.getElementById('modal-album-tracks');
  const modalTbody = document.getElementById('modal-songs-tbody');
  
  // Show modal layout
  albumModal.classList.remove('hidden');
  modalTbody.innerHTML = `<tr><td colspan="5" class="table-loading">Loading album tracks...</td></tr>`;
  
  if (title) {
    modalTitle.textContent = title;
    modalSubtitle.textContent = releaseDate ? `Released on ${formatDate(releaseDate)}` : '';
  }
  
  try {
    const res = await fetch(`/api/albums/${albumId}/songs`);
    const songs = await res.json();
    
    if (songs.length > 0) {
      if (!title) {
        // Fallback title lookup
        const sampleSong = allSongs.find(s => s.album_id === albumId);
        modalTitle.textContent = sampleSong ? sampleSong.album_title : 'Album Tracks';
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
      modalGain.textContent = (totalGain > 0 ? '+' : '') + formatNumber(totalGain);
      modalTracks.textContent = songs.length;
      
      // Populate Table
      modalTbody.innerHTML = songs.map(s => {
        const dailyGain = Number(s.daily_gain);
        let gainHtml = '<span class="gain-cell gain-neutral">-</span>';
        if (dailyGain > 0) {
          gainHtml = `<span class="gain-cell gain-positive">+${formatNumber(dailyGain)}</span>`;
        } else if (dailyGain < 0) {
          gainHtml = `<span class="gain-cell" style="color: var(--accent-red);">${formatNumber(dailyGain)}</span>`;
        }
        
        return `
          <tr>
            <td><strong>${s.track_number || '-'}</strong></td>
            <td><span class="song-title">${s.title}</span></td>
            <td>${formatDuration(s.duration_ms)}</td>
            <td><span class="streams-count">${formatNumber(s.cumulative)}</span></td>
            <td>${gainHtml}</td>
          </tr>
        `;
      }).join('');
    } else {
      modalTbody.innerHTML = `<tr><td colspan="5" class="table-empty">No tracked songs found in this album.</td></tr>`;
    }
  } catch (err) {
    console.error('Error loading album details:', err);
    modalTbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color: var(--accent-red);">Failed to load album tracks!</td></tr>`;
  }
};

// Close Modal
function closeModal() {
  albumModal.classList.add('hidden');
}

modalCloseBtn.addEventListener('click', closeModal);
albumModal.addEventListener('click', (e) => {
  if (e.target === albumModal) closeModal();
});

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

// Initial load
fetchData();
