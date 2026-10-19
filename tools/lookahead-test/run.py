#!/usr/bin/env python3
"""Look-ahead delay measurements. Runs INSIDE sandbox.sh (a private PipeWire), never on a desktop session.

    tools/lookahead-test/sandbox.sh <scratch> python3 tools/lookahead-test/run.py <scratch> <test>

tests: exact drift pause seek quantum follow track crash recreate unroute
Each writes <scratch>/out/<test>/: rec.f32 + rec.cycles (the probe: ch1/2 the player's own output, what
the engine tap hears; ch3/4 the "speakers" monitor; ch5/6 "speakers2"), ctl.jsonl (every command with
its send time and reply), delay.log / player.log, cpu.jsonl, notes.json. analyze.py reads them.

The player is la-test's pw_stream (a stand-in for Chromium's), routed like Sonata routes its own stream:
`pactl move-sink-input <index> sonata-lookahead`.
"""
import json
import os
import random
import signal
import socket
import subprocess
import sys
import threading
import time

S = os.path.abspath(sys.argv[1])
TEST = sys.argv[2]
B = os.path.join(S, "build")
RUN = os.environ["XDG_RUNTIME_DIR"]
O = os.path.join(S, "out", TEST)
os.makedirs(O, exist_ok=True)
RATE = 48000
procs = []
ctl_log = open(os.path.join(O, "ctl.jsonl"), "w")
notes = {}


def start(args, **kw):
    p = subprocess.Popen(args, **kw)
    procs.append(p)
    return p


def sh(*args):
    return subprocess.run(list(args), capture_output=True, text=True).stdout


def wait_for(fn, timeout=5.0, what="condition"):
    t = time.time()
    while time.time() - t < timeout:  # loop: SERIAL-REQUIRED — poll until ready (deadline)
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise SystemExit(f"timed out waiting for {what}")


def ports():
    return sh("pw-link", "-io")


def link(a, b):
    subprocess.run(["pw-link", a, b], capture_output=True)


def sink_input(node_name):
    try:
        for s in json.loads(sh("pactl", "-f", "json", "list", "sink-inputs")):  # loop: NOT-WORTH — a few streams
            if s["properties"].get("node.name") == node_name:
                return s
    except ValueError:
        return None
    return None


def sink_name_of(si):
    for s in json.loads(sh("pactl", "-f", "json", "list", "sinks")):  # loop: NOT-WORTH — a few sinks
        if s["index"] == si["sink"]:
            return s["name"]
    return None


def nodes():
    out = []
    for o in json.loads(sh("pw-dump")):  # loop: NOT-WORTH — the private graph's objects
        if o.get("type") == "PipeWire:Interface:Node":
            out.append(o["info"]["props"].get("node.name"))
    return out


class Line:
    """One control socket: replies in order; 'ev' lines collected with their arrival time."""

    def __init__(self, path, who, hello=False):
        self.who = who
        self.s = socket.socket(socket.AF_UNIX)
        wait_for(lambda: self._try(path), 5, f"{who} socket")
        self.f = self.s.makefile("rw")
        self.events = []
        self.replies = []
        self.cv = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()
        if hello:
            self.wait_event("hello", 3)

    def _try(self, path):
        try:
            self.s.connect(path)
            return True
        except OSError:
            return False

    def _read(self):
        for line in self.f:  # loop: SERIAL-REQUIRED — a stream read in order
            t = time.monotonic_ns()
            line = line.strip()
            with self.cv:
                if line.startswith("ev "):
                    kv = dict(p.split("=", 1) for p in line.split()[2:] if "=" in p)
                    kv.update(ev=line.split()[1], t_arrive=t)
                    self.events.append(kv)
                    ctl_log.write(json.dumps({"who": self.who, "event": kv}) + "\n")
                else:
                    self.replies.append(line)
                self.cv.notify_all()

    def cmd(self, line):
        t_send = time.monotonic_ns()
        with self.cv:
            n = len(self.replies)
            self.f.write(line + "\n")
            self.f.flush()
            self.cv.wait_for(lambda: len(self.replies) > n, 3)
            reply = self.replies[n] if len(self.replies) > n else ""
        kv = dict(p.split("=", 1) for p in reply.split()[1:] if "=" in p)
        kv.update(t_send=t_send, who=self.who, cmd=line)
        ctl_log.write(json.dumps(kv) + "\n")
        ctl_log.flush()
        return kv

    def wait_event(self, name, timeout):
        with self.cv:
            ok = self.cv.wait_for(lambda: any(e["ev"] == name for e in self.events), timeout)
            return ok


def proc_cpu(pid):
    with open(f"/proc/{pid}/stat") as f:
        parts = f.read().rsplit(")", 1)[1].split()
    return (int(parts[11]) + int(parts[12])) / os.sysconf("SC_CLK_TCK")


