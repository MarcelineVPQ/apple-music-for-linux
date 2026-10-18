// The playing song's actions (Favorite, Add to Library, Add to a playlist, Copy Link, Go to Album / Artist)
// behind one source-neutral interface, so the Studio and the mini player's ⋯ menu ask "the source" and
// never MusicKit directly (Sonata's sources may grow beyond Apple Music: the universal lyric player).
// createAppleSource({ run }) is Apple Music's adapter: page scripts run in Apple's page through run(code)
// (main.js: appleWC().executeJavaScript). No DOM, no Electron here; tested in test/song-actions.test.js
// (the scripts run against a stand-in MusicKit). Nothing here polls: each call is one user action, or one
// read when the song changes while the Studio shows.
'use strict'
const mini = require('./mini-model')

// an id that may be written into a page script (Apple's catalog, library and playlist ids)
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/
const safeId = (v) => typeof v === 'string' && SAFE_ID.test(v)

// the playing song's id as the mini player has always read it: the catalog id, else its own id
const ID_OF = `const attrs = item.attributes || {};
    const pp = attrs.playParams || {};
    const id = String(pp.catalogId || pp.id || item.id || '');`

/**
 * The playing song's state, read once per song (and after an action): its ids, link, favourite rating,
 * whether it is in the library (true / false, or null when Apple doesn't say) and its album's and artist's
 * catalog ids. -> { ok, id, title, artist, url, rating, inLibrary, albumId, artistId } or { ok: false }
 */
const stateScript = `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    if (!item) return { ok: false, why: 'nothing' };
    ${ID_OF}
    const out = { ok: true, id, title: String(attrs.name || ''), artist: String(attrs.artistName || ''), url: String(attrs.url || ''), rating: 0, inLibrary: pp.isLibrary ? true : null, albumId: '', artistId: '' };
    const m = out.url.match(/\\/album\\/[^/]*\\/?(\\d+)/);
    out.albumId = m ? m[1] : (item.container && item.container.type === 'albums' ? String(item.container.id || '') : '');
    const rel = item.relationships || {};
    const ar = rel.artists && rel.artists.data && rel.artists.data[0];
    if (ar && /^\\d+$/.test(String(ar.id))) out.artistId = String(ar.id);
    try {
      // read fresh (no HTTP cache: right after a Favorite the answer must be Apple's new one); a song known
      // only by its library id (i.…) is rated as a library song
      const r = await mk.api.music('/v1/me/ratings/' + (/^\\d+$/.test(id) ? 'songs' : 'library-songs'), { ids: id }, { fetchOptions: { cache: 'no-store' } });
      const entry = r && r.data && r.data.data && r.data.data[0];
      out.rating = entry && entry.attributes ? entry.attributes.value : 0;
    } catch (e) { /* error: NOT-WORTH — not rated (or no answer): shown as not a favourite */ }
    if (/^\\d+$/.test(id)) {
      try {
        const sf = mk.storefrontId || 'us';
        const s = await mk.api.music('/v1/catalog/' + sf + '/songs/' + id, { include: 'artists', relate: 'library' });
        const d = s && s.data && s.data.data && s.data.data[0];
        const r2 = (d && d.relationships) || {};
        if (out.inLibrary === null && r2.library && Array.isArray(r2.library.data)) out.inLibrary = r2.library.data.length > 0;
        const a2 = r2.artists && r2.artists.data && r2.artists.data[0];
        if (!out.artistId && a2 && /^\\d+$/.test(String(a2.id))) out.artistId = String(a2.id);
        const al = r2.albums && r2.albums.data && r2.albums.data[0];
        if (!out.albumId && al && /^\\d+$/.test(String(al.id))) out.albumId = String(al.id);
      } catch (e) { /* error: NOT-WORTH — no answer: the library state stays unknown (Add to Library stays offered), no artist link */ }
    }
    return out;
  } catch (e) { /* error: PASSES-ON — no MusicKit yet (page loading): { ok: false }, the Studio says nothing is known */
    return { ok: false, why: 'not-ready' };
  }
})()`

/** Favorite (value 1) or undo it (null), for the song with this id. */
const favoriteScript = (id, value) => `(async () => {
    const mk = MusicKit.getInstance();
    await mk.api.music('/v1/me/ratings/${/^\d+$/.test(id) ? 'songs' : 'library-songs'}/${id}', {}, { fetchOptions: {
      method: '${value === null ? 'DELETE' : 'PUT'}',
      ${value === null ? '' : `body: JSON.stringify({ type: 'rating', attributes: { value: ${Number(value)} } }),`}
      headers: { 'Content-Type': 'application/json' }
    } });
  })()`

/** Add the song with this id to the library. */
const addToLibraryScript = (id) => `(async () => {
    const mk = MusicKit.getInstance();
    await mk.api.music('/v1/me/library', { 'ids[songs]': '${id}' }, { fetchOptions: { method: 'POST' } });
  })()`

