// Which graphics cards this computer has, and which build of the Precise timing helper fits them
// (Settings → Precise timing → Build for). No Electron; the reads are injectable for the tests
// (test/gpu-detect.test.js, fake sysfs trees). Linux: /sys/class/drm/cardN/device/{vendor,device,class},
// amdgpu's mem_info_vram_total (an integrated AMD GPU has a small carve-out), boot_vga; `lspci -mm -nn`
// gives names and is the fallback when sysfs has no cards (a container).
//
// The builds (the engine's setup-venv.sh --backend): cuda = NVIDIA (CUDA 12.8), rocm = AMD (ROCm 7.2: the
// PyTorch wheels carry the ROCm runtime, the system needs the amdgpu kernel driver; discrete Radeon RX 6000
// and newer, integrated AMD GPUs aren't supported by those wheels), xpu = Intel Arc (A- and B-series cards),
// openvino = Intel graphics (Iris Xe, UHD) or the processor through OpenVINO (engine 0.2.6: the CPU wheels plus
// OpenVINO; on the processor alone measured 1.5x as fast as the plain CPU build, word times identical),
// cpu = the processor only. Auto picks: an NVIDIA card, else a discrete AMD card, else an Intel Arc card, else
// Intel integrated graphics (OpenVINO), else on an Intel processor OpenVINO too, else the processor.
// ROCm, XPU and OpenVINO's GPU device are new and untested on real hardware here.
const fs = require('fs')
const path = require('path')

const VENDORS = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' }
const PCI_VENDOR = { '10de': 'nvidia', '1002': 'amd', '8086': 'intel' }
const BACKENDS = ['cuda', 'rocm', 'xpu', 'openvino', 'cpu']
const BACKEND_OF = { nvidia: 'cuda', amd: 'rocm', intel: 'xpu' }
const AMD_IGPU_VRAM = 4 * 1024 * 1024 * 1024   // below this, amdgpu's VRAM is an integrated GPU's carve-out
// Intel Arc discrete cards: Alchemist 0x5690–0x56cf, Battlemage 0xe200–0xe2ff (Intel's PCI id lists)
function intelArc(device) {
  const d = parseInt(String(device || ''), 16)
  return (d >= 0x5690 && d <= 0x56cf) || (d >= 0xe200 && d <= 0xe2ff)
}

/** The display controllers in /sys/class/drm: [{ card, vendor, vendorId, deviceId, vram, bootVga }] */
function scanSysfs(root = '/sys/class/drm', io = fs) {
  let names = []
  // error: NOT-WORTH — no /sys/class/drm (not Linux, a container): no cards, lspci is asked instead
  try { names = io.readdirSync(root) } catch (e) { return [] }
  const read = (f) => { try { return String(io.readFileSync(f, 'utf8')).trim() } catch (e) { return '' } }   // error: NOT-WORTH — a missing file is an unknown value
  const out = []
  // loop: NOT-WORTH — the DRM cards (1–4), once per start
  for (const n of names.filter((x) => /^card\d+$/.test(x)).sort()) {
    const dev = path.join(root, n, 'device')
    const cls = read(path.join(dev, 'class'))
    if (cls && !/^0x03/.test(cls)) continue   // a display controller (0x03xxxx) only
    const vendorId = read(path.join(dev, 'vendor')).toLowerCase()
    if (!vendorId) continue
    const vram = parseInt(read(path.join(dev, 'mem_info_vram_total')), 10)
    out.push({ card: n, vendor: VENDORS[vendorId] || 'other', vendorId: vendorId.replace(/^0x/, ''), deviceId: read(path.join(dev, 'device')).toLowerCase().replace(/^0x/, ''),
      vram: Number.isFinite(vram) ? vram : null, bootVga: read(path.join(dev, 'boot_vga')) === '1' })
  }
  return out
}

/** `lspci -mm -nn` -> the display controllers: [{ slot, vendor, vendorId, deviceId, name }] */
function parseLspci(text) {
  const out = []
  // loop: NOT-WORTH — one line per PCI device (a few dozen), once per start
  for (const line of String(text || '').split('\n')) {
    // 01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GB203 [GeForce RTX 5080] [2c02]" …
    // (the slot is quoted too in older lspci versions)
    const slot = /^"?([0-9a-f:.]+)"?\s/.exec(line)
    const f = [...line.slice(slot ? slot[0].length : 0).matchAll(/"([^"]*)"/g)].map((m) => m[1])
    if (f.length < 3 || !/\[03[0-9a-f]{2}\]$/.test(f[0])) continue
    const v = /\[([0-9a-f]{4})\]$/.exec(f[1])
    const d = /\[([0-9a-f]{4})\]$/.exec(f[2])
    if (!v) continue
    out.push({ slot: slot ? slot[1] : '', vendor: PCI_VENDOR[v[1]] || 'other', vendorId: v[1], deviceId: d ? d[1] : '', name: niceName(PCI_VENDOR[v[1]], f[2]) })
  }
  return out
}

