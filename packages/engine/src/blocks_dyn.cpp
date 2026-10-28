// Compressors and gates (mono). meter() reports the current gain reduction in dB.
#include <cmath>

#include "blocks.h"
#include "dsp.h"

namespace forge {
namespace {

/** feed-forward gain computer with a soft knee, smoothing in the dB domain */
struct GainComputer {
  float thr = -20, ratio = 4, knee = 6;
  float att = 1, rel = 1, gr = 0;
  void times(float sr, float attackMs, float releaseMs) {
    att = 1.f - std::exp(-1.f / (0.001f * (attackMs > 0.05f ? attackMs : 0.05f) * sr));
    rel = 1.f - std::exp(-1.f / (0.001f * (releaseMs > 1 ? releaseMs : 1) * sr));
  }
  inline float curve(float levelDb) const {
    const float over = levelDb - thr, slope = 1.f / ratio - 1.f;
    if (2 * over < -knee) return 0;
    if (knee > 0 && 2 * std::fabs(over) <= knee) { const float t = over + knee / 2; return slope * t * t / (2 * knee); }
    return slope * over;
  }
  /** returns the linear gain for a detector level (linear) */
  inline float run(float det) {
    const float target = curve(gainToDb(det));
    gr += (target < gr ? att : rel) * (target - gr);
    return dbToGain(gr);
  }
};

class CompBase : public Block {
public:
  void setParam(int i, float v) override { if (i >= 0 && i < 12) { p_[i] = v; dirty_ = true; } }
  float meter() const override { return meter_; }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); mix_.setTime(sr, 20); makeup_.setTime(sr, 20); configure(); mix_.snap(mix_.target); makeup_.snap(makeup_.target); dirty_ = false; }
protected:
  virtual void configure() = 0;
  float p_[12] = {};
  bool dirty_ = true;
  float meter_ = 0;
  Smooth mix_, makeup_;
};

// Squeeze Comp (Dyna Comp-style): Sensitivity, Level (dB), Mix
class SqueezeComp : public CompBase {
public:
  SqueezeComp() { p_[0] = 5; p_[1] = 0; p_[2] = 1; }
  void reset() override { det_.reset(); gc_.gr = 0; tone_.reset(); }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      const float x = L[i];
      const float g = gc_.run(det_.run(x));
      const float y = tone_.run(x * g) * makeup_.next();
      const float m = mix_.next();
      L[i] = m * y + (1 - m) * x;
    }
    meter_ = gc_.gr;
  }
protected:
  void configure() override {
    gc_.thr = -12.f - clampf(p_[0], 0, 10) * 3.6f;
    gc_.ratio = 8; gc_.knee = 6;
    gc_.times(sr_, 3, 140);
    det_.set(sr_, 0.5f, 25);
    tone_.highCut(sr_, 9000);
    makeup_.set(dbToGain(-gc_.thr * 0.38f + p_[1]));
    mix_.set(clampf(p_[2], 0, 1));
  }
private:
  GainComputer gc_;
  Envelope det_;
  Biquad tone_;
};

// Opto Comp (LA-2A-style): Peak Reduction (0..100), Gain (dB), Mix
class OptoComp : public CompBase {
public:
  OptoComp() { p_[0] = 40; p_[1] = 0; p_[2] = 1; }
  void reset() override { det_.reset(); emph_.reset(); fast_ = slow_ = 0; }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      const float x = L[i];
      const float target = gc_.curve(gainToDb(det_.run(emph_.run(x))));
      // program-dependent release: a fast cell and a slow cell, like the optical element
      fast_ += (target < fast_ ? att_ : relFast_) * (target - fast_);
      slow_ += (target < slow_ ? att_ : relSlow_) * (target - slow_);
      const float gr = 0.6f * fast_ + 0.4f * slow_;
      const float y = x * dbToGain(gr) * makeup_.next();
      const float m = mix_.next();
      L[i] = m * y + (1 - m) * x;
      meter_ = gr;
    }
  }
protected:
  void configure() override {
    gc_.thr = -6.f - clampf(p_[0], 0, 100) * 0.4f;
    gc_.ratio = 3.5f; gc_.knee = 10;
    att_ = 1.f - std::exp(-1.f / (0.010f * sr_));
    relFast_ = 1.f - std::exp(-1.f / (0.060f * sr_));
    relSlow_ = 1.f - std::exp(-1.f / (1.5f * sr_));
    det_.set(sr_, 1, 30);
    emph_.highShelf(sr_, 3000, 4);
    makeup_.set(dbToGain(-gc_.thr * 0.3f + p_[1]));
    mix_.set(clampf(p_[2], 0, 1));
  }
private:
  GainComputer gc_;
  Envelope det_;
  Biquad emph_;
  float fast_ = 0, slow_ = 0, att_ = 1, relFast_ = 1, relSlow_ = 1;
};

// Studio Comp: Threshold, Ratio, Attack, Release, Knee, Makeup, Mix
class StudioComp : public CompBase {
public:
  StudioComp() { p_[0] = -20; p_[1] = 4; p_[2] = 10; p_[3] = 120; p_[4] = 6; p_[5] = 0; p_[6] = 1; }
  void reset() override { ms_ = 0; gc_.gr = 0; }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      const float x = L[i];
      ms_ += rms_ * (x * x - ms_);
      const float g = gc_.run(std::sqrt(ms_ * 2.f));
      const float y = x * g * makeup_.next();
      const float m = mix_.next();
      L[i] = m * y + (1 - m) * x;
    }
    meter_ = gc_.gr;
  }