// the user's own playlists that take songs (canEdit), at most PLAYLISTS_MAX, read when the menu opens
const PLAYLISTS_MAX = 100
const playlistsScript = `(async () => {
  const mk = MusicKit.getInstance();
  const r = await mk.api.music('/v1/me/library/playlists', { limit: ${PLAYLISTS_MAX} });
  const list = (r && r.data && r.data.data) || [];
  /* loop: NOT-WORTH — the user's playlists (≤ ${PLAYLISTS_MAX}), once per menu open */
  return list.filter((p) => p && p.attributes && p.attributes.canEdit !== false).map((p) => ({ id: String(p.id), name: String(p.attributes.name || '') }));
})()`
/** Add the song (a catalog id) to one of the user's playlists. */
const addToPlaylistScript = (playlistId, id) => `(async () => {
    const mk = MusicKit.getInstance();
    await mk.api.music('/v1/me/library/playlists/${playlistId}/tracks', {}, { fetchOptions: {
      method: 'POST',
      body: JSON.stringify({ data: [{ id: '${id}', type: '${/^\d+$/.test(id) ? 'songs' : 'library-songs'}' }] }),
      headers: { 'Content-Type': 'application/json' }
    } });
  })()`

/**
 * Open the playing song's album or artist in Apple's page through a link already in the page (the
 * now-playing bar, lists), found through shadow roots, so playback goes on (client-side routing). The
 * album id comes from the song's catalog URL (…/album/name/123?i=456) or its container (or given: a queue
 * row's album, digits only); the artist's from the song's relationships, else the catalog.
 * -> true when a link was clicked, false otherwise.
 */
const openPageScript = (kind, given) => `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    let id = ${JSON.stringify(/^\d{1,20}$/.test(String(given || '')) ? String(given) : '')};
    if (!id && !item) return false;
    if (id) { /* a queue row's album (its id from the queue, digits only) */ }
    else if (${JSON.stringify(kind)} === 'album') {
      const m = String((item.attributes && item.attributes.url) || '').match(/\\/album\\/[^/]*\\/?(\\d+)/);
      id = m ? m[1] : (item.container && item.container.type === 'albums' ? String(item.container.id) : '');
    } else {
      const rel = item.relationships || {};
      const ar = rel.artists && rel.artists.data && rel.artists.data[0];
      id = ar ? String(ar.id) : '';
      const pp = (item.attributes && item.attributes.playParams) || {};
      const sid = String(pp.catalogId || pp.id || item.id || '');
      if (!/^\\d+$/.test(id) && /^\\d+$/.test(sid)) {
        try {
          const s = await mk.api.music('/v1/catalog/' + (mk.storefrontId || 'us') + '/songs/' + sid, { include: 'artists' });
          const d = s && s.data && s.data.data && s.data.data[0];
          const a = d && d.relationships && d.relationships.artists && d.relationships.artists.data && d.relationships.artists.data[0];
          id = a ? String(a.id) : '';
        } catch (e) { /* error: PASSES-ON — no answer: false, the caller says the artist couldn't be opened */ }
      }
    }
    if (!/^\\d+$/.test(id)) return false;
    const re = new RegExp('/${kind}/(?:[^/?#]*/)?' + id + '(?:[?#]|$)');
    const walk = (root, depth) => {
      if (depth > 25) return null;
      /* loop: NOT-WORTH — one walk per click, shadow depth ≤ 25 */
      for (const a of root.querySelectorAll('a[href*="/${kind}/"]')) if (re.test(a.getAttribute('href'))) return a;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const hit = walk(el.shadowRoot, depth + 1); if (hit) return hit; }
      }
      return null;
    };
    const link = walk(document, 0);
    if (link) link.click();
    return !!link;
  } catch (e) { /* error: PASSES-ON — no song or no MusicKit: false, the caller says so */ return false; }
})()`

/**
 * Play a song of the queue next (the Studio's row menu): MusicKit's playNext inserts it after the song
 * playing (it also stays at its own place). The id is checked again in the queue at that index.
 * -> 'ok' | 'gone' (the queue moved on) | 'unsupported' (no playNext in this player)
 */
const playNextScript = (index, id) => `(async () => {
  const mk = MusicKit.getInstance();
  const it = mk.queue && mk.queue.items ? mk.queue.items[${Number(index) | 0}] : null;
  if (!it || String(it.id) !== ${JSON.stringify(String(id))}) return 'gone';
  if (typeof mk.playNext !== 'function') return 'unsupported';
  const pp = (it.attributes && it.attributes.playParams) || {};
  await mk.playNext({ song: String(pp.catalogId || pp.id || it.id) });
  return 'ok';
})()`

