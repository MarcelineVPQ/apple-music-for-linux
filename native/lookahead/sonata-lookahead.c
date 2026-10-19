// sonata-lookahead: the delay of Sonata's look-ahead play (Linux, PipeWire). Experimental.
//
// Sonata plays Apple Music through Chromium; the engine works out a song's word timing from Sonata's
// own output stream while the song plays. Look-ahead delays what the listener hears by D seconds, so
// the engine hears every sound D seconds early and the words are ready before they are sung, even on
// a song's first play. Design: docs/LOOKAHEAD.md. This program is the delay, nothing else:
//
//   Sonata's stream ──► "Sonata look-ahead" (a virtual sink: this program's input stream)
//                         └─ ring of D s ──► this program's output stream ──► the default output device
//
// - Only Sonata's own stream is routed here (Sonata moves its sink input; no other app changes, the
//   default device isn't touched). The engine tap (parec --monitor-stream=<Sonata's sink input>) reads
//   the stream as Chromium plays it, undelayed.
// - The output stream is linked by the session manager (WirePlumber) to the default device and follows
//   it when the default changes. Both streams are one node group, so one driver clocks them: no
//   resampling, no drift between what the engine hears and what the listener hears.
// - Everything runs inside the graph's process cycle (the prototype showed that a pipe-based delay
//   can be neither exact nor pause in time).
//
// Usage: sonata-lookahead --ctl SOCKET [--delay-ms D] [--name N] [--description TEXT] [--log FILE]
//
// Control: a unix stream socket, one client (Sonata). One text command per line, one reply line
// ("ok ..." / "err ..."); events start with "ev " and can come between replies.
//   pause            freeze: silence from the next cycle; nothing buffered plays while paused. The player's
//                    own pause tail (non-silent input after the pause, at most TAIL_MS) is kept, silence isn't.
//   play             resume from the ring at once, after a hold that lands the delay back on D (learned from
//                    the player's resume lag); leading silent input is dropped until the player's audio comes.
//   flush D          a seek or a skip: drop what is buffered (silence at once), the delay becomes D ms, and the
//                    input is gated (dropped) until `open`.
//   open             the player confirmed the new position. Its events come ~100 ms before its audio changes
//                    (Chromium, measured), so the gate opens at the break of silence before the new audio
//                    (OPEN_BREAK_FRAMES), or OPEN_MAX_MS after `open`.
//   track D          a natural track change: no cut. The boundary is placed in the first silence after the
//                    command (the gap between two tracks). Into an equal or longer delay, silence is added
//                    there so the new track is heard D ms after it plays; into a shorter one, the old track's
//                    tail plays out (the input gated meanwhile), "ev drained" says when, then D.
//   setd D           (tests) the delay becomes D ms now: drop what is buffered, no gate.
//   stat             one line: state, fill, pad, the heard delay, quantum, rate, counters.
//   quit
// Surplus: a pause tail longer than the player's resume lag leaves the delay above D. Once that surplus is
// over a quantum it is taken out of the next silence longer than TRIM_AFTER_MS (never out of sound), so the
// delay lands on D again (Chromium's tail and lag are within ±15 ms of each other: ~6 ms per pause).
// A pause Sonata was never told the end of (the player plays on while frozen for FROZEN_PLAY_MS): resumed.
// Heard delay (`heard_us` in stat): what is buffered at the start of an output cycle plus one quantum to the
// device plus the device's own delay as PipeWire reports it (0 for a null sink). Sonata runs the lyrics clock
// on it, so the clock follows a quantum change.
//
// Safety: the program exits when Sonata closes the socket or dies (PR_SET_PDEATHSIG), and when no
// client connects within 15 s. Its PipeWire objects belong to its connection, so the daemon removes
// them with it: no virtual device is left behind. Sonata's stream then falls back to the default
// device (the session manager relinks it), and Sonata stops shifting its clock.
//
// Licence: Sonata's (GPL-3.0-or-later), our own code. Links libpipewire (MIT).
#define _GNU_SOURCE
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/pod/builder.h>

#define VERSION "1"
#define CH 2
#define MAX_SECONDS 12          // ring capacity: D (≤ 10 s) + pause tail + surplus
#define TAIL_MS 250             // at most this much pause tail is kept (Chromium's: 75–104 ms, measured)
#define RESUME_DROP_SECONDS 2.0 // leading silence dropped at most this long after play/open
#define GATE_TIMEOUT_MS 3000    // a gate the player never opens opens by itself (never stuck silent)
#define OPEN_BREAK_FRAMES 120   // after `open`: the new audio starts after a silence this long (2.5 ms at 48 kHz)
#define OPEN_MAX_MS 250         // ... or this long after `open`, whichever first
#define BOUNDARY_SILENCE_MS 3   // a track boundary is placed in the first silence this long after `track`
#define BOUNDARY_MAX_MS 150     // ... or this long after it (Chromium: the old track's audio ends 0–41 ms after the
                                // item changes, then 45–120 ms of silence before the new one: measured)
