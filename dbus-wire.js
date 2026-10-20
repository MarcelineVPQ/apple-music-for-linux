// A small D-Bus client: the wire format (marshal / unmarshal, messages) and one session-bus
// connection, with no dependency. Sonata needs it for one thing only, the XDG GlobalShortcuts portal
// (portal-shortcuts.js): a portal session lives exactly as long as the D-Bus connection that made it,
// so the one-shot `gdbus call` children used elsewhere can't hold one, and Electron 42's globalShortcut
// does not use the portal on Wayland (checked on an isolated copy: no portal traffic at all).
//
// Supported: every basic type except unix fds (h), arrays, structs, dict entries and variants, both
// byte orders on read, little endian on write. Values: a{..} reads as a plain object (keys as
// strings), a variant reads as its plain value; to write a variant pass [signature, value], a dict as
// an object or a list of [key, value] pairs, 't'/'x' as a number or BigInt (read as a number).
// The codec is pure (node --test covers it); Connection takes `net` and the environment injected.
'use strict'
const { EventEmitter } = require('events')

const MAX_DEPTH = 32
const MAX_MESSAGE = 16 * 1024 * 1024

// --- signatures -> type trees: { t: 's' } | { t: 'a', e } | { t: '(', f: [] } | { t: '{', k, v } ---
const BASIC = 'ybnqiuxtdsogv'
function parseSig(sig) {
  const s = String(sig || '')
  let i = 0
  function one(depth) {
    if (depth > MAX_DEPTH) throw new Error('signature too deep')
    const c = s[i++]
    if (c === undefined) throw new Error('signature ends early: ' + s)
    if (BASIC.includes(c)) return { t: c }
    if (c === 'a') {
      if (s[i] === '{') {
        i++
        const k = one(depth + 1)
        if (!'ybnqiuxtdsog'.includes(k.t)) throw new Error('dict key must be basic: ' + s)
        const v = one(depth + 1)
        if (s[i++] !== '}') throw new Error('dict entry not closed: ' + s)
        return { t: 'a', e: { t: '{', k, v } }
      }
      return { t: 'a', e: one(depth + 1) }
    }
    if (c === '(') {
      const f = []
      // loop: NOT-WORTH — the fields of one struct in a short signature
      while (s[i] !== ')') { if (i >= s.length) throw new Error('struct not closed: ' + s); f.push(one(depth + 1)) }
      i++
      if (!f.length) throw new Error('empty struct: ' + s)
      return { t: '(', f }
    }
    throw new Error('unsupported type "' + c + '" in ' + s)
  }
  const out = []
  // loop: NOT-WORTH — the complete types of one signature (a handful)
  while (i < s.length) out.push(one(0))
  return out
}
const ALIGN = { y: 1, g: 1, v: 1, n: 2, q: 2, b: 4, i: 4, u: 4, s: 4, o: 4, a: 4, x: 8, t: 8, d: 8, '(': 8, '{': 8 }
const alignOf = (node) => ALIGN[node.t]

