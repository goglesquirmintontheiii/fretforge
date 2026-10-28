// EQ, volume, gain, pan and stereo width.
#include <cmath>

#include "blocks.h"
#include "dsp.h"

namespace forge {
namespace {

/** a mono chain of biquads with an output level */
class EqBase : public Block {
public:
  void setParam(int i, float v) override { if (i >= 0 && i < 12) { p_[i] = v; dirty_ = true; } }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); level_.setTime(sr, 20); configure(); level_.snap(level_.target); dirty_ = false; }
  void reset() override { for (int b = 0; b < nb_; b++) bq_[b].reset(); }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int b = 0; b < nb_; b++) {
      Biquad& f = bq_[b];
      if (!f.active) continue;
      for (int i = 0; i < n; i++) L[i] = f.run(L[i]);
    }
    for (int i = 0; i < n; i++) L[i] *= level_.next();
  }
protected:
  virtual void configure() = 0;
  float p_[12] = {};
  bool dirty_ = true;
  Biquad bq_[12];
  int nb_ = 0;
  Smooth level_;
};

// Simple EQ: Low, Mid, Mid Freq, High, Level
class SimpleEq : public EqBase {
public:
  SimpleEq() { p_[2] = 800; nb_ = 3; }
protected:
  void configure() override {
    bq_[0].lowShelf(sr_, 120, clampf(p_[0], -15, 15));
    bq_[1].peak(sr_, clampf(p_[2], 150, 6000), 0.8f, clampf(p_[1], -15, 15));
    bq_[2].highShelf(sr_, 3200, clampf(p_[3], -15, 15));
    level_.set(dbToGain(p_[4]));
  }
};

// Parametric EQ: Low Cut, Low Freq, Low Gain, Mid Freq, Mid Q, Mid Gain, High Freq, High Gain, High Cut, Level
class ParamEq : public EqBase {
public:
  ParamEq() { p_[0] = 0; p_[1] = 120; p_[3] = 800; p_[4] = 0.7f; p_[6] = 4000; p_[8] = 0; nb_ = 5; }
protected:
  void configure() override {
    if (p_[0] > 10) bq_[0].lowCut(sr_, p_[0]); else bq_[0].bypass();
    bq_[1].lowShelf(sr_, clampf(p_[1], 30, 1000), clampf(p_[2], -15, 15));
    bq_[2].peak(sr_, clampf(p_[3], 80, 10000), clampf(p_[4], 0.1f, 10), clampf(p_[5], -15, 15));
    bq_[3].highShelf(sr_, clampf(p_[6], 1000, 16000), clampf(p_[7], -15, 15));
    if (p_[8] > 100 && p_[8] < sr_ * 0.45f) bq_[4].highCut(sr_, p_[8]); else bq_[4].bypass();
    level_.set(dbToGain(p_[9]));
  }
};

// 10-Band Graphic EQ: 31 Hz .. 16 kHz gains, Level
class GraphicEq : public EqBase {
public:
  GraphicEq() { nb_ = 10; }
protected:
  void configure() override {
    static const float f[10] = { 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 };
    for (int b = 0; b < 10; b++) {
      if (f[b] < sr_ * 0.45f) bq_[b].peak(sr_, f[b], 1.4f, clampf(p_[b], -15, 15));
      else bq_[b].bypass();
    }
    level_.set(dbToGain(p_[10]));
  }
};

// Low/High Cut (24 dB/oct): Low Cut, High Cut
class CutEq : public EqBase {
public:
  CutEq() { p_[0] = 80; p_[1] = 8000; nb_ = 4; }
protected:
  void configure() override {
    if (p_[0] > 10) { bq_[0].lowCut(sr_, p_[0]); bq_[1].lowCut(sr_, p_[0]); } else { bq_[0].bypass(); bq_[1].bypass(); }
    if (p_[1] > 100 && p_[1] < sr_ * 0.45f) { bq_[2].highCut(sr_, p_[1]); bq_[3].highCut(sr_, p_[1]); } else { bq_[2].bypass(); bq_[3].bypass(); }
    level_.set(1);
  }
};