#define TRIM_AFTER_MS 200       // surplus is trimmed only from silences longer than this
#define FROZEN_PLAY_MS 600      // non-silent input this long while frozen: the player plays, resume
#define SILENT 1e-7f

static uint64_t mono_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

enum cmd { C_NONE = 0, C_PAUSE, C_PLAY, C_FLUSH, C_TRACK, C_OPEN, C_SETD };
static const char *cmd_name[] = {"none", "pause", "play", "flush", "track", "open", "setd"};

struct command { int type; int64_t arg_ms; uint64_t t; };
#define CMDQ 64
struct event { int type; uint64_t t; int64_t a, b; };
enum ev { E_APPLIED = 1, E_DRAINED, E_GATE_TIMEOUT, E_AUTO_RESUME, E_TRIMMED, E_INPUT_BACK, E_BOUNDARY };
#define EVQ 256

struct app {
  const char *ctl_path, *name, *desc, *log_path;
  struct pw_main_loop *loop;
  struct pw_context *context;
  struct pw_core *core;
  struct pw_stream *in, *out;
  struct spa_hook in_listener, out_listener, core_listener;
  struct spa_source *wake;     // the data thread wakes the main loop for events
  FILE *log;
  int listen_fd, client_fd;
  _Atomic int quit;

  // commands: control thread -> data thread (SPSC)
  struct command cq[CMDQ];
  _Atomic uint32_t cq_w, cq_r;
  // events: data thread -> main loop (SPSC)
  struct event eq[EVQ];
  _Atomic uint32_t eq_w;
  uint32_t eq_r;

  // --- data thread only (both streams' process callbacks run on the same data loop) ---
  uint32_t rate;               // negotiated (0 until the format is known)
  float *ring;                 // interleaved stereo content (never the pad)
  int64_t cap, w, count;       // capacity, write index, content frames
  int64_t pad;                 // silence to play before the content (a flush's delay line)
  int64_t D;                   // requested delay (frames at rate)
  int64_t D_ms;
  int frozen, resuming, gated, draining, opening;
  int64_t open_sil;            // silent frames since `open` (the break before the player's new audio)
  uint64_t open_ns;
  int boundary;                // a `track` waiting for its silence: 1 = add silence, 2 = drain
  int64_t boundary_sil;
  uint64_t boundary_ns;
  int64_t tail, resume_drop, frozen_loud;
  int64_t lag_est, hold;
  int learn;                   // this resume is a play after a pause: learn the player's lag
  int64_t sil_run;             // current run of silent input frames (for the surplus trim)
  int trimming;                // a surplus over one quantum is being trimmed, until none is left
  uint64_t gate_ns;
  uint32_t quantum;            // last cycle's frames
  int need_reset;

  // published for stat (atomics, written by the data thread)
  _Atomic int64_t p_fill, p_out_fill, p_pad, p_count, p_target, p_delay_frames, p_pwdelay;
  _Atomic uint32_t p_rate, p_quantum;
  _Atomic int p_state;
  _Atomic uint64_t underruns, overflows, xruns, trimmed, cycles_in, cycles_out, dropped_gate;
  _Atomic uint64_t p_nsec;
};

static struct app A;

// ---- events (data thread -> main loop) ----
static void push_event(struct app *a, int type, int64_t x, int64_t y) {
  uint32_t i = atomic_load(&a->eq_w);
  struct event *e = &a->eq[i % EVQ];
  e->type = type;
  e->t = mono_ns();
  e->a = x;
  e->b = y;
  atomic_store(&a->eq_w, i + 1);
  if (a->wake) pw_loop_signal_event(pw_main_loop_get_loop(a->loop), a->wake);
}

static inline int silent(const float *f) { return fabsf(f[0]) < SILENT && fabsf(f[1]) < SILENT; }

// Between a frame reaching our input stream and leaving our output stream the graph adds two quanta
// (the input runs after the output in a cycle, and one more cycle to the device; measured in the private
// PipeWire, tools/lookahead-test): a delay of D is D minus those in our own buffer.
static int64_t deff(struct app *a, int64_t D) {
  int64_t d = D - 2 * (int64_t)a->quantum;
  return d < 0 ? 0 : d;
}

static inline int64_t fill(struct app *a) { return a->pad + a->count; }

static void ring_put(struct app *a, const float *f) {
  if (a->count >= a->cap) {   // overflow: drop the oldest frame (never with D ≤ 10 s)
    a->count--;
    atomic_fetch_add(&a->overflows, 1);
  }
  a->ring[CH * a->w] = f[0];
  a->ring[CH * a->w + 1] = f[1];
  a->w = (a->w + 1) % a->cap;
  a->count++;
}

