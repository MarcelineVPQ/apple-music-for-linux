// Sample content for the mock-ups. The band, album, people and dates are fictional placeholders
// (marked "sample" in the UI); every song is a traditional public-domain song, so no copyrighted
// lyrics appear. "Oh My Darling, Clementine": words by Percy Montrose, 1884 (public domain).
// Syllables are split with "·" (shown without it) so the karaoke pitch lane and the staff can time
// them; the melody is the traditional tune, illustrative only (the real staff uses analysed notes).
;(function () {
  'use strict'
  const LIVE = ' (Live at the Gorge Amphitheatre, George, WA, 08.30.25)'
  const tracks = [
    ['Wayfaring Stranger', 6.2], ['Shenandoah', 7.4], ['The Water Is Wide', 5.1], ['Red River Valley', 4.8],
    ['Home on the Range', 6.0], ['Down in the Valley', 4.2], ['Black Is the Colour', 7.9], ['Scarborough Fair', 5.6],
    ['Sweet Betsy from Pike', 4.4], ['Hard Times Come Again No More', 8.3], ['Beautiful Dreamer', 6.7], ['Streets of Laredo', 5.2],
    ['Oh My Darling, Clementine', 2.2], ['The Parting Glass', 6.6], ['Cotton-Eyed Joe', 4.9], ['Oh! Susanna', 3.8],
    ['Wildwood Flower', 9.4], ['Swing Low, Sweet Chariot', 7.0], ['Bury Me Not on the Lone Prairie', 5.5], ['Down by the Riverside', 8.8],
    ['I Ride an Old Paint', 4.6], ['Old Joe Clark', 3.9], ['Amazing Grace', 10.2], ['Will the Circle Be Unbroken', 12.4]
  ].map(([title, min], i) => ({ n: i + 1, title, full: title + LIVE, dur: Math.round(min * 60) }))

  const album = {
    title: 'Wayfarers: Live at the Gorge',
    artist: 'The Juniper Lane Band',
    sample: true,
    year: 2026,
    genre: 'Folk',
    date: 'August 30, 2025',
    dateShort: '08.30.25',
    venue: 'The Gorge Amphitheatre',
    place: 'George, Washington',
    cover: 'img/cover-gorge.jpg',
    tracks,
    current: 13
  }

  // the song: verse / chorus, 3/4 time; ~3.1 s a line
  const V = [
    ['In a cav·ern, in a can·yon,', 'Ex·ca·vat·ing for a mine,', 'Dwelt a min·er, for·ty-·nin·er,', 'And his daugh·ter Clem·en·tine.'],
    ['Light she was and like a fair·y,', 'And her shoes were num·ber nine,', 'Her·ring box·es, with·out top·ses,', 'San·dals were for Clem·en·tine.'],
    ['Drove she duck·lings to the wa·ter', 'Ev·\'ry morn·ing just at nine,', 'Hit her foot a·gainst a splin·ter,', 'Fell in·to the foam·ing brine.'],
    ['Ru·by lips a·bove the wa·ter,', 'Blow·ing bub·bles, soft and fine,', 'But, a·las, I was no swim·mer,', 'So I lost my Clem·en·tine.']
  ]
  const C = ['Oh my dar·ling, oh my dar·ling,', 'Oh my dar·ling, Clem·en·tine!', 'You are lost and gone for·ev·er,', 'Dread·ful sor·ry, Clem·en·tine.']
  // the crowd's echo in the choruses (backing vocals)
  const ECHO = ['(oh my darling)', '(Clementine)', '(gone forever)', '(Clementine)']
  // the tune (F major, MIDI), one note per syllable; a few syllables get two (a melisma)
  const TUNE = [
    [65, 65, 65, 60, 69, 69, 69, 65],
    [65, 69, 72, 72, [70, 69], 69, 67],
    [67, 69, 70, 70, 69, 67, 69, 65],
    [65, 69, 67, 60, 64, 67, 65]
  ]
  const LINE = 3.1
  function song(opts) {
    const o = Object.assign({ duet: false, echo: true }, opts || {})
    const lines = []
    let t = 9.5                          // the band's intro
    const stanza = (texts, side, echo, k) => {
      texts.forEach((raw, i) => {
        const l = { raw, text: raw.replace(/·/g, ''), t, d: LINE * 0.93, side, stanza: k, row: i, tune: TUNE[i] }
        if (echo) l.bg = { text: ECHO[i], t: t + LINE * 0.62, d: LINE * 0.34 }
        lines.push(l)
        t += LINE
      })
    }
    V.forEach((v, k) => {
      stanza(v, o.duet ? (k % 2 === 0 ? 'left' : 'right') : '', false, k * 2)
      stanza(C, o.duet ? 'center' : '', o.echo, k * 2 + 1)
      if (k === 1) t += 9.3              // a fiddle break: the interlude dots
    })
    return { lines, duration: t + 7 }
  }
  // syllables (and their notes) of a timed line
  function syllables(line) {
    const out = []
    const words = line.raw.split(/\s+/)
    const sylls = []
    words.forEach((w, wi) => w.split('·').forEach((s, si, arr) => sylls.push({ text: s.replace(/[,.!]/g, ''), word: wi, last: si === arr.length - 1 })))
    const step = line.d / sylls.length
    sylls.forEach((s, i) => {
      const n = line.tune[i] !== undefined ? line.tune[i] : line.tune[line.tune.length - 1]
      const t = line.t + i * step
      out.push(Object.assign(s, { t, end: t + step * 0.92, midi: n }))
    })
    return out
  }

  // the whole song's notes (one per syllable, two on a melisma) and an illustrative sung pitch line
  // (the note, a slide into it, a little vibrato on held notes), every 20 ms
  function melody(lines, duration) {
    const notes = []
    lines.forEach((l, li) => syllables(l).forEach((s, si) => {
      const key = li + ':' + si
      const text = s.text + (s.last ? '' : '-')
      const parts = Array.isArray(s.midi) ? s.midi : [s.midi]
      const step = (s.end - s.t) / parts.length
      parts.forEach((m, k) => notes.push({ t: s.t + k * step, end: s.t + (k + 1) * step - 0.03, midi: m, syl_text: text, syl_key: key, line: li }))
    }))
    const hop = 0.02
    const f0 = []
    let ni = 0
    for (let t = 0; t < duration; t += hop) {
      while (ni < notes.length && notes[ni].end < t) ni++
      const n = notes[ni]
      if (!n || t < n.t - 0.02) { f0.push(null); continue }
      const prev = notes[ni - 1]
      const into = t - n.t
      let m = n.midi
      if (prev && n.t - prev.end < 0.15 && into < 0.07) m = prev.midi + (n.midi - prev.midi) * Math.max(0, into / 0.07)
      const held = n.end - n.t > 0.35 ? Math.min(1, into / 0.25) : 0
      m += 0.18 * held * Math.sin(2 * Math.PI * 5.4 * t) + 0.04 * Math.sin(t * 13.7)
      f0.push(+m.toFixed(2))
    }
    return { notes, f0: { hop_s: hop, midi: f0 } }
  }

  window.MOCK_SONGS = { album, song, syllables, melody, LIVE }
})()
