// forge-native: the desktop app's low-latency rig engine.
//
// Runs a forge-dsp Chain (the rig graph from the rig editor) inside a JACK process callback.
// JACK is loaded with dlopen, so the addon loads (and reports why) even when JACK or
// PipeWire's JACK library is missing. On Nobara/Fedora PipeWire provides libjack, so this works
// out of the box, and the ports show up in Helvum, qpwgraph or any patchbay for routing.
//
// Audio thread rules: the process callback never allocates, locks or calls into JS. Graphs
// (with their models and IRs) are built on the JS thread and handed to the Chain, which
// crossfades them in; parameter changes go through the Chain's lock-free queue; MIDI input is
// copied into a ring the JS thread drains.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <string>
#include <thread>
#include <vector>

#include <node_api.h>

#include "chain.h"
#include "convolver.h"
#include "nam.h"
#include "player.h"

using namespace forge;

// ------------------------------------------------------------------ minimal JACK API (dlopen)
typedef struct _jack_client jack_client_t;
typedef struct _jack_port jack_port_t;
typedef uint32_t jack_nframes_t;
typedef unsigned char jack_midi_data_t;
struct jack_midi_event_t { jack_nframes_t time; size_t size; jack_midi_data_t* buffer; };
typedef int (*JackProcessCallback)(jack_nframes_t, void*);
typedef int (*JackXRunCallback)(void*);
typedef void (*JackShutdownCallback)(void*);
struct jack_latency_range_t { jack_nframes_t min, max; };
enum { JackPortIsInput = 0x1, JackPortIsOutput = 0x2, JackPortIsPhysical = 0x4 };
enum { JackNoStartServer = 0x01 };
enum { JackCaptureLatency = 0, JackPlaybackLatency = 1 };
static const char* AUDIO_TYPE = "32 bit float mono audio";
static const char* MIDI_TYPE = "8 bit raw midi";

struct Jack {
  void* lib = nullptr;
  jack_client_t* (*client_open)(const char*, int, int*, ...) = nullptr;
  int (*client_close)(jack_client_t*) = nullptr;
  jack_port_t* (*port_register)(jack_client_t*, const char*, const char*, unsigned long, unsigned long) = nullptr;
  int (*set_process_callback)(jack_client_t*, JackProcessCallback, void*) = nullptr;
  int (*set_xrun_callback)(jack_client_t*, JackXRunCallback, void*) = nullptr;
  void (*on_shutdown)(jack_client_t*, JackShutdownCallback, void*) = nullptr;
  int (*activate)(jack_client_t*) = nullptr;
  int (*deactivate)(jack_client_t*) = nullptr;
  void* (*port_get_buffer)(jack_port_t*, jack_nframes_t) = nullptr;
  jack_nframes_t (*get_sample_rate)(jack_client_t*) = nullptr;
  jack_nframes_t (*get_buffer_size)(jack_client_t*) = nullptr;
  const char** (*get_ports)(jack_client_t*, const char*, const char*, unsigned long) = nullptr;
  int (*connect)(jack_client_t*, const char*, const char*) = nullptr;
  int (*disconnect)(jack_client_t*, const char*, const char*) = nullptr;
  const char* (*port_name)(const jack_port_t*) = nullptr;
  const char** (*port_get_connections)(const jack_port_t*) = nullptr;
  jack_port_t* (*port_by_name)(jack_client_t*, const char*) = nullptr;
  int (*port_flags)(const jack_port_t*) = nullptr;
  void (*free_)(void*) = nullptr;
  void (*port_get_latency_range)(jack_port_t*, int, jack_latency_range_t*) = nullptr;
  float (*cpu_load)(jack_client_t*) = nullptr;
  uint32_t (*midi_get_event_count)(void*) = nullptr;
  int (*midi_event_get)(jack_midi_event_t*, void*, uint32_t) = nullptr;
  std::string error;

  bool load() {
    if (lib) return true;
    const char* names[] = { "libjack.so.0", "libjack.so", "/usr/lib64/pipewire-0.3/jack/libjack.so.0", "/usr/lib/x86_64-linux-gnu/pipewire-0.3/jack/libjack.so.0" };
    for (const char* n : names) if ((lib = dlopen(n, RTLD_NOW | RTLD_LOCAL))) break;
    if (!lib) { error = "JACK is not installed. On Nobara/Fedora install pipewire-jack-audio-connection-kit; on Debian/Ubuntu install pipewire-jack or jackd2."; return false; }
#define SYM(field, name) field = reinterpret_cast<decltype(field)>(dlsym(lib, name)); if (!field) { error = std::string("libjack is missing ") + name; dlclose(lib); lib = nullptr; return false; }
    SYM(client_open, "jack_client_open") SYM(client_close, "jack_client_close") SYM(port_register, "jack_port_register")
    SYM(set_process_callback, "jack_set_process_callback") SYM(set_xrun_callback, "jack_set_xrun_callback") SYM(on_shutdown, "jack_on_shutdown")
    SYM(activate, "jack_activate") SYM(deactivate, "jack_deactivate") SYM(port_get_buffer, "jack_port_get_buffer")
    SYM(get_sample_rate, "jack_get_sample_rate") SYM(get_buffer_size, "jack_get_buffer_size") SYM(get_ports, "jack_get_ports")
    SYM(connect, "jack_connect") SYM(disconnect, "jack_disconnect") SYM(port_name, "jack_port_name") SYM(free_, "jack_free")
    SYM(port_get_connections, "jack_port_get_connections") SYM(port_by_name, "jack_port_by_name") SYM(port_flags, "jack_port_flags")
    SYM(port_get_latency_range, "jack_port_get_latency_range") SYM(cpu_load, "jack_cpu_load")
    SYM(midi_get_event_count, "jack_midi_get_event_count") SYM(midi_event_get, "jack_midi_event_get")
#undef SYM
    return true;
  }
};