static void ring_clear(struct app *a) { a->count = 0; }

static int state_code(struct app *a) {
  return a->frozen ? 1 : a->gated ? (a->draining ? 4 : 3) : a->resuming ? 2 : 0;
}
static const char *state_name[] = {"run", "frozen", "resuming", "gated", "draining"};

static void apply(struct app *a, struct command *c) {
  int64_t D = c->arg_ms * (int64_t)a->rate / 1000;
  switch (c->type) {
    case C_PAUSE:
      if (!a->frozen) { a->frozen = 1; a->tail = 0; a->frozen_loud = 0; }
      break;
    case C_PLAY:
      if (a->frozen) {
        a->frozen = 0;
        a->resuming = 1;
        a->resume_drop = 0;
        a->learn = 1;
        // The player's audio comes back lag_est later and the ring drains meanwhile: hold our output
        // so the delay lands back on D (a deficit is fixed for free; resume is silent anyway). A
        // surplus (a pause tail longer than the lag) is trimmed later, at a silence (TRIM_AFTER_MS).
        int64_t h = deff(a, a->D) - (fill(a) - a->lag_est);
        a->hold = a->gated ? 0 : (h > 0 ? h : 0);
      }
      break;
    case C_FLUSH:
      ring_clear(a);
      a->D = D; a->D_ms = c->arg_ms;
      a->pad = deff(a, D);
      a->gated = 1; a->draining = 0; a->opening = 0; a->boundary = 0; a->gate_ns = mono_ns();
      a->resuming = 0; a->hold = 0; a->sil_run = 0; a->trimming = 0;
      break;
    case C_TRACK:
      // Chromium plays the old track's last ~40 ms after the item changes and the new one ~80 ms later
      // (measured): the boundary goes in that silence, not at the command
      a->D = D; a->D_ms = c->arg_ms;
      a->boundary = deff(a, D) >= fill(a) ? 1 : 2;
      a->boundary_sil = 0; a->boundary_ns = c->t;
      break;
    case C_OPEN:
      // the player's events come ~100 ms before its audio changes (measured: seeked/playing 0.3–2 ms
      // after the seek, the old audio for ~100 ms more, then a ~4 ms break, then the new audio): the
      // gate opens at that break, or OPEN_MAX_MS after `open`
      if (a->gated && !a->draining) { a->opening = 1; a->open_sil = 0; a->open_ns = c->t; }
      break;
    case C_SETD:
      ring_clear(a);
      a->D = D; a->D_ms = c->arg_ms;
      a->pad = deff(a, D);
      a->gated = 0; a->draining = 0; a->opening = 0; a->boundary = 0; a->resuming = 0; a->hold = 0;
      break;
  }
  push_event(a, E_APPLIED, c->type, fill(a));
}

static void take_commands(struct app *a) {
  uint32_t r = atomic_load(&a->cq_r), w = atomic_load(&a->cq_w);
  for (; r != w; r++) apply(a, &a->cq[r % CMDQ]);  // loop: HOT-PATH-OK — the commands sent since the last cycle (≤ a few)
  atomic_store(&a->cq_r, r);
}

static void publish(struct app *a) {
  atomic_store(&a->p_fill, fill(a));
  atomic_store(&a->p_pad, a->pad);
  atomic_store(&a->p_count, a->count);
  atomic_store(&a->p_target, deff(a, a->D));
  atomic_store(&a->p_state, state_code(a));
  atomic_store(&a->p_quantum, a->quantum);
}