// --- writing (little endian) ---
class Writer {
  constructor() { this.buf = Buffer.alloc(256); this.pos = 0 }
  room(n) {
    if (this.pos + n <= this.buf.length) return
    const b = Buffer.alloc(Math.max(this.buf.length * 2, this.pos + n))
    this.buf.copy(b, 0, 0, this.pos)
    this.buf = b
  }
  align(n) { const p = (n - (this.pos % n)) % n; this.room(p); this.buf.fill(0, this.pos, this.pos + p); this.pos += p }
  u8(v) { this.room(1); this.buf.writeUInt8(v & 0xff, this.pos); this.pos += 1 }
  num(n, fn, v) { this.align(n); this.room(n); this.buf[fn](v, this.pos); this.pos += n }
  bytes(b) { this.room(b.length); b.copy(this.buf, this.pos); this.pos += b.length }
  result() { return this.buf.subarray(0, this.pos) }
}
function write(w, node, v, depth) {
  if (depth > MAX_DEPTH) throw new Error('value too deep')
  switch (node.t) {
    case 'y': w.u8(v); break
    case 'b': w.num(4, 'writeUInt32LE', v ? 1 : 0); break
    case 'n': w.num(2, 'writeInt16LE', v); break
    case 'q': w.num(2, 'writeUInt16LE', v); break
    case 'i': w.num(4, 'writeInt32LE', v); break
    case 'u': w.num(4, 'writeUInt32LE', v >>> 0); break
    case 'x': w.num(8, 'writeBigInt64LE', BigInt(v)); break
    case 't': w.num(8, 'writeBigUInt64LE', BigInt(v)); break
    case 'd': w.num(8, 'writeDoubleLE', v); break
    case 's': case 'o': {
      const b = Buffer.from(String(v), 'utf8')
      w.num(4, 'writeUInt32LE', b.length); w.bytes(b); w.u8(0)
      break
    }
    case 'g': {
      const b = Buffer.from(String(v), 'utf8')
      if (b.length > 255) throw new Error('signature too long')
      w.u8(b.length); w.bytes(b); w.u8(0)
      break
    }
    case 'v': {
      if (!Array.isArray(v) || v.length !== 2) throw new Error('a variant is written as [signature, value]')
      const nodes = parseSig(v[0])
      if (nodes.length !== 1) throw new Error('a variant holds one complete type: ' + v[0])
      write(w, { t: 'g' }, v[0], depth + 1)
      write(w, nodes[0], v[1], depth + 1)
      break
    }
    case 'a': {
      w.align(4)
      const lenAt = w.pos
      w.num(4, 'writeUInt32LE', 0)
      w.align(alignOf(node.e))
      const start = w.pos
      const items = node.e.t === '{' && !Array.isArray(v) ? Object.entries(v || {}) : (v || [])
      // loop: NOT-WORTH — the elements of one array in one message (a few shortcuts or options)
      for (const x of items) write(w, node.e, x, depth + 1)
      w.buf.writeUInt32LE(w.pos - start, lenAt)
      break
    }
    case '(':
      w.align(8)
      // loop: NOT-WORTH — the fields of one struct
      node.f.forEach((f, i) => write(w, f, v[i], depth + 1))
      break
    case '{':
      w.align(8)
      write(w, node.k, v[0], depth + 1)
      write(w, node.v, v[1], depth + 1)
      break
    default: throw new Error('cannot write type ' + node.t)
  }
}
function marshal(signature, values, startAt) {
  const w = new Writer()
  if (startAt) { w.room(startAt); w.pos = startAt }   // alignment as if the data began at this offset
  const nodes = parseSig(signature)
  if (nodes.length !== (values || []).length) throw new Error('signature ' + signature + ' wants ' + nodes.length + ' values')
  // loop: NOT-WORTH — the arguments of one call
  nodes.forEach((n, i) => write(w, n, values[i], 0))
  return w.result().subarray(startAt || 0)
}

