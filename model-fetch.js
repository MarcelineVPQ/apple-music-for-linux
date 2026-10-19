// The helper's model files, downloaded so a quit, a crash or a lost connection never costs the bytes
// already fetched (Marcy 2026-10-19: she restarted Sonata at "English aligner 679 of 1262 MB"). The
// helper downloads its models itself on first use, from the start each time; the install's last step
// fetches them here first, into the helper's models folder under the helper's own file names, then the
// helper finds them there:
//   - the list comes from the installed engine itself (enginePlan: its model table, read by its own
//     Python in a few ms), so a newer engine with other models needs no Sonata change; a model it doesn't
//     list is left to the helper (it downloads it on first use, as before);
//   - a download goes to ".<file>.part-sonata" (a dot file: the folder doesn't count as having models)
//     with its server's ETag beside it, and continues from its end with an HTTP Range request (If-Range:
//     the same file, else from the start); a part the helper's own download left (<file>.part) is taken
//     over when the file has a SHA-256 to check it against;
//   - after the last byte: the size, and the SHA-256 when the engine or KNOWN_SHA256 names one; a wrong
//     file is deleted and said (code verify); only then is it renamed into place. A complete file
//     (the size the engine names) is never downloaded again.
// Pure Node (https, fs, crypto): no Electron. Tested in test/model-fetch.test.js against a loopback server.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const { execFile } = require('child_process')

// SHA-256 of the files the engine names without one (measured 2026-10-19 on a working install, the same
// bytes the engine's URLs serve; the Demucs file's name carries the first 8 hex digits of its own)
const KNOWN_SHA256 = {
  'htdemucs-955717e8.th': '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4',
  'w2v2-large-lv60k-960h.pth': '7a88965716fbd598a595209bf45c1210a18a6935cfb0cf53527fc986c5543ac7',
  'kim-melband-roformer-ac9b0614.ckpt': '87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e'
}
// what the install's last step fetches (main.js helperModels): the vocal separator and the English
// aligner, and on a graphics card the whole-song separator the helper uses there
const INSTALL_MODELS = ['htdemucs', 'en']
const GPU_MODELS = ['kim']
const STALL_MS = 60 * 1000
const MAX_REDIRECTS = 5
// a part is continued this far before its end: a power cut can leave the last written blocks unwritten
const BACKOFF = 1024 * 1024

const partOf = (dest) => path.join(path.dirname(dest), '.' + path.basename(dest) + '.part-sonata')
const metaOf = (dest) => partOf(dest) + '.json'
const sizeOf = (f) => { try { return fs.statSync(f).size } catch (e) { return -1 } }   // error: NOT-WORTH — no file: -1

class FetchError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

/** The models the install fetches for a build (cuda | rocm | xpu | cpu). */
function installNames(backend) { return INSTALL_MODELS.concat(backend && backend !== 'cpu' ? GPU_MODELS : []) }

// the engine's table, printed by its own Python (stdlib only at import: ~30 ms); names the caller wants
const PLAN_PY = [
  'import sys, json',
  'sys.path.insert(0, sys.argv[1])',
  'import sonata_align as S',
  'want = sys.argv[2].split(",")',
  'out = {}',
  'for k in want:',
  '    m = S.MODELS.get(k)',
  '    if m and m.get("url") and m.get("file") and m.get("bytes"):',
  '        out[k] = {"url": m["url"], "file": m["file"], "bytes": m["bytes"], "sha256": m.get("sha256") or ""}',
  'print(json.dumps({"dir": S.MODEL_DIR, "models": out}))'
].join('\n')

/**
 * The installed engine's model list -> Promise<[{ name, url, dest, bytes, sha256 }]>.
 * o: { python (the venv's), engine (its folder), home, names, env, exec? (tests) }. Rejects when the
 * engine can't say (an engine whose table differs): the caller lets the helper download them itself.
 */
function enginePlan(o) {
  const run = o.exec || execFile
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, o.env || process.env, { SONATA_ALIGN_HOME: o.home })
    // lifetime: OK — one short python child (≤ 15 s timeout), ends by itself
    run(o.python, ['-I', '-c', PLAN_PY, o.engine, o.names.join(',')], { timeout: 15000, env, maxBuffer: 256 * 1024 }, (err, out) => {
      if (err) { reject(new FetchError('plan', 'the helper\'s model list could not be read: ' + err.message)); return }
      let j
      // error: PASSES-ON — not JSON: rejected, the caller logs it and lets the helper download
      try { j = JSON.parse(String(out).trim().split('\n').pop()) } catch (e) { reject(new FetchError('plan', 'the helper\'s model list is not JSON')); return }
      const dir = path.resolve(String(j.dir || ''))
      // the models folder must be the helper's own (inside its home)
      if (!j.dir || path.relative(path.resolve(o.home), dir).startsWith('..')) { reject(new FetchError('plan', 'the helper\'s models folder is outside its home')); return }
      const items = []
      // loop: NOT-WORTH — the install's 2-3 models, once per install
      for (const name of o.names) {
        const m = (j.models || {})[name]
        if (!m) continue
        const file = String(m.file)
        if (!/^[\w.-]+$/.test(file) || file.startsWith('.')) continue
        if (!/^https:\/\//.test(String(m.url))) continue
        const bytes = Number(m.bytes)
        if (!Number.isSafeInteger(bytes) || bytes <= 0) continue
        const sha = /^[0-9a-f]{64}$/.test(String(m.sha256 || '')) ? m.sha256 : (KNOWN_SHA256[file] || '')
        items.push({ name, url: String(m.url), dest: path.join(dir, file), bytes, sha256: sha })
      }
      resolve(items)
    })
  })
}