static Jack J;

// ------------------------------------------------------------------ engine state
struct Engine {
  jack_client_t* client = nullptr;
  jack_port_t* in = nullptr;
  jack_port_t* outL = nullptr;
  jack_port_t* outR = nullptr;
  jack_port_t* midiIn = nullptr;
  jack_port_t* phL = nullptr;
  jack_port_t* phR = nullptr;
  Chain* chain = nullptr;
  // the song plays in the same callback as the rig: one clock, nothing drifts
  Player* player = nullptr;
  float *rigL = nullptr, *rigR = nullptr, *songL = nullptr, *songR = nullptr;
  // bus gains: 0 main song, 1 main rig, 2 phones song, 3 phones rig (targets; ramped per block)
  std::atomic<float> bus[4] = { 1.f, 1.f, 1.f, 1.f };
  float busCur[4] = { 1.f, 1.f, 1.f, 1.f };
  int maxFrames = 8192;

  // recording ring: DI (before the rig), rig L/R and song L/R, filled while armed
  static constexpr int kRecFrames = 48000 * 8;
  static constexpr int kRecCh = 5;
  float* rec = nullptr; // kRecFrames * kRecCh, interleaved
  std::atomic<bool> recArmed{ false };
  std::atomic<uint64_t> recHead{ 0 }, recTail{ 0 };
  std::atomic<uint32_t> recDropped{ 0 };
  // one mark per callback: engine frame of the block start, song position, playing
  static constexpr int kMarks = 4096;
  struct Mark { uint64_t frame; double song; float rate; int playing; };
  Mark marks[kMarks];
  std::atomic<uint64_t> markHead{ 0 }, markTail{ 0 };
  uint64_t frameCounter = 0;
  std::atomic<float> songRate{ 1.f };
  float sampleRate = 48000;
  int bufferSize = 0;
  std::string name;

  std::atomic<float> load{ 0 };
  std::atomic<uint32_t> xruns{ 0 };
  std::atomic<bool> shutdown{ false };

  // MIDI ring: 3 bytes per message, audio thread writes, JS thread reads
  static constexpr int kMidi = 1024;
  uint8_t midi[kMidi][3] = {};
  std::atomic<uint32_t> midiHead{ 0 }, midiTail{ 0 };

  // latency measurement: 0 idle, 1 send impulse, 2 listening, 3 done, 4 timed out
  std::atomic<int> latState{ 0 };
  std::atomic<int64_t> latFrames{ -1 };
  int64_t latCounter = 0;
};

static Engine* E = nullptr;