def pw_top():
    out = sh("timeout", "5", "pw-top", "-b", "-n", "3")
    with open(os.path.join(O, "pwtop.txt"), "a") as f:
        f.write(f"--- {time.monotonic_ns()}\n{out}")


class Rig:
    def __init__(self, delay_ms=1000, chans=6):
        self.delay_ms = delay_ms
        self.probe = start([os.path.join(B, "la-test"), "rec", "--out", f"{O}/rec", "--chans", str(chans)])
        self.player = start([os.path.join(B, "la-test"), "player", "--ctl", f"{RUN}/player.sock", "--log", f"{O}/player.log"])
        wait_for(lambda: "probe:in_6" in ports() and "la-player:output_FR" in ports(), 5, "player and probe")
        link("speakers:monitor_FL", "probe:in_3")
        link("speakers:monitor_FR", "probe:in_4")
        link("speakers2:monitor_FL", "probe:in_5")
        link("speakers2:monitor_FR", "probe:in_6")
        self.tap_player()
        self.pctl = Line(f"{RUN}/player.sock", "player")
        self.start_helper()

    def tap_player(self):
        link("la-player:output_FL", "probe:in_1")
        link("la-player:output_FR", "probe:in_2")

    def start_helper(self):
        self.helper = start([os.path.join(B, "sonata-lookahead"), "--ctl", f"{RUN}/la.sock", "--delay-ms",
                             str(self.delay_ms), "--log", f"{O}/delay.log"], stdout=subprocess.PIPE, text=True)
        assert self.helper.stdout.readline().startswith("ready")
        self.d = Line(f"{RUN}/la.sock", "delay", hello=True)
        wait_for(lambda: "sonata-lookahead:playback_FR" in ports(), 5, "virtual sink")

    def route(self):
        si = wait_for(lambda: sink_input("la-player"), 5, "player sink input")
        subprocess.run(["pactl", "move-sink-input", str(si["index"]), "sonata-lookahead"], check=True)
        wait_for(lambda: sink_name_of(sink_input("la-player")) == "sonata-lookahead", 5, "routed")
        return si

    def cpu(self, label):
        r = {"label": label, "t": time.monotonic()}
        for k in ("helper", "player", "probe"):
            p = getattr(self, k, None)
            if p is not None and p.poll() is None:
                r[k] = proc_cpu(p.pid)
        pid = sh("pgrep", "-x", "pipewire").split()
        if pid:
            r["pipewire"] = proc_cpu(int(pid[0]))
        with open(os.path.join(O, "cpu.jsonl"), "a") as f:
            f.write(json.dumps(r) + "\n")


def stop_all():
    for p in procs[::-1]:  # loop: NOT-WORTH — a handful of processes at exit
        if p.poll() is None:
            p.send_signal(signal.SIGINT)
    for p in procs:  # loop: NOT-WORTH — a handful of processes at exit
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


# ---- scenarios ----

def t_exact():
    r = Rig(500)
    r.route()
    time.sleep(2)
    for d in (500, 1000, 2000, 3000):  # loop: SERIAL-REQUIRED — one segment per delay, in order
        r.d.cmd(f"setd {d}")
        time.sleep(30)
        r.d.cmd("stat")
    pw_top()


def t_drift(minutes=10):
    r = Rig(3000)
    si = r.route()
    # the engine's tap exactly as Sonata reads it (audio-listen.js): parec of its own sink input
    tap = start(["parec", f"--monitor-stream={si['index']}", "--format=float32le", "--channels=2", "--rate=48000",
                 "--raw", "--latency-msec=20", "--process-time-msec=10"], stdout=subprocess.PIPE)
    taplog = open(os.path.join(O, "tap.log"), "w")

    def read_tap():
        import numpy as np
        buf = b""
        while True:  # loop: SERIAL-REQUIRED — a stream read in order
            d = tap.stdout.read1(65536)
            if not d:
                return
            t = time.monotonic_ns()
            buf += d
            n = len(buf) // 8 * 8
            x = np.frombuffer(buf[:n], dtype="<f4").reshape(-1, 2)
            buf = buf[n:]
            v = x[:, 1]
            ok = v >= 0.5
            last = int(round(float(v[ok][-1]) * (1 << 24))) - (1 << 23) if ok.any() else -1
            taplog.write(f"{t} {len(x)} {last}\n")

    threading.Thread(target=read_tap, daemon=True).start()
    time.sleep(2)
    r.cpu("start")
    for i in range(minutes * 6):  # loop: SERIAL-REQUIRED — a 10 s cadence for the soak (deadline)
        time.sleep(10)
        r.d.cmd("stat")
        if i % 6 == 5:
            r.cpu(f"min{(i + 1) // 6}")
        if i == 3:
            pw_top()
    pw_top()
    notes["tap_proc"] = "parec --monitor-stream (Sonata's own tap)"