// ---- input: Sonata's stream arrives here ----
static void on_in_process(void *data) {
  struct app *a = data;
  struct pw_buffer *b = pw_stream_dequeue_buffer(a->in);
  if (!b) return;
  atomic_fetch_add(&a->cycles_in, 1);
  struct spa_buffer *sb = b->buffer;
  float *src = sb->datas[0].data;
  uint32_t n = sb->datas[0].chunk ? sb->datas[0].chunk->size / (sizeof(float) * CH) : 0;
  if (a->ring && src) {
    if (n) a->quantum = n;
    if (a->need_reset) { a->pad = deff(a, a->D); a->need_reset = 0; }
    take_commands(a);
    // the surplus: trimmed only once it is over one quantum (Chromium's tail and lag differ by ±15 ms:
    // jitter is never trimmed), and then all of it, so the delay lands on D again
    int64_t surplus = fill(a) - deff(a, a->D);
    if (surplus > (int64_t)a->quantum) a->trimming = 1;
    if (surplus <= 0) a->trimming = 0;
    int64_t trim_room = a->trimming ? surplus : 0;
    for (uint32_t i = 0; i < n; i++) {  // loop: HOT-PATH-OK — one quantum of frames (1024 at 48 kHz)
      const float *f = src + CH * i;
      int s = silent(f);
      a->sil_run = s ? a->sil_run + 1 : 0;
      if (a->boundary) {
        a->boundary_sil = s ? a->boundary_sil + 1 : 0;
        int found = a->boundary_sil >= (int64_t)BOUNDARY_SILENCE_MS * a->rate / 1000;
        if (found || mono_ns() - a->boundary_ns > (uint64_t)BOUNDARY_MAX_MS * 1000000ull) {
          if (a->boundary == 1) {
            // into a longer delay: silence here, so the new track is heard D after it plays (no cut); this
            // frame's place in the cycle counts, as in steady play (frame i of a cycle sits at deff + i)
            float z[CH] = {0, 0};
            int64_t want = deff(a, a->D) + i;
            for (int64_t k = fill(a); k < want; k++) ring_put(a, z);  // loop: NOT-WORTH — once per track change, ≤ D frames
          } else {
            // into a shorter delay: the old track's tail plays out, the new track waits (input gated)
            a->gated = 1; a->draining = 1; a->opening = 0; a->gate_ns = mono_ns();
          }
          a->boundary = 0;
          push_event(a, E_BOUNDARY, found, fill(a));
        }
      }
      if (a->gated) {
        if (a->opening) {
          int late = mono_ns() - a->open_ns > (uint64_t)OPEN_MAX_MS * 1000000ull;
          if (s) a->open_sil++;
          if ((!s && a->open_sil >= OPEN_BREAK_FRAMES) || late) {
            a->gated = 0; a->opening = 0;
            a->resuming = 1; a->resume_drop = 0; a->learn = 0;   // leading silence still dropped
          } else {
            if (!s) a->open_sil = 0;   // still the old audio
            atomic_fetch_add(&a->dropped_gate, 1);
            continue;
          }
        } else { atomic_fetch_add(&a->dropped_gate, 1); continue; }
      }
      if (a->frozen) {
        // keep the player's pause tail; a player that keeps playing means a pause we were never told
        // about the end of: after FROZEN_PLAY_MS of it, resume (never stuck silent)
        if (s) continue;
        if (a->tail < (int64_t)TAIL_MS * a->rate / 1000) { a->tail++; ring_put(a, f); continue; }
        if (++a->frozen_loud < (int64_t)FROZEN_PLAY_MS * a->rate / 1000) continue;
        a->frozen = 0;
        push_event(a, E_AUTO_RESUME, 0, 0);
      }
      if (a->resuming) {
        if (s && a->resume_drop < (int64_t)(RESUME_DROP_SECONDS * a->rate)) { a->resume_drop++; continue; }
        a->resuming = 0;
        if (a->learn) a->lag_est = a->lag_est ? (a->lag_est + a->resume_drop) / 2 : a->resume_drop;
        a->learn = 0;
        push_event(a, E_INPUT_BACK, a->resume_drop, fill(a));
      }
      // the surplus policy: a delay longer than D (a pause tail longer than the player's resume lag)
      // shrinks back inside a silence, never by skipping sound: silences stay at least TRIM_AFTER_MS
      if (s && trim_room > 0 && a->sil_run > (int64_t)TRIM_AFTER_MS * a->rate / 1000) {
        trim_room--;
        atomic_fetch_add(&a->trimmed, 1);
        continue;
      }
      // the first frame into a held line (a flush's pad waiting for audio): its place in this cycle
      // counts, so it is heard exactly D after it came (the frames before it were dropped)
      if (a->count == 0 && a->pad > 0) a->pad += i;
      ring_put(a, f);
    }
    if (a->gated && !a->draining && !a->opening && mono_ns() - a->gate_ns > (uint64_t)GATE_TIMEOUT_MS * 1000000ull) {
      a->gated = 0; a->resuming = 1; a->resume_drop = 0; a->learn = 0;
      push_event(a, E_GATE_TIMEOUT, 0, 0);
    }
    publish(a);
  }
  pw_stream_queue_buffer(a->in, b);
}

