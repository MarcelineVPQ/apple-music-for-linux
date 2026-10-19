// Test parts for the look-ahead delay (tools/lookahead-test/README.md). Private PipeWire only.
//
//   la-test player --ctl SOCK [--name N] [--log FILE]
//       a stand-in for Sonata's Chromium stream: a pw_stream (Stream/Output/Audio) the session manager
//       links to the default sink, as it links Chromium's. Two channels:
//         left:  a 440 Hz tone at -12 dBFS with a click every 0.5 s
//         right: a sample counter, ((n mod 2^23) + 2^23) / 2^24, exact in float32 and never 0, so every
//                frame that reaches the speakers names the sample it came from
//       Control (one line each): pause TAIL_MS (audio goes on TAIL_MS, then silence: the player's own
//       pause tail), play LAG_MS (silence LAG_MS more, then audio: its resume lag), seek MS (the counter
//       jumps), recreate (the stream is destroyed and made again: a new sink input, as Chromium does after
//       a long pause), stat, quit.
//   la-test rec --out PREFIX [--chans N] [--name N]
//       the probe: a pw_filter with N input ports (linked by pw-link) that records every frame plus each
//       cycle's CLOCK_MONOTONIC time, to PREFIX.f32 / PREFIX.cycles (from the prototype's laproto rec).
#define _GNU_SOURCE
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <pipewire/filter.h>
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/pod/builder.h>

#define RATE 48000
#define MAXPORTS 8

static uint64_t mono_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

enum { C_NONE, C_PAUSE, C_PLAY, C_SEEK, C_RECREATE };
struct app {
  int player;
  const char *name, *ctl, *out_prefix, *log_path;
  struct pw_main_loop *loop;
  struct pw_context *ctx;
  struct pw_core *core;
  struct pw_stream *stream;
  struct spa_hook sl;
  struct pw_filter *filter;
  void *in[MAXPORTS];
  int n_in;
  FILE *log;
  // player (data thread)
  uint64_t n;
  int playing;
  int64_t countdown;     // frames until the pending pause/play takes effect
  int pending;           // C_PAUSE / C_PLAY waiting for its countdown
  int seeking;
  int64_t seek_to, seek_count, seek_gap, seek_tail_ms, seek_gap_ms;
  struct pcmd { int cmd; int64_t arg, tail, gap; uint64_t t; } q[64];
  _Atomic uint32_t qw, qr;
  _Atomic uint64_t frames_out;
  struct spa_source *recreate_ev;
  // recorder
  float *rbuf;
  int64_t rcap;
  _Atomic int64_t rw, rr;
  struct cyc { uint64_t frame, nsec, pos; uint32_t n, flags; } *cbuf;
  int64_t ccap;
  _Atomic int64_t cw, cr;
  _Atomic uint64_t rec_frames, rec_drops;
  _Atomic int quit;
};
static struct app A;

static void logf_(struct app *a, const char *what, int64_t arg, uint64_t t_cmd) {
  if (!a->log) return;
  fprintf(a->log, "%s arg=%lld t_cmd=%llu t_applied=%llu n=%llu\n", what, (long long)arg, (unsigned long long)t_cmd,
          (unsigned long long)mono_ns(), (unsigned long long)a->n);
  fflush(a->log);
}