protected:
  void configure() override {
    gc_.thr = clampf(p_[0], -60, 0);
    gc_.ratio = clampf(p_[1], 1, 30);
    gc_.knee = clampf(p_[4], 0, 24);
    gc_.times(sr_, p_[2], p_[3]);
    rms_ = 1.f - std::exp(-1.f / (0.004f * sr_));
    makeup_.set(dbToGain(p_[5]));
    mix_.set(clampf(p_[6], 0, 1));
  }
private:
  GainComputer gc_;
  float ms_ = 0, rms_ = 1;
};

// Multiband Comp: LowFreq, HighFreq, LowThr, MidThr, HighThr, Ratio, LowGain, MidGain, HighGain, Attack, Release
class MultiComp : public CompBase {
public:
  MultiComp() { p_[0] = 200; p_[1] = 2500; p_[2] = -24; p_[3] = -24; p_[4] = -24; p_[5] = 3; p_[6] = 0; p_[7] = 0; p_[8] = 0; p_[9] = 10; p_[10] = 150; }
  void reset() override { x1_.reset(); x2_.reset(); ap_.reset(); for (auto& d : det_) d.reset(); for (auto& g : gc_) g.gr = 0; }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      float low, rest, mid, high;
      x1_.run(L[i], low, rest);
      x2_.run(rest, mid, high);
      // keep the low band in phase with the two upper bands
      low = ap_.run(low);
      float band[3] = { low, mid, high };
      float y = 0;
      for (int b = 0; b < 3; b++) y += band[b] * gc_[b].run(det_[b].run(band[b])) * gain_[b];
      L[i] = y;
    }
    meter_ = std::fmin(gc_[0].gr, std::fmin(gc_[1].gr, gc_[2].gr));
  }
protected:
  void configure() override {
    const float lo = clampf(p_[0], 40, 1000), hi = clampf(p_[1], lo * 2, 12000);
    x1_.set(sr_, lo);
    x2_.set(sr_, hi);
    ap_.allpass(sr_, hi, 0.7071f);
    for (int b = 0; b < 3; b++) {
      gc_[b].thr = clampf(p_[2 + b], -60, 0);
      gc_[b].ratio = clampf(p_[5], 1, 20);
      gc_[b].knee = 6;
      gc_[b].times(sr_, p_[9], p_[10]);
      det_[b].set(sr_, 0.5f, 20);
      gain_[b] = dbToGain(clampf(p_[6 + b], -12, 12));
    }
  }
private:
  Crossover x1_, x2_;
  Biquad ap_;
  GainComputer gc_[3];
  Envelope det_[3];
  float gain_[3] = { 1, 1, 1 };
};

// Noise Gate: Threshold (dB), Decay (ms)
// Hard Gate: Threshold, Attack (ms), Hold (ms), Release (ms), Range (dB)
class Gate : public CompBase {
public:
  explicit Gate(bool hard) : hard_(hard) {
    if (hard) { p_[0] = -55; p_[1] = 0.5f; p_[2] = 40; p_[3] = 120; p_[4] = -80; }
    else { p_[0] = -60; p_[1] = 100; }
  }
  void reset() override { det_.reset(); g_ = 1; open_ = false; holdLeft_ = 0; }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      const float e = det_.run(L[i]);
      if (open_) {
        if (e < close_) { if (holdLeft_ > 0) holdLeft_--; else open_ = false; }
        else holdLeft_ = hold_;
      } else if (e > openLvl_) { open_ = true; holdLeft_ = hold_; }
      const float target = open_ ? 1.f : floor_;
      g_ += (target > g_ ? att_ : rel_) * (target - g_);
      L[i] *= g_;
    }
    meter_ = gainToDb(g_);
  }
protected:
  void configure() override {
    const float thr = clampf(p_[0], -96, 0);
    openLvl_ = dbToGain(thr);
    close_ = dbToGain(thr - 4);
    if (hard_) {
      att_ = 1.f - std::exp(-1.f / (0.001f * clampf(p_[1], 0.05f, 50) * sr_));
      hold_ = (int)(0.001f * clampf(p_[2], 0, 500) * sr_);
      rel_ = 1.f - std::exp(-1.f / (0.001f * clampf(p_[3], 5, 2000) * sr_));
      floor_ = dbToGain(clampf(p_[4], -96, 0));
    } else {
      att_ = 1.f - std::exp(-1.f / (0.0005f * sr_));
      hold_ = (int)(0.03f * sr_);
      rel_ = 1.f - std::exp(-1.f / (0.001f * clampf(p_[1], 5, 2000) * sr_));
      floor_ = 0;
    }
    det_.set(sr_, 0.2f, 15);
  }
private:
  bool hard_;
  Envelope det_;
  float g_ = 1, openLvl_ = 0.001f, close_ = 0.0006f, att_ = 1, rel_ = 1, floor_ = 0;
  int hold_ = 0, holdLeft_ = 0;
  bool open_ = false;
};

} // namespace

Block* createDynamics(int type) {
  switch (type) {
    case B_COMP_SQUEEZE: return new SqueezeComp();
    case B_COMP_OPTO: return new OptoComp();
    case B_COMP_STUDIO: return new StudioComp();
    case B_COMP_MULTI: return new MultiComp();
    case B_GATE_SIMPLE: return new Gate(false);
    case B_GATE_HARD: return new Gate(true);
    default: return nullptr;
  }
}

} // namespace forge