// ---- output: what the listener hears ----
static void on_out_process(void *data) {
  struct app *a = data;
  struct pw_buffer *b = pw_stream_dequeue_buffer(a->out);
  if (!b) return;
  atomic_fetch_add(&a->cycles_out, 1);
  struct spa_buffer *sb = b->buffer;
  float *dst = sb->datas[0].data;
  if (!dst) { pw_stream_queue_buffer(a->out, b); return; }
  uint32_t max = sb->datas[0].maxsize / (sizeof(float) * CH);
  uint32_t n = b->requested ? (uint32_t)b->requested : (a->quantum ? a->quantum : 1024);
  if (n > max) n = max;
  if (a->ring) take_commands(a);
  // the heard delay is read here, before this cycle's output: what is buffered + one quantum to the device
  atomic_store(&a->p_out_fill, fill(a));
  uint32_t o = 0;
  if (a->ring && !a->frozen) {
    // the resume hold, sample-exact
    uint32_t h = a->hold > n ? n : (uint32_t)a->hold;
    memset(dst, 0, sizeof(float) * CH * h);
    a->hold -= h;
    o = h;
    // the pad (a flush's silence) runs only while content waits behind it: with nothing to delay
    // yet (a gate, a player still loading) the line holds, so new audio is heard exactly D later
    if (a->pad && a->count) {
      uint32_t p = (uint32_t)(a->pad < n - o ? a->pad : n - o);
      memset(dst + CH * o, 0, sizeof(float) * CH * p);
      a->pad -= p;
      o += p;
    }
    if (!a->pad) {
      int64_t r = (a->w - a->count + a->cap) % a->cap;
      uint32_t have = (uint32_t)(a->count < (int64_t)(n - o) ? a->count : (int64_t)(n - o));
      for (uint32_t i = 0; i < have; i++) {  // loop: HOT-PATH-OK — one quantum of frames
        dst[CH * (o + i)] = a->ring[CH * r];
        dst[CH * (o + i) + 1] = a->ring[CH * r + 1];
        r = (r + 1) % a->cap;
      }
      a->count -= have;
      o += have;
      if (o < n && !a->gated && !a->resuming && a->hold == 0) atomic_fetch_add(&a->underruns, 1);
    }
    if (a->draining && a->count == 0) {
      // the old track's tail has been heard: the new delay waits for the new track's audio
      a->draining = 0;
      a->pad = deff(a, a->D);
      push_event(a, E_DRAINED, 0, 0);
    }
  }
  if (o < n) memset(dst + CH * o, 0, sizeof(float) * CH * (n - o));
  sb->datas[0].chunk->offset = 0;
  sb->datas[0].chunk->stride = sizeof(float) * CH;
  sb->datas[0].chunk->size = n * sizeof(float) * CH;
  struct pw_time t;
  if (pw_stream_get_time_n(a->out, &t, sizeof t) == 0) atomic_store(&a->p_pwdelay, t.delay);
  if (a->ring) publish(a);
  pw_stream_queue_buffer(a->out, b);
}

struct swap { float *ring; int64_t cap; uint32_t rate; };

// runs on the data loop (both process callbacks run there), so the ring never changes under them
static int do_swap(struct spa_loop *loop, bool async, uint32_t seq, const void *data, size_t size, void *user) {
  struct app *a = user;
  struct swap *sw = *(struct swap *const *)data;   // the invoke copies its data: a pointer to ours (blocking call)
  (void)loop; (void)async; (void)seq; (void)size;
  float *old = a->ring;
  a->D = a->D_ms * (int64_t)sw->rate / 1000;
  a->rate = sw->rate;
  a->cap = sw->cap; a->w = 0; a->count = 0; a->pad = 0; a->need_reset = 1;
  a->ring = sw->ring;
  atomic_store(&a->p_rate, sw->rate);
  sw->ring = old;   // handed back, freed off the data thread
  return 0;
}

static void on_in_param_changed(void *data, uint32_t id, const struct spa_pod *param) {
  struct app *a = data;
  if (!param || id != SPA_PARAM_Format) return;
  struct spa_audio_info_raw info = {0};
  if (spa_format_audio_raw_parse(param, &info) < 0 || !info.rate) return;
  if (a->ring && info.rate == a->rate) return;
  // the first format (or a new graph rate): a new ring for MAX_SECONDS at that rate
  struct swap sw = { .cap = (int64_t)MAX_SECONDS * info.rate, .rate = info.rate };
  sw.ring = calloc((size_t)(sw.cap * CH), sizeof(float));  // lifetime: OK — freed on a rate change (below) and at exit
  if (!sw.ring) { fprintf(stderr, "out of memory\n"); exit(1); }
  struct swap *swp = &sw;
  pw_loop_invoke(pw_data_loop_get_loop(pw_context_get_data_loop(a->context)), do_swap, 0, &swp, sizeof swp, true, a);
  free(sw.ring);   // the old ring (NULL the first time)
  if (a->log) { fprintf(a->log, "format rate=%u channels=%u\n", info.rate, info.channels); fflush(a->log); }
}

static void on_state(void *data, enum pw_stream_state old, enum pw_stream_state state, const char *err) {
  struct app *a = data;
  (void)old;
  if (a->log) { fprintf(a->log, "stream state %s%s%s\n", pw_stream_state_as_string(state), err ? " " : "", err ? err : ""); fflush(a->log); }
  if (state == PW_STREAM_STATE_ERROR) pw_main_loop_quit(a->loop);
}

static void on_io_changed(void *data, uint32_t id, void *area, uint32_t size) { (void)data; (void)id; (void)area; (void)size; }

