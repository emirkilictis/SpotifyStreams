/* Shared authentication and song editing helpers are defined by admin.html. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const artistSelect = el('releases-artist'), message = el('releases-message'), detail = el('release-detail');
  let releases = [], selected = null, generation = 0, detailGeneration = 0;
  const visible = row => row.state.code === 'visible';
  async function json(path, opts) {
    const response = await api(path, opts);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
    return data;
  }
  function reset() {
    generation++; detailGeneration++; releases = []; selected = null;
    el('releases-list').innerHTML = '';
    detail.innerHTML = '';
    artistSelect.innerHTML = '<option value="">Choose an artist…</option>';
    message.textContent = '';
  }
  async function open() {
    const token = ++generation;
    try {
      const artists = await json('/api/admin/artists');
      if (token !== generation || !passcode) return;
      const previous = artistSelect.value;
      artistSelect.innerHTML = '<option value="">Choose an artist…</option>' + artists
        .filter(a => adminRole !== 'secadmin' || a.artist_id !== '31TPClRtHm23RisEBtV3X7')
        .map(a => `<option value="${esc(a.artist_id)}">${esc(a.name)}${a.active ? '' : ' (inactive)'}</option>`).join('');
      artistSelect.value = previous;
      if (artistSelect.value) await load();
    } catch (err) { if (token === generation) message.textContent = err.message; }
  }
  async function load() {
    const artist = artistSelect.value, token = ++generation;
    message.textContent = '';
    if (!artist) { releases = []; render(); return; }
    el('releases-list').innerHTML = '<div class="loading">Loading releases…</div>';
    try {
      const data = await json('/api/admin/releases?artist=' + encodeURIComponent(artist));
      if (token !== generation || !passcode) return;
      releases = data.releases;
      if (!data.setup_ready) message.textContent = 'Release management setup is incomplete. Visibility changes are unavailable.';
      else if (!data.artist.active) message.textContent = 'This artist is inactive. Their profile is not in the public artist picker.';
      else if (data.artist.locked) message.textContent = 'This artist’s profile requires an access code.';
      render();
    } catch (err) { if (token === generation) { message.textContent = err.message; el('releases-list').innerHTML = ''; } }
  }
  function render() {
    const q = el('releases-search').value.trim().toLowerCase(), filter = el('releases-filter').value;
    const rows = releases.filter(r => (!q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      && (filter === 'all' || (filter === 'visible' ? visible(r) : !visible(r))));
    el('releases-count').textContent = releases.length ? `${rows.length} of ${releases.length} releases · ${releases.filter(visible).length} visible` : '';
    el('releases-list').innerHTML = rows.map(r => `<button type="button" class="release-row" data-release="${esc(r.id)}" aria-pressed="${selected === r.id}">
      ${/^https:\/\//.test(r.image_url || '') ? `<img src="${esc(r.image_url)}" alt="" loading="lazy">` : ''}
      <span><b>${esc(r.title)}</b><small>${esc(r.release_date || 'Date unknown')} · ${r.track_count} collected recordings</small>
        <small class="release-state ${visible(r) ? 'visible' : ''}">${esc(r.state.label)}</small></span></button>`).join('')
      || `<div class="empty">${artistSelect.value ? 'No releases match. Paste a Spotify link above to check or add a release.' : 'Choose an artist to see their releases.'}</div>`;
  }
  async function inspect(reference) {
    const artist = artistSelect.value;
    if (!artist) { message.textContent = 'Choose an artist first.'; artistSelect.focus(); return; }
    const token = ++detailGeneration;
    selected = null;
    detail.innerHTML = '<div class="release-panel">Checking visibility…</div>';
    try {
      const data = await json('/api/admin/releases/diagnose?artist=' + encodeURIComponent(artist) + '&reference=' + encodeURIComponent(reference));
      if (token !== detailGeneration || artist !== artistSelect.value || !passcode) return;
      selected = data.album?.id || null;
      render(); renderDetail(data);
      if (matchMedia('(max-width:800px)').matches) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { if (token === detailGeneration) detail.innerHTML = `<div class="release-panel">${esc(err.message)}</div>`; }
  }
  function renderDetail(data) {
    const album = data.album;
    const manageable = album?.display_album_id && !['unrelated','missing'].includes(data.state.code);
    detail.innerHTML = `<div class="release-panel"><h3>${esc(album?.title || 'Visibility check')}</h3>
      <span class="release-state ${data.state.code === 'visible' ? 'visible' : ''}">${esc(data.state.label)}</span>
      ${!data.artist.active ? '<p class="songs-hint">The artist is inactive; their profile is absent from the public picker.</p>' : data.artist.locked ? '<p class="songs-hint">The profile requires an access code.</p>' : ''}
      ${data.track?.canonical_id ? `<p class="songs-hint">Canonical recording: <button type="button" class="act" data-release-song="${esc(data.track.canonical_id)}">Manage recording</button></p>` : ''}
      <p class="songs-hint">${esc(data.reference.kind === 'track' ? 'Song' : 'Album')} · <a href="https://open.spotify.com/${esc(data.reference.kind)}/${esc(data.reference.id)}" target="_blank" rel="noopener noreferrer">Open in Spotify ↗</a></p>
      ${data.can_import || manageable ? `<p class="songs-hint">Preview this album, check its artist credits, then choose the songs to add.</p><button type="button" class="act ok" data-release-import="${esc(manageable ? album.id : data.reference.id)}">Preview album import</button>` : ''}
      ${manageable ? `<form id="release-settings-form" class="release-settings" data-album="${esc(album.display_album_id)}">
        <label>Profile visibility<select name="visibility" class="search"><option value="auto">Automatic</option><option value="show">Show on profile</option><option value="hide">Hide from profile</option></select></label>
        <label>Release label<select name="release_type" class="search"><option value="auto">Automatic</option><option value="album">Album</option><option value="ep">EP</option><option value="single">Single</option></select></label>
        <label>Display priority<input name="sort_order" class="search" type="number" min="0" max="9999" placeholder="Default ordering"></label>
        <p class="songs-hint">Lower numbers appear first. Leave blank to use the visitor’s selected sort. These settings affect this artist’s album list.</p>
        <div class="release-save-row"><button type="submit" class="act ok" ${data.setup_ready ? '' : 'disabled'}>Save settings</button><button type="button" class="act" data-release-reset>Use automatic settings</button><span id="release-save-message" role="status"></span></div>
      </form><h4>Songs and copies (${data.tracks.length})</h4>
      <p class="songs-hint">${album.displayed_track_count} songs on the profile’s album card. Merged copies share a recording and are counted once.</p>
      ${data.tracks.map(t => `<div class="release-track"><b>${t.track_number || '•'}. ${esc(t.title)}${t.selected ? ' · selected song' : ''}</b>
        <small>${[t.hidden ? 'Hidden from the site' : '', t.album_hidden ? 'Hidden from album lists' : '', t.canonical_id ? 'Merged into ' + t.head_id : '', t.pinned_album ? 'Assigned to album ' + t.pinned_album : '', !t.last_observation ? 'No playcount observation for this copy' : 'Last observation: ' + t.last_observation].filter(Boolean).map(esc).join(' · ')}</small>
        <button type="button" class="act" data-release-song="${esc(t.head_id)}">Manage song</button>${t.added_membership ? `<button type="button" class="act" data-release-remove="${esc(t.id)}" data-album="${esc(album.display_album_id)}">Remove added membership</button>` : ''}</div>`).join('')}
      <div class="release-diagnose"><label for="release-add-song">Add an existing recording to this album</label><form id="release-add-form" class="toolbar" data-album="${esc(album.display_album_id)}"><input id="release-add-song" class="search" maxlength="2048" placeholder="Spotify song link" required><button type="submit" class="act">Add recording</button></form><small class="songs-hint">Adds album membership; the recording keeps its original album and history.</small><p id="release-add-message" role="status"></p></div>` : ''}</div>`;
    const form = el('release-settings-form');
    if (form) {
      form.elements.visibility.value = album.visibility;
      form.elements.release_type.value = album.release_type;
      form.elements.sort_order.value = album.sort_order ?? '';
    }
  }
  artistSelect.addEventListener('change', () => {
    detailGeneration++; selected = null;
    detail.innerHTML = '<div class="release-placeholder">Select a release to inspect its visibility and songs.</div>';
    load();
  });
  el('releases-search').addEventListener('input', render);
  el('releases-filter').addEventListener('change', render);
  el('releases-refresh').addEventListener('click', () => { load(); if (selected) inspect('spotify:album:' + selected); });
  el('releases-list').addEventListener('click', event => {
    const button = event.target.closest('[data-release]');
    if (button) inspect('spotify:album:' + button.dataset.release);
  });
  el('release-diagnose-form').addEventListener('submit', event => { event.preventDefault(); inspect(el('release-reference').value.trim()); });
  detail.addEventListener('click', async event => {
    const song = event.target.closest('[data-release-song]');
    if (song) { jumpToSong(song.dataset.releaseSong); return; }
    if (event.target.closest('[data-release-reset]')) {
      const form = el('release-settings-form');
      form.elements.visibility.value = 'auto'; form.elements.release_type.value = 'auto'; form.elements.sort_order.value = '';
      el('release-save-message').textContent = 'Automatic settings selected. Save to apply.';
    }
    const remove = event.target.closest('[data-release-remove]');
    if (remove) {
      const artist = artistSelect.value, token = detailGeneration;
      remove.disabled = true;
      try {
        await json('/api/admin/releases/' + encodeURIComponent(remove.dataset.album) + '/tracks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artist_id: artist, song_url: remove.dataset.releaseRemove, action: 'remove' }),
        });
        if (artist === artistSelect.value && token === detailGeneration) { await load(); await inspect('spotify:album:' + remove.dataset.album); }
      } catch (err) { if (token === detailGeneration) message.textContent = err.message; }
      finally { remove.disabled = false; }
      return;
    }
    const button = event.target.closest('[data-release-import]');
    if (!button) return;
    const artist = artistSelect.value;
    button.disabled = true; message.textContent = 'Starting album preview…';
    try {
      const job = await json('/api/admin/playlist-imports', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist_id: artist, album_url: 'https://open.spotify.com/album/' + button.dataset.releaseImport }) });
      document.querySelector('[data-view="artists"]').click();
      await loadArtists();
      playlistArtist.value = artist;
      await openPlaylistImport(job.id);
      el('playlist-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
      message.textContent = '';
    } catch (err) { message.textContent = err.message; }
    finally { button.disabled = false; }
  });
  detail.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target, artist = artistSelect.value, token = detailGeneration;
    if (!['release-settings-form','release-add-form'].includes(form.id)) return;
    const output = el(form.id === 'release-settings-form' ? 'release-save-message' : 'release-add-message');
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    output.textContent = 'Saving…';
    try {
      const settings = form.id === 'release-settings-form';
      const body = settings ? { artist_id: artist, visibility: form.elements.visibility.value,
        release_type: form.elements.release_type.value, sort_order: form.elements.sort_order.value === '' ? null : Number(form.elements.sort_order.value) }
        : { artist_id: artist, song_url: el('release-add-song').value.trim() };
      await json('/api/admin/releases/' + encodeURIComponent(form.dataset.album) + (settings ? '/settings' : '/tracks'),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (token !== detailGeneration || artist !== artistSelect.value) return;
      await load(); await inspect('spotify:album:' + form.dataset.album);
      const saved = el(settings ? 'release-save-message' : 'release-add-message');
      if (saved) saved.textContent = settings ? 'Saved. Profile list refreshed.' : 'Recording added.';
    } catch (err) { if (token === detailGeneration) output.textContent = err.message; }
    finally { button.disabled = false; }
  });
  window.releaseAdmin = { open, reset };
})();