// ---- player ----
static void on_player_process(void *data) {
  struct app *a = data;
  struct pw_buffer *b = pw_stream_dequeue_buffer(a->stream);
  if (!b) return;
  struct spa_buffer *sb = b->buffer;
  float *d = sb->datas[0].data;
  if (!d) { pw_stream_queue_buffer(a->stream, b); return; }
  uint32_t n = b->requested ? (uint32_t)b->requested : 1024;
  uint32_t max = sb->datas[0].maxsize / (2 * sizeof(float));
  if (n > max) n = max;
  uint32_t qr = atomic_load(&a->qr), qw = atomic_load(&a->qw);
  for (; qr != qw; qr++) {  // loop: HOT-PATH-OK — the commands since the last cycle (test tool)
    struct pcmd *pc = &a->q[qr % 64];
    int c = pc->cmd;
    int64_t arg = pc->arg;
    uint64_t t = pc->t;
    a->seek_tail_ms = pc->tail; a->seek_gap_ms = pc->gap;
    if (c == C_PAUSE || c == C_PLAY) { a->pending = c; a->countdown = arg * RATE / 1000; }
    if (c == C_SEEK) {
      // like Chromium (measured): the old audio goes on ~100 ms, a ~4 ms break, then the new position
      a->seek_to = (int64_t)a->n + arg * RATE / 1000;
      a->seek_count = a->seek_tail_ms * RATE / 1000;
      a->seek_gap = a->seek_gap_ms * RATE / 1000;
      a->seeking = 1;
    }
    logf_(a, c == C_PAUSE ? "pause" : c == C_PLAY ? "play" : "seek", arg, t);
  }
  atomic_store(&a->qr, qr);
  for (uint32_t i = 0; i < n; i++) {  // loop: HOT-PATH-OK — one quantum (test tool)
    if (a->pending) {
      if (a->countdown-- <= 0) { a->playing = a->pending == C_PLAY; a->pending = 0; }
    }
    if (a->seeking) {
      if (a->seek_count > 0) a->seek_count--;
      else if (a->seek_gap > 0) { a->seek_gap--; d[2 * i] = d[2 * i + 1] = 0.0f; continue; }
      else { a->n = (uint64_t)a->seek_to; a->seeking = 0; logf_(a, "seeked", 0, 0); }
    }
    if (!a->playing) { d[2 * i] = d[2 * i + 1] = 0.0f; continue; }
    uint64_t k = a->n++;
    float s = 0.25f * sinf((float)(2.0 * M_PI * 440.0 * (double)(k % RATE) / RATE));
    if (k % (RATE / 2) == 0) s += 0.65f;
    d[2 * i] = s;
    d[2 * i + 1] = (float)((k & ((1u << 23) - 1)) + (1u << 23)) * (1.0f / 16777216.0f);
  }
  atomic_fetch_add(&a->frames_out, n);
  sb->datas[0].chunk->offset = 0;
  sb->datas[0].chunk->stride = 2 * sizeof(float);
  sb->datas[0].chunk->size = n * 2 * sizeof(float);
  pw_stream_queue_buffer(a->stream, b);
}

static const struct pw_stream_events player_events = { PW_VERSION_STREAM_EVENTS, .process = on_player_process };

static void make_stream(struct app *a) {
  // like Chromium's stream (measured): no media.role, so the session manager keys it by application.name
  struct pw_properties *p = pw_properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Playback",
                                              PW_KEY_NODE_NAME, a->name, PW_KEY_APP_NAME, "la-test-player", NULL);
  a->stream = pw_stream_new(a->core, a->name, p);
  pw_stream_add_listener(a->stream, &a->sl, &player_events, a);
  uint8_t buf[1024];
  struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof buf);
  struct spa_audio_info_raw info = SPA_AUDIO_INFO_RAW_INIT(.format = SPA_AUDIO_FORMAT_F32, .channels = 2, .rate = RATE);
  info.position[0] = SPA_AUDIO_CHANNEL_FL;
  info.position[1] = SPA_AUDIO_CHANNEL_FR;
  const struct spa_pod *params[1] = { spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat, &info) };
  pw_stream_connect(a->stream, PW_DIRECTION_OUTPUT, PW_ID_ANY,
                    PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_RT_PROCESS, params, 1);
}

static void on_recreate(void *data, uint64_t count) {
  struct app *a = data;
  (void)count;
  spa_hook_remove(&a->sl);
  pw_stream_destroy(a->stream);
  make_stream(a);
  logf_(a, "recreated", 0, 0);
}