// Five-Band EQ (80/240/750/2200/6600 Hz, Mesa-style sliders): 5 gains, Level
class FiveEq : public EqBase {
public:
  FiveEq() { nb_ = 5; }
protected:
  void configure() override {
    static const float f[5] = { 80, 240, 750, 2200, 6600 };
    for (int b = 0; b < 5; b++) bq_[b].peak(sr_, f[b], 1.1f, clampf(p_[b], -12, 12));
    level_.set(dbToGain(p_[5]));
  }
};

// Volume Pedal: Position (0..1), Min (0..1), Max (0..1), Taper (0 linear, 1 audio)
class VolumePedal : public Block {
public:
  VolumePedal() { p_[0] = 1; p_[1] = 0; p_[2] = 1; p_[3] = 1; }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); g_.setTime(sr, 15); update(); g_.snap(g_.target); }
  void setParam(int i, float v) override { if (i >= 0 && i < 4) { p_[i] = v; update(); } }
  void process(float* L, float*, int n) override { for (int i = 0; i < n; i++) L[i] *= g_.next(); }
private:
  void update() {
    const float pos = clampf(p_[0], 0, 1);
    float t = lerp(clampf(p_[1], 0, 1), clampf(p_[2], 0, 1), pos);
    if (p_[3] > 0.5f) t = t * t * t; // audio taper
    g_.set(t);
  }
  float p_[4];
  Smooth g_;
};

// Gain: Gain (dB)
class GainBlock : public Block {
public:
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); g_.setTime(sr, 15); g_.snap(g_.target); }
  void setParam(int i, float v) override { if (i == 0) g_.set(dbToGain(clampf(v, -60, 24))); }
  void process(float* L, float*, int n) override { for (int i = 0; i < n; i++) L[i] *= g_.next(); }
private:
  Smooth g_{ 1, 1, 1 };
};

// Pan: Pan (-1..1), constant power
class PanBlock : public Block {
public:
  bool stereo() const override { return true; }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); l_.setTime(sr, 15); r_.setTime(sr, 15); setParam(0, pan_); l_.snap(l_.target); r_.snap(r_.target); }
  void setParam(int i, float v) override {
    if (i != 0) return;
    pan_ = clampf(v, -1, 1);
    const float a = (pan_ + 1) * 0.25f * kPi;
    l_.set(std::cos(a) * 1.41421356f);
    r_.set(std::sin(a) * 1.41421356f);
  }
  void process(float* L, float* R, int n) override {
    for (int i = 0; i < n; i++) { L[i] *= l_.next(); R[i] *= r_.next(); }
  }
private:
  float pan_ = 0;
  Smooth l_, r_;
};

// Stereo Width: Width (0..2)
class WidthBlock : public Block {
public:
  bool stereo() const override { return true; }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); w_.setTime(sr, 20); w_.snap(w_.target); }
  void setParam(int i, float v) override { if (i == 0) w_.set(clampf(v, 0, 2)); }
  void process(float* L, float* R, int n) override {
    for (int i = 0; i < n; i++) {
      const float m = 0.5f * (L[i] + R[i]), s = 0.5f * (L[i] - R[i]) * w_.next();
      L[i] = m + s; R[i] = m - s;
    }
  }
private:
  Smooth w_{ 1, 1, 1 };
};

} // namespace

Block* createEq(int type) {
  switch (type) {
    case B_EQ_SIMPLE: return new SimpleEq();
    case B_EQ_PARAM: return new ParamEq();
    case B_EQ_GRAPHIC: return new GraphicEq();
    case B_EQ_CUT: return new CutEq();
    case B_EQ_FIVE: return new FiveEq();
    case B_VOLUME: return new VolumePedal();
    case B_GAIN: return new GainBlock();
    case B_PAN: return new PanBlock();
    case B_WIDTH: return new WidthBlock();
    default: return nullptr;
  }
}

} // namespace forge
