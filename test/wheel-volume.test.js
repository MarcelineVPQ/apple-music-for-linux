// Mouse wheel → volume (wheel-volume.js): 5 % per notch, up = louder; trackpad deltas add up to notches.
const test = require('node:test')
const assert = require('node:assert/strict')
const W = require('../wheel-volume')

test('a mouse notch is one 5 % step: up louder, down quieter', () => {
  const s = W.createWheelSteps()
  assert.equal(s.feed(-100, 0, 0), 1)     // wheel up (negative deltaY)
  assert.equal(s.feed(-100, 0, 50), 1)
  assert.equal(s.feed(100, 0, 100), -1)   // turning back starts fresh
  assert.equal(s.feed(0, 0, 150), 0)
  // line and page delta modes
  assert.equal(W.createWheelSteps().feed(-3, 1, 0), 1)
  assert.equal(W.createWheelSteps().feed(1, 2, 0), -1)
  // a fast spin: one event worth two notches is two steps
  assert.equal(W.createWheelSteps().feed(-200, 0, 0), 2)
})

test('trackpad: small deltas accumulate to whole notches, not one step per event', () => {
  const s = W.createWheelSteps()
  let steps = 0
  for (let i = 0; i < 10; i++) steps += s.feed(-15, 0, i * 16)    // 150 px in 10 events
  assert.equal(steps, 1)
  for (let i = 10; i < 20; i++) steps += s.feed(-15, 0, i * 16)   // 300 px in total
  assert.equal(steps, 3)
  // a pause drops a half notch; a direction change too
  const p = W.createWheelSteps()
  assert.equal(p.feed(-60, 0, 0), 0)
  assert.equal(p.feed(-60, 0, 1000), 0)  // after 1 s: the first 60 px were dropped
  assert.equal(p.feed(-40, 0, 1010), 1)
  assert.equal(p.feed(70, 0, 1020), 0)   // reversed: starts again from 0
  assert.equal(p.feed(30, 0, 1030), -1)
})

test('stepVolume: on the 5 % grid, clamped to 0..100 %', () => {
  assert.equal(W.percent(W.stepVolume(0.5, 1)), 55)
  assert.equal(W.percent(W.stepVolume(0.5, -3)), 35)
  assert.equal(W.percent(W.stepVolume(0.43, 1)), 50)   // snaps to the grid first (45) then +5
  assert.equal(W.stepVolume(0.98, 3), 1)
  assert.equal(W.stepVolume(0.02, -2), 0)
  assert.equal(W.stepVolume('garbage', 1), 0.05)
})
