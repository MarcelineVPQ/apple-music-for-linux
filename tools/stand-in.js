// A stand-in player for the checks (tools/ui-check.js `every`, tools/check-budgets.js): Apple's page in an
// ISOLATED copy is logged out and plays nothing, so this replaces `MusicKit.getInstance()` in that page
// (main world, the test copy only) with a local player that "plays" a looped set of test tracks on the
// wall clock. Everything main.js reads through MusicKit then runs for real: the 5 s now-playing loop
// (tray, notifications), the mini player's 1 s poll, the lyrics feed (500 ms), the lyrics lookup (the
// stand-in answers /syllable-lyrics with word-timed TTML, so the real resolver, cache and lyrics view
// run), next-song prefetch, the palette and Glass backdrop from the track's artwork (data: URLs of the
// test artworks) and the media-position script.
//
// No sound: there is no media element. A real <audio> in the test copy could reach the machine's sound
// card (the isolated copy has no PulseAudio, so Chromium would try ALSA), so the clock stands in.
// Nothing here ships: it is not in package.json build.files.
'use strict'
const fs = require('fs')
const path = require('path')

const art = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, f)).toString('base64')

// word-timed TTML like Apple's /syllable-lyrics: two singers, background vocals, held notes, syllables,
// an interlude long enough for the countdown dots
function ttml(seed, duration) {
  const vocab = ['shining', 'over', 'the', 'water', 'tonight', 'we', 'are', 'golden', 'and', 'never', 'falling', 'down', 'carry', 'me', 'home']
  const ps = []
  let t = 3
  for (let i = 0; t < duration - 8; i++) {
    if (i === 6) t += 12   // interlude: countdown dots
    const n = 5 + ((i + seed) % 3)
    const spans = []
    let w = t
    // loop: NOT-WORTH — test fixture, a few words per line, built once per track
    for (let j = 0; j < n; j++) {
      const text = vocab[(i * 3 + j + seed) % vocab.length]
      const d = j === n - 1 && i % 4 === 3 ? 1.8 : 0.42   // every 4th line ends on a held note
      if (text.length > 5) {   // two syllables, as Apple times them
        const h = Math.ceil(text.length / 2)
        spans.push(`<span begin="${w.toFixed(3)}" end="${(w + d / 2).toFixed(3)}">${text.slice(0, h)}</span><span begin="${(w + d / 2).toFixed(3)}" end="${(w + d).toFixed(3)}">${text.slice(h)}</span>`)
      } else spans.push(`<span begin="${w.toFixed(3)}" end="${(w + d).toFixed(3)}">${text}</span>`)
      w += d + 0.06
    }
    const bg = i % 5 === 2 ? ` <span ttm:role="x-bg"><span begin="${(t + 0.5).toFixed(3)}" end="${(t + 1).toFixed(3)}">(ooh</span> <span begin="${(t + 1).toFixed(3)}" end="${(t + 1.5).toFixed(3)}">yeah)</span></span>` : ''
    ps.push(`<p begin="${t.toFixed(3)}" end="${w.toFixed(3)}" ttm:agent="${i % 6 === 4 ? 'v2' : 'v1'}">${spans.join(' ')}${bg}</p>`)
    t = w + 0.4
  }
  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word" xml:lang="en">` +
    `<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head><body><div>${ps.join('')}</div></body></tt>`
}

// three tracks, looped: a track change every ~75-90 s exercises the track-change paths too
function tracks() {
  return [
    { id: '9000000001', name: 'Stand-in One', artist: 'Sonata Test', album: 'Checks (Live)', duration: 75, art: art('dark-artwork.png') },
    { id: '9000000002', name: 'Stand-in Two', artist: 'Sonata Test', album: 'Checks (Live)', duration: 90, art: art('light-artwork.png') },
    { id: '9000000003', name: 'Stand-in Three', artist: 'Sonata Test', album: 'Checks (Live)', duration: 80, art: art('worst-artwork.png') }
  ].map((t, i) => Object.assign(t, { ttml: ttml(i, t.duration) }))
}

