// Shared by the UI checkers (tools/rail-check.js, tools/ui-check.js): a small DevTools-protocol
// client for the app's pages and its main process, real X input through XTest (xtest-input.py), X
// screenshots, and colour maths read from computed styles (independent of theme.js).
// Only for an ISOLATED test copy on a throwaway Xvfb display (see the checkers' headers).
'use strict'
const path = require('path')
const { execFileSync } = require('child_process')

function createKit({ cdp, insp, display }) {
  const CDP = cdp; const INSP = insp; const DISPLAY = display
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // --- input through XTest (real X events), window screenshots from the X server ---
  function x(...a) { execFileSync('python3', ['-I', path.join(__dirname, 'xtest-input.py'), DISPLAY, ...a.map(String)]) }
  function xshot(file, w, h) { execFileSync('import', ['-display', DISPLAY, '-window', 'root', '-crop', `${w}x${h}+0+0`, '+repage', file]) }

  // --- a small CDP client ---
  async function ws(url) {
    const sock = new WebSocket(url)
    await new Promise((r, j) => { sock.onopen = r; sock.onerror = j })
    let id = 0; const pend = new Map(); const subs = []
    sock.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } else for (const f of subs) f(d)
    }
    const send = (method, params = {}) => new Promise((r, j) => {
      const i = ++id
      pend.set(i, (d) => (d.error ? j(new Error(method + ': ' + JSON.stringify(d.error))) : r(d.result)))
      sock.send(JSON.stringify({ id: i, method, params }))
    })
    return { send, on: (f) => subs.push(f), close: () => sock.close() }
  }
  async function target(match) {
    let t
    for (let i = 0; i < 60 && !t; i++) {
      try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((p) => p.type === 'page' && p.url.includes(match)) } catch (e) {}
      if (!t) await sleep(500)
    }
    if (!t) throw new Error(match + ' not found on port ' + CDP)
    const c = await ws(t.webSocketDebuggerUrl)
    const ctxs = new Map()
    c.on((m) => {
      if (m.method === 'Runtime.executionContextCreated') ctxs.set(m.params.context.id, m.params.context)
      if (m.method === 'Runtime.executionContextDestroyed') ctxs.delete(m.params.executionContextId)
      if (m.method === 'Runtime.executionContextsCleared') ctxs.clear()
    })
    await c.send('Runtime.enable')
    await c.send('Page.enable')
    const ev = async (expression, contextId) => {
      const p = { expression, awaitPromise: true, returnByValue: true }
      if (contextId) p.contextId = contextId
      const r = await c.send('Runtime.evaluate', p)
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text))
      return r.result.value
    }
    const isoId = async (probe) => {
      for (let i = 0; i < 40; i++) {
        for (const ctx of ctxs.values()) {
          if (ctx.auxData && !ctx.auxData.isDefault && ctx.auxData.frameId === t.id) {
            try { if (await ev(probe, ctx.id)) return ctx.id } catch (e) {}
          }
        }
        await sleep(250)
      }
      throw new Error('isolated world not found')
    }
    return {
      c, t, ev,
      iso: async (e) => ev(e, await isoId('!!globalThis.__sonataFocus')),
      object: async (e) => (await c.send('Runtime.evaluate', { expression: e })).result.objectId,
      metrics: async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
    }
  }
  async function mainProc() {
    const list = await (await fetch(`http://127.0.0.1:${INSP}/json/list`)).json()
    const c = await ws(list[0].webSocketDebuggerUrl)
    const ev = async (expression) => {
      const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true })
      if (r.exceptionDetails) throw new Error('main eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
      return r.result.value
    }
    return { c, ev }
  }

  async function waitFor(fn, ms = 4000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100) } return v }
  return { sleep, x, xshot, ws, target, mainProc, waitFor }
}

// --- colour maths (independent of rail-model.js, from computed styles) ---
const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 } }
const lum = (rgb) => { const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const lay = (base, layers) => layers.reduce((acc, l) => acc.map((v, i) => l.rgb[i] * l.a + v * (1 - l.a)), base)
const worst = (text, layers) => Math.min(ratio(text, lay([255, 255, 255], layers)), ratio(text, lay([0, 0, 0], layers)))


module.exports = { createKit, parse, lum, ratio, lay, worst }
