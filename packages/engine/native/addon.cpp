// forge-native: the desktop app's low-latency rig engine.
//
// Runs the forge-dsp Rig (NAM + IR + EQ) inside a JACK process callback. JACK is loaded with
// dlopen, so the addon loads (and reports why) even when JACK/PipeWire-JACK is missing. On
// Nobara/Fedora PipeWire provides libjack, so this works out of the box there.
//
// Audio thread rules: the process callback never allocates, locks or calls into JS. Models
// and IRs are built on the JS thread and handed over through atomic pointers; the old object
// is freed on the JS thread once the audio thread has let go of it.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <string>
#include <thread>

#include <node_api.h>

#include "convolver.h"
#include "nam.h"
#include "rig.h"

using namespace forge;

// ------------------------------------------------------------------ minimal JACK API (dlopen)
typedef struct _jack_client jack_client_t;
typedef struct _jack_port jack_port_t;
typedef uint32_t jack_nframes_t;
typedef float jack_default_audio_sample_t;
typedef int (*JackProcessCallback)(jack_nframes_t, void*);
typedef int (*JackXRunCallback)(void*);
typedef void (*JackShutdownCallback)(void*);
struct jack_latency_range_t { jack_nframes_t min, max; };
enum { JackPortIsInput = 0x1, JackPortIsOutput = 0x2, JackPortIsPhysical = 0x4 };
enum { JackNoStartServer = 0x01 };
enum { JackCaptureLatency = 0, JackPlaybackLatency = 1 };

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
  const char* (*port_name)(const jack_port_t*) = nullptr;
  void (*free_)(void*) = nullptr;
  void (*port_get_latency_range)(jack_port_t*, int, jack_latency_range_t*) = nullptr;
  float (*cpu_load)(jack_client_t*) = nullptr;
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
    SYM(connect, "jack_connect") SYM(port_name, "jack_port_name") SYM(free_, "jack_free")
    SYM(port_get_latency_range, "jack_port_get_latency_range") SYM(cpu_load, "jack_cpu_load")
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
  Rig* rig = nullptr;
  float sampleRate = 48000;
  int bufferSize = 0;

  // handover: JS thread stores pending objects; the audio thread installs them and
  // publishes the previous one in `retired*` for the JS thread to free.
  std::atomic<NamModel*> pendingNam{ nullptr };
  std::atomic<bool> namChange{ false };
  std::atomic<NamModel*> retiredNam{ nullptr };
  NamModel* liveNam = nullptr;
  std::atomic<Convolver*> pendingIr{ nullptr };
  std::atomic<bool> irChange{ false };
  std::atomic<Convolver*> retiredIr{ nullptr };
  Convolver* liveIr = nullptr;

  std::atomic<float> params[P_COUNT];
  std::atomic<uint32_t> paramDirty{ 0 };
  float applied[P_COUNT];

  std::atomic<float> inPeak{ 0 }, outPeak{ 0 }, load{ 0 };
  std::atomic<uint32_t> xruns{ 0 };
  std::atomic<bool> shutdown{ false };

  // latency measurement: 0 idle, 1 send impulse, 2 listening, 3 done, 4 timed out
  std::atomic<int> latState{ 0 };
  std::atomic<int64_t> latFrames{ -1 };
  int64_t latCounter = 0;
  float* scratch = nullptr;
  int scratchLen = 0;
};

static Engine* E = nullptr;

