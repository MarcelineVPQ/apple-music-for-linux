// Settings → Precise timing's helper block (panel.html, before panel-ui.js; SonataPanelHelper): the state
// row with its ⓘ and buttons (Install / Update / Repair / Rebuild / Cancel), the install's progress and the
// helper's licence (Accept / Cancel); and, apart, the section's last row (the danger zone last): Remove…
// with its confirmation, all in the page (no dialogs). Main owns
// the state (main.js helperSnapshot) and does the work; this sends command names only. The words come from
// helper-install-model.js (SonataHelperInstallModel). Built only while Precise timing is open; no timers,
// no animation, no observers: it redraws on a state push (≤ 4 a second while an install runs).
;(function (root) {
  'use strict'
  const HM = root.SonataHelperInstallModel
  const V = root.SonataVersionDisplay

  /**
   * create({ doc, el, setAttr, setText, nextId, bridge, markdown }) -> { el, update(S), danger: { el, update(S) } }
   * (danger: the Remove the helper row and its confirmation, for the section's end)
   * markdown(text) -> a DOM tree (panel-ui.js, text nodes only)
   */
  function create(ctx) {
    const { doc, el, setAttr, setText, nextId, bridge, markdown } = ctx
    const send = (action) => bridge.send('action', action)
    const box = el('div', 'group helper')
    setAttr(box, 'aria-label', 'Precise timing helper')
    setAttr(box, 'role', 'group')

    // --- the state row: "Helper", the state (≤ 60 characters), the ⓘ with the longer words, the buttons ---
    const row = el('div', 'row action-row helper-row')
    const text = el('div', 'row-text')
    const label = el('span', 'row-label', 'Helper')
    label.id = nextId('l')
    const line = el('span', 'row-desc helper-state')
    line.id = nextId('d')
    const stateText = el('span', 'helper-state-text')
    setAttr(stateText, 'aria-live', 'polite')
    // the ⓘ (the DS5 app's long-text rule, as the sheet-notes band): hover or focus shows the words, a click
    // toggles them (touch), Esc closes them; screen readers get them as the button's description
    function infoTip(name, holder) {
      const btn = el('button', 'info-btn', 'i')
      btn.type = 'button'
      setAttr(btn, 'aria-label', name)
      const words = el('span', 'info-text')
      words.id = nextId('i')
      words.hidden = true
      setAttr(btn, 'aria-describedby', words.id)
      const tipEl = el('span', 'info-tip')
      setAttr(tipEl, 'aria-hidden', 'true')
      tipEl.hidden = true
      holder.append(words, tipEl)
      const show = (on) => { tipEl.hidden = !on || !words.textContent; btn.classList.toggle('open', !tipEl.hidden) }
      // lifetime: OK — the ⓘ's six handlers, set once, dropped with the section's body
      btn.onmouseenter = () => show(true)
      btn.onmouseleave = () => { if (doc.activeElement !== btn) show(false) }
      btn.onfocus = () => show(true)
      btn.onblur = () => show(false)
      btn.onclick = (e) => { e.stopPropagation(); if (e.isTrusted) show(tipEl.hidden) }
      btn.onkeydown = (e) => { if (e.key === 'Escape' && !tipEl.hidden) { e.preventDefault(); e.stopPropagation(); show(false) } }
      return {
        btn,
        set(t) { setText(words, t); setText(tipEl, t); btn.hidden = !t; if (!t) show(false) }
      }
    }
    line.append(stateText)
    text.append(label, line)
    const stateInfo = infoTip('More about the helper', text)
    line.append(stateInfo.btn)
    const btns = el('div', 'btns')
    const made = {}
    // loop: NOT-WORTH — five buttons, once per body build
    for (const id of ['install', 'update', 'repair', 'rebuild', 'cancel']) {
      const b = el('button', 'btn' + (['install', 'update', 'repair', 'rebuild'].includes(id) ? ' primary' : ''), HM.BUTTON_LABEL[id])
      b.type = 'button'
      b.dataset.helper = id
      b.hidden = true
      setAttr(b, 'aria-describedby', line.id)
      // lifetime: OK — one click listener per button, dropped with the section's body
      b.addEventListener('click', (e) => { if (e.isTrusted && !b.disabled) send('helper-' + id) })
      btns.appendChild(b)
      made[id] = b
    }
    row.append(text, btns)
    setAttr(row, 'aria-labelledby', label.id)

    // --- Build for: the card found and the PyTorch build (Auto, or one chosen); the ROCm and XPU builds are new ---
    const brow = el('div', 'row helper-row build-row')
    const btext = el('div', 'row-text')
    const blabel = el('span', 'row-label', 'Build for')
    blabel.id = nextId('l')
    const bline = el('span', 'row-desc helper-state')
    bline.id = nextId('d')
    const bstate = el('span', 'helper-state-text')
    bline.append(bstate)
    btext.append(blabel, bline)
    const buildInfo = infoTip('More about the builds', btext)
    bline.append(buildInfo.btn)
    const sel = el('select', 'select')
    // loop: NOT-WORTH — five builds, once per body build
    for (const [value, words] of HM.BUILD_FOR) { const op = el('option', '', words); op.value = value; sel.appendChild(op) }
    setAttr(sel, 'aria-labelledby', blabel.id)
    setAttr(sel, 'aria-describedby', bline.id)
    // lifetime: OK — one change listener, dropped with the section's body
    sel.addEventListener('change', (e) => { if (e.isTrusted) bridge.send('set', 'alignBackend', sel.value) })
    brow.append(btext, sel)

    // --- progress: the step, one bar for the whole install, what is happening in bytes ---
    const prog = el('div', 'helper-progress')
    prog.hidden = true
    const stepLine = el('div', 'helper-step')
    const bar = el('div', 'progress')
    setAttr(bar, 'role', 'progressbar')
    setAttr(bar, 'aria-valuemin', 0)
    setAttr(bar, 'aria-valuemax', 100)
    setAttr(bar, 'aria-label', 'Helper install')
    const fill = el('i')
    bar.appendChild(fill)
    const detail = el('div', 'helper-detail')
    prog.append(stepLine, bar, detail)

    // --- an install that failed or was cancelled: what happened and what to do, with a × ---
    const result = el('div', 'notice helper-result')
    result.hidden = true
    const resultText = el('div', 'notice-text')
    const resultX = el('button', 'icon-btn notice-x')
    resultX.type = 'button'
    resultX.appendChild(globalThis.SonataIcons.icon(doc, 'close'))
    setAttr(resultX, 'aria-label', 'Dismiss')
    setAttr(resultX, 'title', 'Dismiss')
    // lifetime: OK — one click listener, dropped with the section's body
    resultX.addEventListener('click', (e) => { if (e.isTrusted) send('helper-dismiss') })
    result.append(resultText, resultX)

    // --- the licence, in the page: scrollable, Accept and install / Cancel ---
    const lic = el('div', 'helper-licence')
    lic.hidden = true
    const licHead = el('h3', 'subhead')
    licHead.id = nextId('h')
    const licNote = el('p', 'note')
    const licBody = el('div', 'licence-text')
    licBody.tabIndex = 0
    setAttr(licBody, 'role', 'region')
    setAttr(licBody, 'aria-labelledby', licHead.id)
    const licBtns = el('div', 'btns')
    const accept = el('button', 'btn primary', 'Accept and install')
    accept.type = 'button'
    const decline = el('button', 'btn', 'Cancel')
    decline.type = 'button'
    setAttr(decline, 'aria-label', 'Cancel: don\'t install the helper')
    // lifetime: OK — two click listeners, dropped with the section's body
    accept.addEventListener('click', (e) => { if (e.isTrusted) send('helper-accept') })
    decline.addEventListener('click', (e) => { if (e.isTrusted) send('helper-decline') })
    licBtns.append(accept, decline)
    lic.append(licHead, licNote, licBody, licBtns)
    let licShown = ''

    // --- Remove the helper (the section's last row): Remove…, then the confirmation, in the page; the
    // models stay unless unticked ---
    const dangerBox = el('div', 'group helper helper-danger')
    const drow = el('div', 'row action-row helper-row')
    const dtext = el('div', 'row-text')
    const dlabel = el('span', 'row-label', 'Remove the helper')
    dlabel.id = nextId('l')
    const dline = el('span', 'row-desc')
    dline.id = nextId('d')
    dtext.append(dlabel, dline)
    const dbtns = el('div', 'btns')
    const removeAsk = el('button', 'btn', HM.BUTTON_LABEL.remove)
    removeAsk.type = 'button'
    removeAsk.dataset.helper = 'remove'
    setAttr(removeAsk, 'aria-describedby', dline.id)
    // lifetime: OK — one click listener, dropped with the section's body
    removeAsk.addEventListener('click', (e) => { if (e.isTrusted && !removeAsk.disabled) send('helper-remove') })
    dbtns.appendChild(removeAsk)
    drow.append(dtext, dbtns)
    setAttr(drow, 'aria-labelledby', dlabel.id)
    const conf = el('div', 'helper-confirm')
    conf.hidden = true
    setAttr(conf, 'role', 'group')
    const confText = el('p', 'helper-confirm-text')
    confText.id = nextId('c')
    setAttr(conf, 'aria-labelledby', confText.id)
    const keepRow = el('label', 'check-row')
    const keep = el('input')
    keep.type = 'checkbox'
    keep.checked = true
    const keepText = el('span')
    keepRow.append(keep, keepText)
    const confBtns = el('div', 'btns')
    const removeBtn = el('button', 'btn danger', 'Remove')
    removeBtn.type = 'button'
    const keepCancel = el('button', 'btn', 'Cancel')
    keepCancel.type = 'button'
    setAttr(keepCancel, 'aria-label', 'Cancel: keep the helper')
    // lifetime: OK — two click listeners, dropped with the section's body
    removeBtn.addEventListener('click', (e) => { if (e.isTrusted) send(keep.checked && !keepRow.hidden ? 'helper-remove-keep' : 'helper-remove-all') })
    keepCancel.addEventListener('click', (e) => { if (e.isTrusted) send('helper-remove-cancel') })
    confBtns.append(removeBtn, keepCancel)
    conf.append(confText, keepRow, confBtns)
    let confWas = false

    // Esc in the licence or the confirmation is its Cancel (and doesn't also close a drawer panel)
    // lifetime: OK — two keydown listeners, dropped with the section's body
    lic.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.isTrusted) { e.preventDefault(); e.stopPropagation(); send('helper-decline') } })
    conf.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.isTrusted) { e.preventDefault(); e.stopPropagation(); send('helper-remove-cancel') } })
    box.append(row, brow, prog, result, lic)
    dangerBox.append(drow, conf)

    // after a press the pressed button may go (Install -> Cancel): the keyboard lands on what replaced it
    function keepFocus(had) {
      if (!had) return
      const a = doc.activeElement
      if (a && box.contains(a) && !a.closest('[hidden]') && !a.disabled) return
      // loop: HOT-PATH-OK — per state push (≤ 4/s during an install) only when focus was in the block and lost, N ≤ 6 buttons
      const next = !lic.hidden ? licBody : [...btns.children].find((b) => !b.hidden && !b.disabled)
      if (next) next.focus({ focusVisible: true })
    }
    function keepDangerFocus(had) {
      if (!had) return
      const a = doc.activeElement
      if (a && dangerBox.contains(a) && !a.closest('[hidden]') && !a.disabled) return
      // loop: HOT-PATH-OK — per state push only when focus was in the danger zone and lost, N ≤ 6 buttons
      const next = !conf.hidden ? (keepRow.hidden ? removeBtn : keep) : !drow.hidden ? removeAsk : [...btns.children].find((b) => !b.hidden && !b.disabled)
      if (next) next.focus({ focusVisible: true })
    }

    function update(S) {
      const v = (S && S.v) || {}
      const h = v.helper || { state: 'missing' }
      const had = box.contains(doc.activeElement)
      let st = HM.stateRow(h)
      // the running helper's own answer while it starts or when it doesn't work (one place for the helper's
      // state: this line; "Ready on …" and the plain Installed line stay as they are)
      const said = String(v.alignStatus || '')
      if (h.state === 'ok' && !h.available && !(h.job && h.job.phase === 'running') && v.alignInstalled && v.lyricsPreciseTiming && !/^Ready/.test(said) && h.phase !== 'licence') {
        const t = said || 'Asking the helper…'
        st = { text: t.length > 60 ? t.slice(0, 59) + '…' : t, info: (t.length > 60 ? t + '. ' : '') + st.info, level: /not working/i.test(t) ? 'warn' : 'busy' }
      }
      setText(stateText, st.text)
      row.dataset.level = st.level
      stateInfo.set(st.info)
      // Build for: shown when there is something to build (not while a job, the licence or Remove's question shows)
      const bf = HM.buildForRow(h)
      setText(bstate, bf.text)
      buildInfo.set(bf.info)
      const choice = h.choice || 'auto'
      if (sel.value !== choice && doc.activeElement !== sel) sel.value = choice
      brow.hidden = !!(h.phase === 'running' || h.phase === 'licence-fetch' || h.phase === 'licence' || h.confirmRemove)
      // buttons: only the ones that do something now
      const want = HM.buttons(h)
      // loop: NOT-WORTH — five buttons
      for (const id of Object.keys(made)) {
        made[id].hidden = !want.includes(id)
        if (id === 'update') setAttr(made[id], 'aria-label', h.available ? 'Update the helper to ' + h.available : 'Update the helper')
        if (id === 'rebuild') setText(made[id], HM.buttonLabel('rebuild', h))
      }
      btns.hidden = !want.some((id) => id !== 'remove')
      // progress
      const job = h.job
      const running = !!job && (h.phase === 'running' || h.phase === 'licence-fetch')
      prog.hidden = !running
      if (running && job) {
        const p = job.kind === 'remove' ? { stepNo: 1, stepCount: 1, label: 'Removing the helper', fraction: null, detail: '', whole: 0 } : HM.progressView(job)
        const step = 'Step ' + p.stepNo + ' of ' + p.stepCount + ': ' + p.label
        setText(stepLine, step)
        // the whole install on one bar (helper-install-model.js progressView: steps weighted by their time)
        const whole = typeof p.whole === 'number' ? p.whole : 0
        const pct = Math.round(whole * 100)
        fill.style.transform = 'scaleX(' + whole + ')'
        setAttr(bar, 'aria-valuenow', pct)
        setAttr(bar, 'aria-valuetext', step + (p.detail ? ', ' + p.detail : ''))
        setText(detail, p.detail)
        detail.hidden = !p.detail
      }
      // a failure or a cancel: what to do
      const ended = job && (job.phase === 'failed' || job.phase === 'cancelled') && h.phase !== 'licence'
      result.hidden = !ended
      result.classList.toggle('error', !!(job && job.phase === 'failed'))
      setAttr(result, 'role', job && job.phase === 'failed' ? 'alert' : 'status')
      if (ended) setText(resultText, job.phase === 'failed' ? (h.fail || 'The install stopped.') : (job.kind === 'remove' ? 'Removing was cancelled.' : h.state === 'missing' ? 'Cancelled: nothing was installed.' : 'Cancelled: nothing was changed; the installed helper is as it was.'))
      // the licence
      const L = h.licence
      lic.hidden = !L
      if (L) {
        setText(licHead, 'Licence of the helper ' + V.short(L.version) + (L.licenceVersion ? ' (licence ' + V.short(L.licenceVersion) + ')' : ''))
        setText(licNote, L.again ? 'The helper\'s licence changed since you last accepted it. Read it, then accept to go on.' : 'The helper is a separate program with its own licence. Read it, then accept to install.')
        if (licShown !== L.text) { licShown = L.text; licBody.replaceChildren(markdown(L.text)); licBody.scrollTop = 0 }
      } else licShown = ''
      keepFocus(had)
    }
    // the danger zone: Remove… only when there is something to remove (HM.buttons), then its question
    function updateDanger(S) {
      const v = (S && S.v) || {}
      const h = v.helper || { state: 'missing' }
      const had = dangerBox.contains(doc.activeElement)
      const can = HM.buttons(h).includes('remove')
      const onlyModels = h.state === 'missing' && !h.leftovers
      dangerBox.hidden = !can && !h.confirmRemove
      drow.hidden = !!h.confirmRemove
      setText(dlabel, onlyModels ? 'Downloaded models' : 'Remove the helper')
      setText(removeAsk, onlyModels ? 'Delete the models…' : HM.BUTTON_LABEL.remove)
      setText(dline, onlyModels ? 'Left from an earlier install' + (h.modelsText ? ' (' + h.modelsText + ')' : '') : 'The downloaded models can stay for later')
      // the confirmation
      conf.hidden = !h.confirmRemove
      if (h.confirmRemove) {
        if (!confWas) keep.checked = true   // each time it opens: keep the models
        setText(confText, onlyModels ? 'Delete the downloaded models' + (h.modelsText ? ' (' + h.modelsText + ')' : '') + '? A later install downloads them again.'
          : 'Remove the helper? Precise word timing stops until it is installed again.')
        keepRow.hidden = onlyModels || !h.models
        setText(keepText, 'Keep the downloaded models' + (h.modelsText ? ' (' + h.modelsText + ')' : '') + ' for a later install')
        setText(removeBtn, onlyModels ? 'Delete' : 'Remove')
      }
      confWas = !!h.confirmRemove
      keepDangerFocus(had)
    }
    return { el: box, update, danger: { el: dangerBox, update: updateDanger } }
  }

  root.SonataPanelHelper = Object.freeze({ create })
})(typeof globalThis !== 'undefined' ? globalThis : this)
