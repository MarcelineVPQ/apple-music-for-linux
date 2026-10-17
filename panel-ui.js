// Sonata's side panel (panel.html, its own view between Apple's page and the rail; local, sandboxed,
// contextIsolation on, no Node). Settings and About as an accordion (panel-model.js has the rules),
// the app's notices at the top, a section's own notices at the top of its body. Main owns all state
// (settings.json) and sends it when it changes; this page sends back command names with plain
// arguments through the preload's sonataPanelBridge (preload-panel.js), which main checks.
//
// One rule everywhere (DS5): a section is a header button (icon, title, a live status or its task,
// chevron) and a pin; its body is built only while it is open (a folded section costs nothing) and
// its controls are updated in place on each state push, so focus stays where it is. No <details>.
// No timers, no animation frames, no polling, no observers: it redraws on a state push, a click,
// a key, or a colour-scheme change (theme-apply.js).
;(function () {
  'use strict'
  const M = globalThis.SonataPanelModel
  const MD = globalThis.SonataMarkdown
  const bridge = globalThis.sonataPanelBridge
  if (!M || !MD || !bridge || !globalThis.SonataIcons || !globalThis.SonataThemeApply || globalThis.__sonataPanel) return
  const doc = document
  const icon = (name) => globalThis.SonataIcons.icon(doc, name)
  let uid = 0
  const nextId = (p) => p + '-' + (++uid)
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined && text !== null) e.textContent = text
    return e
  }
  function setAttr(e, name, value) {
    if (value === null || value === undefined || value === false) { if (e.hasAttribute(name)) e.removeAttribute(name) }
    else if (e.getAttribute(name) !== String(value)) e.setAttribute(name, String(value))
  }
  const setText = (e, t) => { if (e.textContent !== t) e.textContent = t }
  const iconButton = (cls, name, label) => {
    const b = el('button', cls)
    b.type = 'button'
    b.appendChild(icon(name))
    setAttr(b, 'aria-label', label)
    setAttr(b, 'title', label)
    return b
  }

  // --- the shell, built once ---
  const panel = el('aside', 'panel')
  const head = el('header', 'head')
  const titles = el('div', 'titles')
  const title = el('h2', 'title')
  title.id = 'panel-title'
  title.tabIndex = -1
  const sub = el('span', 'sub')
  titles.append(title, sub)
  const menuBtn = iconButton('icon-btn menu-btn', 'more', 'More: collapse all, clear pins')
  setAttr(menuBtn, 'aria-haspopup', 'menu')
  setAttr(menuBtn, 'aria-expanded', 'false')
  // no hide button here (0.15.33, as in the DS5 app): the rail item of the page shown is the one way
  // to show or hide the panel, plus Esc for the drawer in narrow windows
  head.append(titles, menuBtn)
  const menu = el('ul', 'menu')
  menu.id = 'panel-menu'
  setAttr(menu, 'role', 'menu')
  setAttr(menu, 'aria-label', 'Panel')
  menu.hidden = true
  setAttr(menuBtn, 'aria-controls', 'panel-menu')
  const topNotices = el('div', 'notices')
  setAttr(topNotices, 'role', 'region')
  setAttr(topNotices, 'aria-label', 'Notices')
  const scroll = el('div', 'scroll')
  const acc = el('div', 'accordion')
  scroll.appendChild(acc)
  panel.append(head, menu, topNotices, scroll)
  setAttr(panel, 'aria-labelledby', 'panel-title')
  doc.body.appendChild(panel)
  const theme = globalThis.SonataThemeApply.attach({ surfaces: [panel] })

  let S = null            // main's state
  let page = ''           // the page the accordion is built for
  let sections = []       // [{ id, root, toggle, pin, status, dot, chev, bodyWrap, body: null | { el, update, notices } }]
  let revealN = 0
  let olderShown = false  // About → What's new: older releases shown

  // --- controls (each returns { el, update(S) }) ---
  function row(labelText, descText, control) {
    const r = el('div', 'row')
    const text = el('div', 'row-text')
    const label = el('span', 'row-label', labelText)
    label.id = nextId('l')
    const desc = el('span', 'row-desc', descText || '')
    desc.id = nextId('d')
    text.append(label, desc)
    r.append(text)
    if (control) r.append(control)
    return { r, label, desc }
  }
  // a switch: a button with role=switch (Space/Enter toggle), named by its row's label
  function switchRow(key, labelText, descText, o) {
    const opt = o || {}
    const b = el('button', 'switch')
    b.type = 'button'
    setAttr(b, 'role', 'switch')
    b.appendChild(el('span', 'knob'))
    const { r, label, desc } = row(labelText, descText, b)
    setAttr(b, 'aria-labelledby', label.id)
    setAttr(b, 'aria-describedby', desc.id)
    b.dataset.key = key
    // lifetime: OK — one click listener per switch, dropped with its section's body
    b.addEventListener('click', (e) => { if (e.isTrusted && !b.disabled) bridge.send('set', key, b.getAttribute('aria-checked') !== 'true') })
    return {
      el: r,
      update(s) {
        const v = s.v || {}
        setAttr(b, 'aria-checked', v[key] ? 'true' : 'false')
        const off = opt.disabled ? opt.disabled(v) : false
        b.disabled = !!off
        r.classList.toggle('disabled', !!off)
        setText(desc, (off && opt.why) || (opt.desc ? opt.desc(v) : descText) || '')
        r.hidden = opt.hidden ? !!opt.hidden(v) : false
      }
    }
  }
  function selectRow(key, labelText, descText, options, o) {
    const opt = o || {}
    const sel = el('select', 'select')
    // loop: NOT-WORTH — ≤ 3 options, once per body build
    for (const [value, text] of options) { const op = el('option', '', text); op.value = value; sel.appendChild(op) }
    const { r, label, desc } = row(labelText, descText, sel)
    setAttr(sel, 'aria-labelledby', label.id)
    setAttr(sel, 'aria-describedby', desc.id)
    sel.dataset.key = key
    // lifetime: OK — one change listener per select, dropped with its section's body
    sel.addEventListener('change', (e) => { if (e.isTrusted) bridge.send('set', key, sel.value) })
    return {
      el: r,
      update(s) {
        const v = s.v || {}
        const want = String(opt.value ? opt.value(v) : v[key])
        if (sel.value !== want && doc.activeElement !== sel) sel.value = want
        const off = opt.disabled ? opt.disabled(v) : false
        sel.disabled = !!off
        r.classList.toggle('disabled', !!off)
        setText(desc, (off && opt.why) || (opt.desc ? opt.desc(v) : descText) || '')
        r.hidden = opt.hidden ? !!opt.hidden(v) : false
      }
    }
  }
  // a status line with buttons: buttons [{ label(v), action, primary, disabled(v), hidden(v) }]
  function actionRow(labelText, statusFn, buttons, o) {
    const opt = o || {}
    const btns = el('div', 'btns')
    const made = buttons.map((d) => {
      const b = el('button', 'btn' + (d.primary ? ' primary' : ''))
      b.type = 'button'
      // lifetime: OK — one click listener per button, dropped with its section's body
      b.addEventListener('click', (e) => { if (e.isTrusted && !b.disabled) bridge.send('action', d.action) })
      btns.appendChild(b)
      return { d, b }
    })
    const { r, desc } = row(labelText, '', btns)
    r.classList.add('action-row')
    return {
      el: r,
      update(s) {
        const v = s.v || {}
        r.hidden = opt.hidden ? !!opt.hidden(v) : false
        setText(desc, statusFn ? statusFn(v) : '')
        // loop: NOT-WORTH — ≤ 3 buttons
        for (const { d, b } of made) {
          setText(b, typeof d.label === 'function' ? d.label(v) : d.label)
          b.disabled = d.disabled ? !!d.disabled(v) : false
          b.hidden = d.hidden ? !!d.hidden(v) : false
          setAttr(b, 'title', d.tip ? d.tip(v) : null)
        }
      }
    }
  }
  function textBlock(cls, fn) {
    const p = el('p', cls)
    return { el: p, update(s) { const t = fn(s.v || {}, s); setText(p, t); p.hidden = !t } }
  }
  const group = (titleText, parts) => {
    const g = el('div', 'group')
    if (titleText) g.appendChild(el('h3', 'subhead', titleText))
    // loop: NOT-WORTH — a few controls per group
    for (const p of parts) g.appendChild(p.el)
    return { el: g, update(s) { for (const p of parts) p.update(s) } }
  }

  // --- links: only http(s), opened by main in the browser ---
  function link(text, url, cls) {
    const a = el('a', cls || 'link', text)
    a.href = url
    setAttr(a, 'title', url)
    // lifetime: OK — one click listener per link, dropped with its body
    a.addEventListener('click', (e) => { e.preventDefault(); if (e.isTrusted) bridge.send('open-link', url) })
    return a
  }
  // the Markdown tree (markdown-lite.js) as DOM nodes: text nodes only, never HTML strings
  function inlineNodes(parent, nodes) {
    // loop: NOT-WORTH — one node per run of text in a line
    for (const n of nodes) {
      if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v))
      else if (n.t === 'code') parent.appendChild(el('code', '', n.v))
      else if (n.t === 'a') { const a = link('', n.href); inlineNodes(a, n.c); parent.appendChild(a) }
      else { const e = el(n.t === 'b' ? 'strong' : 'em'); inlineNodes(e, n.c); parent.appendChild(e) }
    }
  }
  function markdown(md) {
    const box = el('div', 'md')
    // loop: NOT-WORTH — one block per heading / paragraph / list of one release
    for (const b of MD.parse(md)) {
      if (b.t === 'h') { const h = el(b.level <= 3 ? 'h4' : 'h5'); inlineNodes(h, b.c); box.appendChild(h) }
      else if (b.t === 'p') { const p = el('p'); inlineNodes(p, b.c); box.appendChild(p) }
      else {
        const ul = el('ul')
        // loop: NOT-WORTH — list items of one release
        for (const it of b.items) { const li = el('li'); inlineNodes(li, it); ul.appendChild(li) }
        box.appendChild(ul)
      }
    }
    return box
  }

  // --- the sections' bodies (built only while open) ---
  const BODY = {
    settings: {
      playback: () => [
        switchRow('notifications', 'Track notifications', 'A desktop notification when the song changes'),
        switchRow('lrclibFallback', 'LRCLIB lyrics', 'When Apple has no lyrics, look the song up on lrclib.net (sends title, artist, album and length)'),
        switchRow('estimatedWordTiming', 'Estimated word timing', 'When a song has line timing only, spread each line across its words (marked "estimated")'),
        switchRow('lyricsArtSpin', 'Spin album art like a record', 'Turn the round cover in the lyrics window while music plays'),
        selectRow('lyricsArtSpinSpeed', 'Record speed', 'Relaxed feels like a record across the room; True is 33⅓ rpm for albums, 45 for singles and EPs',
          [['relaxed', 'Relaxed'], ['true', 'True']], { disabled: (v) => !v.lyricsArtSpin, why: 'Needs Spin album art like a record (above) on' })
      ],
      timing: () => [
        switchRow('lyricsListenRefine', 'Refine timing by listening (experimental)', 'Listens to Sonata\'s own audio while a lyric view is open to move estimated words to where they\'re sung. Analysed in memory, never saved or sent.',
          { disabled: (v) => !v.estimatedWordTiming, why: 'Needs Estimated word timing (Playback & lyrics) on' }),
        switchRow('lyricsPreciseTiming', 'Precise word timing (GPU, experimental)', 'Separates the vocals and lines up each word with the singing, on this computer, after a song has played once with a lyric view open. Audio stays in memory; only the word times are kept.',
          { hidden: (v) => !v.alignInstalled }),
        textBlock('note', (v) => (!v.alignInstalled
          ? 'Precise word timing needs the sonata-align helper (about 10 GB). Install it with align/install.sh from the Sonata source; this section notices it.'
          : v.lyricsPreciseTiming ? (v.alignStatus || 'Asking the helper…') : ''))
      ],
      appearance: () => [
        selectRow('theme', 'Theme', 'Ctrl+D switches between light and dark', [['system', 'Same as the desktop'], ['light', 'Light'], ['dark', 'Dark']]),
        switchRow('adaptiveColor', 'Adaptive album color', 'Tint Sonata\'s windows (this panel, the rail, mini player, lyrics) with the current album\'s colour'),
        switchRow('glass', 'Glass look', 'A translucent material made from the album artwork, behind the panel, the rail, the lyrics window and the mini player. Off: plain surfaces',
          { disabled: (v) => !v.adaptiveColor, why: 'Glass is made from the album artwork: it needs Adaptive album color (above) on' })
      ],
      windows: () => [
        switchRow('miniAlwaysOnTop', 'Keep the mini player on top', 'Float the mini player above other windows (on GNOME Wayland: Alt+Space → Always on Top)'),
        switchRow('lyricsAlwaysOnTop', 'Keep lyrics on top', 'Float the lyrics window above other windows')
      ],
      integrations: () => [
        actionRow('Last.fm', (v) => (v.lastfmConnected ? 'Connected as ' + (v.lastfmUser || '?') + ', scrobbling' : 'Not connected'),
          [{ label: (v) => (v.lastfmConnected ? 'Disconnect' : 'Connect…'), action: 'lastfm' }]),
        actionRow('Discord Rich Presence', (v) => (!v.discordEnabled ? 'Off' : v.discordState === 'on' ? 'Connected, showing what you play' : 'On, waiting for the Discord app'),
          [{ label: (v) => (v.discordEnabled ? 'Disconnect' : 'Connect…'), action: 'discord' }])
      ],
      updates: () => [
        // from source (no AppImage) nothing here can do anything: one status line instead of greyed-out controls
        textBlock('note', (v) => (v.appImage ? '' : 'Sonata ' + (v.version || '') + ', running from source: only the AppImage updates itself. Update with git pull.')),
        actionRow('Sonata ' + ((S && S.v && S.v.version) || ''), (v) => v.updateLine || '',
          [{ label: 'Check now', action: 'check-now', disabled: (v) => v.updateBusy, tip: () => 'Check the update feed now' }], { hidden: (v) => !v.appImage }),
        selectRow('updateChannel', 'Update channel', '', [['stable', 'Stable'], ['dev', 'Development']],
          { desc: (v) => (v.updateChannel === 'dev' ? 'Development builds before they\'re released: newer, less tested. You also get every stable release.' : 'Tested releases, for everyone.'),
            hidden: (v) => !v.appImage }),
        switchRow('checkForUpdates', 'Check for updates automatically', 'At start and every 2 hours. Off: Sonata goes online for updates only when you press Check now',
          { hidden: (v) => !v.appImage }),
        switchRow('autoInstallUpdates', 'Install updates automatically', 'Downloads and checks them in the background; the new version starts the next time you open Sonata',
          { hidden: (v) => !v.appImage, disabled: (v) => !v.checkForUpdates, why: 'Needs Check for updates automatically (above) on' }),
        // only where it can do something: on the Development channel or a development build
        actionRow('Back to stable', (v) => (v.backConfirm
          ? 'Install the newest stable release, even though it is older than this build? Settings stay. It starts the next time you open Sonata.'
          : 'Install the newest stable release, even if it is older than this build'),
        [{ label: (v) => (v.backConfirm ? 'Install stable' : 'Back to stable…'), action: 'back-to-stable', primary: false, disabled: (v) => v.updateBusy },
          { label: 'Cancel', action: 'back-cancel', hidden: (v) => !v.backConfirm }], { hidden: (v) => !v.appImage || !v.backToStable })
      ],
      startup: () => [
        switchRow('closeToTray', 'Close to tray', 'Closing the window hides it; music keeps playing'),
        switchRow('launchAtLogin', 'Launch at login', 'Start Sonata when you log in'),
        switchRow('startMinimized', 'Start minimized', 'Start hidden in the tray')
      ]
    },
    about: {
      whatsnew: () => {
        const box = el('div', 'about-md')
        let shownKey = ''
        return [{
          el: box,
          update(s) {
            const a = s.about
            const key = (a ? a.whatsNew.current && a.whatsNew.current.version : '') + '|' + olderShown
            if (key === shownKey) return
            shownKey = key
            box.replaceChildren()
            if (!a) { box.appendChild(el('p', 'note', 'Loading…')); return }
            const add = (sec) => {
              box.appendChild(el('h3', 'release', sec.version + (sec.title ? ' — ' + sec.title : '')))
              box.appendChild(markdown(sec.body))
            }
            if (a.whatsNew.current) add(a.whatsNew.current)
            // loop: NOT-WORTH — ≤ ~40 releases, only after Show older releases
            if (olderShown) a.whatsNew.older.forEach(add)
            else if (a.whatsNew.older.length) {
              const more = el('button', 'btn', 'Show older releases (' + a.whatsNew.older.length + ')')
              more.type = 'button'
              // lifetime: OK — one click listener, replaced with the body's content
              more.addEventListener('click', () => { olderShown = true; shownKey = ''; this.update(S) })
              box.appendChild(more)
            }
          }
        }]
      },
      soon: () => {
        const box = el('div', 'about-list')
        let n = -1
        return [{
          el: box,
          update(s) {
            const items = s.about ? s.about.soon : null
            if (items && items.length === n) return
            box.replaceChildren(el('p', 'note', 'Plans, not promises: they can change, and none has a date. Suggestions are welcome on GitHub.'))
            if (!items) return
            n = items.length
            const ul = el('ul', 'plain-list')
            // loop: NOT-WORTH — a handful of plans
            for (const it of items) { const li = el('li'); li.append(el('strong', '', it.title), doc.createTextNode(': ' + it.text)); ul.appendChild(li) }
            box.appendChild(ul)
          }
        }]
      },
      credits: () => {
        const box = el('div', 'about-list')
        let built = false
        return [{
          el: box,
          update(s) {
            if (built || !s.about) return
            built = true
            const a = s.about
            // loop: NOT-WORTH — 4 groups of ≤ 6 credits, once
            for (const g of a.credits) {
              box.appendChild(el('h3', 'subhead', g.title + (/sonata-align/.test(g.title) ? (a.alignInstalled ? ' · installed' : ' · not installed') : '')))
              const dl = el('dl', 'credits')
              for (const r of g.rows) {
                const dt = el('dt')
                if (r.url) dt.appendChild(link(r.what, r.url)); else dt.textContent = r.what
                dl.append(dt, el('dd', '', r.text))
              }
              box.appendChild(dl)
              if (/^Lyrics$/.test(g.title)) {
                const ul = el('ul', 'patterns')
                setAttr(ul, 'aria-label', 'Hyphenation pattern licences')
                // loop: NOT-WORTH — 22 pattern files, once
                for (const p of a.patterns) ul.appendChild(el('li', '', p.lang + ': ' + p.by + ' · ' + p.licence))
                box.appendChild(ul)
              }
            }
            box.appendChild(el('p', 'note', a.notAffiliated))
          }
        }]
      },
      links: () => {
        const box = el('div', 'links')
        let built = false
        return [{
          el: box,
          update(s) {
            if (built || !s.about) return
            built = true
            // loop: NOT-WORTH — 4 links, once
            for (const l of s.about.links) {
              const a = link(l.label, l.url, 'btn link-btn')
              a.appendChild(icon('external'))
              box.appendChild(a)
            }
          }
        }]
      }
    }
  }
  function aboutStatus(id, s) {
    const a = s.about
    if (id === 'whatsnew') return a && a.whatsNew.current ? a.whatsNew.current.version : (s.v ? s.v.version : '')
    if (id === 'soon') return a ? a.soon.length + (a.soon.length === 1 ? ' plan' : ' plans') : ''
    if (id === 'credits') return 'castlabs Electron, LRCLIB, hyph-utf8 and more'
    if (id === 'links') return 'GitHub, bugs, 42 Pixel Studios'
    return ''
  }

  // --- notices (top of the panel, or a section's) ---
  function noticeEl(n) {
    const box = el('div', 'notice' + (n.kind === 'error' ? ' error' : ''))
    setAttr(box, 'role', n.role)
    box.dataset.notice = n.id
    const text = el('div', 'notice-text')
    text.appendChild(el('span', '', n.text))
    if (n.detail) text.appendChild(el('span', 'notice-detail', n.detail))
    box.appendChild(text)
    if (typeof n.progress === 'number') {
      const bar = el('div', 'progress')
      setAttr(bar, 'role', 'progressbar')
      setAttr(bar, 'aria-valuemin', 0); setAttr(bar, 'aria-valuemax', 100); setAttr(bar, 'aria-valuenow', n.progress)
      setAttr(bar, 'aria-label', 'Download')
      const fill = el('i')
      fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, n.progress / 100)) + ')'
      bar.appendChild(fill)
      box.appendChild(bar)
    }
    if (n.actions.length) {
      const acts = el('div', 'btns')
      // loop: NOT-WORTH — ≤ 3 actions
      for (const a of n.actions) {
        const b = el('button', 'btn' + (a.primary ? ' primary' : ''), a.label)
        b.type = 'button'
        b.disabled = a.disabled
        if (a.tip) setAttr(b, 'title', a.tip)
        // lifetime: OK — one click listener per action button, dropped with the notice
        b.addEventListener('click', (e) => { if (e.isTrusted) bridge.send('notice-action', n.id, a.id) })
        acts.appendChild(b)
      }
      box.appendChild(acts)
    }
    if (n.closable) {
      const x = iconButton('icon-btn notice-x', 'close', 'Dismiss')
      // lifetime: OK — one click listener, dropped with the notice
      x.addEventListener('click', (e) => { if (e.isTrusted) bridge.send('notice-dismiss', n.id) })
      box.appendChild(x)
    }
    return box
  }
  // keyed: a notice whose content didn't change keeps its element (and the focus on its buttons)
  function renderNotices(container, list) {
    const old = new Map([...container.children].map((c) => [c.dataset.notice, c]))
    const want = list.map((n) => {
      const key = JSON.stringify(n)
      const prev = old.get(n.id)
      if (prev && prev.dataset.key === key) return prev
      const e = noticeEl(n)
      e.dataset.key = key
      return e
    })
    if (want.length === container.children.length && want.every((e, i) => container.children[i] === e)) return
    container.replaceChildren(...want)
  }

  // --- the accordion ---
  function buildPage(p) {
    page = p
    olderShown = false
    acc.replaceChildren()
    sections = M.PAGES[p].sections.map((def) => {
      const root = el('section', 'sec')
      root.dataset.section = def.id
      const headRow = el('div', 'sec-head')
      const toggle = el('button', 'sec-toggle')
      toggle.type = 'button'
      toggle.id = 'h-' + p + '-' + def.id
      const ic = el('span', 'sec-ic')
      ic.appendChild(icon(def.icon))
      const dot = el('i', 'task')
      dot.hidden = true
      ic.appendChild(dot)
      const status = el('span', 'sec-status')
      const chev = el('span', 'sec-chev')
      chev.appendChild(icon('chevron'))
      toggle.append(ic, el('span', 'sec-title', def.title), status, chev)
      const pin = el('button', 'sec-pin')
      pin.type = 'button'
      pin.appendChild(el('i'))
      setAttr(pin, 'aria-label', 'Keep ' + def.title + ' open')
      headRow.append(toggle, pin)
      const bodyWrap = el('div', 'sec-body')
      bodyWrap.id = 'b-' + p + '-' + def.id
      setAttr(bodyWrap, 'role', 'region')
      setAttr(bodyWrap, 'aria-labelledby', toggle.id)
      bodyWrap.hidden = true
      root.append(headRow, bodyWrap)
      acc.appendChild(root)
      // lifetime: OK — one click listener on each header and pin, dropped with the page's accordion
      toggle.addEventListener('click', (e) => { if (e.isTrusted) bridge.send('acc', p, 'toggle', def.id) })
      pin.addEventListener('click', (e) => { if (e.isTrusted) bridge.send('acc', p, 'pin', def.id) })
      return { id: def.id, def, root, toggle, pin, status, dot, bodyWrap, body: null }
    })
  }
  function renderSections() {
    const st = M.accState(S.acc && S.acc[page], page)
    const rem = (S.reminders && S.reminders.sections) || {}
    // loop: NOT-WORTH — ≤ 7 sections per state push
    for (const sec of sections) {
      const open = M.isOpen(st, sec.id)
      const pinned = M.isPinned(st, sec.id)
      sec.root.classList.toggle('open', open)
      sec.root.classList.toggle('pinned', pinned)
      setAttr(sec.toggle, 'aria-expanded', open ? 'true' : 'false')
      setAttr(sec.toggle, 'aria-controls', open ? sec.bodyWrap.id : null)
      setAttr(sec.pin, 'aria-pressed', pinned ? 'true' : 'false')
      setAttr(sec.pin, 'title', pinned ? 'Pinned: stays open (click to unpin)' : 'Pin: keep open while others fold')
      const task = rem[page + '/' + sec.id] || ''
      const status = task || (page === 'about' ? aboutStatus(sec.id, S) : M.sectionStatus(page, sec.id, S.v))
      sec.dot.hidden = !task
      sec.status.classList.toggle('warn', !!task)
      setText(sec.status, status)
      sec.status.hidden = !status
      setAttr(sec.status, 'title', status || null)
      setAttr(sec.toggle, 'aria-description', task ? 'Waiting: ' + task : null)
      if (open && !sec.body) {
        const parts = BODY[page][sec.id]()
        const notices = el('div', 'notices')
        sec.bodyWrap.replaceChildren(notices, ...parts.map((x) => x.el))
        sec.body = { parts, notices }
      } else if (!open && sec.body) {
        sec.bodyWrap.replaceChildren()
        sec.body = null
      }
      sec.bodyWrap.hidden = !open
      if (sec.body) {
        // loop: NOT-WORTH — a section's few controls
        for (const x of sec.body.parts) x.update(S)
        renderNotices(sec.body.notices, (S.notices || []).filter((n) => n.place !== 'top' && n.place.page === page && n.place.section === sec.id))
      }
    }
  }
  function renderMenu() {
    const st = M.accState(S.acc && S.acc[page], page)
    const items = M.menuItems(st)
    if (menu.children.length !== items.length) {
      menu.replaceChildren(...items.map((it) => {
        const li = el('li')
        setAttr(li, 'role', 'none')
        const b = el('button', 'menu-item', it.label)
        b.type = 'button'
        setAttr(b, 'role', 'menuitem')
        b.dataset.item = it.id
        b.tabIndex = -1
        li.appendChild(b)
        return li
      }))
    }
    // loop: NOT-WORTH — 2 menu items per state push
    items.forEach((it, i) => {
      const b = menu.children[i].firstChild
      b.disabled = it.disabled
      setAttr(b, 'aria-disabled', it.disabled ? 'true' : null)
      setAttr(b, 'title', it.tip)
    })
  }

  function render() {
    if (!S) return
    theme.set(S.theme)
    if (S.page !== page) buildPage(S.page)
    setText(title, M.PAGES[page].title)
    setText(sub, 'Sonata ' + (S.v.version || '') + ' · ' + (S.v.updateChannel === 'dev' ? 'Development' : 'Stable') + (S.v.appImage ? '' : ' · from source'))
    panel.classList.toggle('drawer', S.mode === 'drawer')
    renderMenu()
    renderNotices(topNotices, (S.notices || []).filter((n) => n.place === 'top'))
    topNotices.hidden = !topNotices.children.length
    renderSections()
    // a deep link (a rail dot, a notice's action): open is main's; scroll there and focus its header
    if (S.reveal && S.reveal.n !== revealN && S.reveal.page === page) {
      revealN = S.reveal.n
      const sec = sections.find((x) => x.id === S.reveal.section)
      if (sec) { sec.root.scrollIntoView({ block: 'nearest' }); if (S.reveal.focus) sec.toggle.focus({ focusVisible: true }) }
    }
  }

  // --- the ⋮ menu ---
  function openMenu(focusFirst) {
    menu.hidden = false
    setAttr(menuBtn, 'aria-expanded', 'true')
    const first = [...menu.querySelectorAll('.menu-item')].find((b) => !b.disabled) || menu.querySelector('.menu-item')
    if (focusFirst && first) first.focus({ focusVisible: true })
  }
  function closeMenu(refocus) {
    if (menu.hidden) return
    menu.hidden = true
    setAttr(menuBtn, 'aria-expanded', 'false')
    if (refocus) menuBtn.focus({ focusVisible: true })
  }
  // lifetime: OK — menu button click, menu click and keydown, one each for the page's life
  menuBtn.addEventListener('click', (e) => { if (!e.isTrusted) return; if (menu.hidden) openMenu(e.detail === 0); else closeMenu(false) })
  menu.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('.menu-item') : null
    if (!e.isTrusted || !b || b.disabled) return
    bridge.send('acc', page, b.dataset.item)
    closeMenu(true)
  })
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.menu-item')]
    const i = items.indexOf(doc.activeElement)
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(true); return }
    const k = M.headerKey(e.key, i, items.length)
    if (k >= 0) { e.preventDefault(); items[k].focus({ focusVisible: true }) }
  })

  // --- keyboard: header arrows, Esc (drawer, menu), Tab out at either end to the next view ---
  const tabbables = () => [...panel.querySelectorAll('button, select, a[href], [tabindex="0"]')]
    .filter((x) => !x.disabled && x.tabIndex >= 0 && !x.closest('[hidden]') && x.getClientRects().length)
  // lifetime: OK — one keydown listener on the panel and one pointerdown on the document (closes the menu)
  panel.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      if (!menu.hidden) { closeMenu(true); e.preventDefault(); return }
      if (S && S.mode === 'drawer') { e.preventDefault(); bridge.send('hide') }
      return
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const list = tabbables()
      const at = list.indexOf(doc.activeElement)
      if ((!e.shiftKey && at === list.length - 1) || (e.shiftKey && at <= 0)) {
        e.preventDefault()
        bridge.send(e.shiftKey ? 'focus-prev' : 'focus-next')
      }
      return
    }
    if (e.target.classList && e.target.classList.contains('sec-toggle') && !e.ctrlKey && !e.altKey) {
      const heads = sections.map((x) => x.toggle)
      const k = M.headerKey(e.key, heads.indexOf(e.target), heads.length)
      if (k >= 0) { e.preventDefault(); heads[k].focus({ focusVisible: true }) }
    }
  })
  // lifetime: OK — one pointerdown listener on the document for the page's life: a press outside the ⋮ menu closes it
  doc.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) closeMenu(false) })

  bridge.onState((s) => { S = s; render() })
  // main hands keyboard focus over (Tab from Apple's page or the rail, F6): the first or last control
  bridge.onFocus((where) => {
    const list = tabbables()
    const t = where === 'last' ? list[list.length - 1] : (sections.length ? sections[0].toggle : list[0])
    if (t) t.focus({ focusVisible: true })
  })
  bridge.send('mounted')

  // test hook (the panel's own page; Apple's page is another view and can't reach it)
  globalThis.__sonataPanel = Object.freeze({
    panel, state: () => S, page: () => page,
    theme: () => theme.state(),
    counts: () => ({ sections: sections.length, bodies: sections.filter((x) => x.body).length, nodes: doc.getElementsByTagName('*').length, listeners: 6 })
  })
})()