// "Navi 32 [Radeon RX 7700 XT / 7800 XT] [747e]" -> "AMD Radeon RX 7700 XT / 7800 XT"
function niceName(vendor, devField) {
  const s = String(devField || '').replace(/\s*\[[0-9a-f]{4}\]$/, '')
  const inner = /\[([^\]]+)\]/.exec(s)
  const model = (inner ? inner[1] : s).trim()
  const brand = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[vendor] || ''
  return (brand && !model.startsWith(brand) ? brand + ' ' : '') + model
}

/**
 * The cards with names (sysfs first, lspci's names joined by vendor:device; lspci alone when sysfs has none),
 * each with its kind: 'discrete' | 'integrated' | 'unknown'.
 */
function detect(sys, lspci) {
  const named = parseLspci(lspci)
  const base = sys && sys.length ? sys : named
  return base.map((g) => {
    const n = named.find((x) => x.vendorId === g.vendorId && x.deviceId === g.deviceId)
    let kind = 'unknown'
    if (g.vendor === 'nvidia') kind = 'discrete'
    else if (g.vendor === 'amd') kind = g.vram == null ? 'unknown' : g.vram >= AMD_IGPU_VRAM ? 'discrete' : 'integrated'
    else if (g.vendor === 'intel') kind = intelArc(g.deviceId) ? 'discrete' : 'integrated'
    const name = (n && n.name) || g.name || ({ nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[g.vendor] || 'Unknown') + ' graphics (' + g.vendorId + ':' + g.deviceId + ')'
    return { vendor: g.vendor, vendorId: g.vendorId, deviceId: g.deviceId, name, kind, vram: g.vram == null ? null : g.vram }
  })
}

/**
 * Auto's choice: { backend, gpu (the card it is for, or null), why }. An NVIDIA card first (the tested
 * path), then a discrete AMD card (ROCm), then an Intel Arc card (XPU); integrated GPUs and anything else:
 * Intel integrated graphics through OpenVINO; no usable card on an Intel processor (cpu: cpuVendor()) also
 * OpenVINO (its CPU device is faster than the plain CPU build); anything else: the processor.
 */
function recommend(gpus, cpu) {
  const list = gpus || []
  const nv = list.find((g) => g.vendor === 'nvidia')
  if (nv) return { backend: 'cuda', gpu: nv, why: '' }
  const amd = list.find((g) => g.vendor === 'amd' && g.kind !== 'integrated')
  if (amd) return { backend: 'rocm', gpu: amd, why: '' }
  const arc = list.find((g) => g.vendor === 'intel' && g.kind === 'discrete')
  if (arc) return { backend: 'xpu', gpu: arc, why: '' }
  const intel = list.find((g) => g.vendor === 'intel' && g.kind === 'integrated')
  if (intel) return { backend: 'openvino', gpu: intel, why: '' }
  const igpu = list.find((g) => g.kind === 'integrated')
  if (cpu === 'intel') return { backend: 'openvino', gpu: null, why: igpu ? igpu.name + ' is an integrated GPU the helper can\'t use' : list.length ? 'no graphics card the helper can use' : 'no graphics card found' }
  return { backend: 'cpu', gpu: null, why: igpu ? igpu.name + ' is an integrated GPU the helper can\'t use' : list.length ? 'no graphics card the helper can use' : 'no graphics card found' }
}

/** The build Settings asks for: the choice ('auto' | a backend) resolved with Auto's recommendation. */
function resolve(choice, rec) {
  return BACKENDS.includes(choice) ? choice : (rec && rec.backend) || 'cpu'
}

/** The processor's maker from /proc/cpuinfo's vendor_id: 'intel' | 'amd' | '' (unknown, not Linux). */
function cpuVendor(read = (f) => fs.readFileSync(f, 'utf8')) {
  let text = ''
  try { text = String(read('/proc/cpuinfo')) } catch (e) { return '' }   // error: NOT-WORTH — no /proc: unknown, Auto takes the processor build
  const v = /^vendor_id\s*:\s*(\S+)/m.exec(text)
  return !v ? '' : v[1] === 'GenuineIntel' ? 'intel' : v[1] === 'AuthenticAMD' ? 'amd' : ''
}

/** The engine venv's stamp variant (setup-venv.sh: cu128, rocm7.2, xpu, openvino, cpu) -> the backend, or ''. */
function backendOfVariant(v) {
  const s = String(v || '')
  if (/^cu\d+$/.test(s)) return 'cuda'
  if (/^rocm/.test(s)) return 'rocm'
  if (s === 'xpu') return 'xpu'
  if (s === 'openvino') return 'openvino'
  if (s === 'cpu') return 'cpu'
  return ''
}

module.exports = { VENDORS, BACKENDS, BACKEND_OF, AMD_IGPU_VRAM, intelArc, scanSysfs, parseLspci, niceName, detect, recommend, resolve, backendOfVariant, cpuVendor }