static int process(jack_nframes_t n, void* arg) {
  Engine* e = static_cast<Engine*>(arg);
  float* in = static_cast<float*>(J.port_get_buffer(e->in, n));
  float* L = static_cast<float*>(J.port_get_buffer(e->outL, n));
  float* R = static_cast<float*>(J.port_get_buffer(e->outR, n));

  // install new model / IR (the previous one is retired for the JS thread to free)
  if (e->namChange.exchange(false, std::memory_order_acq_rel)) {
    NamModel* next = e->pendingNam.exchange(nullptr, std::memory_order_acq_rel);
    NamModel* old = e->liveNam;
    e->liveNam = next;
    e->rig->setNam(next);
    if (old) {
      NamModel* prev = e->retiredNam.exchange(old, std::memory_order_acq_rel);
      (void)prev; // the JS thread frees retired objects before handing over new ones
    }
  }
  if (e->irChange.exchange(false, std::memory_order_acq_rel)) {
    Convolver* next = e->pendingIr.exchange(nullptr, std::memory_order_acq_rel);
    Convolver* old = e->liveIr;
    e->liveIr = next;
    e->rig->setIr(next);
    if (old) e->retiredIr.exchange(old, std::memory_order_acq_rel);
  }
  if (e->paramDirty.exchange(0, std::memory_order_acq_rel)) {
    for (int i = 0; i < P_COUNT; i++) {
      const float v = e->params[i].load(std::memory_order_relaxed);
      if (v != e->applied[i]) { e->applied[i] = v; e->rig->set(i, v); }
    }
  }

  // latency test: impulse out, wait for it to come back in
  const int ls = e->latState.load(std::memory_order_acquire);
  if (ls == 1 || ls == 2) {
    for (jack_nframes_t i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
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
  e->rig->process(in, L, (int)n);
  std::memcpy(R, L, sizeof(float) * n);
  const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  const float l = (float)(dt / (n / e->sampleRate));
  e->load.store(std::max(l, e->load.load(std::memory_order_relaxed) * 0.97f), std::memory_order_relaxed);
  e->inPeak.store(std::max(e->inPeak.load(std::memory_order_relaxed), e->rig->takeInPeak()), std::memory_order_relaxed);
  e->outPeak.store(std::max(e->outPeak.load(std::memory_order_relaxed), e->rig->takeOutPeak()), std::memory_order_relaxed);
  return 0;
}

static int onXrun(void* arg) { static_cast<Engine*>(arg)->xruns.fetch_add(1); return 0; }
static void onShutdown(void* arg) { static_cast<Engine*>(arg)->shutdown.store(true); }

/** Frees objects the audio thread has let go of (JS thread only). */
static void collect(Engine* e) {
  if (NamModel* m = e->retiredNam.exchange(nullptr)) delete m;
  if (Convolver* c = e->retiredIr.exchange(nullptr)) delete c;
}

// ------------------------------------------------------------------ N-API helpers
#define NAPI(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, "forge-native: N-API call failed"); return nullptr; } } while (0)

static napi_value str(napi_env env, const char* s) { napi_value v; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v); return v; }
static napi_value num(napi_env env, double d) { napi_value v; napi_create_double(env, d, &v); return v; }
static napi_value boolean(napi_env env, bool b) { napi_value v; napi_get_boolean(env, b, &v); return v; }
static void set(napi_env env, napi_value o, const char* k, napi_value v) { napi_set_named_property(env, o, k, v); }

static napi_value statusObject(napi_env env) {
  napi_value o;
  napi_create_object(env, &o);
  const bool loaded = J.load();
  set(env, o, "available", boolean(env, loaded));
  set(env, o, "running", boolean(env, E && E->client && !E->shutdown.load()));
  set(env, o, "backend", str(env, "JACK"));
  if (!loaded) set(env, o, "reason", str(env, J.error.c_str()));
  if (E && E->client) {
    set(env, o, "sampleRate", num(env, E->sampleRate));
    set(env, o, "bufferSize", num(env, E->bufferSize));
    jack_latency_range_t cap{ 0, 0 }, play{ 0, 0 };
    J.port_get_latency_range(E->in, JackCaptureLatency, &cap);
    J.port_get_latency_range(E->outL, JackPlaybackLatency, &play);
    set(env, o, "latencyMs", num(env, 1000.0 * (cap.max + play.max) / E->sampleRate));
    if (E->shutdown.load()) set(env, o, "reason", str(env, "The JACK server stopped."));
  }
  return o;
}

static napi_value Status(napi_env env, napi_callback_info) { return statusObject(env); }

static void connectPhysical(Engine* e) {
  const char** caps = J.get_ports(e->client, nullptr, "audio", JackPortIsOutput | JackPortIsPhysical);
  if (caps && caps[0]) J.connect(e->client, caps[0], J.port_name(e->in));
  if (caps) J.free_(caps);
  const char** plays = J.get_ports(e->client, nullptr, "audio", JackPortIsInput | JackPortIsPhysical);
  if (plays) {
    if (plays[0]) J.connect(e->client, J.port_name(e->outL), plays[0]);
    if (plays[0] && plays[1]) J.connect(e->client, J.port_name(e->outR), plays[1]);
    J.free_(plays);
  }
}

static void stopEngine() {
  if (!E) return;
  if (E->client) {
    J.deactivate(E->client);
    J.client_close(E->client);
  }
  collect(E);
  delete E->liveNam;
  delete E->liveIr;
  delete E->pendingNam.exchange(nullptr);
  delete E->pendingIr.exchange(nullptr);
  delete E->rig;
  delete E;
  E = nullptr;
}

// start({ name?, connect?: boolean })
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!J.load()) { napi_throw_error(env, nullptr, J.error.c_str()); return nullptr; }
  if (E && E->client && !E->shutdown.load()) return statusObject(env);
  stopEngine();
  std::string name = "Fretforge";
  bool autoConnect = true;
  if (argc > 0) {
    napi_valuetype t;
    napi_typeof(env, argv[0], &t);
    if (t == napi_object) {
      napi_value v;
      bool has = false;
      napi_has_named_property(env, argv[0], "name", &has);
      if (has) { napi_get_named_property(env, argv[0], "name", &v); char buf[64]; size_t len; if (napi_get_value_string_utf8(env, v, buf, sizeof buf, &len) == napi_ok) name = buf; }
      napi_has_named_property(env, argv[0], "connect", &has);
      if (has) { napi_get_named_property(env, argv[0], "connect", &v); napi_get_value_bool(env, v, &autoConnect); }
    }
  }
  int status = 0;
  jack_client_t* c = J.client_open(name.c_str(), JackNoStartServer, &status);
  if (!c) { napi_throw_error(env, nullptr, "Could not connect to JACK. Is PipeWire (with its JACK support) or a JACK server running?"); return nullptr; }
  E = new Engine();
  E->client = c;
  E->sampleRate = (float)J.get_sample_rate(c);
  E->bufferSize = (int)J.get_buffer_size(c);
  E->rig = new Rig(E->sampleRate, 8192);
  for (int i = 0; i < P_COUNT; i++) { E->applied[i] = E->rig->get(i); E->params[i].store(E->applied[i]); }
  E->in = J.port_register(c, "in", "32 bit float mono audio", JackPortIsInput, 0);
  E->outL = J.port_register(c, "out_L", "32 bit float mono audio", JackPortIsOutput, 0);
  E->outR = J.port_register(c, "out_R", "32 bit float mono audio", JackPortIsOutput, 0);
  if (!E->in || !E->outL || !E->outR) { stopEngine(); napi_throw_error(env, nullptr, "Could not create JACK ports."); return nullptr; }
  J.set_process_callback(c, process, E);
  J.set_xrun_callback(c, onXrun, E);
  J.on_shutdown(c, onShutdown, E);
  if (J.activate(c) != 0) { stopEngine(); napi_throw_error(env, nullptr, "JACK refused to start the client."); return nullptr; }
  if (autoConnect) connectPhysical(E);
  return statusObject(env);
}

