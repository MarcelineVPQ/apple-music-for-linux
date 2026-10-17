// The small D-Bus client (dbus-wire.js): the codec against hand-checked bytes, round trips, messages
// split across socket chunks, the bus address, and a Connection over a fake socket (auth, Hello, a
// call, a signal, an error, the close). The live check against the real xdg-desktop-portal frontend is
// in the commit notes (it needs a private bus).
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const W = require('../dbus-wire')

test('signatures: containers parse; bad ones throw', () => {
  assert.deepEqual(W.parseSig('a{sv}'), [{ t: 'a', e: { t: '{', k: { t: 's' }, v: { t: 'v' } } }])
  assert.equal(W.parseSig('oa(sa{sv})sa{sv}').length, 4)
  for (const bad of ['a', '(', 'a{vs}', '()', 'h', 'a{ss']) assert.throws(() => W.parseSig(bad), undefined, bad)
  assert.throws(() => W.parseSig('a'.repeat(40) + 's'), /too deep/)
})

test('marshal: alignment and lengths as the spec has them', () => {
  // a string: u32 length, bytes, NUL
  assert.deepEqual([...W.marshal('s', ['ab'])], [2, 0, 0, 0, 0x61, 0x62, 0])
  // y then u: three pad bytes
  assert.deepEqual([...W.marshal('yu', [1, 2])], [1, 0, 0, 0, 2, 0, 0, 0])
  // a{sv} with one entry: length counts from the 8-aligned first entry, not the padding before it
  const b = W.marshal('a{sv}', [{ k: ['u', 7] }])
  assert.equal(b.readUInt32LE(0), b.length - 8)
  assert.equal(b.readUInt32LE(8), 1)
})

test('round trip: every type Sonata sends or reads', () => {
  const sig = 'ybnqiuxtdsogva{sv}a(sa{sv})'
  const vals = [255, true, -2, 65535, -7, 4000000000, -5, 1792225209321, 1.5, 'héllo', '/a/b', 'a{sv}', ['s', 'v'],
    { handle_token: ['s', 't1'], n: ['u', 3] }, [['next', { description: ['s', 'Next song'], preferred_trigger: ['s', 'CTRL+ALT+n'] }]]]
  const out = W.unmarshal(sig, W.marshal(sig, vals))
  assert.deepEqual(out, [255, true, -2, 65535, -7, 4000000000, -5, 1792225209321, 1.5, 'héllo', '/a/b', 'a{sv}', 'v',
    { handle_token: 't1', n: 3 }, [['next', { description: 'Next song', preferred_trigger: 'CTRL+ALT+n' }]]])
  assert.throws(() => W.marshal('v', ['x']), /variant/)
  assert.throws(() => W.marshal('ss', ['one']), /wants 2/)
})

test('messages: encode, decode (also split into chunks), big-endian replies, short and bad data', () => {
  const m = W.encodeMessage({ type: 'call', serial: 9, destination: 'org.x', path: '/o', interface: 'org.x.I', member: 'M', signature: 'su', body: ['hi', 3] })
  assert.equal(m.length % 1, 0)
  const got = W.decodeMessage(m)
  assert.equal(got.size, m.length)
  assert.deepEqual({ ...got.message, flags: undefined }, { type: 'call', flags: undefined, serial: 9, destination: 'org.x', path: '/o', interface: 'org.x.I', member: 'M', signature: 'su', body: ['hi', 3] })
  assert.equal(W.decodeMessage(m.subarray(0, m.length - 1)), null, 'not all there yet')
  assert.equal(W.decodeMessage(m.subarray(0, 10)), null)
  const bad = Buffer.from(m); bad[0] = 0x51
  assert.throws(() => W.decodeMessage(bad), /byte order/)
  // a big-endian return: hand-built (header 'B', a u32 reply serial field, body "s")
  const be = Buffer.from([0x42, 2, 0, 1, 0, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0, 0x0f,
    5, 1, 0x75, 0, 0, 0, 0, 9, 8, 1, 0x67, 0, 1, 0x73, 0, 0,
    0, 0, 0, 2, 0x6f, 0x6b, 0])
  const r = W.decodeMessage(be)
  assert.equal(r.message.type, 'return')
  assert.equal(r.message.replySerial, 9)
  assert.deepEqual(r.message.body, ['ok'])
})

