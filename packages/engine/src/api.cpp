// forge-dsp C API. The same functions are exported from the WASM build and linked into the
// native addon. Handles are opaque pointers. Nothing here throws.
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <new>

#include "chain.h"
#include "convolver.h"
#include "nam.h"
#include "rig.h"
#include "signalsmith-stretch.h"

#if defined(__wasm__)
#define FF_EXPORT(name) extern "C" __attribute__((export_name(#name)))
#else
#define FF_EXPORT(name) extern "C" __attribute__((visibility("default")))
#endif

using namespace forge;

namespace {
const char* g_error = "";

struct Stretcher {
  signalsmith::stretch::SignalsmithStretch<float> s;
  int channels = 2;
  int maxIn = 0, maxOut = 0;
  float* in[2] = { nullptr, nullptr };
  float* out[2] = { nullptr, nullptr };
};
} // namespace

FF_EXPORT(ff_version) int ff_version() { return 2; }
FF_EXPORT(ff_alloc) void* ff_alloc(int bytes) { return std::calloc((size_t)(bytes > 0 ? bytes : 1), 1); }
FF_EXPORT(ff_free) void ff_free(void* p) { std::free(p); }
FF_EXPORT(ff_error) const char* ff_error() { return g_error; }

// ------------------------------------------------------------------ NAM
FF_EXPORT(nam_create) NamModel* nam_create(const int32_t* code, int codeLen, const float* weights, int weightLen, int maxBlock) {
  const char* err = nullptr;
  NamModel* m = NamModel::create(code, codeLen, weights, weightLen, maxBlock, &err);
  if (!m) g_error = err ? err : "could not create model";
  return m;
}
FF_EXPORT(nam_process) void nam_process(NamModel* m, const float* in, float* out, int n) { if (m) m->process(in, out, n); }
FF_EXPORT(nam_reset) void nam_reset(NamModel* m) { if (m) m->reset(); }
FF_EXPORT(nam_destroy) void nam_destroy(NamModel* m) { delete m; }

// ------------------------------------------------------------------ IR
FF_EXPORT(conv_create) Convolver* conv_create(const float* ir, int length, int block) {
  Convolver* c = Convolver::create(ir, length, block);
  if (!c) g_error = "empty impulse response";
  return c;
}
FF_EXPORT(conv_process) void conv_process(Convolver* c, const float* in, float* out, int n) { if (c) c->process(in, out, n); }
FF_EXPORT(conv_reset) void conv_reset(Convolver* c) { if (c) c->reset(); }
FF_EXPORT(conv_destroy) void conv_destroy(Convolver* c) { delete c; }

// ------------------------------------------------------------------ Rig
FF_EXPORT(rig_create) Rig* rig_create(float sampleRate, int maxBlock) { return new Rig(sampleRate, maxBlock > 0 ? maxBlock : 128); }
FF_EXPORT(rig_destroy) void rig_destroy(Rig* r) { delete r; }
FF_EXPORT(rig_set_nam) void rig_set_nam(Rig* r, NamModel* m) { if (r) r->setNam(m); }
FF_EXPORT(rig_set_ir) void rig_set_ir(Rig* r, Convolver* c) { if (r) r->setIr(c); }
FF_EXPORT(rig_set) void rig_set(Rig* r, int param, float value) { if (r) r->set(param, value); }
FF_EXPORT(rig_get) float rig_get(Rig* r, int param) { return r ? r->get(param) : 0.f; }
FF_EXPORT(rig_process) void rig_process(Rig* r, const float* in, float* out, int n) { if (r) r->process(in, out, n); }
FF_EXPORT(rig_reset) void rig_reset(Rig* r) { if (r) r->reset(); }
FF_EXPORT(rig_in_peak) float rig_in_peak(Rig* r) { return r ? r->takeInPeak() : 0.f; }
FF_EXPORT(rig_out_peak) float rig_out_peak(Rig* r) { return r ? r->takeOutPeak() : 0.f; }

// ------------------------------------------------------------------ time-stretch / pitch-shift (stereo)
FF_EXPORT(st_create) Stretcher* st_create(float sampleRate, int maxIn, int maxOut) {
  Stretcher* s = new (std::nothrow) Stretcher();
  if (!s) return nullptr;
  s->s.presetDefault(2, sampleRate);
  s->maxIn = maxIn;
  s->maxOut = maxOut;
  for (int c = 0; c < 2; c++) {
    s->in[c] = (float*)std::calloc((size_t)maxIn, sizeof(float));
    s->out[c] = (float*)std::calloc((size_t)maxOut, sizeof(float));
  }
  return s;
}
FF_EXPORT(st_destroy) void st_destroy(Stretcher* s) {
  if (!s) return;
  for (int c = 0; c < 2; c++) { std::free(s->in[c]); std::free(s->out[c]); }
  delete s;
}
FF_EXPORT(st_in) float* st_in(Stretcher* s, int ch) { return s ? s->in[ch & 1] : nullptr; }
FF_EXPORT(st_out) float* st_out(Stretcher* s, int ch) { return s ? s->out[ch & 1] : nullptr; }
FF_EXPORT(st_input_latency) int st_input_latency(Stretcher* s) { return s ? s->s.inputLatency() : 0; }
FF_EXPORT(st_output_latency) int st_output_latency(Stretcher* s) { return s ? s->s.outputLatency() : 0; }
FF_EXPORT(st_transpose) void st_transpose(Stretcher* s, float semitones) { if (s) s->s.setTransposeSemitones(semitones, 8000.f / 48000.f); }
FF_EXPORT(st_reset) void st_reset(Stretcher* s) { if (s) s->s.reset(); }
FF_EXPORT(st_process) void st_process(Stretcher* s, int inN, int outN) {
  if (!s) return;
  if (inN > s->maxIn) inN = s->maxIn;
  if (outN > s->maxOut) outN = s->maxOut;
  s->s.process(s->in, inN, s->out, outN);
}
// prime the stretcher with inN samples of input so playback can start without a fade-in
FF_EXPORT(st_seek) void st_seek(Stretcher* s, int inN, double rate) {
  if (!s) return;
  if (inN > s->maxIn) inN = s->maxIn;
  s->s.seek(s->in, inN, rate);
}