static void *ctl_thread(void *arg) {
  struct app *a = arg;
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un sa = {.sun_family = AF_UNIX};
  snprintf(sa.sun_path, sizeof sa.sun_path, "%s", a->ctl);
  unlink(a->ctl);
  if (bind(s, (void *)&sa, sizeof sa) < 0 || listen(s, 4) < 0) { perror("ctl"); exit(1); }
  for (;;) {  // loop: SERIAL-REQUIRED — one client at a time (test tool)
    int c = accept(s, NULL, NULL);
    if (c < 0) continue;
    FILE *f = fdopen(c, "r+");
    char line[256];
    while (fgets(line, sizeof line, f)) {  // loop: SERIAL-REQUIRED — commands in order
      long long v = 0, tl = 100, gp = 4;
      uint64_t t = mono_ns();
      int cmd = C_NONE;
      if (sscanf(line, "pause %lld", &v) == 1) cmd = C_PAUSE;
      else if (sscanf(line, "play %lld", &v) == 1) cmd = C_PLAY;
      else if (sscanf(line, "seek %lld", &v) == 1) {
        sscanf(line, "seek %*s %lld %lld", &tl, &gp);
        cmd = C_SEEK;
      }
      else if (!strncmp(line, "recreate", 8)) { pw_loop_signal_event(pw_main_loop_get_loop(a->loop), a->recreate_ev); }
      else if (!strncmp(line, "quit", 4)) { atomic_store(&a->quit, 1); pw_main_loop_quit(a->loop); }
      if (cmd != C_NONE) {
        uint32_t w = atomic_load(&a->qw);
        a->q[w % 64] = (struct pcmd){cmd, v, tl, gp, t};
        atomic_store(&a->qw, w + 1);
      }
      fprintf(f, "ok t=%llu frames=%llu\n", (unsigned long long)t, (unsigned long long)atomic_load(&a->frames_out));
      fflush(f);
    }
    fclose(f);
  }
  return NULL;
}

// ---- recorder ----
static void on_rec_process(void *data, struct spa_io_position *p) {
  struct app *a = data;
  uint32_t n = p ? p->clock.duration : 1024;
  float *in[MAXPORTS];
  for (int c = 0; c < a->n_in; c++) in[c] = pw_filter_get_dsp_buffer(a->in[c], n);  // loop: HOT-PATH-OK — ≤ 8 ports
  int64_t w = atomic_load(&a->rw), r = atomic_load(&a->rr);
  uint64_t frame0 = atomic_load(&a->rec_frames);
  if (a->rcap - (w - r) < n) atomic_fetch_add(&a->rec_drops, n);
  else {
    for (uint32_t i = 0; i < n; i++)  // loop: HOT-PATH-OK — one quantum x channels (test tool)
      for (int c = 0; c < a->n_in; c++) a->rbuf[((w + i) % a->rcap) * a->n_in + c] = in[c] ? in[c][i] : 0.0f;
    atomic_store(&a->rw, w + n);
  }
  atomic_store(&a->rec_frames, frame0 + n);
  int64_t cw = atomic_load(&a->cw);
  if (a->ccap - (cw - atomic_load(&a->cr)) > 0) {
    struct cyc *y = &a->cbuf[cw % a->ccap];
    y->frame = frame0;
    y->nsec = p ? p->clock.nsec : 0;
    y->pos = p ? p->clock.position : 0;
    y->n = n;
    y->flags = p ? p->clock.flags : 0;
    atomic_store(&a->cw, cw + 1);
  }
}
static const struct pw_filter_events rec_events = { PW_VERSION_FILTER_EVENTS, .process = on_rec_process };

static void *writer_thread(void *arg) {
  struct app *a = arg;
  char path[1024];
  snprintf(path, sizeof path, "%s.f32", a->out_prefix);
  FILE *fa = fopen(path, "wb");
  snprintf(path, sizeof path, "%s.cycles", a->out_prefix);
  FILE *fc = fopen(path, "wb");
  if (!fa || !fc) { perror("rec out"); exit(1); }
  for (;;) {  // loop: SERIAL-REQUIRED — drains the RT ring in order; 20 ms sleep when empty
    int64_t w = atomic_load(&a->rw), r = atomic_load(&a->rr), cw = atomic_load(&a->cw), cr = atomic_load(&a->cr);
    if (w == r && cw == cr) { if (atomic_load(&a->quit)) break; usleep(20000); continue; }
    while (r < w) {  // loop: SERIAL-REQUIRED — contiguous chunks in order
      int64_t off = r % a->rcap, len = w - r;
      if (off + len > a->rcap) len = a->rcap - off;
      fwrite(a->rbuf + off * a->n_in, sizeof(float) * a->n_in, (size_t)len, fa);
      r += len;
    }
    atomic_store(&a->rr, r);
    for (; cr < cw; cr++) fwrite(&a->cbuf[cr % a->ccap], sizeof(struct cyc), 1, fc);  // loop: SERIAL-REQUIRED — in order
    atomic_store(&a->cr, cr);
  }
  fclose(fa);
  fclose(fc);
  return NULL;
}