test('bus address: path, abstract, %-escapes, the runtime-dir default, nothing', () => {
  assert.equal(W.socketPath({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }), '/run/user/1000/bus')
  assert.equal(W.socketPath({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x,guid=12' }), '\0/tmp/dbus-x')
  assert.equal(W.socketPath({ DBUS_SESSION_BUS_ADDRESS: 'tcp:host=x;unix:path=/tmp/a%20b' }), '/tmp/a b')
  assert.equal(W.socketPath({ XDG_RUNTIME_DIR: '/run/user/5' }), '/run/user/5/bus')
  assert.equal(W.socketPath({}), null)
  assert.equal(W.authLine(1000), 'AUTH EXTERNAL 31303030\r\n')
})

// a fake bus: answers the auth, Hello and one method; sends a signal; then closes
function fakeNet(script) {
  const sock = new EventEmitter()
  sock.written = []
  let authed = false
  let buf = Buffer.alloc(0)
  sock.write = (d) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(d)
    sock.written.push(b)
    if (!authed) {
      const t = b.toString('latin1')
      if (t.includes('AUTH EXTERNAL')) setImmediate(() => sock.emit('data', Buffer.from('OK 0123456789abcdef\r\n')))
      if (t.startsWith('BEGIN')) authed = true
      return true
    }
    buf = Buffer.concat([buf, b])
    let got
    while ((got = W.decodeMessage(buf))) {
      buf = buf.subarray(got.size)
      const replies = script(got.message)
      const all = Buffer.concat(replies.map((r) => W.encodeMessage(r)))
      // deliver in two chunks to exercise the reassembly
      setImmediate(() => { sock.emit('data', all.subarray(0, 5)); sock.emit('data', all.subarray(5)) })
    }
    return true
  }
  sock.destroy = () => { setImmediate(() => sock.emit('close')) }
  return { createConnection: () => { setImmediate(() => sock.emit('connect')); return sock }, sock }
}

test('Connection: auth, Hello, a call, a signal, an error reply, then close rejects what waits', async () => {
  const n = fakeNet((m) => {
    if (m.member === 'Hello') return [{ type: 'return', serial: 1, replySerial: m.serial, signature: 's', body: [':1.42'] }]
    if (m.member === 'Echo') return [{ type: 'return', serial: 2, replySerial: m.serial, signature: 's', body: [m.body[0]] },
      { type: 'signal', serial: 3, path: '/p', interface: 'org.x.I', member: 'Ping', signature: 'u', body: [5] }]
    if (m.member === 'Fail') return [{ type: 'error', serial: 4, replySerial: m.serial, errorName: 'org.x.Error.Nope', signature: 's', body: ['no'] }]
    return []
  })
  const conn = await W.Connection.open({ net: n, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, uid: 1000 })
  assert.equal(conn.uniqueName, ':1.42')
  assert.equal(n.sock.written[0][0], 0, 'the credentials NUL byte first')
  const sig = new Promise((r) => conn.once('signal', r))
  assert.deepEqual(await conn.call({ destination: 'org.x', path: '/p', interface: 'org.x.I', member: 'Echo', signature: 's', body: ['hey'] }), ['hey'])
  assert.deepEqual((await sig).body, [5])
  await assert.rejects(conn.call({ destination: 'org.x', path: '/p', interface: 'org.x.I', member: 'Fail' }), /org\.x\.Error\.Nope: no/)
  const waiting = conn.call({ destination: 'org.x', path: '/p', interface: 'org.x.I', member: 'Never' })
  const closed = new Promise((r) => conn.once('close', r))
  conn.close()
  await assert.rejects(waiting, /closed/)
  await closed
  await assert.rejects(conn.call({ member: 'After' }), /closed/)
})

test('Connection: a refused auth or no address rejects open()', async () => {
  const sock = new EventEmitter()
  sock.write = () => { setImmediate(() => sock.emit('data', Buffer.from('REJECTED EXTERNAL\r\n'))) }
  sock.destroy = () => {}
  await assert.rejects(W.Connection.open({ net: { createConnection: () => { setImmediate(() => sock.emit('connect')); return sock } }, env: { XDG_RUNTIME_DIR: '/x' } }), /refused/)
  await assert.rejects(W.Connection.open({ net: {}, env: {} }), /no session bus/)
})
