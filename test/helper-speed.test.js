// helper-speed.js: the measured helper speed that lets a helper on Intel graphics (OpenVINO, engine 0.2.6)
// do first-play section work like a GPU machine, and keeps every processor-only helper timing after the song.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../helper-speed')

const pong = (device) => ({ type: 'pong', device: 'cpu', backend: 'openvino', openvino: { device, name: device === 'GPU' ? 'Intel(R) Iris(R) Xe Graphics' : 'Intel Core i5' } })
const job = (work, dur, extra) => Object.assign({ separate_s: work * 0.6, emissions_s: work * 0.3, align_s: work * 0.1, duration_s: dur }, extra)

test('speed: a job\'s work per audio second; stitched passes and non-alignment results do not count', () => {
  assert.ok(Math.abs(S.ratioOf(job(10, 20)) - 0.5) < 1e-9)
  assert.equal(S.ratioOf(job(10, 20, { stitched: 3 })), null)
  assert.equal(S.ratioOf({ notes: [], f0_s: 2 }), null)
  assert.equal(S.ratioOf(job(1, 2)), null)          // too short to judge
  assert.equal(S.ratioOf(null), null)
})

test('speed: Intel graphics that keep up with the music allow section work; slower ones and the processor do not', () => {
  const logs = []
  const sp = S.createHelperSpeed({ log: (m) => logs.push(m) })
  assert.equal(sp.fast(), false)                      // nothing measured: timed after the song
  sp.learnPong(pong('GPU'))
  assert.equal(sp.fast(), false)
  sp.record(job(120, 240))                            // the first whole-song job: 0.5 s per s
  assert.equal(sp.fast(), true)
  assert.match(logs.join('\n'), /0\.50 s of work per s of audio .* on Intel graphics → first plays section by section/)
  sp.record(job(300, 240)); sp.record(job(320, 240))  // the laptop slowed down (on battery): median over 1
  assert.equal(sp.fast(), false)
  assert.match(logs[logs.length - 1], /timed after the song/)
  // OpenVINO on the processor, however fast: the 0.15.59 protections stay
  const cpu = S.createHelperSpeed()
  cpu.learnPong(pong('CPU'))
  cpu.record(job(10, 240))
  assert.equal(cpu.fast(), false)
  // a plain processor-only helper (no OpenVINO in the pong)
  const plain = S.createHelperSpeed()
  plain.learnPong({ type: 'pong', device: 'cpu', backend: 'cpu' })
  plain.record(job(10, 240))
  assert.equal(plain.fast(), false)
})

test('speed: another build or device starts the measurement over; only the last jobs count', () => {
  const sp = S.createHelperSpeed()
  sp.learnPong(pong('GPU'))
  sp.record(job(10, 240))
  assert.equal(sp.fast(), true)
  sp.learnPong(pong('GPU'))                           // the same helper answering again keeps it
  assert.equal(sp.fast(), true)
  sp.learnPong(pong('CPU'))                           // the GPU fell back: start over
  assert.deepEqual(sp.state().ratios, [])
  sp.learnPong(pong('GPU'))
  for (let i = 0; i < 10; i++) sp.record(job(10, 240))
  assert.equal(sp.state().ratios.length, S.KEEP)
})

test('speed: a graphics card\'s helper (CUDA) logs no processor decision', () => {
  const logs = []
  const sp = S.createHelperSpeed({ log: (m) => logs.push(m) })
  sp.learnPong({ type: 'pong', device: 'cuda', backend: 'torch', gpu: 'NVIDIA GeForce RTX 4070' })
  sp.record(job(30, 240))
  sp.fast()
  assert.deepEqual(logs, [])
  sp.learnPong(pong('CPU'))                           // OpenVINO on the processor: its decision is logged
  sp.record(job(300, 240))
  assert.match(logs.join('\n'), /on the processor → first plays timed after the song/)
})
