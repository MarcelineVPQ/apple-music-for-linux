// gpu-detect.js: which graphics cards a computer has (fake /sys/class/drm trees, lspci text) and which
// build of the Precise timing helper Auto picks (Settings → Precise timing → Build for).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const G = require('../gpu-detect')

// a fake /sys/class/drm: cards { card1: { vendor, device, class, vram, bootVga } } plus connector entries
function sysfs(cards) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-'))
  for (const [name, c] of Object.entries(cards)) {
    const dev = path.join(root, name, 'device')
    fs.mkdirSync(dev, { recursive: true })
    fs.writeFileSync(path.join(dev, 'vendor'), c.vendor + '\n')
    fs.writeFileSync(path.join(dev, 'device'), c.device + '\n')
    fs.writeFileSync(path.join(dev, 'class'), (c.class || '0x030000') + '\n')
    if (c.vram != null) fs.writeFileSync(path.join(dev, 'mem_info_vram_total'), String(c.vram) + '\n')
    if (c.bootVga) fs.writeFileSync(path.join(dev, 'boot_vga'), '1\n')
    fs.mkdirSync(path.join(root, name + '-DP-1'))   // a connector: not a card
  }
  fs.writeFileSync(path.join(root, 'version'), 'drm 1.1.0\n')
  return root
}
const GB = 1024 * 1024 * 1024
const pick = (cards, lspci = '') => {
  const root = sysfs(cards)
  try {
    const d = G.detect(G.scanSysfs(root), lspci)
    return { d, rec: G.recommend(d) }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('gpu: this kind of PC (an integrated AMD GPU + an NVIDIA card): NVIDIA, CUDA', () => {
  const lspci = '01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GB203 [GeForce RTX 5080] [2c02]" -ra1 -p00 "ASUSTeK Computer Inc. [1043]" "Device [89e0]"\n' +
    '79:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Granite Ridge [Radeon Graphics] [13c0]" -rc9 -p00 "ASUSTeK Computer Inc. [1043]" "Device [8877]"\n' +
    '00:14.0 "USB controller [0c03]" "Advanced Micro Devices, Inc. [AMD] [1022]" "Device [15b6]"\n'
  const { d, rec } = pick({ card1: { vendor: '0x1002', device: '0x13c0', vram: 2 * GB, bootVga: true }, card2: { vendor: '0x10de', device: '0x2c02' } }, lspci)
  assert.deepEqual(d.map((g) => [g.name, g.kind]), [['AMD Radeon Graphics', 'integrated'], ['NVIDIA GeForce RTX 5080', 'discrete']])
  assert.equal(rec.backend, 'cuda')
  assert.equal(rec.gpu.name, 'NVIDIA GeForce RTX 5080')
})

test('gpu: a discrete AMD card: ROCm; an integrated one alone: the processor, and why', () => {
  const lspci = '03:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 32 [Radeon RX 7700 XT / 7800 XT] [747e]" -rc8 "Sapphire [1da2]" "Device [e471]"\n'
  const amd = pick({ card0: { vendor: '0x1002', device: '0x747e', vram: 16 * GB } }, lspci)
  assert.equal(amd.rec.backend, 'rocm')
  assert.equal(amd.rec.gpu.name, 'AMD Radeon RX 7700 XT / 7800 XT')
  const apu = pick({ card0: { vendor: '0x1002', device: '0x13c0', vram: 512 * 1024 * 1024 } })
  assert.equal(apu.rec.backend, 'cpu')
  assert.match(apu.rec.why, /AMD graphics \(1002:13c0\) is an integrated GPU/)
  // no amdgpu VRAM reading (an older driver): the card is tried (the helper's test computation decides)
  assert.equal(pick({ card0: { vendor: '0x1002', device: '0x73bf' } }).rec.backend, 'rocm')
})

test('gpu: Intel Arc cards: XPU; Intel integrated graphics: the processor; nothing: the processor', () => {
  assert.equal(pick({ card0: { vendor: '0x8086', device: '0x56a0' } }).rec.backend, 'xpu')       // Arc A770
  assert.equal(pick({ card0: { vendor: '0x8086', device: '0xe20b' } }).rec.backend, 'xpu')       // Arc B580
  const igpu = pick({ card0: { vendor: '0x8086', device: '0xa780' } })                           // Raptor Lake UHD 770
  assert.equal(igpu.rec.backend, 'cpu')
  assert.equal(igpu.d[0].kind, 'integrated')
  const none = pick({})
  assert.equal(none.rec.backend, 'cpu')
  assert.equal(none.rec.why, 'no graphics card found')
  // NVIDIA wins over AMD and Intel; a discrete AMD card over an Arc
  assert.equal(pick({ card0: { vendor: '0x8086', device: '0x56a0' }, card1: { vendor: '0x1002', device: '0x747e', vram: 16 * GB } }).rec.backend, 'rocm')
  // a non-display PCI class (an NPU, a sound function) is no card
  assert.equal(pick({ card0: { vendor: '0x10de', device: '0x2c02', class: '0x040300' } }).d.length, 0)
})

test('gpu: lspci alone (no sysfs cards, a container) and its older quoted-slot form', () => {
  const quoted = '"01:00.0" "3D controller [0302]" "NVIDIA Corporation [10de]" "GA102GL [A10] [2236]" "NVIDIA Corporation [10de]" "Device [1482]"\n'
  const d = G.detect([], quoted)
  assert.deepEqual(d.map((g) => [g.name, g.vendor]), [['NVIDIA A10', 'nvidia']])
  assert.equal(G.recommend(d).backend, 'cuda')
  assert.deepEqual(G.parseLspci('garbage\n\n'), [])
  assert.deepEqual(G.scanSysfs('/nonexistent/drm'), [])
})

test('gpu: Build for resolves Auto; the venv stamp names the installed build', () => {
  assert.equal(G.resolve('auto', { backend: 'rocm' }), 'rocm')
  assert.equal(G.resolve('cpu', { backend: 'rocm' }), 'cpu')
  assert.equal(G.resolve('metal', null), 'cpu')
  assert.deepEqual(['cu128', 'cu130', 'rocm7.2', 'xpu', 'cpu', '', 'other'].map(G.backendOfVariant), ['cuda', 'cuda', 'rocm', 'xpu', 'cpu', '', ''])
  assert.equal(G.niceName('intel', 'DG2 [Arc A770] [56a0]'), 'Intel Arc A770')
  assert.equal(G.niceName('nvidia', 'GB203 [GeForce RTX 5080] [2c02]'), 'NVIDIA GeForce RTX 5080')
})