/** True when the file is there whole (the size the engine names: what the helper itself checks). */
function complete(item) { return sizeOf(item.dest) === item.bytes }

// one GET, redirects followed (https only; http only to a loopback address, for tests)
function get(url, headers, redirects, onReq) {
  return new Promise((resolve, reject) => {
    let u
    // error: PASSES-ON — a malformed address rejects; the download fails with it
    try { u = new URL(url) } catch (e) { reject(new FetchError('download', 'bad address')); return }
    const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) { reject(new FetchError('download', 'refused: not https (' + u.protocol + ')')); return }
    const lib = u.protocol === 'https:' ? https : http
    // lifetime: OK — one request; it ends with its response, on error, on a stall (destroyed) or on abort (onReq)
    const req = lib.get(u, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) { reject(new FetchError('download', 'too many redirects')); return }
        resolve(get(new URL(res.headers.location, u).toString(), headers, redirects + 1, onReq))
        return
      }
      resolve(res)
    })
    // lifetime: OK — the stall timer and the error listener die with the request
    req.setTimeout(STALL_MS, () => req.destroy(new FetchError('download', 'no data for ' + STALL_MS / 1000 + ' s')))
    req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError('download', e.message)))
    if (onReq) onReq(req)
  })
}

// the SHA-256 of the first n bytes of a file (the part already there, before more is appended)
function hashPrefix(file, n) {
  const h = crypto.createHash('sha256')
  if (n <= 0) return Promise.resolve(h)
  return new Promise((resolve, reject) => {
    // lifetime: OK — a read stream over the part, ends at its end or on error
    const s = fs.createReadStream(file, { start: 0, end: n - 1 })
    s.on('data', (b) => h.update(b))
    s.on('end', () => resolve(h))
    s.on('error', reject)
  })
}

/**
 * Fetches one model, continuing a part that is there. item: { name, url, dest, bytes, sha256 }.
 * o: { onProgress(done, total), signal: { aborted, onAbort(fn) }, log, get? (tests) }
 * -> Promise<{ skipped, resumedFrom, fetched }>; rejects FetchError (code download | verify | cancelled).
 */