// what each action says in the Studio (ok) and when it fails; the three the mini player's ⋯ menu also has
// take their failure words from mini-model.js actionFailedText (one set of words)
const failed = (a) => mini.actionFailedText(a, '').title
const SAID = {
  favorite: ['Added to Favorites', failed('favorite')],
  'undo-favorite': ['Removed from Favorites', failed('undo-favorite')],
  library: ['Added to Library', failed('library')],
  playlist: ['Added to', 'Adding to the playlist didn\'t go through'],
  playlists: ['', 'Your playlists didn\'t load'],
  link: ['Link copied', 'The link wasn\'t copied'],
  share: ['Song and link copied', 'Nothing was copied'],
  'play-next': ['Plays next (it also stays at its place in the queue)', 'Play Next didn\'t go through'],
  album: ['Album opened in Apple Music', 'The album isn\'t shown in Apple Music\'s page right now, so it couldn\'t be opened from here'],
  artist: ['Artist opened in Apple Music', 'The artist isn\'t shown in Apple Music\'s page right now, so it couldn\'t be opened from here']
}
/**
 * The Studio's short note after an action. -> { kind: 'ok' | 'error', text }. extra: the playlist's name
 * (ok), or why it failed ('nothing': nothing playing; 'offline').
 */
function said(action, ok, extra) {
  const w = SAID[action]
  if (!w) return null
  if (ok) return { kind: 'ok', text: action === 'playlist' ? 'Added to “' + String(extra || 'the playlist').slice(0, 60) + '”' : w[0] }
  const why = extra === 'unsupported' ? ': Apple Music\'s player doesn\'t offer it here' : extra === 'gone' ? ': the queue changed, try again' : extra === 'nothing' ? ': nothing is playing' : extra === 'offline' ? ': Sonata is offline' : extra === 'signed-out' ? ': sign in to Apple Music first' : ''
  return { kind: 'error', text: w[1] + why + (why || /couldn't be opened/.test(w[1]) ? '' : '. Try again in a moment') }
}

/** The page script's state, checked and bounded (it comes from Apple's page). */
function cleanState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  if (!r.ok) return { ok: false, why: r.why === 'nothing' ? 'nothing' : 'not-ready' }
  const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const id = s(r.id, 64)
  return {
    ok: true,
    id: safeId(id) ? id : '',
    title: s(r.title, 300),
    artist: s(r.artist, 300),
    url: /^https:\/\/music\.apple\.com\//.test(s(r.url, 600)) ? s(r.url, 600) : '',
    favorite: r.rating === 1,
    inLibrary: r.inLibrary === true ? true : r.inLibrary === false ? false : null,
    albumId: /^\d{1,20}$/.test(s(r.albumId, 20)) ? r.albumId : '',
    artistId: /^\d{1,20}$/.test(s(r.artistId, 20)) ? r.artistId : ''
  }
}

/** What the Studio's action row may offer for a state (no control that can't do anything). */
function offers(st) {
  const ok = !!(st && st.ok && st.id)
  return {
    favorite: ok,
    library: ok && st.inLibrary !== true,
    inLibrary: !!(st && st.inLibrary === true),
    playlist: ok,
    link: !!(st && st.url),
    album: ok,
    artist: ok
  }
}

/**
 * Apple Music's adapter: createAppleSource({ run(code) -> Promise }) -> { name, state(), favorite(id, on),
 * addToLibrary(id), playlists(), addToPlaylist(playlistId, id), open(kind, albumId?), playNext(index, id) }. Ids are checked before they
 * reach a page script; a bad one rejects.
 */
function createAppleSource(deps) {
  const run = deps.run
  const need = (...ids) => { if (!ids.every(safeId)) throw new Error('bad id') }
  return {
    name: 'Apple Music',
    async state() { return cleanState(await run(stateScript)) },
    async favorite(id, on) { need(id); await run(favoriteScript(id, on ? 1 : null)) },
    async addToLibrary(id) { need(id); await run(addToLibraryScript(id)) },
    async playlists() {
      const list = await run(playlistsScript)
      return (Array.isArray(list) ? list : []).filter((p) => p && safeId(p.id) && typeof p.name === 'string').slice(0, PLAYLISTS_MAX).map((p) => ({ id: p.id, name: p.name.slice(0, 120) || 'Untitled playlist' }))
    },
    async addToPlaylist(playlistId, id) { need(playlistId, id); await run(addToPlaylistScript(playlistId, id)) },
    async open(kind, albumId) { if (kind !== 'album' && kind !== 'artist') throw new Error('bad kind'); return !!(await run(openPageScript(kind, albumId))) },
    async playNext(index, id) { if (!Number.isInteger(index) || index < 0 || !safeId(id)) throw new Error('bad id'); return run(playNextScript(index, id)) }
  }
}

module.exports = { SAFE_ID, PLAYLISTS_MAX, safeId, stateScript, favoriteScript, addToLibraryScript, playlistsScript, addToPlaylistScript, openPageScript, playNextScript, said, cleanState, offers, createAppleSource }