static int process(jack_nframes_t n, void* arg) {
  Engine* e = static_cast<Engine*>(arg);
  float* in = static_cast<float*>(J.port_get_buffer(e->in, n));
  float* L = static_cast<float*>(J.port_get_buffer(e->outL, n));
  float* R = static_cast<float*>(J.port_get_buffer(e->outR, n));

  if (e->midiIn) {
    void* mb = J.port_get_buffer(e->midiIn, n);
    const uint32_t count = J.midi_get_event_count(mb);
    for (uint32_t i = 0; i < count; i++) {
      jack_midi_event_t ev;
      if (J.midi_event_get(&ev, mb, i) != 0 || ev.size < 2 || ev.size > 3) continue;
      const uint32_t h = e->midiHead.load(std::memory_order_relaxed);
      if (h - e->midiTail.load(std::memory_order_acquire) >= (uint32_t)Engine::kMidi) break;
      uint8_t* m = e->midi[h % Engine::kMidi];
      m[0] = ev.buffer[0]; m[1] = ev.buffer[1]; m[2] = ev.size > 2 ? ev.buffer[2] : 0;
      e->midiHead.store(h + 1, std::memory_order_release);
    }
  }

  // latency test: impulse out, wait for it to come back in
  const int ls = e->latState.load(std::memory_order_acquire);
  if (ls == 1 || ls == 2) {
    for (jack_nframes_t i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
    if (e->phL && e->phR) { float* a = static_cast<float*>(J.port_get_buffer(e->phL, n)); float* b = static_cast<float*>(J.port_get_buffer(e->phR, n)); for (jack_nframes_t i = 0; i < n; i++) a[i] = b[i] = 0; }
    if (ls == 1) { L[0] = R[0] = 0.8f; e->latCounter = 0; e->latState.store(2, std::memory_order_release); }
    for (jack_nframes_t i = 0; i < n; i++) {
      if (std::fabs(in[i]) > 0.25f && (ls == 2 || i > 0)) {
        e->latFrames.store(e->latCounter + i, std::memory_order_release);
        e->latState.store(3, std::memory_order_release);
        break;
      }
    }
    e->latCounter += n;
    if (e->latState.load(std::memory_order_acquire) == 2 && e->latCounter > (int64_t)e->sampleRate) e->latState.store(4, std::memory_order_release);
    return 0;
  }

  const auto t0 = std::chrono::steady_clock::now();
  float* pL = e->phL ? static_cast<float*>(J.port_get_buffer(e->phL, n)) : nullptr;
  float* pR = e->phR ? static_cast<float*>(J.port_get_buffer(e->phR, n)) : nullptr;
  const int frames = std::min((int)n, e->maxFrames);
  const double songPos = e->player->heardFrames();
  const bool songPlaying = e->player->playing();
  e->chain->process(in, e->rigL, e->rigR, frames);
  e->player->render(e->songL, e->songR, frames);
  // buses: main and headphones each get their own song and rig levels (ramped, no zipper)
  float g0[4], d[4];
  for (int k = 0; k < 4; k++) { const float t = e->bus[k].load(std::memory_order_relaxed); g0[k] = e->busCur[k]; d[k] = (t - g0[k]) / frames; e->busCur[k] = t; }
  for (int i = 0; i < frames; i++) {
    const float ms = g0[0] + d[0] * i, mr = g0[1] + d[1] * i;
    L[i] = e->songL[i] * ms + e->rigL[i] * mr;
    R[i] = e->songR[i] * ms + e->rigR[i] * mr;
    if (pL && pR) {
      const float hs = g0[2] + d[2] * i, hr = g0[3] + d[3] * i;
      pL[i] = e->songL[i] * hs + e->rigL[i] * hr;
      pR[i] = e->songR[i] * hs + e->rigR[i] * hr;
    }
  }
  for (int i = frames; i < (int)n; i++) { L[i] = R[i] = 0; if (pL && pR) pL[i] = pR[i] = 0; }
  if (e->recArmed.load(std::memory_order_acquire)) {
    const uint64_t h = e->recHead.load(std::memory_order_relaxed);
    if (h + frames - e->recTail.load(std::memory_order_acquire) > (uint64_t)Engine::kRecFrames) e->recDropped.fetch_add(frames, std::memory_order_relaxed);
    else {
      for (int i = 0; i < frames; i++) {
        float* f = e->rec + ((h + i) % Engine::kRecFrames) * Engine::kRecCh;
        f[0] = in[i]; f[1] = e->rigL[i]; f[2] = e->rigR[i]; f[3] = e->songL[i]; f[4] = e->songR[i];
      }
      e->recHead.store(h + frames, std::memory_order_release);
    }
  }
  {
    const uint64_t mh = e->markHead.load(std::memory_order_relaxed);
    if (mh - e->markTail.load(std::memory_order_acquire) < (uint64_t)Engine::kMarks) {
      e->marks[mh % Engine::kMarks] = Engine::Mark{ e->frameCounter, songPos, e->songRate.load(std::memory_order_relaxed), songPlaying ? 1 : 0 };
      e->markHead.store(mh + 1, std::memory_order_release);
    }
  }
  e->frameCounter += n;
  const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  const float l = (float)(dt / (n / e->sampleRate));
  e->load.store(std::max(l, e->load.load(std::memory_order_relaxed) * 0.97f), std::memory_order_relaxed);
  return 0;
}

static int onXrun(void* arg) { static_cast<Engine*>(arg)->xruns.fetch_add(1); return 0; }
static void onShutdown(void* arg) { static_cast<Engine*>(arg)->shutdown.store(true); }

static void collect(Engine* e) {
  if (e && e->chain) while (Graph* g = e->chain->collect()) delete g;
  if (e && e->player) e->player->collect();
}

// ------------------------------------------------------------------ N-API helpers
#define NAPI(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, "forge-native: N-API call failed"); return nullptr; } } while (0)

static napi_value str(napi_env env, const char* s) { napi_value v; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v); return v; }
static napi_value num(napi_env env, double d) { napi_value v; napi_create_double(env, d, &v); return v; }
static napi_value boolean(napi_env env, bool b) { napi_value v; napi_get_boolean(env, b, &v); return v; }
static napi_value nul(napi_env env) { napi_value v; napi_get_null(env, &v); return v; }
static void set(napi_env env, napi_value o, const char* k, napi_value v) { napi_set_named_property(env, o, k, v); }
static bool getProp(napi_env env, napi_value o, const char* k, napi_value* v) {
  bool has = false;
  if (napi_has_named_property(env, o, k, &has) != napi_ok || !has) return false;
  return napi_get_named_property(env, o, k, v) == napi_ok;
}
static std::string getString(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return "";
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  return s;
}
static std::vector<std::string> getStrings(napi_env env, napi_value arr) {
  std::vector<std::string> out;
  bool isArr = false;
  if (napi_is_array(env, arr, &isArr) != napi_ok || !isArr) return out;
  uint32_t n = 0;
  napi_get_array_length(env, arr, &n);
  for (uint32_t i = 0; i < n; i++) { napi_value v; napi_get_element(env, arr, i, &v); out.push_back(getString(env, v)); }
  return out;
}
static napi_value stringArray(napi_env env, const char** list) {
  napi_value a;
  napi_create_array(env, &a);
  uint32_t i = 0;
  if (list) for (; list[i]; i++) napi_set_element(env, a, i, str(env, list[i]));
  return a;
}
template <class T> static bool typed(napi_env env, napi_value v, napi_typedarray_type want, T** data, size_t* len) {
  bool is = false;
  if (napi_is_typedarray(env, v, &is) != napi_ok || !is) return false;
  napi_typedarray_type t;
  void* d;
  if (napi_get_typedarray_info(env, v, &t, len, &d, nullptr, nullptr) != napi_ok || t != want) return false;
  *data = static_cast<T*>(d);
  return true;
}

