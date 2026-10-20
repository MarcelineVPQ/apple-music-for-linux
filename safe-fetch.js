// One fetch for every third-party request main makes (LRCLIB, the Montage's Wikidata / Commons photos,
// the liner notes' sources, the disc scans). Electron's net.fetch builds a WHATWG Headers object from the
// server's response headers inside an event listener; a header that isn't Latin-1 (Wikimedia's thumbnails
// send `xkey: File:<the file's name>` in UTF-8, e.g. Hebrew or Korean names) throws "Cannot convert argument
// to a ByteString" there, outside the fetch's promise, as an uncaught main-process exception: an error
// window (Marcy, 2026-10-19, Nirvana's MTV Unplugged with the Montage on). This one goes through the same
// Chromium network stack (net.request) but keeps the headers as plain strings, so a server can't throw.
//
// createSafeFetch({ open }) -> fetch(url, { method, headers, body, signal }) -> Promise<response>
//   open(url, method) -> a ClientRequest-like (setHeader, on('response'|'error'), write, end, abort):
//   main passes net.request, the tests Node's http.request.
//   response: { ok, status, statusText, url, headers: { get, has }, text(), json(), arrayBuffer() },
//   the body already read (each caller reads it whole anyway; its timeout covers the body too).
// No Electron here, so node --test covers it (test/safe-fetch.test.js).

function headerGetter(raw) {
  const h = raw || {}
  const get = (name) => {
    const k = String(name).toLowerCase()
    // loop: NOT-WORTH — one response's headers (≤ ~30), once per header asked
    for (const key of Object.keys(h)) {
      if (key.toLowerCase() !== k) continue
      const v = h[key]
      return Array.isArray(v) ? v.join(', ') : String(v)
    }
    return null
  }
  return { get, has: (name) => get(name) !== null }
}

function abortError(signal) {
  if (signal && signal.reason) return signal.reason
  const e = new Error('The operation was aborted.')
  e.name = 'AbortError'
  return e
}

function createSafeFetch(deps) {
  return function safeFetch(url, opts) {
    const o = opts || {}
    const signal = o.signal
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError(signal)); return }
      let req
      try { req = deps.open(String(url), o.method || 'GET') } catch (e) { reject(e); return }   // error: PASSES-ON — a bad URL rejects like fetch does
      let done = false
      // lifetime: OK — the abort listener is removed when the request settles (finish), or fires once
      const onAbort = () => { if (done) return; try { req.abort() } catch (e) { /* error: NOT-WORTH — already closed */ } finish(reject, abortError(signal)) }
      const finish = (fn, v) => {
        if (done) return
        done = true
        if (signal) signal.removeEventListener('abort', onAbort)
        fn(v)
      }
      if (signal) signal.addEventListener('abort', onAbort)
      const headers = o.headers || {}
      // loop: NOT-WORTH — the caller's request headers (≤ ~4), once per request
      for (const k of Object.keys(headers)) req.setHeader(k, headers[k])
      // lifetime: OK — the request's listeners go with it when it ends, fails or is aborted
      req.on('response', (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))   // lifetime: OK — goes with the response
        res.on('end', () => {   // lifetime: OK — goes with the response
          const body = Buffer.concat(chunks)
          const status = res.statusCode
          finish(resolve, {
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage || '',
            url: String(url),
            headers: headerGetter(res.headers),
            text: async () => body.toString('utf8'),
            json: async () => JSON.parse(body.toString('utf8')),   // error: PASSES-ON — not JSON rejects; every caller catches it
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          })
        })
        res.on('error', (e) => finish(reject, e))   // lifetime: OK — goes with the response
        res.on('aborted', () => finish(reject, abortError(signal)))   // lifetime: OK — goes with the response
      })
      req.on('error', (e) => finish(reject, e))   // lifetime: OK — goes with the request
      if (o.body != null) req.write(o.body)
      req.end()
    })
  }
}

// The last-resort guard's test (main.js process.on('uncaughtException')): only this one known error, a
// server's non-Latin-1 response header thrown by undici's Headers inside Electron's net.fetch. Anything
// else is not this, and main shows it as Electron always has.
function isBadHeaderError(e) {
  if (!e || e.name !== 'TypeError') return false
  const msg = String(e.message || '')
  const stack = String(e.stack || '')
  return /Cannot convert argument to a ByteString/.test(msg) && /Headers\.(set|append)|webidl\.converters\.ByteString/.test(stack)
}

module.exports = { createSafeFetch, headerGetter, isBadHeaderError }