async function fetchModel(item, o = {}) {
  const log = o.log || (() => {})
  const doGet = o.get || get
  if (complete(item)) return { skipped: true, resumedFrom: 0, fetched: 0 }
  fs.mkdirSync(path.dirname(item.dest), { recursive: true })
  const part = partOf(item.dest)
  const metaFile = metaOf(item.dest)
  let meta = {}
  // error: NOT-WORTH — no meta or unreadable: the part is treated as unknown (Range without If-Range, checked after)
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {} } catch (e) { meta = {} }
  let have = sizeOf(part)
  // the helper's own interrupted download (<file>.part): taken over when a checksum can tell it is the right file
  const helperPart = item.dest + '.part'
  if (have < 0 && item.sha256 && sizeOf(helperPart) > 0 && sizeOf(helperPart) <= item.bytes) {
    // error: NOT-WORTH — the rename fails (gone meanwhile): starts from zero
    try { fs.renameSync(helperPart, part); have = sizeOf(part); meta = { url: item.url, from: 'helper' }; log(item.name + ': took over the helper\'s part (' + have + ' bytes)') } catch (e) { have = -1 }
  }
  // a part from another address or larger than the file: from the start
  if (have > 0 && (meta.url !== item.url || have > item.bytes)) { fs.rmSync(part, { force: true }); have = -1; meta = {} }
  if (have < 0) have = 0
  if (have > 0 && have < item.bytes) { have = Math.max(0, have - BACKOFF); fs.truncateSync(part, have) }
  // a part nothing can check (no ETag, no SHA-256) is not trusted
  if (have > 0 && !meta.etag && !item.sha256) { fs.truncateSync(part, 0); have = 0 }

  let req = null
  let aborted = false
  const abort = () => { aborted = true; if (req) req.destroy(new FetchError('cancelled', 'cancelled')) }
  if (o.signal) { if (o.signal.aborted) abort(); else o.signal.onAbort(abort) }
  if (aborted) throw new FetchError('cancelled', 'cancelled')

  const headers = { 'User-Agent': o.userAgent || 'Sonata' }
  if (have > 0 && have < item.bytes) {
    headers.Range = 'bytes=' + have + '-'
    if (meta.etag && !/^W\//.test(meta.etag)) headers['If-Range'] = meta.etag
  }
  const resumedFrom = have < item.bytes ? have : 0
  let res
  if (have === item.bytes) res = null   // the part is whole: only the checks are left
  else res = await doGet(item.url, headers, 0, (r) => { req = r })
  if (aborted) { if (res) res.resume(); throw new FetchError('cancelled', 'cancelled') }
  let start = have
  if (res) {
    if (res.statusCode === 206) {
      const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(res.headers['content-range'] || ''))
      if (!cr || +cr[1] !== have || (cr[3] !== '*' && +cr[3] !== item.bytes)) { res.resume(); throw new FetchError('download', item.name + ': the server answered another part of the file') }
    } else if (res.statusCode === 200) {
      start = 0   // a server that ignores Range, or a file that changed (If-Range): from the start
    } else if (res.statusCode === 416 && have > 0) {
      res.resume(); fs.rmSync(part, { force: true }); fs.rmSync(metaFile, { force: true })
      throw new FetchError('download', item.name + ': the server refused the rest of the file; it starts again on the next try')
    } else { res.resume(); throw new FetchError('download', item.name + ': HTTP ' + res.statusCode) }
    const etag = String(res.headers.etag || '')
    fs.writeFileSync(metaFile, JSON.stringify({ url: item.url, etag: start === 0 ? etag : (meta.etag || etag) }))
  }
  if (start === 0 && have > 0) log(item.name + ': the server sent the whole file again (it ignored the part, ' + have + ' bytes)')
  else if (start > 0) log(item.name + ': continuing at ' + start + ' of ' + item.bytes + ' bytes')
  const h = res ? await hashPrefix(part, start) : null
  let done = start
  if (res) {
    await new Promise((resolve, reject) => {
      // lifetime: OK — the part's write stream, closed at the response's end or on failure
      const out = fs.createWriteStream(part, start > 0 ? { flags: 'r+', start } : { flags: 'w' })
      let last = 0
      let failed = false
      // what came is kept (the stream is ended, not dropped): the next try continues after it
      const fail = (e) => {
        if (failed) return
        failed = true
        res.destroy()
        const err = aborted ? new FetchError('cancelled', 'cancelled') : (e instanceof FetchError ? e : new FetchError('download', e.message))
        if (out.destroyed || out.writableEnded) reject(err)
        else out.end(() => reject(err))
      }
      // loop: HOT-PATH-OK — one chunk of the response at a time (16-64 KB) · progress at most every 8 MB
      res.on('data', (b) => {
        h.update(b)
        done += b.length
        if (done > item.bytes) { fail(new FetchError('download', item.name + ': the server sent more than the file\'s size')); return }
        if (!out.write(b)) res.pause()
        if (o.onProgress && (done - last >= 8e6 || done === item.bytes)) { last = done; o.onProgress(done, item.bytes) }
      })
      out.on('drain', () => res.resume())
      let ended = false
      // lifetime: OK — the response's and the part's listeners end with them (end, close, error)
      res.on('end', () => { ended = true; out.end() })
      res.on('close', () => { if (!ended) fail(new FetchError('download', item.name + ': the connection closed')) })
      out.on('finish', () => { if (!failed) resolve() })
      res.on('error', fail)
      out.on('error', (e) => { out.destroy(); fail(e) })
    })
  }
  if (aborted) throw new FetchError('cancelled', 'cancelled')
  const got = sizeOf(part)
  if (got !== item.bytes) throw new FetchError('download', item.name + ': the download stopped at ' + got + ' of ' + item.bytes + ' bytes; it continues on the next try')
  const sum = (res ? h : await hashPrefix(part, got)).digest('hex')
  if (item.sha256 && sum !== item.sha256) {
    fs.rmSync(part, { force: true }); fs.rmSync(metaFile, { force: true })
    throw new FetchError('verify', item.name + ': the download\'s SHA-256 is not the expected one; it was deleted')
  }
  fs.renameSync(part, item.dest)
  fs.rmSync(metaFile, { force: true })
  return { skipped: false, resumedFrom: start, fetched: done - start, sha256: sum, checked: !!item.sha256 }
}

module.exports = { enginePlan, fetchModel, complete, installNames, partOf, metaOf, KNOWN_SHA256, INSTALL_MODELS, FetchError, get }