static napi_value Stop(napi_env env, napi_callback_info) {
  stopEngine();
  return boolean(env, true);
}

// loadNam(Int32Array code, Float32Array weights, gain)
static napi_value LoadNam(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E) { napi_throw_error(env, nullptr, "The engine is not running."); return nullptr; }
  if (argc < 2) { napi_throw_type_error(env, nullptr, "loadNam(code, weights, gain)"); return nullptr; }
  napi_typedarray_type t1, t2;
  size_t n1, n2;
  void *d1, *d2;
  NAPI(napi_get_typedarray_info(env, argv[0], &t1, &n1, &d1, nullptr, nullptr));
  NAPI(napi_get_typedarray_info(env, argv[1], &t2, &n2, &d2, nullptr, nullptr));
  if (t1 != napi_int32_array || t2 != napi_float32_array) { napi_throw_type_error(env, nullptr, "loadNam needs an Int32Array and a Float32Array"); return nullptr; }
  double gain = 1;
  if (argc > 2) napi_get_value_double(env, argv[2], &gain);
  const char* err = nullptr;
  // block size: JACK's period, with room for changes
  NamModel* m = NamModel::create(static_cast<int32_t*>(d1), (int)n1, static_cast<float*>(d2), (int)n2, std::max(64, std::min(8192, E->bufferSize)), &err);
  if (!m) { napi_throw_error(env, nullptr, err ? err : "Could not load the model."); return nullptr; }
  collect(E);
  delete E->pendingNam.exchange(m);
  E->namChange.store(true, std::memory_order_release);
  E->params[P_NAM_GAIN].store((float)gain);
  E->paramDirty.store(1, std::memory_order_release);
  return boolean(env, true);
}