static napi_value statusObject(napi_env env) {
  napi_value o;
  napi_create_object(env, &o);
  const bool loaded = J.load();
  set(env, o, "available", boolean(env, loaded));
  set(env, o, "running", boolean(env, E && E->client && !E->shutdown.load()));
  set(env, o, "backend", str(env, "JACK"));
  if (!loaded) set(env, o, "reason", str(env, J.error.c_str()));
  if (E && E->client) {
    set(env, o, "client", str(env, E->name.c_str()));
    set(env, o, "sampleRate", num(env, E->sampleRate));
    set(env, o, "bufferSize", num(env, E->bufferSize));
    jack_latency_range_t cap{ 0, 0 }, play{ 0, 0 };
    J.port_get_latency_range(E->in, JackCaptureLatency, &cap);
    J.port_get_latency_range(E->outL, JackPlaybackLatency, &play);
    const int rig = E->chain ? E->chain->latency() : 0;
    set(env, o, "latencyMs", num(env, 1000.0 * (cap.max + play.max + rig) / E->sampleRate));
    set(env, o, "rigLatencyMs", num(env, 1000.0 * rig / E->sampleRate));
    if (E->shutdown.load()) set(env, o, "reason", str(env, "The JACK server stopped."));
  }
  return o;
}

static napi_value Status(napi_env env, napi_callback_info) { return statusObject(env); }

static const char* portFor(const std::string& which) {
  if (!E) return nullptr;
  if (which == "in") return J.port_name(E->in);
  if (which == "out_L") return J.port_name(E->outL);
  if (which == "out_R") return J.port_name(E->outR);
  if (which == "midi_in" && E->midiIn) return J.port_name(E->midiIn);
  if (which == "phones_L" && E->phL) return J.port_name(E->phL);
  if (which == "phones_R" && E->phR) return J.port_name(E->phR);
  return nullptr;
}

static void connectDefaults(Engine* e, const std::vector<std::string>& inputs, const std::vector<std::string>& outputs) {
  if (!inputs.empty()) for (auto& p : inputs) J.connect(e->client, p.c_str(), J.port_name(e->in));
  else {
    const char** caps = J.get_ports(e->client, nullptr, AUDIO_TYPE, JackPortIsOutput | JackPortIsPhysical);
    if (caps && caps[0]) J.connect(e->client, caps[0], J.port_name(e->in));
    if (caps) J.free_(caps);
  }
  if (outputs.size() >= 2) { J.connect(e->client, J.port_name(e->outL), outputs[0].c_str()); J.connect(e->client, J.port_name(e->outR), outputs[1].c_str()); }
  else if (outputs.size() == 1) { J.connect(e->client, J.port_name(e->outL), outputs[0].c_str()); J.connect(e->client, J.port_name(e->outR), outputs[0].c_str()); }
  else {
    const char** plays = J.get_ports(e->client, nullptr, AUDIO_TYPE, JackPortIsInput | JackPortIsPhysical);
    if (plays) {
      if (plays[0]) J.connect(e->client, J.port_name(e->outL), plays[0]);
      if (plays[0] && plays[1]) J.connect(e->client, J.port_name(e->outR), plays[1]);
      J.free_(plays);
    }
  }
  if (e->midiIn) {
    const char** midis = J.get_ports(e->client, nullptr, MIDI_TYPE, JackPortIsOutput | JackPortIsPhysical);
    if (midis) { for (int i = 0; midis[i]; i++) J.connect(e->client, midis[i], J.port_name(e->midiIn)); J.free_(midis); }
  }
}

static void stopEngine() {
  if (!E) return;
  if (E->client) {
    J.deactivate(E->client);
    J.client_close(E->client);
  }
  collect(E);
  delete E->chain;
  delete E->player;
  std::free(E->rigL); std::free(E->rigR); std::free(E->songL); std::free(E->songR); std::free(E->rec);
  delete E;
  E = nullptr;
}