// --- reading (either byte order) ---
class Reader {
  constructor(buf, pos, end, le) { this.buf = buf; this.pos = pos; this.end = end; this.le = le }
  align(n) { this.pos += (n - (this.pos % n)) % n; if (this.pos > this.end) throw new Error('short message') }
  need(n) { if (this.pos + n > this.end) throw new Error('short message') }
  u8() { this.need(1); return this.buf[this.pos++] }
  num(n, le, be) { this.align(n); this.need(n); const v = this.buf[this.le ? le : be](this.pos); this.pos += n; return v }
  u32() { return this.num(4, 'readUInt32LE', 'readUInt32BE') }
}
function read(r, node, depth) {
  if (depth > MAX_DEPTH) throw new Error('value too deep')
  switch (node.t) {
    case 'y': return r.u8()
    case 'b': return r.u32() !== 0
    case 'n': return r.num(2, 'readInt16LE', 'readInt16BE')
    case 'q': return r.num(2, 'readUInt16LE', 'readUInt16BE')
    case 'i': return r.num(4, 'readInt32LE', 'readInt32BE')
    case 'u': return r.u32()
    case 'x': return Number(r.num(8, 'readBigInt64LE', 'readBigInt64BE'))
    case 't': return Number(r.num(8, 'readBigUInt64LE', 'readBigUInt64BE'))
    case 'd': return r.num(8, 'readDoubleLE', 'readDoubleBE')
    case 's': case 'o': {
      const n = r.u32()
      r.need(n + 1)
      const s = r.buf.toString('utf8', r.pos, r.pos + n)
      r.pos += n + 1
      return s
    }
    case 'g': {
      const n = r.u8()
      r.need(n + 1)
      const s = r.buf.toString('utf8', r.pos, r.pos + n)
      r.pos += n + 1
      return s
    }
    case 'v': {
      const nodes = parseSig(read(r, { t: 'g' }, depth + 1))
      if (nodes.length !== 1) throw new Error('bad variant signature')
      return read(r, nodes[0], depth + 1)
    }
    case 'a': {
      const len = r.u32()
      if (len > MAX_MESSAGE) throw new Error('array too long')
      r.align(alignOf(node.e))
      const end = r.pos + len
      if (end > r.end) throw new Error('short message')
      const dict = node.e.t === '{'
      const out = dict ? {} : []
      // loop: NOT-WORTH — the elements of one array of one portal message (bounded by its byte length)
      while (r.pos < end) {
        const x = read(r, node.e, depth + 1)
        if (dict) out[String(x[0])] = x[1]
        else out.push(x)
      }
      if (r.pos !== end) throw new Error('array overruns its length')
      return out
    }
    // loop: NOT-WORTH — per D-Bus message from the portal (shortcut presses, session setup), N = struct fields
    case '(': r.align(8); return node.f.map((f) => read(r, f, depth + 1))
    case '{': r.align(8); return [read(r, node.k, depth + 1), read(r, node.v, depth + 1)]
    default: throw new Error('cannot read type ' + node.t)
  }
}
function unmarshal(signature, buf, start, le) {
  const r = new Reader(buf, start || 0, buf.length, le !== false)
  // loop: NOT-WORTH — per D-Bus message from the portal (shortcut presses, session setup), N = signature items
  return parseSig(signature).map((n) => read(r, n, 0))
}

// --- messages ---
const TYPE = { call: 1, return: 2, error: 3, signal: 4 }
const TYPE_NAME = { 1: 'call', 2: 'return', 3: 'error', 4: 'signal' }
const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 }
const FIELD_SIG = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g' }
const FIELD_NAME = Object.fromEntries(Object.entries(FIELD).map(([k, v]) => [v, k]))
const NO_REPLY = 1

// m: { type: 'call' | 'return' | 'error' | 'signal', serial, flags?, path?, interface?, member?,
//      errorName?, replySerial?, destination?, signature?, body? }
function encodeMessage(m) {
  const sig = m.signature || ''
  const body = sig ? marshal(sig, m.body || []) : Buffer.alloc(0)
  const fields = []
  // loop: NOT-WORTH — the 8 header field kinds
  for (const [name, code] of Object.entries(FIELD)) {
    if (name === 'sender') continue   // the bus sets it
    const v = name === 'signature' ? (sig || undefined) : m[name]
    if (v !== undefined && v !== null && v !== '') fields.push([code, [FIELD_SIG[code], v]])
  }
  const w = new Writer()
  w.u8(0x6c); w.u8(TYPE[m.type]); w.u8(m.flags || 0); w.u8(1)
  w.num(4, 'writeUInt32LE', body.length)
  w.num(4, 'writeUInt32LE', m.serial >>> 0)
  write(w, parseSig('a(yv)')[0], fields, 0)
  w.align(8)
  return Buffer.concat([w.result(), body])
}