static void on_signal(void *data, int sig) { struct app *a = data; (void)sig; atomic_store(&a->quit, 1); pw_main_loop_quit(a->loop); }

int main(int argc, char **argv) {
  struct app *a = &A;
  if (argc < 2) { fprintf(stderr, "usage: la-test player|rec ...\n"); return 2; }
  a->player = !strcmp(argv[1], "player");
  a->name = a->player ? "la-player" : "probe";
  int chans = 4;
  for (int i = 2; i + 1 < argc; i += 2) {  // loop: NOT-WORTH — argv
    if (!strcmp(argv[i], "--name")) a->name = argv[i + 1];
    else if (!strcmp(argv[i], "--ctl")) a->ctl = argv[i + 1];
    else if (!strcmp(argv[i], "--out")) a->out_prefix = argv[i + 1];
    else if (!strcmp(argv[i], "--log")) a->log_path = argv[i + 1];
    else if (!strcmp(argv[i], "--chans")) chans = atoi(argv[i + 1]);
  }
  if (a->log_path) a->log = fopen(a->log_path, "w");
  pw_init(&argc, &argv);
  a->loop = pw_main_loop_new(NULL);
  struct pw_loop *l = pw_main_loop_get_loop(a->loop);
  pw_loop_add_signal(l, SIGINT, on_signal, a);
  pw_loop_add_signal(l, SIGTERM, on_signal, a);
  a->ctx = pw_context_new(l, NULL, 0);
  a->core = pw_context_connect(a->ctx, NULL, 0);
  if (!a->core) { fprintf(stderr, "no pipewire\n"); return 1; }
  if (a->player) {
    a->playing = 1;
    a->recreate_ev = pw_loop_add_event(l, on_recreate, a);
    make_stream(a);
    pthread_t t;
    pthread_create(&t, NULL, ctl_thread, a);
    pthread_detach(t);
  } else {
    a->n_in = chans;
    a->filter = pw_filter_new_simple(l, a->name,
        pw_properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Filter", PW_KEY_MEDIA_ROLE, "DSP",
                          PW_KEY_NODE_NAME, a->name, PW_KEY_NODE_ALWAYS_PROCESS, "true", NULL), &rec_events, a);
    for (int i = 0; i < chans; i++) {  // loop: NOT-WORTH — ≤ 8 ports, startup
      char pn[32];
      snprintf(pn, sizeof pn, "in_%d", i + 1);
      a->in[i] = pw_filter_add_port(a->filter, PW_DIRECTION_INPUT, PW_FILTER_PORT_FLAG_MAP_BUFFERS, 0,
                                    pw_properties_new(PW_KEY_FORMAT_DSP, "32 bit float mono audio", PW_KEY_PORT_NAME, pn, NULL), NULL, 0);
    }
    a->rcap = 8 * RATE;
    a->rbuf = calloc((size_t)(a->rcap * a->n_in), sizeof(float));
    a->ccap = 8192;
    a->cbuf = calloc((size_t)a->ccap, sizeof(struct cyc));
    pthread_t wt;
    pthread_create(&wt, NULL, writer_thread, a);
    if (pw_filter_connect(a->filter, PW_FILTER_FLAG_RT_PROCESS, NULL, 0) < 0) { fprintf(stderr, "rec connect\n"); return 1; }
    pw_main_loop_run(a->loop);
    atomic_store(&a->quit, 1);
    pthread_join(wt, NULL);
    pw_filter_destroy(a->filter);
    pw_core_disconnect(a->core);
    return 0;
  }
  pw_main_loop_run(a->loop);
  pw_stream_destroy(a->stream);
  pw_core_disconnect(a->core);
  return 0;
}
