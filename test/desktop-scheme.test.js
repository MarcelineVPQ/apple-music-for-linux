// Light or dark (desktop-scheme.js): the desktop's answer (portal, then KDE), Sonata's choice on top.
const test = require('node:test')
const assert = require('node:assert/strict')
const D = require('../desktop-scheme')

test('portal: 1 dark, 2 light, 0 / garbage: no answer; change signals', () => {
  assert.equal(D.parsePortal('(<uint32 1>,)'), 'dark')
  assert.equal(D.parsePortal('(<<uint32 2>>,)'), 'light')
  assert.equal(D.parsePortal('(<uint32 0>,)'), null)
  assert.equal(D.parsePortal('Error: GDBus.Error'), null)
  assert.equal(D.parsePortalSignal("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)"), 'dark')
  assert.equal(D.parsePortalSignal("SettingChanged ('org.kde.kdeglobals.General', 'ColorScheme', <'BreezeDark'>)"), undefined)
})

test('kdeglobals: the window background decides (BreezeDark dark, Breeze light); else the scheme name', () => {
  assert.equal(D.parseKdeglobals('[General]\nColorScheme=BreezeDark\n\n[Colors:Window]\nBackgroundAlternate=41,44,48\nBackgroundNormal=32,35,38\n'), 'dark')
  assert.equal(D.parseKdeglobals('[Colors:Window]\nBackgroundNormal=239,240,241\n[WM]\nactiveBackground=1,1,1\n'), 'light')
  assert.equal(D.parseKdeglobals('[General]\nColorScheme=BreezeDark\n'), 'dark')
  assert.equal(D.parseKdeglobals(''), null)
})

test('effective: Sonata\'s choice > the portal > KDE > Chromium (the GTK theme)', () => {
  assert.equal(D.effectiveScheme('system', 'dark', null, false), 'dark', 'GTK says light, the desktop says dark: dark')
  assert.equal(D.effectiveScheme('system', null, 'dark', false), 'dark')
  assert.equal(D.effectiveScheme('system', 'light', 'dark', true), 'light')
  assert.equal(D.effectiveScheme('system', null, null, true), 'dark')
  assert.equal(D.effectiveScheme('light', 'dark', 'dark', true), 'light', 'Ctrl+D wins')
  assert.equal(D.effectiveScheme('dark', 'light', null, false), 'dark')
})