// The first whole message at the start of `buf`: { message, size }, or null while more bytes are due.
// Throws on a malformed one (the connection then closes).
function decodeMessage(buf) {
  if (buf.length < 16) return null
  const le = buf[0] === 0x6c
  if (!le && buf[0] !== 0x42) throw new Error('bad byte order mark')
  const rd = (at) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at))
  const bodyLen = rd(4)
  const fieldsLen = rd(12)
  const headerLen = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8)
  const size = headerLen + bodyLen
  if (size > MAX_MESSAGE) throw new Error('message too large')
  if (buf.length < size) return null
  const whole = buf.subarray(0, size)
  const r = new Reader(whole, 12, 16 + fieldsLen, le)
  const fields = read(r, parseSig('a(yv)')[0], 0)
  const msg = { type: TYPE_NAME[buf[1]] || 'unknown', flags: buf[2], serial: rd(8), body: [] }
  // loop: NOT-WORTH — ≤ 9 header fields
  for (const [code, value] of fields) if (FIELD_NAME[code]) msg[FIELD_NAME[code]] = value
  if (msg.signature && bodyLen) msg.body = unmarshal(msg.signature, whole, headerLen, le)
  return { message: msg, size }
}

// --- the bus address and authentication ---
// DBUS_SESSION_BUS_ADDRESS ("unix:path=…" or "unix:abstract=…", ';'-separated, values %-escaped);
// without it, the standard $XDG_RUNTIME_DIR/bus. -> a socket path for net (abstract: a leading NUL) or null
function socketPath(env) {
  const e = env || {}
  const addr = e.DBUS_SESSION_BUS_ADDRESS || (e.XDG_RUNTIME_DIR ? 'unix:path=' + e.XDG_RUNTIME_DIR + '/bus' : '')
  // loop: NOT-WORTH — the few addresses of one bus address string
  for (const one of addr.split(';')) {
    const m = /^unix:(.*)$/.exec(one.trim())
    if (!m) continue
    const kv = {}
    // loop: NOT-WORTH — the key=value pairs of one address
    for (const part of m[1].split(',')) {
      const i = part.indexOf('=')
      if (i > 0) {
        try { kv[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)) } catch (err) { kv[part.slice(0, i)] = part.slice(i + 1) }   // error: NOT-WORTH — a stray % stays literal
      }
    }
    if (kv.path) return kv.path
    if (kv.abstract) return '\0' + kv.abstract
  }
  return null
}
const authLine = (uid) => 'AUTH EXTERNAL ' + Buffer.from(String(uid)).toString('hex') + '\r\n'