// The page script: installs the stand-in (idempotent) and returns its state. `opts.playing` starts it.
function installScript(opts = {}) {
  return `(() => {
  const T = ${JSON.stringify(tracks())};
  if (!window.__sonataStandIn) {
    const s = { pos: 0, playing: false, base: 0, at: performance.now(), volume: 0.8, shuffleMode: 0, repeatMode: 2 };
    const now = () => s.base + (s.playing ? (performance.now() - s.at) / 1000 : 0);
    /* loop: NOT-WORTH — test stand-in: advances past the tracks a long pause skipped (a few at most) */
    const settle = () => { let t = now(); while (t >= T[s.pos].duration) { t -= T[s.pos].duration; s.pos = (s.pos + 1) % T.length; s.base = t; s.at = performance.now() } };
    const item = (tr) => ({ id: tr.id, type: 'songs', container: null, attributes: { name: tr.name, artistName: tr.artist, albumName: tr.album, durationInMillis: tr.duration * 1000, contentRating: '', url: 'https://music.apple.com/us/album/stand-in/9000000000?i=' + tr.id, playParams: { id: tr.id, catalogId: tr.id, kind: 'song' }, artwork: { url: tr.art } } });
    const mk = {
      get isPlaying() { return s.playing },
      get playbackState() { return s.playing ? 2 : 3 },
      get nowPlayingItem() { settle(); return item(T[s.pos]) },
      get currentPlaybackTime() { settle(); return now() },
      get currentPlaybackDuration() { return T[s.pos].duration },
      get queue() { settle(); return { position: s.pos, items: T.concat(T).map(item) } },
      get volume() { return s.volume }, set volume(v) { s.volume = Math.max(0, Math.min(1, +v || 0)) },
      get shuffleMode() { return s.shuffleMode }, set shuffleMode(v) { s.shuffleMode = v },
      get repeatMode() { return s.repeatMode }, set repeatMode(v) { s.repeatMode = v },
      play() { if (!s.playing) { s.base = now(); s.at = performance.now(); s.playing = true } return Promise.resolve() },
      pause() { if (s.playing) { s.base = now(); s.playing = false } return Promise.resolve() },
      seekToTime(t) { s.base = Math.max(0, Math.min(+t || 0, T[s.pos].duration - 0.5)); s.at = performance.now(); return Promise.resolve() },
      skipToNextItem() { s.pos = (s.pos + 1) % T.length; s.base = 0; s.at = performance.now(); return Promise.resolve() },
      skipToPreviousItem() { s.pos = (s.pos + T.length - 1) % T.length; s.base = 0; s.at = performance.now(); return Promise.resolve() },
      api: { music: async (p) => {
        const m = /\\/songs\\/(\\d+)\\/(syllable-lyrics|lyrics)/.exec(p);
        if (m) { const tr = T.find((x) => x.id === m[1]); return { data: { data: tr ? [{ attributes: { ttml: tr.ttml } }] : [] } } }
        if (/\\/me\\/ratings\\//.test(p)) return { data: { data: [] } };
        if (/\\/me\\/library/.test(p)) return { data: {} };
        throw new Error('stand-in: no ' + p);
      } }
    };
    window.__sonataStandIn = { s, mk, now, settle, tracks: T.map((t) => ({ name: t.name, duration: t.duration })) };
    if (window.MusicKit && !window.__sonataRealGetInstance) window.__sonataRealGetInstance = window.MusicKit.getInstance;
    window.MusicKit = window.MusicKit || {};
    window.MusicKit.getInstance = () => mk;
  }
  const si = window.__sonataStandIn;
  ${opts.playing === true ? 'si.mk.play();' : opts.playing === false ? 'si.mk.pause();' : ''}
  ${Number.isFinite(opts.seek) ? `si.mk.seekToTime(${opts.seek});` : ''}
  return { installed: true, playing: si.s.playing, pos: si.s.pos, time: +si.now().toFixed(2), title: si.tracks[si.s.pos].name };
})()`
}

module.exports = { tracks, ttml, installScript }