// start({ name?, connect?: boolean, inputs?: string[], outputs?: string[], latency?: frames })
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!J.load()) { napi_throw_error(env, nullptr, J.error.c_str()); return nullptr; }
  if (E && E->client && !E->shutdown.load()) return statusObject(env);
  stopEngine();
  std::string name = "Fretforge";
  bool autoConnect = true;
  std::vector<std::string> inputs, outputs;
  double latency = 0;
  if (argc > 0) {
    napi_valuetype t;
    napi_typeof(env, argv[0], &t);
    if (t == napi_object) {
      napi_value v;
      if (getProp(env, argv[0], "name", &v)) { std::string s = getString(env, v); if (!s.empty()) name = s.substr(0, 60); }
      if (getProp(env, argv[0], "connect", &v)) napi_get_value_bool(env, v, &autoConnect);
      if (getProp(env, argv[0], "inputs", &v)) inputs = getStrings(env, v);
      if (getProp(env, argv[0], "outputs", &v)) outputs = getStrings(env, v);
      if (getProp(env, argv[0], "latency", &v)) napi_get_value_double(env, v, &latency);
    }
  }
  // PipeWire's JACK reads the requested period from the environment when the client opens
  if (latency >= 16 && latency <= 4096) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%d/48000", (int)latency);
    setenv("PIPEWIRE_LATENCY", buf, 1);
  }
  int status = 0;
  jack_client_t* c = J.client_open(name.c_str(), JackNoStartServer, &status);
  if (!c) { napi_throw_error(env, nullptr, "Could not connect to JACK. Is PipeWire (with its JACK support) or a JACK server running?"); return nullptr; }
  E = new Engine();
  E->client = c;
  E->name = name;
  E->sampleRate = (float)J.get_sample_rate(c);
  E->bufferSize = (int)J.get_buffer_size(c);
  E->chain = new Chain(E->sampleRate, 2048);
  E->player = new Player(E->sampleRate, E->maxFrames);
  for (float** b : { &E->rigL, &E->rigR, &E->songL, &E->songR }) *b = (float*)std::calloc(E->maxFrames, sizeof(float));
  E->rec = (float*)std::calloc((size_t)Engine::kRecFrames * Engine::kRecCh, sizeof(float));
  E->in = J.port_register(c, "in", AUDIO_TYPE, JackPortIsInput, 0);
  E->outL = J.port_register(c, "out_L", AUDIO_TYPE, JackPortIsOutput, 0);
  E->outR = J.port_register(c, "out_R", AUDIO_TYPE, JackPortIsOutput, 0);
  E->midiIn = J.port_register(c, "midi_in", MIDI_TYPE, JackPortIsInput, 0);
  // a second stereo output with its own mix, for headphones (connect it in the I/O panel or a patchbay)
  E->phL = J.port_register(c, "phones_L", AUDIO_TYPE, JackPortIsOutput, 0);
  E->phR = J.port_register(c, "phones_R", AUDIO_TYPE, JackPortIsOutput, 0);
  if (!E->in || !E->outL || !E->outR) { stopEngine(); napi_throw_error(env, nullptr, "Could not create JACK ports."); return nullptr; }
  J.set_process_callback(c, process, E);
  J.set_xrun_callback(c, onXrun, E);
  J.on_shutdown(c, onShutdown, E);
  if (J.activate(c) != 0) { stopEngine(); napi_throw_error(env, nullptr, "JACK refused to start the client."); return nullptr; }
  if (autoConnect) connectDefaults(E, inputs, outputs);
  return statusObject(env);
}

static napi_value Stop(napi_env env, napi_callback_info) {
  stopEngine();
  return boolean(env, true);
}

// ports() -> { sources: string[] (audio outputs of other clients: guitar inputs, apps), sinks: string[], physicalSources, physicalSinks, midiSources }
static napi_value Ports(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  if (!E || !E->client) { set(env, o, "sources", stringArray(env, nullptr)); set(env, o, "sinks", stringArray(env, nullptr)); return o; }
  const char** src = J.get_ports(E->client, nullptr, AUDIO_TYPE, JackPortIsOutput);
  const char** snk = J.get_ports(E->client, nullptr, AUDIO_TYPE, JackPortIsInput);
  const char** psrc = J.get_ports(E->client, nullptr, AUDIO_TYPE, JackPortIsOutput | JackPortIsPhysical);
  const char** psnk = J.get_ports(E->client, nullptr, AUDIO_TYPE, JackPortIsInput | JackPortIsPhysical);
  const char** midi = J.get_ports(E->client, nullptr, MIDI_TYPE, JackPortIsOutput);
  set(env, o, "sources", stringArray(env, src));
  set(env, o, "sinks", stringArray(env, snk));
  set(env, o, "physicalSources", stringArray(env, psrc));
  set(env, o, "physicalSinks", stringArray(env, psnk));
  set(env, o, "midiSources", stringArray(env, midi));
  for (const char** l : { src, snk, psrc, psnk, midi }) if (l) J.free_(l);
  return o;
}

// connections() -> { in: [...], out_L: [...], out_R: [...], midi_in: [...] } (what a patchbay shows)
static napi_value Connections(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  if (!E || !E->client) return o;
  const std::pair<const char*, jack_port_t*> ports[] = { { "in", E->in }, { "out_L", E->outL }, { "out_R", E->outR }, { "midi_in", E->midiIn }, { "phones_L", E->phL }, { "phones_R", E->phR } };
  for (auto& p : ports) {
    if (!p.second) continue;
    const char** c = J.port_get_connections(p.second);
    set(env, o, p.first, stringArray(env, c));
    if (c) J.free_(c);
  }
  return o;
}