// --- one connection to the session bus ---
// Connection.open({ net, env, uid, timeoutMs }) -> a ready connection (authenticated, Hello sent).
// .call({ destination, path, interface, member, signature, body }, { timeoutMs }) -> the reply body
// .addMatch(rule) · 'signal' events (a decoded message) · 'close' once · .close()
class Connection extends EventEmitter {
  constructor(sock, timeoutMs) {
    super()
    this.sock = sock
    this.timeoutMs = timeoutMs || 10000
    this.serial = 0
    // cache: OK — key=call serial; invalidated=deleted on reply or timeout, cleared on shut(); bound=calls in flight (a few)
    this.pending = new Map()   // serial -> { resolve, reject, timer }
    this.buf = Buffer.alloc(0)
    this.uniqueName = ''
    this.closed = false
  }
  static open(opts) {
    const o = opts || {}
    const path = socketPath(o.env || process.env)
    if (!path) return Promise.reject(new Error('no session bus address'))
    return new Promise((resolve, reject) => {
      // lifetime: OK — the socket lives until close() or the bus ends it; 'close' tells the owner
      const sock = o.net.createConnection({ path })
      let mode = 'auth'      // what incoming bytes are: the auth reply, then messages
      let settled = false
      let line = ''
      let conn = null
      const fail = (err) => {
        if (settled) return
        settled = true
        try { sock.destroy() } catch (e) { /* error: NOT-WORTH — already gone */ }
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error('session bus: no answer')), o.timeoutMs || 5000)   // lifetime: OK — cleared on success or failure
      // lifetime: OK — the socket's listeners go with the socket
      sock.on('error', (err) => { clearTimeout(timer); if (conn) conn.shut(err); else fail(err) })
      sock.on('close', () => { clearTimeout(timer); if (conn) conn.shut(null); else fail(new Error('session bus closed the connection')) })
      sock.on('connect', () => sock.write(Buffer.concat([Buffer.from([0]), Buffer.from(authLine(o.uid !== undefined ? o.uid : process.getuid()))])))
      sock.on('data', (chunk) => {
        if (mode === 'msg') { conn.feed(chunk); return }
        line += chunk.toString('latin1')
        const nl = line.indexOf('\r\n')
        if (nl < 0) { if (line.length > 4096) fail(new Error('session bus: bad auth reply')); return }
        if (!line.startsWith('OK ')) { fail(new Error('session bus refused: ' + line.slice(0, nl))); return }
        const rest = Buffer.from(line.slice(nl + 2), 'latin1')
        sock.write('BEGIN\r\n')
        mode = 'msg'
        conn = new Connection(sock, o.timeoutMs)
        if (rest.length) conn.feed(rest)
        conn.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'Hello' })
          .then(([name]) => { clearTimeout(timer); conn.uniqueName = name; if (!settled) { settled = true; resolve(conn) } })
          .catch((err) => { clearTimeout(timer); fail(err) })   // error: PASSES-ON — the caller's open() rejects
      })
    })
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    // loop: NOT-WORTH — the whole messages in one socket chunk (one or two portal signals)
    while (!this.closed) {
      let got
      try { got = decodeMessage(this.buf) } catch (err) { this.shut(err); return }   // error: PASSES-ON — a malformed message closes the connection; the owner hears 'close'
      if (!got) return
      this.buf = this.buf.subarray(got.size)
      this.dispatch(got.message)
    }
  }
  dispatch(m) {
    if (m.type === 'return' || m.type === 'error') {
      const p = this.pending.get(m.replySerial)
      if (!p) return
      this.pending.delete(m.replySerial)
      clearTimeout(p.timer)
      if (m.type === 'return') p.resolve(m.body)
      else { const e = new Error(m.errorName + (m.body && typeof m.body[0] === 'string' ? ': ' + m.body[0] : '')); e.dbusName = m.errorName; p.reject(e) }
    } else if (m.type === 'signal') this.emit('signal', m)
    else if (m.type === 'call' && !(m.flags & NO_REPLY)) {
      // nothing is exported here: Peer.Ping is answered, anything else gets UnknownMethod
      if (m.interface === 'org.freedesktop.DBus.Peer' && m.member === 'Ping') this.send({ type: 'return', replySerial: m.serial, destination: m.sender })
      else this.send({ type: 'error', replySerial: m.serial, destination: m.sender, errorName: 'org.freedesktop.DBus.Error.UnknownMethod', signature: 's', body: ['Sonata exports nothing here'] })
    }
  }
  send(m) {
    if (this.closed) throw new Error('connection closed')
    const serial = ++this.serial
    this.sock.write(encodeMessage(Object.assign({}, m, { serial })))
    return serial
  }
  call(m, opts) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('connection closed')); return }
      let serial
      try { serial = this.send(Object.assign({ type: 'call' }, m)) } catch (err) { reject(err); return }   // error: PASSES-ON — a value the signature can't hold: the caller's promise rejects
      const ms = (opts && opts.timeoutMs) || this.timeoutMs
      // lifetime: OK — cleared by the reply, or fires once and rejects
      const timer = setTimeout(() => { this.pending.delete(serial); reject(new Error(m.member + ': no reply')) }, ms)
      this.pending.set(serial, { resolve, reject, timer })
    })
  }
  addMatch(rule) {
    return this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] })
  }
  shut(err) {
    if (this.closed) return
    this.closed = true
    // loop: NOT-WORTH — the calls still waiting when the connection ends (a few)
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err || new Error('connection closed')) }
    this.pending.clear()
    try { this.sock.destroy() } catch (e) { /* error: NOT-WORTH — already gone */ }
    this.emit('close', err || null)
  }
  close() { this.shut(null) }
}

module.exports = { parseSig, marshal, unmarshal, encodeMessage, decodeMessage, socketPath, authLine, Connection }
