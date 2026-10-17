// Global shortcuts, the pure part (shortcuts-model.js): the key model, changing a key, key presses in
// the panel, the portal's trigger form and the X11 / portal / none choice.
const test = require('node:test')
const assert = require('node:assert/strict')
const K = require('../shortcuts-model')

test('keys: normalized to one spelling; only keys Sonata can grab', () => {
  assert.equal(K.normalize('ctrl+alt+p'), 'Ctrl+Alt+P')
  assert.equal(K.normalize('Alt+Control+pagedown'), 'Ctrl+Alt+PageDown')
  assert.equal(K.normalize('Super+Shift+f12'), 'Shift+Super+F12')
  assert.equal(K.normalize('Meta+1'), 'Super+1')
  assert.equal(K.normalize('P'), null, 'a key alone')
  assert.equal(K.normalize('Ctrl+Ctrl+P'), null)
  assert.equal(K.normalize('Ctrl+Hyper+P'), null)
  assert.equal(K.normalize('Ctrl+Alt+MediaPlayPause'), null, 'media keys stay with the desktop (MPRIS)')
  assert.equal(K.normalize(42), null)
})

test('a key needs Ctrl, Alt or Super and must not be one of Sonata\'s window keys', () => {
  assert.equal(K.problem('Ctrl+Alt+P'), '')
  assert.match(K.problem('Shift+P'), /Needs Ctrl, Alt or Super/)
  assert.match(K.problem('Ctrl+Shift+L'), /Sonata's own window keys/)
  assert.match(K.problem('Ctrl+D'), /Sonata's own window keys/)
  assert.match(K.problem('nonsense'), /Not a key/)
})

test('the suggested keys are all usable and all different', () => {
  const keys = K.ACTIONS.map((a) => a.key)
  for (const k of keys) assert.equal(K.problem(k), '', k)
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(K.IDS, ['play-pause', 'next', 'previous', 'lyrics'])
})

test('bindings: stored changes over the suggestions; a bad or duplicate stored key goes back', () => {
  assert.deepEqual(K.bindings({}), { 'play-pause': 'Ctrl+Alt+P', next: 'Ctrl+Alt+PageDown', previous: 'Ctrl+Alt+PageUp', lyrics: 'Ctrl+Alt+Y' })
  assert.equal(K.bindings({ next: 'alt+super+n' }).next, 'Alt+Super+N')
  assert.equal(K.bindings({ next: 'Shift+N' }).next, 'Ctrl+Alt+PageDown')
  const dup = K.bindings({ next: 'Ctrl+Alt+P' })
  assert.equal(dup['play-pause'], 'Ctrl+Alt+P')
  assert.equal(dup.next, 'Ctrl+Alt+PageDown', 'the later action loses a clash')
  assert.deepEqual(K.bindings(null), K.bindings({}))
})

test('setKey: saves only what differs; refuses clashes and bad keys with words; null resets', () => {
  let r = K.setKey({}, 'next', 'ctrl+alt+n')
  assert.deepEqual(r, { stored: { next: 'Ctrl+Alt+N' }, error: '' })
  r = K.setKey(r.stored, 'previous', 'Ctrl+Alt+N')
  assert.equal(r.error, 'Ctrl+Alt+N is already Next song')
  assert.deepEqual(r.stored, { next: 'Ctrl+Alt+N' })
  assert.match(K.setKey({}, 'next', 'N').error, /Not a key|Needs/)
  assert.equal(K.setKey({}, 'nope', 'Ctrl+Alt+N').error, 'No such shortcut')
  assert.deepEqual(K.setKey({ next: 'Ctrl+Alt+N' }, 'next', 'Ctrl+Alt+PageDown').stored, {}, 'the suggested key again: nothing stored')
  assert.deepEqual(K.setKey({ next: 'Ctrl+Alt+N' }, 'next', null).stored, {})
  // swap: the old key of an action is free once it moved
  r = K.setKey({ next: 'Ctrl+Alt+N' }, 'previous', 'Ctrl+Alt+PageDown')
  assert.equal(r.error, '')
})

test('validStored: the settings-file check', () => {
  assert.equal(K.validStored({}), true)
  assert.equal(K.validStored({ next: 'Ctrl+Alt+N' }), true)
  assert.equal(K.validStored({ evil: 'Ctrl+Alt+N' }), false)
  assert.equal(K.validStored({ next: 5 }), false)
  assert.equal(K.validStored([]), false)
  assert.equal(K.validStored(null), false)
})

test('key presses in the panel: modifiers wait, Esc cancels, a full press is a key, the rest is refused', () => {
  const ev = (o) => Object.assign({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: '', code: '' }, o)
  assert.deepEqual(K.fromKeyEvent(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true })), { waiting: true })
  assert.deepEqual(K.fromKeyEvent(ev({ key: 'Escape', code: 'Escape' })), { cancel: true })
  assert.deepEqual(K.fromKeyEvent(ev({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true })), { key: 'Ctrl+Alt+P' })
  // the code, not the typed character: Shift and other layouts don't change the key's name
  assert.deepEqual(K.fromKeyEvent(ev({ key: 'Π', code: 'KeyP', ctrlKey: true, altKey: true, shiftKey: true })), { key: 'Ctrl+Alt+Shift+P' })
  assert.deepEqual(K.fromKeyEvent(ev({ key: 'PageDown', code: 'PageDown', metaKey: true })), { key: 'Super+PageDown' })
  assert.deepEqual(K.fromKeyEvent(ev({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true })), { key: 'Ctrl+Alt+Left' })
  assert.match(K.fromKeyEvent(ev({ key: 'p', code: 'KeyP' })).error, /Needs Ctrl, Alt or Super/)
  assert.match(K.fromKeyEvent(ev({ key: ';', code: 'Semicolon', ctrlKey: true })).error, /can't use that key/)
  assert.match(K.fromKeyEvent(ev({ key: 'm', code: 'KeyM', ctrlKey: true })).error, /own window keys/)
})

test('portal triggers: the XDG shortcuts form (modifiers, then the xkb key name)', () => {
  assert.equal(K.toPortalTrigger('Ctrl+Alt+P'), 'CTRL+ALT+p')
  assert.equal(K.toPortalTrigger('Ctrl+Alt+PageDown'), 'CTRL+ALT+Page_Down')
  assert.equal(K.toPortalTrigger('Super+Space'), 'LOGO+space')
  assert.equal(K.toPortalTrigger('Shift+Alt+F5'), 'ALT+SHIFT+F5')
  assert.equal(K.toPortalTrigger('bad'), '')
  assert.deepEqual(K.portalShortcuts().map((s) => s.id), K.IDS)
  assert.ok(K.portalShortcuts().every((s) => s.description && s.trigger))
})

test('backend: X11 grabs on X11; on Wayland the portal or nothing; never X11 grabs on Wayland', () => {
  const pick = (env, v) => K.chooseBackend({ platform: 'linux', env, portalVersion: v })
  assert.deepEqual(pick({ DISPLAY: ':0' }, null), { kind: 'x11', reason: '' })
  assert.deepEqual(pick({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, null), { kind: 'unknown', reason: 'asking' }, 'Xwayland\'s DISPLAY does not make it X11')
  assert.deepEqual(pick({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 2), { kind: 'portal', reason: '' })
  assert.deepEqual(pick({ XDG_SESSION_TYPE: 'wayland' }, 0), { kind: 'none', reason: 'no-portal' })
  assert.deepEqual(pick({}, 0), { kind: 'none', reason: 'no-display' })
  assert.equal(K.chooseBackend({ platform: 'darwin', env: { DISPLAY: ':0' } }).kind, 'none')
})

test('words: where the desktop keeps them, why it\'s unavailable, the section status', () => {
  assert.match(K.WHERE[K.desktopOf({ XDG_CURRENT_DESKTOP: 'KDE' })], /System Settings/)
  assert.equal(K.desktopOf({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), 'gnome')
  assert.equal(K.desktopOf({ XDG_CURRENT_DESKTOP: 'sway' }), 'other')
  assert.match(K.unavailableText({ kind: 'none', reason: 'no-portal' }), /no GlobalShortcuts portal.*media keys/)
  assert.equal(K.unavailableText({ kind: 'x11' }), '')
  assert.equal(K.statusLine(null), 'Not available here')
  assert.equal(K.statusLine({ backend: { kind: 'x11' }, enabled: false }), 'Off')
  assert.equal(K.statusLine({ backend: { kind: 'x11' }, enabled: true, phase: 'on', keys: { 'play-pause': 'Ctrl+Alt+P', next: 'Ctrl+Alt+N' } }), 'On · Ctrl+Alt+P and 1 more')
  assert.match(K.statusLine({ backend: { kind: 'portal' }, enabled: true, phase: 'cancelled' }), /cancelled/)
})

test('repeat guard: a held key or a double signal is one action; a new press later counts', () => {
  const g = K.repeatGuard(300)
  assert.equal(g('next', 1000), true)
  assert.equal(g('next', 1100), false)
  assert.equal(g('previous', 1100), true, 'per action')
  assert.equal(g('next', 1400), true)
})

test('settings: off by default, keys stored only as checked changes; the Settings section status', () => {
  const S = require('../settings-store')
  assert.equal(S.defaults().globalShortcuts, false)
  assert.deepEqual(S.defaults().shortcutKeys, {})
  assert.equal(S.validSetting('shortcutKeys', { next: 'Ctrl+Alt+N' }), true)
  assert.equal(S.validSetting('shortcutKeys', { next: 'x'.repeat(41) }), false)
  const P = require('../panel-model')
  assert.equal(P.sectionStatus('settings', 'shortcuts', {}), 'Not available here')
  assert.equal(P.sectionStatus('settings', 'shortcuts', { shortcuts: { backend: { kind: 'portal' }, enabled: false } }), 'Off')
})