// ------------------------------------------------------------------ rig graphs (offline rendering) and the live chain
FF_EXPORT(block_param_count) int block_param_count(int type) { return blockParamCount(type); }
FF_EXPORT(graph_create) Graph* graph_create(const float* desc, int len, float sampleRate, int maxBlock, int offline) {
  const char* err = nullptr;
  Graph* g = Graph::build(desc, len, sampleRate, maxBlock, offline != 0, &err);
  if (!g) g_error = err ? err : "could not build the rig";
  return g;
}
FF_EXPORT(graph_destroy) void graph_destroy(Graph* g) { delete g; }
FF_EXPORT(graph_block_count) int graph_block_count(Graph* g) { return g ? g->blockCount() : 0; }
// the graph takes ownership of models and IRs
FF_EXPORT(graph_set_nam) void graph_set_nam(Graph* g, int block, NamModel* m, float gain) { if (g) g->setNam(block, m, gain); else delete m; }
FF_EXPORT(graph_set_ir) void graph_set_ir(Graph* g, int block, int slot, Convolver* c) { if (g) g->setIr(block, slot, c); else delete c; }
FF_EXPORT(graph_set_param) void graph_set_param(Graph* g, int block, int index, float v) { if (g) g->setParam(block, index, v); }
FF_EXPORT(graph_set_enabled) void graph_set_enabled(Graph* g, int block, int on) { if (g) g->setEnabled(block, on != 0); }
FF_EXPORT(graph_set_tempo) void graph_set_tempo(Graph* g, float bpm) { if (g) g->setTempo(bpm); }
FF_EXPORT(graph_set_quality) void graph_set_quality(Graph* g, int q) { if (g) g->setQuality(q); }
FF_EXPORT(graph_reset) void graph_reset(Graph* g) { if (g) g->reset(); }
FF_EXPORT(graph_latency) int graph_latency(Graph* g) { return g ? g->latency() : 0; }
FF_EXPORT(graph_process) int graph_process(Graph* g, float* L, float* R, int n) {
  if (!g) { std::memcpy(R, L, sizeof(float) * (size_t)n); return 0; }
  return g->process(L, R, n) ? 1 : 0;
}

FF_EXPORT(chain_create) Chain* chain_create(float sampleRate, int maxBlock) { return new (std::nothrow) Chain(sampleRate, maxBlock); }
FF_EXPORT(chain_destroy) void chain_destroy(Chain* c) { delete c; }
FF_EXPORT(chain_swap) void chain_swap(Chain* c, Graph* g) { if (c) c->swap(g); else delete g; }
FF_EXPORT(chain_collect) void chain_collect(Chain* c) { if (c) delete c->collect(); }
FF_EXPORT(chain_set_param) void chain_set_param(Chain* c, int block, int index, float v) { if (c) c->setParam(block, index, v); }
FF_EXPORT(chain_set_enabled) void chain_set_enabled(Chain* c, int block, int on) { if (c) c->setEnabled(block, on != 0); }
FF_EXPORT(chain_trigger) void chain_trigger(Chain* c, int block, int action) { if (c) c->trigger(block, action); }
FF_EXPORT(chain_set_tempo) void chain_set_tempo(Chain* c, float bpm) { if (c) c->setTempo(bpm); }
FF_EXPORT(chain_set_quality) void chain_set_quality(Chain* c, int q) { if (c) c->setQuality(q); }
FF_EXPORT(chain_set_io) void chain_set_io(Chain* c, int which, float v) { if (c) c->setIo(which, v); }
FF_EXPORT(chain_process) void chain_process(Chain* c, const float* in, float* L, float* R, int n) { if (c) c->process(in, L, R, n); }
FF_EXPORT(chain_in_peak) float chain_in_peak(Chain* c) { return c ? c->takeInPeak() : 0.f; }
FF_EXPORT(chain_out_peak) float chain_out_peak(Chain* c) { return c ? c->takeOutPeak() : 0.f; }
FF_EXPORT(chain_tuner_hz) float chain_tuner_hz(Chain* c) { return c ? c->tunerHz() : 0.f; }
FF_EXPORT(chain_latency) int chain_latency(Chain* c) { return c ? c->latency() : 0; }
FF_EXPORT(chain_block_meter) float chain_block_meter(Chain* c, int b) { return c ? c->blockMeter(b) : 0.f; }
FF_EXPORT(chain_block_state) int chain_block_state(Chain* c, int b) { return c ? c->blockState(b) : 0; }