static const struct pw_stream_events in_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = on_state,
    .param_changed = on_in_param_changed,
    .io_changed = on_io_changed,
    .process = on_in_process,
};
static const struct pw_stream_events out_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = on_state,
    .process = on_out_process,
};

static void on_core_error(void *data, uint32_t id, int seq, int res, const char *message) {
  struct app *a = data;
  (void)seq;
  fprintf(stderr, "pipewire error id=%u res=%d: %s\n", id, res, message);
  if (id == PW_ID_CORE && res == -EPIPE) pw_main_loop_quit(a->loop);  // the daemon went away
}
static const struct pw_core_events core_events = { PW_VERSION_CORE_EVENTS, .error = on_core_error };

// ---- control socket (its own thread: blocking reads, replies at once) ----
static void post(struct app *a, int type, int64_t arg_ms) {
  uint32_t w = atomic_load(&a->cq_w);
  if (w - atomic_load(&a->cq_r) >= CMDQ) return;   // 64 commands unapplied: the graph isn't running
  a->cq[w % CMDQ] = (struct command){type, arg_ms, mono_ns()};
  atomic_store(&a->cq_w, w + 1);
}

static pthread_mutex_t write_lock = PTHREAD_MUTEX_INITIALIZER;
static void client_write(struct app *a, const char *line) {
  pthread_mutex_lock(&write_lock);
  int fd = a->client_fd;
  if (fd >= 0) {
    size_t len = strlen(line), off = 0;
    while (off < len) {  // loop: SERIAL-REQUIRED — one socket, a line written whole
      ssize_t k = write(fd, line + off, len - off);
      if (k <= 0) { if (k < 0 && errno == EINTR) continue; break; }
      off += (size_t)k;
    }
  }
  pthread_mutex_unlock(&write_lock);
}

static void stat_line(struct app *a, char *buf, size_t len) {
  uint32_t rate = atomic_load(&a->p_rate), q = atomic_load(&a->p_quantum);
  int64_t f = atomic_load(&a->p_fill), pd = atomic_load(&a->p_pwdelay);
  // heard delay: buffered at the start of an output cycle + one quantum to the device + what the
  // device adds after our output stream (PipeWire's delay; 0 for a null sink)
  int64_t heard = atomic_load(&a->p_out_fill) + q + (pd > 0 ? pd : 0);
  snprintf(buf, len,
           "ok stat version=" VERSION " state=%s rate=%u quantum=%u fill=%lld pad=%lld count=%lld target=%lld "
           "pwdelay=%lld heard_us=%lld underruns=%llu overflows=%llu trimmed=%llu gate_dropped=%llu "
           "cycles_in=%llu cycles_out=%llu t=%llu\n",
           state_name[atomic_load(&a->p_state)], rate, q, (long long)f, (long long)atomic_load(&a->p_pad),
           (long long)atomic_load(&a->p_count), (long long)atomic_load(&a->p_target), (long long)pd,
           rate ? (long long)(heard * 1000000 / rate) : 0LL, (unsigned long long)atomic_load(&a->underruns),
           (unsigned long long)atomic_load(&a->overflows), (unsigned long long)atomic_load(&a->trimmed),
           (unsigned long long)atomic_load(&a->dropped_gate), (unsigned long long)atomic_load(&a->cycles_in),
           (unsigned long long)atomic_load(&a->cycles_out), (unsigned long long)mono_ns());
}

static void *ctl_thread(void *arg) {
  struct app *a = arg;
  int c = a->client_fd;
  FILE *f = fdopen(dup(c), "r");
  char line[256], reply[768];
  while (f && fgets(line, sizeof line, f)) {  // loop: SERIAL-REQUIRED — commands apply in the order sent
    long long v = 0;
    uint64_t t = mono_ns();
    snprintf(reply, sizeof reply, "ok t=%llu\n", (unsigned long long)t);
    if (!strncmp(line, "pause", 5)) post(a, C_PAUSE, 0);
    else if (!strncmp(line, "play", 4)) post(a, C_PLAY, 0);
    else if (!strncmp(line, "open", 4)) post(a, C_OPEN, 0);
    else if (sscanf(line, "flush %lld", &v) == 1 && v >= 0 && v <= 10000) post(a, C_FLUSH, v);
    else if (sscanf(line, "track %lld", &v) == 1 && v >= 0 && v <= 10000) post(a, C_TRACK, v);
    else if (sscanf(line, "setd %lld", &v) == 1 && v >= 0 && v <= 10000) post(a, C_SETD, v);
    else if (!strncmp(line, "stat", 4)) stat_line(a, reply, sizeof reply);
    else if (!strncmp(line, "quit", 4)) { client_write(a, reply); break; }
    else snprintf(reply, sizeof reply, "err unknown\n");
    client_write(a, reply);
  }
  if (f) fclose(f);
  // Sonata closed the socket (or quit, or died): the delay has no one to follow, so it ends, and its
  // virtual sink with it
  atomic_store(&a->quit, 1);
  pw_loop_signal_event(pw_main_loop_get_loop(a->loop), a->wake);
  return NULL;
}

