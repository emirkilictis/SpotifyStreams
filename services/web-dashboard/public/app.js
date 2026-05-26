// Global State
let allSongs = [];
let allAlbums = [];
let filteredSongs = [];
let searchFilter = '';
let typeFilter = 'all'; // 'all' | 'lead' | 'featured'
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
const modalDownloadBtn = document.getElementById('modal-download-btn');

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
    if (typeFilter === 'lead') {
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
              <span class="badge ${isFeatured ? 'badge-feat' : 'badge-lead'}">
                ${isFeatured ? 'Featured' : 'Lead'}
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

// Album Cover Art URLs
const ALBUM_COVERS = {
  '0tcExuDWMQdBbwSpqN8Ku2': 'https://i.scdn.co/image/ab67616d0000b273c68f26a3d34fbd0faed2b473', // FutureSex/LoveSounds
  '6QPkyl04rXwTGlGlcYaRoW': 'https://i.scdn.co/image/ab67616d0000b273346a5742374ab4cf9ed32dee', // Justified
  '0O82niJ0NpcptYRxogeEZu': 'https://i.scdn.co/image/ab67616d0000b27356d5fb0cc9cec001d8ae0c8c', // The 20/20 Experience
  '5lYzReGzcSNF0Gx47wm6qU': 'https://i.scdn.co/image/ab67616d0000b273ef074183c3e34d4f80348e98', // The 20/20 Experience - 2 of 2
  '01l3jTY261V3CESZR4dABz': 'https://i.scdn.co/image/ab67616d0000b273d444296aa0ca8fada177e430', // Man of the Woods
  '716B2iWcwoKolCXrqwLGQh': 'https://i.scdn.co/image/ab67616d0000b2730c03eb908cc6baece50c2426'  // Everything I Thought It Was
};

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
    const coverUrl = ALBUM_COVERS[album.album_id] || '';
    const imgHtml = coverUrl ? `<div class="album-cover-wrapper"><img src="${coverUrl}" alt="${album.album_title}" class="album-cover-img"></div>` : '';
    
    return `
      <div class="album-card glass" onclick="openAlbumById('${album.album_id}', '${albumTitleEscaped}', '${dateFormatted}')">
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
window.openAlbumById = async function(albumId, title = null, releaseDate = null) {
  const modalTitle = document.getElementById('modal-album-title');
  const modalSubtitle = document.getElementById('modal-album-subtitle');
  const modalStreams = document.getElementById('modal-album-streams');
  const modalGain = document.getElementById('modal-album-gain');
  const modalTracks = document.getElementById('modal-album-tracks');
  const modalTbody = document.getElementById('modal-songs-tbody');
  const modalCover = document.getElementById('modal-album-cover');
  
  // Show modal layout
  albumModal.classList.remove('hidden');
  modalTbody.innerHTML = `<tr><td colspan="5" class="table-loading">Loading album tracks...</td></tr>`;
  
  if (title) {
    modalTitle.textContent = title;
    modalSubtitle.textContent = releaseDate ? `Released on ${formatDate(releaseDate)}` : '';
  }

  // Set cover art
  const coverUrl = ALBUM_COVERS[albumId] || '';
  if (coverUrl) {
    modalCover.src = coverUrl;
    modalCover.classList.remove('hidden');
  } else {
    modalCover.src = '';
    modalCover.classList.add('hidden');
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
      modalTbody.innerHTML = songs.map((s, idx) => {
        const dailyGain = Number(s.daily_gain);
        let gainHtml = '<span class="gain-cell gain-neutral">-</span>';
        if (dailyGain > 0) {
          gainHtml = `<span class="gain-cell gain-positive">+${formatNumber(dailyGain)}</span>`;
        } else if (dailyGain < 0) {
          gainHtml = `<span class="gain-cell" style="color: var(--accent-red);">${formatNumber(dailyGain)}</span>`;
        }
        
        return `
          <tr>
            <td><strong>${idx + 1}</strong></td>
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

// Download Modal as Image (Twitter Share Card)
async function downloadModalAsImage() {
  const modalCard = document.querySelector('.modal-card');
  if (!modalCard) return;

  const closeBtn = document.getElementById('modal-close-btn');
  const downloadBtn = document.getElementById('modal-download-btn');
  
  // Hide UI buttons from card capture
  if (closeBtn) closeBtn.style.visibility = 'hidden';
  if (downloadBtn) downloadBtn.style.visibility = 'hidden';

  // Save original scroll/overflow styles so we can restore them later
  const origMaxHeight = modalCard.style.maxHeight;
  const origOverflow = modalCard.style.overflow;

  // Temporarily expand the modal to show ALL tracks (remove scroll constraints)
  modalCard.style.maxHeight = 'none';
  modalCard.style.overflow = 'visible';

  // Also expand the backdrop so the card isn't clipped by the viewport
  const backdrop = document.getElementById('album-modal');
  const origBackdropOverflow = backdrop.style.overflow;
  backdrop.style.overflow = 'visible';

  try {
    const canvas = await html2canvas(modalCard, {
      backgroundColor: '#080c14', // Match dashboard background color
      scale: 2, // High resolution scaling
      useCORS: true, // Allow external Spotify cover image domains
      logging: false,
      scrollY: -window.scrollY, // Prevent scroll offset issues
      windowHeight: modalCard.scrollHeight + 200 // Ensure full height is captured
    });

    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    const albumTitle = document.getElementById('modal-album-title').textContent || 'album';
    link.download = `${albumTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_streams.png`;
    link.href = url;
    link.click();
  } catch (err) {
    console.error('Failed to save image:', err);
    alert('Failed to generate image. Please try again.');
  } finally {
    // Restore original scroll/overflow styles
    modalCard.style.maxHeight = origMaxHeight;
    modalCard.style.overflow = origOverflow;
    backdrop.style.overflow = origBackdropOverflow;

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

// Initial load
fetchData();