def t_pause(cycles=12):
    r = Rig(3000)
    r.route()
    time.sleep(4)
    rnd = random.Random(7)
    lags = [(60, 60)] * 6 + [(30, 150)] * 3 + [(150, 30)] * 3
    for i in range(cycles):  # loop: SERIAL-REQUIRED — scripted user actions in order
        time.sleep(3.5 + rnd.random())
        tail, lag = lags[i % len(lags)]
        r.d.cmd("pause")                 # Sonata freezes the delay first
        r.pctl.cmd(f"pause {tail}")      # the player's audio stops `tail` ms later
        time.sleep(2.0 + rnd.random())
        r.d.cmd("stat")
        r.d.cmd("play")                  # resume: the ring plays on at once
        r.pctl.cmd(f"play {lag}")        # the player's audio comes back `lag` ms later
        time.sleep(0.6)
        r.d.cmd("stat")
        # a silence of 400 ms every cycle so a surplus can be trimmed (music has pauses; the tone doesn't)
        time.sleep(1.0)
        r.pctl.cmd("pause 0")
        time.sleep(0.4)
        r.pctl.cmd("play 0")
    time.sleep(8)
    r.d.cmd("stat")
    pw_top()


def t_seek(n=6):
    r = Rig(3000)
    r.route()
    time.sleep(4)
    for i in range(n):  # loop: SERIAL-REQUIRED — scripted user actions in order
        time.sleep(4.5)
        if i == n - 1:  # the last one: a skip while paused
            r.d.cmd("pause")
            r.pctl.cmd("pause 40")
            time.sleep(1.5)
            r.d.cmd("flush 3000")
            r.pctl.cmd("seek 20000")
            time.sleep(1.5)
            r.d.cmd("play")
            r.pctl.cmd("play 60")
            time.sleep(0.03)
            r.d.cmd("open")
        else:
            # 'seeking' -> flush; the player's old audio still comes ~1 quantum; 'seeked' -> open
            r.d.cmd("flush 3000")
            time.sleep(0.015)
            r.pctl.cmd("seek 20000")
            time.sleep(0.03)
            r.d.cmd("open")
        time.sleep(0.2)
        r.d.cmd("stat")
    time.sleep(5)
    r.d.cmd("stat")


def t_quantum():
    r = Rig(3000)
    r.route()
    time.sleep(8)
    for q in (512, 256, 2048, 0):  # loop: SERIAL-REQUIRED — one segment per quantum, in order
        subprocess.run(["pw-metadata", "-n", "settings", "0", "clock.force-quantum", str(q)], capture_output=True)
        time.sleep(1)
        rr = r.d.cmd("stat")
        ctl_log.write(json.dumps({"quantum_set": q, "t": time.monotonic_ns(), "stat": rr}) + "\n")
        time.sleep(9)
        r.d.cmd("stat")


def t_follow():
    """The default device changes while Sonata plays delayed: the delay's output follows, Sonata's stream stays."""
    r = Rig(3000)
    r.route()
    time.sleep(6)
    ctl_log.write(json.dumps({"default": "speakers2", "t": time.monotonic_ns()}) + "\n")
    subprocess.run(["pactl", "set-default-sink", "speakers2"])
    time.sleep(6)
    notes["player_sink_after_default_change"] = sink_name_of(sink_input("la-player"))
    notes["helper_out_sink_after"] = sink_name_of(sink_input("sonata-lookahead-out") or {"sink": -1})
    ctl_log.write(json.dumps({"default": "speakers", "t": time.monotonic_ns()}) + "\n")
    subprocess.run(["pactl", "set-default-sink", "speakers"])
    time.sleep(6)
    notes["helper_out_sink_back"] = sink_name_of(sink_input("sonata-lookahead-out") or {"sink": -1})
    r.d.cmd("stat")


def t_track():
    """Natural track changes: into a delayed song (silence added, no cut) and out of it (the tail plays out)."""
    r = Rig(0)
    r.route()
    time.sleep(4)
    r.d.cmd("stat")
    # 1. a learned song (no delay) ends, a first play starts: the item changes while the old song's last
    #    audio still comes (Chromium: 0–41 ms of it, then 45–120 ms of silence, then the new song)
    r.d.cmd("track 3000")              # Sonata: nowPlayingItemDidChange -> the new song's delay
    r.pctl.cmd("seek 100000 30 60")    # the next track: 30 ms old audio, 60 ms silence, then new (counter jump)
    time.sleep(8)
    r.d.cmd("stat")
    # 2. the delayed song ends, the next is learned: the page holds the player at the new item,
    #    the old tail plays out, then the new song starts with no delay
    r.pctl.cmd("pause 40")             # the hook pauses the player at the item change (its tail: the old song's last ms)
    t_hold = time.monotonic_ns()
    r.d.cmd("track 0")
    ok = r.d.wait_event("drained", 6)
    notes["drained_after_ms"] = (time.monotonic_ns() - t_hold) / 1e6 if ok else None
    r.pctl.cmd("seek 100000 0 60")     # the new track from its start
    r.pctl.cmd("play 40")
    time.sleep(0.02)
    r.d.cmd("open")
    time.sleep(5)
    r.d.cmd("stat")


