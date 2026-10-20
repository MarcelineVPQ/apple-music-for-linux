// Duets and other songs with more than one singer (Apple TTML ttm:agent; 0.15.68). The one view engine
// (lyrics-view.js) asks this model how each line is drawn; no DOM here.
//
// Default (Marcy 2026-10-19): every singer in ONE column with the same alignment, size and position;
// the only per-singer difference is the sung colour (singer 1: the page's --active, singer 2: --active-2,
// lines sung together: --active-mix, the shared blend; all theme tokens fitted to 4.5:1, theme.js).
//
// Singer lanes with name tags are built but off: each singer's lines in their own column, in time order,
// lines sung together spanning all lanes, a quiet name tag at each singer change. They wait for Marcy's OK;
// enabling them is one line: LANES (the section labels' singer names reuse LANES and singerLabels). Inside lanes every singer has one colour unless
// LANE_COLOURS allows the per-singer colours too. Not a setting (never shown in Settings).
const LANES = false
const LANE_COLOURS = false
// a lane narrower than this (px) can't hold a line: the lanes collapse to one column (name tags kept)
const LANE_MIN_PX = 260
// more singers than this: one column with name tags
const MAX_LANES = 3

// 'v2' < 'v10'
function agentOrder(a, b) {
  return (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0) || (a < b ? -1 : a > b ? 1 : 0)
}

/** The song's singers (agent ids, 'group' left out), in Apple's order; fewer than two: not a duet. */
function singersOf(lines) {
  // loop: NOT-WORTH — the song's lines, once per song laid out
  return [...new Set((lines || []).map((l) => l && l.agent).filter((a) => a && a !== 'group'))].sort(agentOrder)
}

/**
 * How each line of a song is drawn. opts: { lanes, laneColours } (default: the flags above).
 * -> { duet, singers, lanes: 0 (one column) or the lane count, voice: per line the colour class
 * ('singer-1' | 'singer-2' | 'singer-group' | ''), lane: per line its lane index, -1 for a line sung
 * together or without a singer mark (spans every lane), null when there are no lanes; who: per line its
 * singer's id or 'group', null when there are no lanes }.
 */
function duetPlan(lines, opts = {}) {
  const list = lines || []
  const singers = singersOf(list)
  const duet = singers.length >= 2
  const lanesOn = duet && (opts.lanes != null ? !!opts.lanes : LANES)
  const colours = duet && (!lanesOn || (opts.laneColours != null ? !!opts.laneColours : LANE_COLOURS))
  const lanes = lanesOn ? Math.min(singers.length, MAX_LANES) : 0
  const many = lanesOn && singers.length > MAX_LANES
  // loop: NOT-WORTH — the song's lines, once per song laid out
  const voice = list.map((l) => {
    if (!colours) return ''
    if (!l.agent || l.agent === 'group') return 'singer-group'
    return singers.indexOf(l.agent) % 2 ? 'singer-2' : 'singer-1'
  })
  // loop: NOT-WORTH — the song's lines, once per song laid out
  const lane = lanesOn ? list.map((l) => (!l.agent || l.agent === 'group' ? -1 : many ? 0 : singers.indexOf(l.agent))) : null
  // loop: NOT-WORTH — the song's lines, once per song laid out
  const who = lanesOn ? list.map((l) => (!l.agent || l.agent === 'group' ? 'group' : l.agent)) : null
  return { duet, singers, lanes: many ? 1 : lanes, voice, lane, who }
}

// "Dominic Cooper & Amanda Seyfried", "A, B & C", "A feat. B" -> the credited names, in order
function creditedNames(artist) {
  // loop: NOT-WORTH — the song's lines, sections or singers (≤ ~150), once per song's lyrics (main.js lyrics lookup on a track change), not per tick
  return String(artist || '').split(/\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i).map((s) => s.trim()).filter(Boolean)
}

/**
 * The name tag of each singer. names: { agentId: name } from Apple's TTML (ttm:name), used as given;
 * else the track's credited artists when they are exactly as many as the singers and each looks like a
 * person's full name (two words or more: "Mumford & Sons" and "Simon & Garfunkel" don't), matched in
 * Apple's singer order; else neutral "Singer 1", "Singer 2". Never a guess. -> { id: label, group: label }
 */
function singerLabels(singers, names, artist) {
  const own = names && typeof names === 'object' ? names : {}
  const credited = creditedNames(artist)
  // loop: NOT-WORTH — the song's lines, sections or singers (≤ ~150), once per song's lyrics (main.js lyrics lookup on a track change), not per tick
  const fromArtist = credited.length === singers.length && credited.every((n) => n.split(/\s+/).length >= 2)
  // cache: NOT-WORTH — key=index/kind; invalidated=each call (local to one analysis of a song's lyrics); bound=the song's lines (≤ ~150)
  const out = {}
  // loop: NOT-WORTH — the song's singers (2-3)
  singers.forEach((id, i) => {
    const own1 = typeof own[id] === 'string' ? own[id].trim() : ''
    out[id] = own1 || (fromArtist ? credited[i] : 'Singer ' + (i + 1))
  })
  out.group = 'Together'
  return out
}

/**
 * Where a name tag goes: at each lane's first line and wherever the singer changes from the line before
 * (the same rule in lanes and in one collapsed column). who: duetPlan's who. -> per line true/false.
 */
function tagAt(who) {
  if (!who) return []
  // loop: NOT-WORTH — the song's lines, once per song laid out
  return who.map((k, i) => i === 0 || who[i - 1] !== k)
}

/** Lanes too narrow for a line: one column. width: the list's width (px). */
function collapsed(width, lanes) {
  return lanes > 1 && width > 0 && width / lanes < LANE_MIN_PX
}

module.exports = { LANES, LANE_COLOURS, LANE_MIN_PX, MAX_LANES, agentOrder, singersOf, duetPlan, creditedNames, singerLabels, tagAt, collapsed }
