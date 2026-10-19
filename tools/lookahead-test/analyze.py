#!/usr/bin/env python3
"""Summarise one look-ahead measurement run:  analyze.py <scratch>/out/<test>   (JSON on stdout)

All times are CLOCK_MONOTONIC: the control client's send times and PipeWire's cycle times in the probe.
"Heard" = the frame reached a speakers sink (ch3/4 "speakers", ch5/6 "speakers2"); ch1/2 is the
player's own output, i.e. what the engine tap gets. ch2/4/6 carry the player's sample counter, so each
heard frame names its source sample and the delay is measured per frame, exactly.
"""
import json
import os
import sys

import numpy as np

RATE = 48000
WRAP = 1 << 23
CYC = np.dtype([("frame", "<u8"), ("nsec", "<u8"), ("pos", "<u8"), ("n", "<u4"), ("flags", "<u4")])

D = sys.argv[1].rstrip("/")
TEST = os.path.basename(D)
CH = 6
a = np.fromfile(os.path.join(D, "rec.f32"), dtype="<f4")
a = a[: len(a) // CH * CH].reshape(-1, CH)
cyc = np.fromfile(os.path.join(D, "rec.cycles"), dtype=CYC)
frames = cyc["frame"].astype(np.int64)
nsec = cyc["nsec"].astype(np.int64)
ctl = [json.loads(x) for x in open(os.path.join(D, "ctl.jsonl"))]
notes = json.load(open(os.path.join(D, "notes.json"))) if os.path.exists(os.path.join(D, "notes.json")) else {}
res = {"test": TEST, "seconds": round(len(a) / RATE, 1), "notes": notes}


def counter(x):
    """Sample-counter channel -> unwrapped source index (int64), -1 where there is no content."""
    v = np.rint(x.astype(np.float64) * (1 << 24)).astype(np.int64) - WRAP
    valid = (x >= 0.5) & (v >= 0) & (v < WRAP)
    out = np.full(len(x), -1, dtype=np.int64)
    idx = np.nonzero(valid)[0]
    if len(idx) == 0:
        return out
    raw = v[idx]
    # a wrap of the 2^23 counter; the tests only seek forward, so any big step back is one (a forward
    # seek across the wrap shows as a step back of less than half the range)
    wraps = np.concatenate([[0], np.cumsum(np.diff(raw) < -WRAP // 4)])
    out[idx] = raw + wraps * WRAP
    return out


def t_of(fr):
    i = np.clip(np.searchsorted(frames, fr, side="right") - 1, 0, len(frames) - 1)
    return nsec[i] + (np.asarray(fr) - frames[i]) * 1e9 / RATE


def frame_at(t_ns):
    i = max(0, min(int(np.searchsorted(nsec, t_ns, side="right") - 1), len(nsec) - 1))
    return int(frames[i] + (t_ns - nsec[i]) * RATE / 1e9)


def runs(x):
    if len(x) == 0:
        return []
    cut = np.nonzero(np.diff(x))[0] + 1
    st = np.concatenate([[0], cut])
    en = np.concatenate([cut, [len(x)]])
    return [(int(s), int(e - s), int(x[s])) for s, e in zip(st, en)]


def first_true(mask, start):
    if start is None:
        return None
    idx = np.nonzero(mask[start:])[0]
    return start + int(idx[0]) if len(idx) else None


src = counter(a[:, 1])
heard = {"speakers": counter(a[:, 3]), "speakers2": counter(a[:, 5])}
both = np.maximum(heard["speakers"], heard["speakers2"])          # whichever device plays it
silent_heard = (a[:, 2] == 0) & (a[:, 3] == 0) & (a[:, 4] == 0) & (a[:, 5] == 0)


def per_frame_delay(out):
    """(frame index at the speakers, delay in frames, unmatched count) for every heard frame."""
    sv = np.nonzero(src >= 0)[0]
    s_vals = src[sv]
    # a source value can occur twice (a seek back); the first occurrence after... keep the latest
    # occurrence not after the heard frame: sort by value then by frame
    order = np.lexsort((sv, s_vals))
    s_sorted, s_frames = s_vals[order], sv[order]
    ov = np.nonzero(out >= 0)[0]
    pos = np.searchsorted(s_sorted, out[ov], side="right") - 1
    ok = (pos >= 0) & (s_sorted[np.maximum(pos, 0)] == out[ov])
    return ov[ok], ov[ok] - s_frames[np.maximum(pos, 0)][ok], int((~ok).sum())


fr, dl, unmatched = per_frame_delay(both)
res["heard_frames_with_content"] = int(len(fr))
res["heard_frames_not_from_source"] = unmatched
res["delay_runs"] = [{"from_s": round(fr[s] / RATE, 2), "dur_s": round(n / RATE, 2), "delay_frames": v,
                      "delay_ms": round(v * 1000 / RATE, 3)} for s, n, v in runs(dl) if n > RATE // 10]
res["steady_delay_ms_values"] = sorted({r["delay_ms"] for r in res["delay_runs"] if r["dur_s"] >= 1.5})
res["delay_runs_short"] = sum(1 for s, n, v in runs(dl) if n <= RATE // 10)
# a frame heard twice (double audio) or a heard counter going backwards outside a scripted seek
hv = both[both >= 0]
res["heard_counter_steps"] = {"repeats_or_back": int((np.diff(hv) <= 0).sum()), "jumps": int((np.diff(hv) > 1).sum())}
res["heard_on_both_devices_frames"] = int(((heard["speakers"] >= 0) & (heard["speakers2"] >= 0)).sum())
res["cycles"] = int(len(cyc))
res["cycle_xrun_flags"] = int(((cyc["flags"] & 2) != 0).sum())
dn = np.diff(nsec) / 1e6
res["cycle_period_ms"] = {"median": round(float(np.median(dn)), 3), "max": round(float(dn.max()), 3), "min": round(float(dn.min()), 3)}
stats = [c for c in ctl if c.get("cmd") == "stat" and "fill" in c]
if stats:
    last = stats[-1]
    res["helper_counters"] = {k: int(last[k]) for k in ("underruns", "overflows", "trimmed", "gate_dropped", "cycles_in", "cycles_out") if k in last}

# the helper's own claim (heard_us) against what the clock needs: the content offset, i.e. the player's
# newest frame minus the frame heard in the same cycle (equal to the wall delay in steady play; after a
# pause the wall delay grows by the pause, the offset doesn't). Only where both sides have content.
claims = []
for c in stats:  # loop: NOT-WORTH — tens of stat replies, offline analysis
    if c.get("state") != "run":
        continue
    f = frame_at(int(c["t"]))
    seg = slice(f, f + RATE // 4)
    s_, h_ = src[seg], both[seg]
    ok = (s_ >= 0) & (h_ >= 0)
    if ok.sum() > RATE // 8:
        off = s_[ok] - h_[ok]
        if len(np.unique(off)) == 1:
            claims.append({"claimed_ms": int(c["heard_us"]) / 1000, "offset_ms": round(float(off[0]) * 1000 / RATE, 3),
                           "quantum": int(c["quantum"])})
if claims:
    res["heard_claim_vs_measured"] = {"n": len(claims), "max_abs_err_ms": round(max(abs(x["claimed_ms"] - x["offset_ms"]) for x in claims), 3),
                                      "samples": claims[:3] + claims[-2:]}

if TEST == "pause":
    pauses = [c for c in ctl if c.get("who") == "delay" and c.get("cmd") == "pause"]
    plays = [c for c in ctl if c.get("who") == "delay" and c.get("cmd") == "play"]
    pplays = [c for c in ctl if c.get("who") == "player" and c.get("cmd", "").startswith("play") and c["cmd"] != "play 0"]
    src_frame = fr - dl
    out = []
    for i, (p, q) in enumerate(zip(pauses, plays)):  # loop: NOT-WORTH — 12 pauses, offline
        f0 = frame_at(p["t_send"])
        f_sil = first_true(silent_heard, f0)
        f_play = frame_at(q["t_send"])
        f_back = first_true(~silent_heard, f_play)
        leaked = int((~silent_heard[f_sil:f_play]).sum()) if f_sil is not None else None
        before = both[:f_sil][both[:f_sil] >= 0]
        after = both[f_back:][both[f_back:] >= 0] if f_back is not None else np.array([])
        gap = int(after[0] - before[-1] - 1) if len(before) and len(after) else None
        f_pp = frame_at(pplays[i]["t_send"]) if i < len(pplays) else f_play
        f_next = frame_at(pauses[i + 1]["t_send"]) if i + 1 < len(pauses) else len(a)
        m = (src_frame > f_pp + RATE // 10) & (fr < f_next)
        vals = dl[m]
        out.append({
            "pause_to_silence_ms": round((t_of(f_sil) - p["t_send"]) / 1e6, 2) if f_sil is not None else None,
            "frames_heard_while_paused": leaked,
            "play_to_sound_ms": round((t_of(f_back) - q["t_send"]) / 1e6, 2) if f_back is not None else None,
            "content_gap_frames_at_resume": gap,
            "delay_after_resume_ms": round(float(vals[0]) * 1000 / RATE, 2) if len(vals) else None,
            "delay_before_next_pause_ms": round(float(vals[-1]) * 1000 / RATE, 2) if len(vals) else None,
        })
    res["pauses"] = out
    ps = [o["pause_to_silence_ms"] for o in out if o["pause_to_silence_ms"] is not None]
    res["pause_to_silence_ms"] = {"min": min(ps), "median": float(np.median(ps)), "max": max(ps)} if ps else None

if TEST == "seek":
    flushes = [c for c in ctl if c.get("who") == "delay" and c.get("cmd", "").startswith("flush")]
    seeks = [c for c in ctl if c.get("who") == "player" and c.get("cmd", "").startswith("seek")]
    plog = [dict(kv.split("=") for kv in line.split()[1:]) for line in open(os.path.join(D, "player.log")) if line.startswith("seeked ")]
    out = []
    for i, f in enumerate(flushes):  # loop: NOT-WORTH — 6 seeks, offline
        f0 = frame_at(f["t_send"])
        f_sil = first_true(silent_heard, f0)
        target = int(plog[i]["n"]) if i < len(plog) else None
        f_new = first_true(both >= target, f_sil) if target is not None else None
        old_after = both[f_sil:f_new] if f_new is not None else both[f_sil:]
        out.append({"seek_to_silence_ms": round((t_of(f_sil) - f["t_send"]) / 1e6, 2),
                    "silence_then_new_audio_ms": round((t_of(f_new) - t_of(f_sil)) / 1e6, 2) if f_new else None,
                    "old_frames_heard_after_flush": int((old_after >= 0).sum()),
                    "new_audio_starts_at_target_plus_frames": int(both[f_new] - target) if f_new else None})
    res["seeks"] = out

if TEST == "track":
    tr = [c for c in ctl if c.get("who") == "delay" and c.get("cmd", "").startswith("track")]
    out = []
    for c in tr:  # loop: NOT-WORTH — 2 track changes, offline
        f0 = frame_at(c["t_send"])
        seg = (fr >= f0 - RATE) & (fr < f0 + 7 * RATE)
        out.append({"cmd": c["cmd"], "delays_ms_around": sorted({round(float(v) * 1000 / RATE, 1) for v in np.unique(dl[seg])})})
    res["tracks"] = out
    # the old track's last heard frame and the new track's first: nothing lost, nothing twice
    jumps = np.nonzero(np.diff(hv) > 1000)[0]
    res["track_jumps"] = [{"last_old": int(hv[j]), "first_new": int(hv[j + 1])} for j in jumps]

if TEST == "crash":
    k = [c for c in ctl if "kill" in c][0]
    f_kill = frame_at(k["t"])
    f_back = first_true(~silent_heard, first_true(silent_heard, f_kill) or f_kill)
    res["kill_to_sound_again_ms"] = round((t_of(f_back) - k["t"]) / 1e6, 1) if f_back else None
    m = fr > (f_back or f_kill) + RATE // 10
    res["delay_after_fallback_ms"] = sorted({round(float(v) * 1000 / RATE, 2) for v in np.unique(dl[m])})[:5]

if TEST in ("recreate", "follow", "unroute"):
    ev = [c for c in ctl if "recreate" in c or "default" in c or "unroute" in c]
    out = []
    for e in ev:  # loop: NOT-WORTH — 1-2 events, offline
        f0 = frame_at(e["t"])
        seg = (fr >= f0 - RATE) & (fr < f0 + 5 * RATE)
        out.append({"event": {k: v for k, v in e.items() if k != "t"},
                    "delays_ms_around": sorted({round(float(v) * 1000 / RATE, 1) for v in np.unique(dl[seg])})})
    res["events"] = out

if TEST == "quantum":
    qs = [c for c in ctl if "quantum_set" in c]
    segs = []
    for i, q in enumerate(qs):  # loop: NOT-WORTH — 4 segments, offline
        f0 = frame_at(q["t"]) + RATE * 2
        f1 = frame_at(qs[i + 1]["t"]) if i + 1 < len(qs) else len(a)
        m = (fr >= f0) & (fr < f1)
        segs.append({"quantum": q["quantum_set"] or "default(1024)", "claimed_ms": int(q["stat"]["heard_us"]) / 1000,
                     "delay_ms_values": sorted({round(v * 1000 / RATE, 2) for v in np.unique(dl[m])})})
    res["quantum_segments"] = segs

if os.path.exists(os.path.join(D, "tap.log")):
    t = np.loadtxt(os.path.join(D, "tap.log"), dtype=np.int64, ndmin=2)
    t = t[t[:, 2] >= 0]
    c = t[:, 2].copy()
    c += np.concatenate([[0], np.cumsum(np.diff(c) < -(1 << 22))]) * (1 << 23)
    src_frames = np.nonzero(src >= 0)[0]
    heard_frames = np.nonzero(both >= 0)[0]
    i_src = np.searchsorted(src[src_frames], c)
    i_out = np.searchsorted(both[heard_frames], c)
    ok = (i_src < len(src_frames)) & (i_out < len(heard_frames))
    tap_lat = (t[ok, 0] - t_of(src_frames[i_src[ok]])) / 1e6
    lead = (t_of(heard_frames[i_out[ok]]) - t[ok, 0]) / 1e6
    res["engine_tap"] = {"reads": int(ok.sum()),
                         "tap_latency_ms_p50_p95_max": [round(float(np.percentile(tap_lat, q)), 1) for q in (50, 95)] + [round(float(tap_lat.max()), 1)],
                         "lead_before_heard_ms_p5_p50_min": [round(float(np.percentile(lead, q)), 1) for q in (5, 50)] + [round(float(lead.min()), 1)]}

if os.path.exists(os.path.join(D, "cpu.jsonl")):
    rows = [json.loads(x) for x in open(os.path.join(D, "cpu.jsonl"))]
    a0, a1 = rows[0], rows[-1]
    wall = a1["t"] - a0["t"]
    if wall > 0:
        res["cpu_pct_of_one_core"] = {k: round(100 * (a1[k] - a0[k]) / wall, 3) for k in a0 if k not in ("label", "t") and k in a1}
        res["cpu_window_s"] = round(wall, 1)

pt = os.path.join(D, "pwtop.txt")
if os.path.exists(pt):
    errs = {}
    for line in open(pt):  # loop: NOT-WORTH — a few hundred lines, offline
        p = line.split()
        if len(p) >= 10 and p[0] in ("R", "S", "I") and p[1].isdigit():
            try:
                errs[p[-1]] = max(errs.get(p[-1], 0), int(p[8]))
            except ValueError:
                pass
    res["pwtop_err_max"] = errs

print(json.dumps(res, indent=1))