def t_crash():
    """The helper dies (kill -9): Sonata's stream must fall back to the device at once, nothing left behind."""
    r = Rig(3000)
    r.route()
    time.sleep(6)
    t_kill = time.monotonic_ns()
    ctl_log.write(json.dumps({"kill": r.helper.pid, "t": t_kill}) + "\n")
    os.kill(r.helper.pid, signal.SIGKILL)
    wait_for(lambda: sink_name_of(sink_input("la-player") or {"sink": -1}) == "speakers", 5, "fallback")
    notes["fallback_relinked_ms"] = (time.monotonic_ns() - t_kill) / 1e6
    time.sleep(4)
    notes["nodes_after_kill"] = [n for n in nodes() if n and "sonata" in n]
    notes["player_sink_after_kill"] = sink_name_of(sink_input("la-player"))
    # Sonata routes the stream back (@DEFAULT_SINK@: no target), so nothing points at the look-ahead sink
    si = sink_input("la-player")
    subprocess.run(["pactl", "move-sink-input", str(si["index"]), "@DEFAULT_SINK@"], capture_output=True)
    time.sleep(1)
    notes["player_sink_after_clear"] = sink_name_of(sink_input("la-player"))
    time.sleep(2)


def t_recreate():
    """The player's stream is destroyed and made again (Chromium after a long pause): where does it go?"""
    r = Rig(3000)
    r.route()
    time.sleep(5)
    t = time.monotonic_ns()
    ctl_log.write(json.dumps({"recreate": True, "t": t}) + "\n")
    r.pctl.cmd("recreate")
    wait_for(lambda: sink_input("la-player"), 5, "new sink input")
    time.sleep(0.3)
    r.tap_player()
    notes["new_stream_sink"] = sink_name_of(sink_input("la-player"))
    time.sleep(6)
    r.d.cmd("stat")
    state = os.path.join(os.environ["XDG_STATE_HOME"], "wireplumber", "stream-properties")
    notes["wireplumber_saved"] = open(state).read() if os.path.exists(state) else None


def t_unroute():
    """Look-ahead turned off: the stream goes back to the default device and nothing is remembered."""
    r = Rig(3000)
    si = r.route()
    time.sleep(5)
    t = time.monotonic_ns()
    subprocess.run(["pactl", "move-sink-input", str(si["index"]), "@DEFAULT_SINK@"], capture_output=True)
    wait_for(lambda: sink_name_of(sink_input("la-player")) == "speakers", 5, "unrouted")
    notes["unroute_ms"] = (time.monotonic_ns() - t) / 1e6
    ctl_log.write(json.dumps({"unroute": True, "t": t}) + "\n")
    time.sleep(2)
    # back on the default device, not pinned to it: a new default takes it along
    subprocess.run(["pactl", "set-default-sink", "speakers2"])
    time.sleep(1)
    notes["follows_default_after_unroute"] = sink_name_of(sink_input("la-player")) == "speakers2"
    subprocess.run(["pactl", "set-default-sink", "speakers"])
    time.sleep(1)
    r.d.cmd("quit")
    time.sleep(1)
    notes["nodes_after_quit"] = [n for n in nodes() if n and "sonata" in n]
    state = os.path.join(os.environ["XDG_STATE_HOME"], "wireplumber", "stream-properties")
    notes["wireplumber_saved"] = open(state).read() if os.path.exists(state) else None
    # a new stream after that: the default, not the (gone) look-ahead sink
    r.pctl.cmd("recreate")
    time.sleep(1)
    notes["new_stream_sink_after_off"] = sink_name_of(sink_input("la-player"))


try:
    {"exact": t_exact, "drift": t_drift, "pause": t_pause, "seek": t_seek, "quantum": t_quantum,
     "follow": t_follow, "track": t_track, "crash": t_crash, "recreate": t_recreate, "unroute": t_unroute}[TEST]()
finally:
    with open(os.path.join(O, "notes.json"), "w") as f:
        json.dump(notes, f, indent=1)
    ctl_log.close()
    stop_all()
