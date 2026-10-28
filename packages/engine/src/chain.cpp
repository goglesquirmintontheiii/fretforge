#include "chain.h"

#include <cmath>
#include <cstring>
#include <new>

#include "convolver.h"
#include "nam.h"

namespace forge {

// ------------------------------------------------------------------ block factory
Block* createBlock(int type) {
  if (type >= 1 && type < 20) return createDrive(type);
  if (type >= 20 && type < 30) return createDynamics(type);
  if (type >= 30 && type < 50) return createEq(type);
  if (type >= 50 && type < 60) return createModulation(type);
  if (type >= 60 && type < 70) return createDelay(type);
  if (type >= 70 && type < 80) return createReverb(type);
  if (type >= 80 && type < 90) return createPitch(type);
  if (type >= 90 && type < 100) return createFilter(type);
  if (type >= 100 && type < 120) return createCapture(type);
  return nullptr;
}

int blockParamCount(int type) {
  switch (type) {
    case B_OD_MID: case B_OD_CLEAR: case B_DIST_GRIT: case B_FUZZ_WALL: case B_FUZZ_ROUND: case B_FUZZ_OCTAVE: return 3;
    case B_BOOST_CLEAN: case B_FUZZ_BENDER: case B_BOOST_TREBLE: return 2;
    case B_OD_SMOOTH: return 5;
    case B_OD_CRUNCH: return 4;
    case B_COMP_SQUEEZE: case B_COMP_OPTO: return 3;
    case B_COMP_STUDIO: return 7;
    case B_COMP_MULTI: return 11;
    case B_GATE_SIMPLE: return 2;
    case B_GATE_HARD: return 5;
    case B_EQ_SIMPLE: return 5;
    case B_EQ_PARAM: return 10;
    case B_EQ_GRAPHIC: return 11;
    case B_EQ_CUT: return 2;
    case B_EQ_FIVE: return 6;
    case B_VOLUME: return 4;
    case B_GAIN: case B_PAN: case B_WIDTH: return 1;
    case B_CHORUS: case B_FLANGER: case B_PHASER: case B_TREMOLO: case B_ROTARY: return 5;
    case B_CHORUS_DIM: case B_PHASER_SCRIPT: case B_RINGMOD: return 2;
    case B_VIBE: return 4;
    case B_DELAY_DIGITAL: case B_DELAY_ANALOG: case B_DELAY_DUCKED: case B_DELAY_MULTITAP: return 6;
    case B_DELAY_TAPE: return 8;
    case B_DELAY_PINGPONG: case B_DELAY_DUAL: return 5;
    case B_DELAY_REVERSE: return 3;
    case B_REV_ROOM: case B_REV_HALL: case B_REV_PLATE: case B_REV_CHAMBER: case B_REV_SHIMMER: case B_REV_AMBIENT: return 6;
    case B_REV_SPRING: return 4;
    case B_PITCH_WHAMMY: case B_PITCH_HARMONY: return 4;
    case B_PITCH_SIMPLE: case B_OCTAVER: return 3;
    case B_PITCH_CAPO: return 2;
    case B_ENV_FILTER: case B_SYNTH_FILTER: return 6;
    case B_WAH_CLASSIC: case B_WAH_VINTAGE: return 3;
    case B_NAM_AMP: case B_NAM_PREAMP: case B_NAM_PEDAL: case B_NAM_CAB: case B_NAM_FULL: return 7;
    case B_CAB_IR: return 4;
    case B_CAB_DUAL: return 7;
    case B_AMP_CAB: return 9;
    case B_LOOPER: return 1;
    default: return -1;
  }
}

// ------------------------------------------------------------------ graph
namespace {
inline void panGains(float pan, float& l, float& r) {
  const float a = (clampf(pan, -1, 1) + 1) * 0.25f * kPi;
  l = std::cos(a) * 1.41421356f;
  r = std::sin(a) * 1.41421356f;
}
} // namespace

bool Graph::parseBlocks(const float*& p, const float* end, int count, float sr, int maxBlock, bool offline, const char** err) {
  for (int k = 0; k < count; k++) {
    if (end - p < 5 || (int)p[0] != 0) { *err = "rig description: expected a block"; return false; }
    const int type = (int)p[1];
    const int np = (int)p[4];
    if (np < 0 || np > 32 || end - p < 5 + np) { *err = "rig description: bad parameter count"; return false; }
    GBlock& g = blocks_[nBlocks_++];
    g.type = type;
    g.enabled = p[2] > 0.5f;
    g.trails = p[3] > 0.5f;
    g.fade = g.enabled ? 1.f : 0.f;
    // the looper only makes sense live; offline renders skip it
    if (!(offline && type == B_LOOPER)) g.b = createBlock(type);
    if (g.b) {
      for (int i = 0; i < np; i++) g.b->setParam(i, p[5 + i]);
      g.b->prepare(sr, maxBlock);
    }
    p += 5 + np;
  }
  return true;
}

Graph* Graph::build(const float* desc, int len, float sr, int maxBlock, bool offline, const char** err) {
  static const char* dummy;
  if (!err) err = &dummy;
  if (!desc || len < 7 || (int)desc[0] != 1) { *err = "rig description: unknown version"; return nullptr; }
  Graph* g = new (std::nothrow) Graph();
  if (!g) { *err = "out of memory"; return nullptr; }
  g->sr_ = sr;
  g->maxBlock_ = maxBlock = maxBlock > 0 ? maxBlock : 128;
  g->pathMode_ = (int)desc[1];
  g->nPaths_ = (int)clampf(desc[2], 1, 2);
  g->pathLevel_[0] = desc[3]; g->pathPan_[0] = desc[4];
  g->pathLevel_[1] = desc[5]; g->pathPan_[1] = desc[6];
  g->fadeStep_ = 1.f / (0.012f * sr);
  // upper bound for blocks: every 5 floats could start one
  const int maxBlocks = len / 5 + 1;
  g->blocks_ = new (std::nothrow) GBlock[maxBlocks];
  const float* p = desc + 7;
  const float* end = desc + len;
  for (int pi = 0; pi < g->nPaths_; pi++) {
    if (p >= end) { *err = "rig description: missing path"; delete g; return nullptr; }
    const int nn = (int)*p++;
    if (nn < 0 || nn > 64) { *err = "rig description: too many nodes"; delete g; return nullptr; }
    Path& path = g->paths_[pi];
    path.nodes = new (std::nothrow) Node[nn > 0 ? nn : 1];
    path.n = nn;
    for (int k = 0; k < nn; k++) {
      if (p >= end) { *err = "rig description: truncated"; delete g; return nullptr; }
      Node& node = path.nodes[k];
      if ((int)p[0] == 0) {
        node.kind = 0;
        node.block = g->nBlocks_;
        if (!g->parseBlocks(p, end, 1, sr, maxBlock, offline, err)) { delete g; return nullptr; }
      } else {
        if (end - p < 11) { *err = "rig description: truncated split"; delete g; return nullptr; }
        node.kind = 1;
        node.splitType = (int)p[1];
        node.s0 = p[2]; node.s1 = p[3];
        node.levelA = dbToGain(p[4]); node.levelB = dbToGain(p[5]);
        node.panA = p[6]; node.panB = p[7];
        node.invertB = p[8] > 0.5f;
        const int na = (int)p[9];
        p += 10;
        node.aFirst = g->nBlocks_; node.aCount = na;
        if (na < 0 || na > 32 || !g->parseBlocks(p, end, na, sr, maxBlock, offline, err)) { delete g; return nullptr; }
        if (p >= end) { *err = "rig description: truncated lane"; delete g; return nullptr; }
        const int nb = (int)*p++;
        node.bFirst = g->nBlocks_; node.bCount = nb;
        if (nb < 0 || nb > 32 || !g->parseBlocks(p, end, nb, sr, maxBlock, offline, err)) { delete g; return nullptr; }
        if (node.splitType == 2) { node.xo[0].set(sr, clampf(node.s0, 80, 8000)); node.xo[1].set(sr, clampf(node.s0, 80, 8000)); }
        node.env.set(sr, 2, 80);
      }
    }
  }
  float** bufs[] = { &g->bL_, &g->bR_, &g->pL_, &g->pR_, &g->dL_, &g->dR_, &g->zL_, &g->zR_ };
  for (float** b : bufs) *b = zalloc<float>(maxBlock);
  return g;
}

Graph::~Graph() {
  for (int i = 0; i < nBlocks_; i++) {
    delete blocks_[i].b;
    delete blocks_[i].nam;
    delete blocks_[i].ir[0];
    delete blocks_[i].ir[1];
  }
  delete[] blocks_;
  for (auto& p : paths_) delete[] p.nodes;
  float* bufs[] = { bL_, bR_, pL_, pR_, dL_, dR_, zL_, zR_ };
  for (float* b : bufs) std::free(b);
}

void Graph::setNam(int b, NamModel* m, float gain) {
  if (b < 0 || b >= nBlocks_) { delete m; return; }
  GBlock& g = blocks_[b];
  if (g.b) g.b->setNam(m, gain);
  delete g.nam;
  g.nam = m;
}
void Graph::setIr(int b, int slot, Convolver* c) {
  if (b < 0 || b >= nBlocks_ || slot < 0 || slot > 1) { delete c; return; }
  GBlock& g = blocks_[b];
  if (g.b) g.b->setIr(slot, c);
  delete g.ir[slot];
  g.ir[slot] = c;
}
void Graph::setParam(int b, int i, float v) { if (b >= 0 && b < nBlocks_ && blocks_[b].b && std::isfinite(v)) blocks_[b].b->setParam(i, v); }
void Graph::setEnabled(int b, bool on) { if (b >= 0 && b < nBlocks_) { blocks_[b].enabled = on; if (on) { blocks_[b].idle = false; blocks_[b].quietSamples = 0; } } }
void Graph::trigger(int b, int a) { if (b >= 0 && b < nBlocks_ && blocks_[b].b) blocks_[b].b->trigger(a); }
void Graph::setTempo(float bpm) { if (bpm > 20 && bpm < 400) for (int i = 0; i < nBlocks_; i++) if (blocks_[i].b) blocks_[i].b->setTempo(bpm); }
void Graph::setQuality(int q) { for (int i = 0; i < nBlocks_; i++) if (blocks_[i].b) blocks_[i].b->setQuality(q); }
void Graph::reset() { for (int i = 0; i < nBlocks_; i++) if (blocks_[i].b) blocks_[i].b->reset(); }
float Graph::blockMeter(int b) const { return b >= 0 && b < nBlocks_ && blocks_[b].b ? blocks_[b].b->meter() : 0.f; }
int Graph::blockState(int b) const { return b >= 0 && b < nBlocks_ && blocks_[b].b ? blocks_[b].b->state() : 0; }
int Graph::blockType(int b) const { return b >= 0 && b < nBlocks_ ? blocks_[b].type : 0; }

int Graph::latency() const {
  // longest path through enabled blocks
  int total = 0;
  for (int pi = 0; pi < nPaths_; pi++) {
    int sum = 0;
    for (int k = 0; k < paths_[pi].n; k++) {
      const Node& nd = paths_[pi].nodes[k];
      if (nd.kind == 0) { const GBlock& g = blocks_[nd.block]; if (g.b && g.enabled) sum += g.b->latency(); continue; }
      int a = 0, b = 0;
      for (int i = 0; i < nd.aCount; i++) { const GBlock& g = blocks_[nd.aFirst + i]; if (g.b && g.enabled) a += g.b->latency(); }
      for (int i = 0; i < nd.bCount; i++) { const GBlock& g = blocks_[nd.bFirst + i]; if (g.b && g.enabled) b += g.b->latency(); }
      sum += a > b ? a : b;
    }
    if (pathMode_ == 0) total += sum; else if (sum > total) total = sum;
  }
  return total;
}

void Graph::runBlock(GBlock& g, float* L, float* R, int n, bool& st) {
  Block* b = g.b;
  if (!b) return;
  const bool mono = !b->stereo();
  if (g.trails && b->timeBased()) {
    if (g.enabled) {
      if (mono) { if (st) for (int i = 0; i < n; i++) L[i] = 0.5f * (L[i] + R[i]); b->process(L, R, n); st = false; }
      else { if (!st) std::memcpy(R, L, sizeof(float) * n); b->process(L, R, n); st = true; }
      return;
    }
    if (g.idle) return;
    // bypassed with trails: the block hears silence and its tail is added to the signal
    std::memset(zL_, 0, sizeof(float) * n);
    std::memset(zR_, 0, sizeof(float) * n);
    b->process(zL_, zR_, n);
    if (!st) { std::memcpy(R, L, sizeof(float) * n); st = true; }
    float peak = 0;
    const float* zr = mono ? zL_ : zR_;
    for (int i = 0; i < n; i++) { L[i] += zL_[i]; R[i] += zr[i]; peak = std::fmax(peak, std::fabs(zL_[i]) + std::fabs(zr[i])); }
    if (peak < 1e-6f) { g.quietSamples += n; if (g.quietSamples > (int)(sr_ * 0.5f)) g.idle = true; }
    else g.quietSamples = 0;
    return;
  }
  const float target = g.enabled ? 1.f : 0.f;
  if (g.fade == target) {
    if (!g.enabled) return;
    if (mono) { if (st) for (int i = 0; i < n; i++) L[i] = 0.5f * (L[i] + R[i]); b->process(L, R, n); st = false; }
    else { if (!st) std::memcpy(R, L, sizeof(float) * n); b->process(L, R, n); st = true; }
    return;
  }
  // crossfade between the processed and the dry signal
  if (!st) { std::memcpy(R, L, sizeof(float) * n); st = true; }
  std::memcpy(dL_, L, sizeof(float) * n);
  std::memcpy(dR_, R, sizeof(float) * n);
  if (mono) { for (int i = 0; i < n; i++) L[i] = 0.5f * (L[i] + R[i]); b->process(L, R, n); std::memcpy(R, L, sizeof(float) * n); }
  else b->process(L, R, n);
  float f = g.fade;
  for (int i = 0; i < n; i++) {
    f = target > f ? std::fmin(target, f + fadeStep_) : std::fmax(target, f - fadeStep_);
    L[i] = f * L[i] + (1 - f) * dL_[i];
    R[i] = f * R[i] + (1 - f) * dR_[i];
  }
  g.fade = f;
  // a time-based block switched off without trails starts clean next time
  if (f == 0.f && b->timeBased()) b->reset();
}

void Graph::runRange(int first, int count, float* L, float* R, int n, bool& st) {
  for (int i = 0; i < count; i++) runBlock(blocks_[first + i], L, R, n, st);
}

void Graph::runPath(const Path& path, float* L, float* R, int n, bool& st) {
  for (int k = 0; k < path.n; k++) {
    Node& nd = path.nodes[k];
    if (nd.kind == 0) { runBlock(blocks_[nd.block], L, R, n, st); continue; }
    // split: lane B gets a copy
    if (!st) std::memcpy(R, L, sizeof(float) * n);
    bool stA = st, stB = st;
    std::memcpy(bL_, L, sizeof(float) * n);
    std::memcpy(bR_, R, sizeof(float) * n);
    switch (nd.splitType) {
      case 1: { // A/B balance: s0 = -1 (all A) .. 1 (all B)
        const float bal = clampf(nd.s0, -1, 1), ga = std::fmin(1.f, 1 - bal), gb = std::fmin(1.f, 1 + bal);
        for (int i = 0; i < n; i++) { L[i] *= ga; R[i] *= ga; bL_[i] *= gb; bR_[i] *= gb; }
        break;
      }
      case 2: // crossover: lows to A, highs to B
        for (int i = 0; i < n; i++) {
          float lo, hi;
          nd.xo[0].run(L[i], lo, hi); L[i] = lo; bL_[i] = hi;
          nd.xo[1].run(R[i], lo, hi); R[i] = lo; bR_[i] = hi;
        }
        break;
      case 3: { // dynamic: quiet to A, loud to B (s0 = threshold dB)
        const float thr = dbToGain(clampf(nd.s0, -70, 0));
        for (int i = 0; i < n; i++) {
          const float e = nd.env.run(0.5f * (L[i] + R[i]));
          nd.dynMix += 0.002f * ((e > thr ? 1.f : 0.f) - nd.dynMix);
          L[i] *= 1 - nd.dynMix; R[i] *= 1 - nd.dynMix; bL_[i] *= nd.dynMix; bR_[i] *= nd.dynMix;
        }
        break;
      }
      default: break; // Y: both lanes get everything
    }
    runRange(nd.aFirst, nd.aCount, L, R, n, stA);
    runRange(nd.bFirst, nd.bCount, bL_, bR_, n, stB);
    if (!stA) std::memcpy(R, L, sizeof(float) * n);
    if (!stB) std::memcpy(bR_, bL_, sizeof(float) * n);
    float al, ar, bl, br;
    panGains(nd.panA, al, ar);
    panGains(nd.panB, bl, br);
    const float la = nd.levelA, lb = nd.levelB * (nd.invertB ? -1.f : 1.f);
    for (int i = 0; i < n; i++) {
      const float l = la * al * L[i] + lb * bl * bL_[i];
      const float r = la * ar * R[i] + lb * br * bR_[i];
      L[i] = l; R[i] = r;
    }
    st = stA || stB || nd.panA != 0 || nd.panB != 0;
  }
}

void Graph::runChunk(float* L, float* R, int n, bool& st) {
  if (nPaths_ == 1 || pathMode_ == 0) {
    for (int pi = 0; pi < nPaths_; pi++) runPath(paths_[pi], L, R, n, st);
    if (nPaths_ == 1 && (pathLevel_[0] != 1 || pathPan_[0] != 0)) {
      if (!st) { std::memcpy(R, L, sizeof(float) * n); }
      float gl, gr;
      panGains(pathPan_[0], gl, gr);
      const float lv = pathLevel_[0];
      for (int i = 0; i < n; i++) { L[i] *= lv * gl; R[i] *= lv * gr; }
      st = st || pathPan_[0] != 0;
    }
    return;
  }
  // parallel paths: B starts from the same input
  std::memcpy(pL_, L, sizeof(float) * n);
  std::memcpy(pR_, st ? R : L, sizeof(float) * n);
  bool stA = st, stB = st;
  runPath(paths_[0], L, R, n, stA);
  runPath(paths_[1], pL_, pR_, n, stB);
  if (!stA) std::memcpy(R, L, sizeof(float) * n);
  if (!stB) std::memcpy(pR_, pL_, sizeof(float) * n);
  float al, ar, bl, br;
  panGains(pathPan_[0], al, ar);
  panGains(pathPan_[1], bl, br);
  for (int i = 0; i < n; i++) {
    const float l = pathLevel_[0] * al * L[i] + pathLevel_[1] * bl * pL_[i];
    const float r = pathLevel_[0] * ar * R[i] + pathLevel_[1] * br * pR_[i];
    L[i] = l; R[i] = r;
  }
  st = true;
}

bool Graph::process(float* L, float* R, int n) {
  bool stereoOut = false;
  while (n > 0) {
    const int k = n < maxBlock_ ? n : maxBlock_;
    bool st = false;
    runChunk(L, R, k, st);
    if (!st) std::memcpy(R, L, sizeof(float) * k);
    stereoOut = stereoOut || st;
    for (int i = 0; i < k; i++) { if (!(L[i] == L[i])) L[i] = 0; if (!(R[i] == R[i])) R[i] = 0; }
    L += k; R += k; n -= k;
  }
  return stereoOut;
}

// ------------------------------------------------------------------ chain
Chain::Chain(float sr, int maxBlock) : sr_(sr), maxBlock_(maxBlock > 0 ? maxBlock : 128) {
  inGain_.setTime(sr, 20); outGain_.setTime(sr, 20);
  inGain_.snap(1); outGain_.snap(1);
  oL_ = zalloc<float>(maxBlock_); oR_ = zalloc<float>(maxBlock_); tmp_ = zalloc<float>(maxBlock_);
  for (int c = 0; c < 2; c++) { eq_[c] = createBlock(B_EQ_PARAM); eq_[c]->prepare(sr, maxBlock_); }
  det_.prepare(sr);
  xfadeLen_ = (int)(0.03f * sr);
  for (int i = 0; i < kMeters; i++) { meters_[i].store(0); states_[i].store(0); }
}

Chain::~Chain() {
  delete cur_;
  delete old_;
  delete pending_.exchange(nullptr);
  delete retired_.exchange(nullptr);
  delete eq_[0]; delete eq_[1];
  std::free(oL_); std::free(oR_); std::free(tmp_);
}

void Chain::swap(Graph* g) {
  if (Graph* r = collect()) delete r;
  if (g) { g->setTempo(tempo_); g->setQuality(quality_); }
  Graph* prev = pending_.exchange(g, std::memory_order_acq_rel);
  delete prev; // never picked up
}

Graph* Chain::collect() { return retired_.exchange(nullptr, std::memory_order_acq_rel); }

void Chain::post(int op, int block, int index, float value) {
  const uint32_t h = head_.load(std::memory_order_relaxed);
  const uint32_t t = tail_.load(std::memory_order_acquire);
  if (h - t >= (uint32_t)kQueue) return; // full: drop (the UI sends the latest value again)
  queue_[h % kQueue] = Cmd{ op, block, index, value };
  head_.store(h + 1, std::memory_order_release);
}

void Chain::apply(const Cmd& c) {
  switch (c.op) {
    case OP_PARAM: if (cur_) cur_->setParam(c.block, c.index, c.value); break;
    case OP_ENABLE: if (cur_) cur_->setEnabled(c.block, c.value > 0.5f); break;
    case OP_TRIGGER: if (cur_) cur_->trigger(c.block, c.index); break;
    case OP_TEMPO: tempo_ = c.value; if (cur_) cur_->setTempo(c.value); break;
    case OP_QUALITY: quality_ = c.index; if (cur_) cur_->setQuality(c.index); latency_.store(cur_ ? cur_->latency() : 0); break;
    case OP_IO:
      if (c.index == 0) inGain_.set(dbToGain(clampf(c.value, -40, 24)));
      else if (c.index == 1) outGain_.set(dbToGain(clampf(c.value, -60, 24)));
      else if (c.index == 2) { tuner_ = c.value > 0.5f; if (!tuner_) tunerHz_.store(0); }
      else if (c.index >= 10 && c.index < 20) {
        eq_[0]->setParam(c.index - 10, c.value); eq_[1]->setParam(c.index - 10, c.value);
        eqOn_ = true;
      }
      break;
    default: break;
  }
}

void Chain::process(const float* in, float* outL, float* outR, int n) {
  // install a new graph and crossfade from the old one (only once the previous old graph is retired)
  if (old_ && xfade_ == 0) {
    Graph* expected = nullptr;
    if (retired_.compare_exchange_strong(expected, old_, std::memory_order_acq_rel)) old_ = nullptr;
  }
  if (!old_ && pending_.load(std::memory_order_relaxed)) {
    Graph* next = pending_.exchange(nullptr, std::memory_order_acq_rel);
    if (next) {
      old_ = cur_;
      cur_ = next;
      xfade_ = old_ ? xfadeLen_ : 0;
      latency_.store(cur_->latency(), std::memory_order_relaxed);
    }
  }
  const uint32_t h = head_.load(std::memory_order_acquire);
  uint32_t t = tail_.load(std::memory_order_relaxed);
  while (t != h) { apply(queue_[t % kQueue]); t++; }
  tail_.store(t, std::memory_order_release);
  while (n > 0) {
    const int k = n < maxBlock_ ? n : maxBlock_;
    processChunk(in, outL, outR, k);
    in += k; outL += k; outR += k; n -= k;
  }
  if (cur_) {
    const int nb = cur_->blockCount() < kMeters ? cur_->blockCount() : kMeters;
    for (int b = 0; b < nb; b++) {
      meters_[b].store(cur_->blockMeter(b), std::memory_order_relaxed);
      states_[b].store(cur_->blockState(b), std::memory_order_relaxed);
    }
  }
}

void Chain::processChunk(const float* in, float* L, float* R, int n) {
  float ip = inPeak_.load(std::memory_order_relaxed);
  for (int i = 0; i < n; i++) {
    const float x = in[i] * inGain_.next();
    L[i] = x; tmp_[i] = x;
    ip = std::fmax(ip, std::fabs(x));
    if (tuner_) det_.push(x);
  }
  inPeak_.store(ip, std::memory_order_relaxed);
  if (tuner_) tunerHz_.store(det_.confidence() > 0.85f ? det_.frequency() : 0.f, std::memory_order_relaxed);
  if (cur_) cur_->process(L, R, n);
  else std::memcpy(R, L, sizeof(float) * n);
  if (old_ && xfade_ > 0) {
    std::memcpy(oL_, tmp_, sizeof(float) * n);
    old_->process(oL_, oR_, n);
    for (int i = 0; i < n; i++) {
      const float f = xfade_ > 0 ? (float)xfade_ / (float)xfadeLen_ : 0.f;
      L[i] = (1 - f) * L[i] + f * oL_[i];
      R[i] = (1 - f) * R[i] + f * oR_[i];
      if (xfade_ > 0) xfade_--;
    }
  }
  if (eqOn_) { eq_[0]->process(L, nullptr, n); eq_[1]->process(R, nullptr, n); }
  float op = outPeak_.load(std::memory_order_relaxed);
  for (int i = 0; i < n; i++) {
    const float g = tuner_ ? 0.f : outGain_.next();
    L[i] *= g; R[i] *= g;
    op = std::fmax(op, std::fmax(std::fabs(L[i]), std::fabs(R[i])));
  }
  outPeak_.store(op, std::memory_order_relaxed);
}

} // namespace forge