static void *accept_thread(void *arg) {
  struct app *a = arg;
  int c = accept(a->listen_fd, NULL, NULL);
  if (c < 0) { atomic_store(&a->quit, 1); pw_loop_signal_event(pw_main_loop_get_loop(a->loop), a->wake); return NULL; }
  close(a->listen_fd);
  unlink(a->ctl_path);        // one client only: nobody else can connect
  a->listen_fd = -1;
  pthread_mutex_lock(&write_lock);
  a->client_fd = c;
  pthread_mutex_unlock(&write_lock);
  client_write(a, "ev hello version=" VERSION "\n");
  return ctl_thread(a);
}

static void on_wake(void *data, uint64_t count) {
  struct app *a = data;
  (void)count;
  uint32_t w = atomic_load(&a->eq_w);
  char line[256];
  for (; a->eq_r != w; a->eq_r++) {  // loop: NOT-WORTH — the events since the last wake (a few per user action)
    struct event *e = &a->eq[a->eq_r % EVQ];
    const char *what = NULL;
    switch (e->type) {
      case E_DRAINED: what = "drained"; break;
      case E_GATE_TIMEOUT: what = "gate-timeout"; break;
      case E_AUTO_RESUME: what = "auto-resume"; break;
      case E_INPUT_BACK: what = "input-back"; break;
      case E_BOUNDARY: what = "boundary"; break;
      default: break;
    }
    if (a->log) {
      fprintf(a->log, "ev %s t=%llu a=%lld b=%lld\n", e->type == E_APPLIED ? cmd_name[e->a] : (what ? what : "?"),
              (unsigned long long)e->t, (long long)e->a, (long long)e->b);
    }
    if (what) {
      snprintf(line, sizeof line, "ev %s t=%llu a=%lld b=%lld\n", what, (unsigned long long)e->t, (long long)e->a, (long long)e->b);
      client_write(a, line);
    }
  }
  if (a->log) fflush(a->log);
  if (atomic_load(&a->quit)) pw_main_loop_quit(a->loop);
}

static void on_timer(void *data, uint64_t expirations) {
  struct app *a = data;
  (void)expirations;
  if (a->client_fd < 0) {   // nobody connected in time: Sonata isn't there
    fprintf(stderr, "no client within 15 s, quitting\n");
    pw_main_loop_quit(a->loop);
  }
}

static void on_signal(void *data, int sig) {
  struct app *a = data;
  (void)sig;
  pw_main_loop_quit(a->loop);
}

static struct pw_properties *stream_props(struct app *a, int sink) {
  char group[128];
  snprintf(group, sizeof group, "%s", a->name);
  struct pw_properties *p = pw_properties_new(
      PW_KEY_MEDIA_TYPE, "Audio",
      PW_KEY_NODE_GROUP, group,          // one driver for both streams: no drift
      PW_KEY_NODE_LINK_GROUP, group,     // never linked to each other (no loop if made the default)
      NULL);
  if (sink) {
    pw_properties_set(p, PW_KEY_MEDIA_CLASS, "Audio/Sink");
    pw_properties_set(p, PW_KEY_NODE_NAME, a->name);
    pw_properties_set(p, PW_KEY_NODE_DESCRIPTION, a->desc);
    pw_properties_set(p, PW_KEY_NODE_VIRTUAL, "true");
    pw_properties_set(p, PW_KEY_APP_NAME, "Sonata");
    pw_properties_set(p, "audio.position", "[ FL FR ]");
  } else {
    pw_properties_setf(p, PW_KEY_NODE_NAME, "%s-out", a->name);
    pw_properties_set(p, PW_KEY_NODE_DESCRIPTION, a->desc);
    pw_properties_set(p, PW_KEY_MEDIA_CATEGORY, "Playback");
    // its own name (the session manager keys remembered settings by media.role, else application.name:
    // never Sonata's stream's key, never a role other players share), and never moved by a remembered
    // target: it always goes to the default device
    pw_properties_set(p, PW_KEY_APP_NAME, a->desc);
    pw_properties_set(p, "state.restore-target", "false");
    pw_properties_set(p, PW_KEY_STREAM_DONT_REMIX, "true");
    pw_properties_set(p, "audio.position", "[ FL FR ]");
  }
  return p;
}

