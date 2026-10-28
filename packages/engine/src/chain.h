// forge-dsp: rig graphs and the live chain.
//
// A Graph is one rig: up to two paths (in series or in parallel), each a list of nodes. A node
// is a block or a split with two lanes of blocks that merge again (Helix-style). Graphs are
// built from a flat float description (packages/shared/src/rigGraph.ts writes it):
//
//   [version=1, pathMode (0 series, 1 parallel), nPaths, levelA, panA, levelB, panB,
//    for each path: nNodes, nodes...]
//   block node: [0, type, enabled, trails, nParams, params...]
//   split node: [1, splitType (0 Y, 1 A/B, 2 crossover, 3 dynamic), s0, s1,
//                levelA, levelB, panA, panB, invertB, nA, blocks..., nB, blocks...]
//
// Blocks are numbered in the order they appear. The graph owns its blocks and the NAM models
// and IRs given to it.
//
// A Chain plays graphs live: input gain -> graph -> global EQ -> output gain, with a tuner and
// meters. New graphs are handed over through an atomic pointer and crossfaded in, so a rig
// change never clicks; parameter changes go through a lock-free queue.
#pragma once
#include <atomic>
#include <cstdint>

#include "blocks.h"
#include "dsp.h"
#include "pitch.h"

namespace forge {

class NamModel;
class Convolver;

class Graph {
public:
  static Graph* build(const float* desc, int len, float sampleRate, int maxBlock, bool offline, const char** error);
  ~Graph();
  int blockCount() const { return nBlocks_; }
  void setNam(int block, NamModel* m, float gain);
  void setIr(int block, int slot, Convolver* c);
  void setParam(int block, int index, float value);
  void setEnabled(int block, bool on);
  void trigger(int block, int action);
  void setTempo(float bpm);
  void setQuality(int q);
  void reset();
  int latency() const;
  float blockMeter(int block) const;
  int blockState(int block) const;
  int blockType(int block) const;
  /** in place; the input is mono in L. Returns true if the output is stereo (R valid). */
  bool process(float* L, float* R, int n);

private:
  Graph() = default;
  struct GBlock {
    Block* b = nullptr;
    int type = 0;
    bool enabled = true, trails = false, idle = false;
    float fade = 1;
    int quietSamples = 0;
    NamModel* nam = nullptr;
    Convolver* ir[2] = { nullptr, nullptr };
  };
  struct Node {
    int kind = 0; // 0 block, 1 split
    int block = -1;
    int splitType = 0;
    float s0 = 0, s1 = 0;
    float levelA = 1, levelB = 1, panA = 0, panB = 0;
    bool invertB = false;
    int aFirst = 0, aCount = 0, bFirst = 0, bCount = 0;
    Crossover xo[2];
    Envelope env;
    float dynMix = 0;
  };
  struct Path { Node* nodes = nullptr; int n = 0; };

  bool parseBlocks(const float*& p, const float* end, int count, float sr, int maxBlock, bool offline, const char** err);
  void runBlock(GBlock& g, float* L, float* R, int n, bool& st);
  void runRange(int first, int count, float* L, float* R, int n, bool& st);
  void runPath(const Path& path, float* L, float* R, int n, bool& st);
  void runChunk(float* L, float* R, int n, bool& st);

  GBlock* blocks_ = nullptr;
  int nBlocks_ = 0;
  Path paths_[2];
  int nPaths_ = 0;
  int pathMode_ = 0;
  float pathLevel_[2] = { 1, 1 }, pathPan_[2] = { 0, 0 };
  int maxBlock_ = 128;
  float sr_ = 48000;
  float fadeStep_ = 0.01f;
  // scratch: lane B, parallel path B, dry copy for fades, zeros for trails
  float *bL_ = nullptr, *bR_ = nullptr, *pL_ = nullptr, *pR_ = nullptr, *dL_ = nullptr, *dR_ = nullptr, *zL_ = nullptr, *zR_ = nullptr;
};

class Chain {
public:
  Chain(float sampleRate, int maxBlock);
  ~Chain();
  // ---- control thread
  /** hands a graph to the audio thread; the chain owns it from now on */
  void swap(Graph* g);
  /** returns a graph the audio thread has let go of (delete it), or nullptr */
  Graph* collect();
  void setParam(int block, int index, float value) { post(OP_PARAM, block, index, value); }
  void setEnabled(int block, bool on) { post(OP_ENABLE, block, 0, on ? 1.f : 0.f); }
  void trigger(int block, int action) { post(OP_TRIGGER, block, action, 0); }
  void setTempo(float bpm) { post(OP_TEMPO, 0, 0, bpm); }
  void setQuality(int q) { post(OP_QUALITY, 0, q, 0); }
  /** 0 input dB, 1 output dB, 2 tuner (mute while on), 10..19 global EQ (parametric EQ params) */
  void setIo(int which, float value) { post(OP_IO, 0, which, value); }
  float takeInPeak() { return inPeak_.exchange(0, std::memory_order_relaxed); }
  float takeOutPeak() { return outPeak_.exchange(0, std::memory_order_relaxed); }
  float tunerHz() const { return tunerHz_.load(std::memory_order_relaxed); }
  int latency() const { return latency_.load(std::memory_order_relaxed); }
  float blockMeter(int b) const { return b >= 0 && b < kMeters ? meters_[b].load(std::memory_order_relaxed) : 0.f; }
  int blockState(int b) const { return b >= 0 && b < kMeters ? states_[b].load(std::memory_order_relaxed) : 0; }
  // ---- audio thread
  void process(const float* in, float* outL, float* outR, int n);

private:
  enum { OP_PARAM = 1, OP_ENABLE, OP_TRIGGER, OP_TEMPO, OP_QUALITY, OP_IO };
  struct Cmd { int op, block, index; float value; };
  static constexpr int kQueue = 2048;
  static constexpr int kMeters = 64;
  void post(int op, int block, int index, float value);
  void apply(const Cmd& c);
  void processChunk(const float* in, float* outL, float* outR, int n);

  float sr_;
  int maxBlock_;
  Cmd queue_[kQueue];
  std::atomic<uint32_t> head_{ 0 }, tail_{ 0 };
  std::atomic<Graph*> pending_{ nullptr };
  std::atomic<Graph*> retired_{ nullptr };
  Graph* cur_ = nullptr;
  Graph* old_ = nullptr;
  int xfade_ = 0, xfadeLen_ = 1;
  float tempo_ = 120;
  int quality_ = 1;
  Smooth inGain_, outGain_;
  bool tuner_ = false;
  Block* eq_[2] = { nullptr, nullptr };
  bool eqOn_ = false;
  PitchDetector det_;
  float *oL_ = nullptr, *oR_ = nullptr, *tmp_ = nullptr;
  std::atomic<float> inPeak_{ 0 }, outPeak_{ 0 }, tunerHz_{ 0 };
  std::atomic<int> latency_{ 0 };
  std::atomic<float> meters_[kMeters];
  std::atomic<int> states_[kMeters];
};

} // namespace forge