// connect(ourPort: 'in'|'out_L'|'out_R'|'midi_in', otherPort: string, on: boolean)
static napi_value Connect(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E || !E->client || argc < 2) return boolean(env, false);
  const std::string ours = getString(env, argv[0]), other = getString(env, argv[1]);
  bool on = true;
  if (argc > 2) napi_get_value_bool(env, argv[2], &on);
  const char* mine = portFor(ours);
  if (!mine || other.empty()) return boolean(env, false);
  const bool isInput = ours == "in" || ours == "midi_in";
  const char* from = isInput ? other.c_str() : mine;
  const char* to = isInput ? mine : other.c_str();
  const int r = on ? J.connect(E->client, from, to) : J.disconnect(E->client, from, to);
  return boolean(env, r == 0 || r == 17 /* EEXIST */);
}

// loadGraph(desc: Float32Array, nams: [{block, code: Int32Array, weights: Float32Array, gain}], irs: [{block, slot, data: Float32Array}])
static napi_value LoadGraph(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E) { napi_throw_error(env, nullptr, "The engine is not running."); return nullptr; }
  float* desc;
  size_t len;
  if (argc < 1 || !typed(env, argv[0], napi_float32_array, &desc, &len)) { napi_throw_type_error(env, nullptr, "loadGraph needs a Float32Array"); return nullptr; }
  const char* err = nullptr;
  const int block = 2048;
  Graph* g = Graph::build(desc, (int)len, E->sampleRate, block, false, &err);
  if (!g) { napi_throw_error(env, nullptr, err ? err : "Could not build the rig."); return nullptr; }
  if (argc > 1) {
    bool isArr = false;
    napi_is_array(env, argv[1], &isArr);
    uint32_t n = 0;
    if (isArr) napi_get_array_length(env, argv[1], &n);
    for (uint32_t i = 0; i < n; i++) {
      napi_value it, v;
      napi_get_element(env, argv[1], i, &it);
      int32_t b = -1; double gain = 1;
      int32_t* code; float* w; size_t nc = 0, nw = 0;
      if (getProp(env, it, "block", &v)) napi_get_value_int32(env, v, &b);
      if (getProp(env, it, "gain", &v)) napi_get_value_double(env, v, &gain);
      napi_value vc, vw;
      if (!getProp(env, it, "code", &vc) || !getProp(env, it, "weights", &vw) || !typed(env, vc, napi_int32_array, &code, &nc) || !typed(env, vw, napi_float32_array, &w, &nw)) continue;
      const char* nerr = nullptr;
      NamModel* m = NamModel::create(code, (int)nc, w, (int)nw, block, &nerr);
      if (!m) { delete g; napi_throw_error(env, nullptr, nerr ? nerr : "Could not load a model."); return nullptr; }
      g->setNam(b, m, (float)gain);
    }
  }
  if (argc > 2) {
    bool isArr = false;
    napi_is_array(env, argv[2], &isArr);
    uint32_t n = 0;
    if (isArr) napi_get_array_length(env, argv[2], &n);
    for (uint32_t i = 0; i < n; i++) {
      napi_value it, v;
      napi_get_element(env, argv[2], i, &it);
      int32_t b = -1, slot = 0;
      float* data; size_t nd = 0;
      if (getProp(env, it, "block", &v)) napi_get_value_int32(env, v, &b);
      if (getProp(env, it, "slot", &v)) napi_get_value_int32(env, v, &slot);
      napi_value vd;
      if (!getProp(env, it, "data", &vd) || !typed(env, vd, napi_float32_array, &data, &nd) || nd == 0) continue;
      g->setIr(b, slot, Convolver::create(data, (int)nd, std::max(16, std::min(E->bufferSize, 1024))));
    }
  }
  collect(E);
  const int blocks = g->blockCount(), lat = g->latency();
  E->chain->swap(g);
  napi_value o;
  napi_create_object(env, &o);
  set(env, o, "blocks", num(env, blocks));
  set(env, o, "latency", num(env, lat));
  return o;
}

static double arg(napi_env env, napi_value v) { double d = 0; napi_get_value_double(env, v, &d); return d; }

// control(op, a, b, value): 'param' (block, index, value), 'enable' (block, on), 'trigger' (block, action),
// 'tempo' (bpm), 'quality' (q), 'io' (which, value)
static napi_value Control(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E || argc < 2) return boolean(env, false);
  const std::string op = getString(env, argv[0]);
  const double a = argc > 1 ? arg(env, argv[1]) : 0, b = argc > 2 ? arg(env, argv[2]) : 0, c = argc > 3 ? arg(env, argv[3]) : 0;
  if (!std::isfinite(a) || !std::isfinite(b) || !std::isfinite(c)) return boolean(env, false);
  if (op == "param") E->chain->setParam((int)a, (int)b, (float)c);
  else if (op == "enable") E->chain->setEnabled((int)a, b > 0.5);
  else if (op == "trigger") E->chain->trigger((int)a, (int)b);
  else if (op == "tempo") E->chain->setTempo((float)a);
  else if (op == "quality") E->chain->setQuality((int)a);
  else if (op == "io") E->chain->setIo((int)a, (float)b);
  else if (op == "bus") { if (a >= 0 && a < 4) E->bus[(int)a].store((float)std::max(0.0, std::min(4.0, b)), std::memory_order_relaxed); }
  else return boolean(env, false);
  return boolean(env, true);
}