static int connect_stream(struct pw_stream *s, enum pw_direction dir) {
  uint8_t buffer[1024];
  struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof buffer);
  // F32 stereo at the graph's rate (no rate given: the adapter takes the graph's)
  struct spa_audio_info_raw info = SPA_AUDIO_INFO_RAW_INIT(.format = SPA_AUDIO_FORMAT_F32, .channels = CH);
  info.position[0] = SPA_AUDIO_CHANNEL_FL;
  info.position[1] = SPA_AUDIO_CHANNEL_FR;
  const struct spa_pod *params[1];
  params[0] = spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat, &info);
  return pw_stream_connect(s, dir, PW_ID_ANY,
                           PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_RT_PROCESS,
                           params, 1);
}

int main(int argc, char **argv) {
  struct app *a = &A;
  a->name = "sonata-lookahead";
  a->desc = "Sonata look-ahead";
  a->client_fd = -1;
  a->listen_fd = -1;
  a->D_ms = 3000;
  for (int i = 1; i + 1 < argc; i += 2) {  // loop: NOT-WORTH — argv, startup only
    if (!strcmp(argv[i], "--ctl")) a->ctl_path = argv[i + 1];
    else if (!strcmp(argv[i], "--name")) a->name = argv[i + 1];
    else if (!strcmp(argv[i], "--description")) a->desc = argv[i + 1];
    else if (!strcmp(argv[i], "--log")) a->log_path = argv[i + 1];
    else if (!strcmp(argv[i], "--delay-ms")) a->D_ms = atoll(argv[i + 1]);
  }
  if (argc == 2 && !strcmp(argv[1], "--version")) { printf("sonata-lookahead " VERSION "\n"); return 0; }
  if (!a->ctl_path || a->D_ms < 0 || a->D_ms > 10000) {
    fprintf(stderr, "usage: sonata-lookahead --ctl SOCKET [--delay-ms 0..10000] [--name N] [--description T] [--log F]\n");
    return 2;
  }
  // dies with Sonata, even when Sonata is killed
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  if (getppid() == 1) return 1;
  signal(SIGPIPE, SIG_IGN);
  if (a->log_path) a->log = fopen(a->log_path, "w");

  // the control socket first: Sonata connects as soon as it exists
  struct sockaddr_un sa = {.sun_family = AF_UNIX};
  if (strlen(a->ctl_path) >= sizeof sa.sun_path) { fprintf(stderr, "socket path too long\n"); return 2; }
  strcpy(sa.sun_path, a->ctl_path);
  unlink(a->ctl_path);
  a->listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (a->listen_fd < 0 || bind(a->listen_fd, (void *)&sa, sizeof sa) < 0 || listen(a->listen_fd, 1) < 0) {
    perror("control socket");
    return 1;
  }

  pw_init(&argc, &argv);
  a->loop = pw_main_loop_new(NULL);
  struct pw_loop *l = pw_main_loop_get_loop(a->loop);
  pw_loop_add_signal(l, SIGINT, on_signal, a);
  pw_loop_add_signal(l, SIGTERM, on_signal, a);
  a->wake = pw_loop_add_event(l, on_wake, a);
  a->context = pw_context_new(l, NULL, 0);
  a->core = a->context ? pw_context_connect(a->context, NULL, 0) : NULL;
  if (!a->core) { fprintf(stderr, "can't connect to PipeWire\n"); unlink(a->ctl_path); return 3; }
  pw_core_add_listener(a->core, &a->core_listener, &core_events, a);

  a->in = pw_stream_new(a->core, "sonata-lookahead-in", stream_props(a, 1));
  a->out = pw_stream_new(a->core, "sonata-lookahead-out", stream_props(a, 0));
  pw_stream_add_listener(a->in, &a->in_listener, &in_events, a);
  pw_stream_add_listener(a->out, &a->out_listener, &out_events, a);
  if (connect_stream(a->in, PW_DIRECTION_INPUT) < 0 || connect_stream(a->out, PW_DIRECTION_OUTPUT) < 0) {
    fprintf(stderr, "can't connect the streams\n");
    unlink(a->ctl_path);
    return 3;
  }

  pthread_t at;
  pthread_create(&at, NULL, accept_thread, a);
  pthread_detach(at);
  struct spa_source *timer = pw_loop_add_timer(l, on_timer, a);
  struct timespec once = {15, 0}, none = {0, 0};
  pw_loop_update_timer(l, timer, &once, &none, false);
  // ready: Sonata waits for this line before it connects and moves its stream
  printf("ready %s\n", a->name);
  fflush(stdout);

  pw_main_loop_run(a->loop);

  if (a->listen_fd >= 0) { close(a->listen_fd); unlink(a->ctl_path); }
  pw_stream_destroy(a->in);
  pw_stream_destroy(a->out);
  pw_core_disconnect(a->core);
  pw_context_destroy(a->context);
  pw_main_loop_destroy(a->loop);
  pw_deinit();
  free(a->ring);
  if (a->log) fclose(a->log);
  return 0;
}
