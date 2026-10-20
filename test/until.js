// Test helpers (not a test file: node --test runs test/*.test.js only). until(): wait for a condition instead of a
// fixed sleep (QC 2026-10: a fixed 130 ms wait for a 100 ms timer flaked on a busy machine). drain(): let every
// queued promise and immediate run (the fakes' async jobs settle in microtasks; no wall-clock time involved).
'use strict'
const until = (fn, ms = 5000) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  // lifetime: OK — cleared when the condition holds or the time is up
  const t = setInterval(() => {
    let ok = false
    try { ok = fn() } catch (e) { ok = false }
    if (ok) { clearInterval(t); resolve() } else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error('timed out waiting for ' + fn)) }
  }, 5)
})
async function drain(rounds = 25) {
  // loop: NOT-WORTH — a test's event-loop turns
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}
module.exports = { until, drain }