// meters() -> { input, output, load, xruns, tunerHz, blocks: number[] (gain reduction), states: number[] (looper), midi: number[][] }
static napi_value Meters(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  collect(E);
  set(env, o, "input", num(env, E ? E->chain->takeInPeak() : 0));
  set(env, o, "output", num(env, E ? E->chain->takeOutPeak() : 0));
  set(env, o, "load", num(env, E ? E->load.load() : 0));
  set(env, o, "xruns", num(env, E ? E->xruns.load() : 0));
  set(env, o, "tunerHz", num(env, E ? E->chain->tunerHz() : 0));
  napi_value blocks, states, midi;
  napi_create_array(env, &blocks);
  napi_create_array(env, &states);
  napi_create_array(env, &midi);
  if (E) {
    for (uint32_t i = 0; i < 64; i++) {
      napi_set_element(env, blocks, i, num(env, E->chain->blockMeter((int)i)));
      napi_set_element(env, states, i, num(env, E->chain->blockState((int)i)));
    }
    uint32_t t = E->midiTail.load(std::memory_order_relaxed);
    const uint32_t h = E->midiHead.load(std::memory_order_acquire);
    uint32_t k = 0;
    for (; t != h; t++) {
      const uint8_t* m = E->midi[t % Engine::kMidi];
      napi_value ev;
      napi_create_array(env, &ev);
      for (uint32_t j = 0; j < 3; j++) napi_set_element(env, ev, j, num(env, m[j]));
      napi_set_element(env, midi, k++, ev);
    }
    E->midiTail.store(t, std::memory_order_release);
  }
  set(env, o, "blocks", blocks);
  set(env, o, "states", states);
  set(env, o, "midi", midi);
  return o;
}

// measureLatency() -> { roundTripMs | null, message } (blocks up to ~1.5 s)
static napi_value MeasureLatency(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  if (!E || !E->client) { set(env, o, "roundTripMs", nul(env)); set(env, o, "message", str(env, "Start the engine first.")); return o; }
  E->latFrames.store(-1);
  E->latState.store(1, std::memory_order_release);
  for (int i = 0; i < 150 && E->latState.load() < 3; i++) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const int st = E->latState.exchange(0);
  const int64_t f = E->latFrames.load();
  if (st == 3 && f >= 0) {
    set(env, o, "roundTripMs", num(env, 1000.0 * (double)f / E->sampleRate));
    set(env, o, "frames", num(env, (double)f));
    set(env, o, "message", str(env, "ok"));
  } else {
    set(env, o, "roundTripMs", nul(env));
    set(env, o, "message", str(env, "No signal came back. Connect an output to an input with a cable, then try again."));
  }
  return o;
}


// ------------------------------------------------------------------ song player
static Player* P(napi_env env) {
  if (!E || !E->player) { napi_throw_error(env, nullptr, "The engine is not running."); return nullptr; }
  return E->player;
}

// playerSource(slot, ch0: Int16Array, ch1?: Int16Array | null, scale?: number)
static napi_value PlayerSourceFn(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Player* p = P(env);
  if (!p) return nullptr;
  int32_t slot = -1;
  napi_get_value_int32(env, argv[0], &slot);
  int16_t* a; size_t na = 0;
  if (argc < 2 || !typed(env, argv[1], napi_int16_array, &a, &na)) { p->removeSource(slot); return boolean(env, true); }
  auto* s = new PlayerSource();
  s->length = (int)na;
  s->ch[0] = (int16_t*)std::malloc(std::max<size_t>(1, na) * 2);
  std::memcpy(s->ch[0], a, na * 2);
  int16_t* b; size_t nb = 0;
  if (argc > 2 && typed(env, argv[2], napi_int16_array, &b, &nb) && nb == na) {
    s->ch[1] = (int16_t*)std::malloc(std::max<size_t>(1, nb) * 2);
    std::memcpy(s->ch[1], b, nb * 2);
  } else s->ch[1] = s->ch[0];
  if (argc > 3) { double sc = 0; napi_get_value_double(env, argv[3], &sc); if (sc > 0) s->scale = (float)sc; }
  p->setSource(slot, s);
  return boolean(env, true);
}

// playerClicks(frames: Float64Array, accent: Uint8Array)
static napi_value PlayerClicksFn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Player* p = P(env);
  if (!p) return nullptr;
  double* f; size_t nf = 0;
  uint8_t* acc; size_t nacc = 0;
  if (argc < 2 || !typed(env, argv[0], napi_float64_array, &f, &nf) || !typed(env, argv[1], napi_uint8_array, &acc, &nacc)) return boolean(env, false);
  auto* c = new PlayerClicks();
  c->count = (int)std::min(nf, nacc);
  c->frames = (double*)std::malloc(std::max<size_t>(1, c->count) * sizeof(double));
  c->accent = (uint8_t*)std::malloc(std::max<size_t>(1, c->count));
  std::memcpy(c->frames, f, c->count * sizeof(double));
  std::memcpy(c->accent, acc, c->count);
  p->setClicks(c);
  return boolean(env, true);
}