static napi_value ClearNam(napi_env env, napi_callback_info) {
  if (!E) return boolean(env, false);
  collect(E);
  delete E->pendingNam.exchange(nullptr);
  E->namChange.store(true, std::memory_order_release);
  return boolean(env, true);
}

// loadIr(Float32Array | null)
static napi_value LoadIr(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E) { napi_throw_error(env, nullptr, "The engine is not running."); return nullptr; }
  Convolver* c = nullptr;
  bool isTa = false;
  if (argc > 0) napi_is_typedarray(env, argv[0], &isTa);
  if (isTa) {
    napi_typedarray_type t;
    size_t n;
    void* d;
    NAPI(napi_get_typedarray_info(env, argv[0], &t, &n, &d, nullptr, nullptr));
    if (t != napi_float32_array) { napi_throw_type_error(env, nullptr, "loadIr needs a Float32Array"); return nullptr; }
    if (n > 0) c = Convolver::create(static_cast<float*>(d), (int)n, std::max(16, E->bufferSize));
  }
  collect(E);
  delete E->pendingIr.exchange(c);
  E->irChange.store(true, std::memory_order_release);
  return boolean(env, true);
}

static napi_value SetParam(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!E || argc < 2) return boolean(env, false);
  int32_t id;
  double v;
  napi_get_value_int32(env, argv[0], &id);
  napi_get_value_double(env, argv[1], &v);
  if (id < 0 || id >= P_COUNT || !std::isfinite(v)) return boolean(env, false);
  E->params[id].store((float)v, std::memory_order_relaxed);
  E->paramDirty.store(1, std::memory_order_release);
  return boolean(env, true);
}

static napi_value Meters(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  if (E) collect(E);
  set(env, o, "input", num(env, E ? E->inPeak.exchange(0) : 0));
  set(env, o, "output", num(env, E ? E->outPeak.exchange(0) : 0));
  set(env, o, "load", num(env, E ? E->load.load() : 0));
  set(env, o, "xruns", num(env, E ? E->xruns.load() : 0));
  return o;
}

// measureLatency() -> { roundTripMs | null, message } (blocks up to ~1.2 s on the JS thread's caller side)
static napi_value MeasureLatency(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  napi_value nul0;
  napi_get_null(env, &nul0);
  if (!E || !E->client) { set(env, o, "roundTripMs", nul0); set(env, o, "message", str(env, "Start the engine first.")); return o; }
  E->latFrames.store(-1);
  E->latState.store(1, std::memory_order_release);
  for (int i = 0; i < 150 && E->latState.load() < 3; i++) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const int st = E->latState.exchange(0);
  const int64_t f = E->latFrames.load();
  napi_value nul;
  napi_get_null(env, &nul);
  if (st == 3 && f >= 0) {
    set(env, o, "roundTripMs", num(env, 1000.0 * (double)f / E->sampleRate));
    set(env, o, "frames", num(env, (double)f));
    set(env, o, "message", str(env, "ok"));
  } else {
    set(env, o, "roundTripMs", nul);
    set(env, o, "message", str(env, "No signal came back. Connect an output to an input with a cable, then try again."));
  }
  return o;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "loadNam", nullptr, LoadNam, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "clearNam", nullptr, ClearNam, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "loadIr", nullptr, LoadIr, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setParam", nullptr, SetParam, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "meters", nullptr, Meters, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "measureLatency", nullptr, MeasureLatency, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
