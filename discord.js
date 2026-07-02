const net = require('net')
const path = require('path')
const crypto = require('crypto')

// Discord Rich Presence over the local IPC socket. Frames are
// [opcode uint32 LE][length uint32 LE][json payload].
const OP_HANDSHAKE = 0
const OP_FRAME = 1
const OP_CLOSE = 2

function socketCandidates() {
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'
  const dirs = [
    base,
    path.join(base, 'app', 'com.discordapp.Discord'), // flatpak
    path.join(base, 'snap.discord')                   // snap
  ]
  const candidates = []
  for (const dir of dirs) {
    for (let i = 0; i < 10; i++) {
      candidates.push(path.join(dir, 'discord-ipc-' + i))
    }
  }
  return candidates
}

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload))
  const header = Buffer.alloc(8)
  header.writeUInt32LE(op, 0)
  header.writeUInt32LE(json.length, 4)
  return Buffer.concat([header, json])
}

class DiscordPresence {
  constructor(applicationId) {
    this.applicationId = applicationId
    this.socket = null
    this.ready = false
    this.buffer = Buffer.alloc(0)
  }

  connect() {
    return new Promise((resolve, reject) => {
      const candidates = socketCandidates()
      const tryNext = (i) => {
        if (i >= candidates.length) {
          reject(new Error('Discord IPC socket not found — is Discord running?'))
          return
        }
        const socket = net.createConnection(candidates[i])
        socket.on('connect', () => {
          this.socket = socket
          socket.on('data', (chunk) => this.onData(chunk))
          socket.on('close', () => { this.ready = false; this.socket = null })
          socket.on('error', () => { this.ready = false; this.socket = null })
          this.awaitingReady = { resolve, reject }
          socket.write(encode(OP_HANDSHAKE, { v: 1, client_id: this.applicationId }))
        })
        socket.on('error', () => tryNext(i + 1))
      }
      tryNext(0)
    })
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 8) {
      const op = this.buffer.readUInt32LE(0)
      const length = this.buffer.readUInt32LE(4)
      if (this.buffer.length < 8 + length) return
      let payload
      try {
        payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString())
      } catch (e) {
        // malformed frame — drop the connection rather than crash
        this.close()
        return
      }
      this.buffer = this.buffer.subarray(8 + length)

      if (op === OP_FRAME && payload.evt === 'READY') {
        this.ready = true
        if (this.awaitingReady) { this.awaitingReady.resolve(); this.awaitingReady = null }
      }
      else if (op === OP_CLOSE || payload.evt === 'ERROR') {
        const err = new Error(payload.message || (payload.data && payload.data.message) || 'Discord rejected the connection')
        if (this.awaitingReady) { this.awaitingReady.reject(err); this.awaitingReady = null }
        this.close()
      }
    }
  }

  send(cmd, args) {
    if (!this.socket || !this.ready) return
    this.socket.write(encode(OP_FRAME, { cmd, args, nonce: crypto.randomUUID() }))
  }

  setActivity(activity) {
    this.send('SET_ACTIVITY', { pid: process.pid, activity })
  }

  clearActivity() {
    this.send('SET_ACTIVITY', { pid: process.pid })
  }

  close() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.ready = false
  }
}

module.exports = { DiscordPresence }