// playerCmd(op, a, b, c, d)
static napi_value PlayerCmdFn(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E || !E->player || argc < 1) return boolean(env, false);
  Player* p = E->player;
  const std::string op = getString(env, argv[0]);
  double v[4] = { 0, 0, 0, 0 };
  for (size_t i = 1; i < argc && i < 5; i++) v[i - 1] = arg(env, argv[i]);
  for (double x : v) if (!std::isfinite(x)) return boolean(env, false);
  if (op == "mix") p->mix((int)v[0], (float)v[1], (float)v[2], ((int)v[3] & 1) != 0, ((int)v[3] & 2) != 0);
  else if (op == "offset") p->setOffset((int)v[0], v[1]);
  else if (op == "play") p->play((int)v[0], v[1]);
  else if (op == "pause") p->pause();
  else if (op == "seek") p->seek(v[0]);
  else if (op == "rate") { p->setRate((float)v[0]); E->songRate.store((float)v[0]); }
  else if (op == "pitch") p->setPitch((float)v[0]);
  else if (op == "master") p->setMaster((float)v[0]);
  else if (op == "duration") p->setDuration(v[0]);
  else if (op == "loop") p->setLoop(v[0], v[1]);
  else if (op == "metronome") p->setMetronome(v[0] > 0.5, (float)v[1]);
  else if (op == "clear") { for (int s = 0; s < Player::kSlots; s++) p->removeSource(s); }
  else return boolean(env, false);
  return boolean(env, true);
}

// playerState() -> { frames, playing, counting, ended, peak, sampleRate, latency }
static napi_value PlayerStateFn(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  if (!E || !E->player) { set(env, o, "running", boolean(env, false)); return o; }
  collect(E);
  set(env, o, "running", boolean(env, true));
  set(env, o, "frames", num(env, E->player->heardFrames()));
  set(env, o, "playing", boolean(env, E->player->playing()));
  set(env, o, "counting", boolean(env, E->player->counting()));
  set(env, o, "ended", num(env, E->player->endedCount()));
  set(env, o, "peak", num(env, E->player->takePeak()));
  set(env, o, "sampleRate", num(env, E->sampleRate));
  set(env, o, "latency", num(env, E->player->latency()));
  return o;
}

// ------------------------------------------------------------------ recording (DI, rig, song)
// record(on): arms or disarms; arming clears what was not taken yet
static napi_value RecordFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E) return boolean(env, false);
  bool on = false;
  if (argc > 0) napi_get_value_bool(env, argv[0], &on);
  if (on) { E->recTail.store(E->recHead.load()); E->recDropped.store(0); E->markTail.store(E->markHead.load()); }
  E->recArmed.store(on, std::memory_order_release);
  return boolean(env, true);
}

// takeRecording() -> { di, rigL, rigR, songL, songR: Float32Array, dropped, marks: Float64Array [frame, song, rate, playing]*, startFrame }
static napi_value TakeRecordingFn(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  if (!E) return o;
  const uint64_t h = E->recHead.load(std::memory_order_acquire), t = E->recTail.load(std::memory_order_relaxed);
  const size_t n = (size_t)(h - t);
  const char* names[] = { "di", "rigL", "rigR", "songL", "songR" };
  for (int c = 0; c < Engine::kRecCh; c++) {
    napi_value ab, arr;
    void* data = nullptr;
    napi_create_arraybuffer(env, n * sizeof(float), &data, &ab);
    float* f = static_cast<float*>(data);
    for (size_t i = 0; i < n; i++) f[i] = E->rec[((t + i) % Engine::kRecFrames) * Engine::kRecCh + c];
    napi_create_typedarray(env, napi_float32_array, n, ab, 0, &arr);
    set(env, o, names[c], arr);
  }
  E->recTail.store(h, std::memory_order_release);
  set(env, o, "dropped", num(env, E->recDropped.exchange(0)));
  const uint64_t mh = E->markHead.load(std::memory_order_acquire), mt = E->markTail.load(std::memory_order_relaxed);
  const size_t nm = (size_t)(mh - mt);
  napi_value mab, marr;
  void* md = nullptr;
  napi_create_arraybuffer(env, nm * 4 * sizeof(double), &md, &mab);
  double* m = static_cast<double*>(md);
  for (size_t i = 0; i < nm; i++) {
    const Engine::Mark& k = E->marks[(mt + i) % Engine::kMarks];
    m[i * 4] = (double)k.frame; m[i * 4 + 1] = k.song; m[i * 4 + 2] = k.rate; m[i * 4 + 3] = k.playing;
  }
  E->markTail.store(mh, std::memory_order_release);
  napi_create_typedarray(env, napi_float64_array, nm * 4, mab, 0, &marr);
  set(env, o, "marks", marr);
  set(env, o, "sampleRate", num(env, E->sampleRate));
  return o;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "ports", nullptr, Ports, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "connections", nullptr, Connections, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "connect", nullptr, Connect, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "loadGraph", nullptr, LoadGraph, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "control", nullptr, Control, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "meters", nullptr, Meters, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "measureLatency", nullptr, MeasureLatency, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "playerSource", nullptr, PlayerSourceFn, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "playerClicks", nullptr, PlayerClicksFn, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "playerCmd", nullptr, PlayerCmdFn, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "playerState", nullptr, PlayerStateFn, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "record", nullptr, RecordFn, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "takeRecording", nullptr, TakeRecordingFn, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
