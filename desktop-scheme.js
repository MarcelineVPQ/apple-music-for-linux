// Is the desktop light or dark? (pure: text in, 'dark' | 'light' | null out). Chromium on Linux takes
// its answer from the GTK theme, which on KDE can say "Breeze" (light) while the desktop is BreezeDark,
// so Sonata's windows came out light on a dark desktop (and lyrics with dark words on a dark album
// tint, 0.15.31). Sonata asks what the desktop itself says, in this order:
//   1. the XDG portal's org.freedesktop.appearance color-scheme (1 dark, 2 light, 0 no preference)
//   2. KDE's kdeglobals: [Colors:Window] BackgroundNormal (dark when its luminance is low)
//   3. Chromium's own answer (nativeTheme), when neither says anything
// Sonata's own choice (Ctrl+D, Settings → Appearance → Theme) always wins over all of them.

// `gdbus call ... org.freedesktop.portal.Settings.ReadOne org.freedesktop.appearance color-scheme`
// prints "(<uint32 1>,)" (older portals: Read, "(<<uint32 1>>,)")
function parsePortal(text) {
  const m = /uint32\s+(\d+)/.exec(String(text || ''))
  if (!m) return null
  return m[1] === '1' ? 'dark' : m[1] === '2' ? 'light' : null
}

// a `gdbus monitor` line announcing a change: "... SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)"
function parsePortalSignal(line) {
  const l = String(line || '')
  if (!/SettingChanged/.test(l) || !/org\.freedesktop\.appearance/.test(l) || !/color-scheme/.test(l)) return undefined
  return parsePortal(l)
}

function parseKdeglobals(text) {
  const t = String(text || '')
  const sec = /^\[Colors:Window\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(t)
  const m = sec && /^BackgroundNormal=(\d+),(\d+),(\d+)/m.exec(sec[1])
  if (!m) {
    const name = /^ColorScheme=(.+)$/m.exec(t)
    return name ? (/dark/i.test(name[1]) ? 'dark' : 'light') : null
  }
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const L = 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3])
  return L < 0.18 ? 'dark' : 'light'
}

// what Sonata's windows use: Sonata's own choice, else the desktop's, else Chromium's
function effectiveScheme(pref, portal, kde, chromiumDark) {
  if (pref === 'light' || pref === 'dark') return pref
  return portal || kde || (chromiumDark ? 'dark' : 'light')
}

module.exports = { parsePortal, parsePortalSignal, parseKdeglobals, effectiveScheme }
