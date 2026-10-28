// Envelope filter, synth filter and wahs (mono).
#include <cmath>

#include "blocks.h"
#include "dsp.h"

namespace forge {
namespace {

// Envelope Filter (Mu-Tron-style): Sensitivity, Range (0 low, 1 high), Q, Mode (0 LP, 1 BP, 2 HP), Direction (0 up, 1 down), Mix
class EnvFilter : public Block {
public:
  EnvFilter() { p_[0] = 0.6f; p_[1] = 0; p_[2] = 4; p_[3] = 1; p_[4] = 0; p_[5] = 1; }
  void setParam(int i, float v) override { if (i >= 0 && i < 6) p_[i] = v; }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); env_.set(sr, 4, 120); }
  void reset() override { env_.reset(); svf_.reset(); }
  void process(float* L, float*, int n) override {
    const float sens = clampf(p_[0], 0, 1) * 12.f;
    const float lo = p_[1] > 0.5f ? 300.f : 150.f, hi = p_[1] > 0.5f ? 3500.f : 1800.f;
    const float q = clampf(p_[2], 0.5f, 12);
    const int mode = (int)p_[3];
    const bool down = p_[4] > 0.5f;
    const float mix = clampf(p_[5], 0, 1);
    for (int i = 0; i < n; i++) {
      const float x = L[i];
      float e = clampf(env_.run(x) * sens, 0, 1);
      if (down) e = 1 - e;
      if ((i & 7) == 0) svf_.set(sr_, lo * std::pow(hi / lo, e), q);
      svf_.run(x);
      const float y = mode == 0 ? svf_.lp : (mode == 2 ? svf_.hp : svf_.bp * 2.2f);
      L[i] = (1 - mix) * x + mix * y;
    }
  }
private:
  float p_[6];
  Envelope env_;
  Svf svf_;
};

// Synth Filter (ladder): Cutoff (Hz), Resonance (0..1), Envelope, LFO Rate, LFO Depth, Mix
class SynthFilter : public Block {
public:
  SynthFilter() { p_[0] = 800; p_[1] = 0.5f; p_[2] = 0.5f; p_[3] = 1; p_[4] = 0; p_[5] = 1; }
  void setParam(int i, float v) override { if (i >= 0 && i < 6) p_[i] = v; }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); env_.set(sr, 3, 150); }
  void reset() override { env_.reset(); for (float& s : s_) s = 0; }
  void process(float* L, float*, int n) override {
    lfo_.setRate(sr_, clampf(p_[3], 0.05f, 20));
    const float base = clampf(p_[0], 40, 12000), res = clampf(p_[1], 0, 1) * 3.9f;
    const float envAmt = clampf(p_[2], 0, 1), lfoAmt = clampf(p_[4], 0, 1), mix = clampf(p_[5], 0, 1);
    float g = 0;
    for (int i = 0; i < n; i++) {
      lfo_.step();
      const float x = L[i];
      const float e = env_.run(x);
      if ((i & 7) == 0) {
        const float oct = envAmt * clampf(e * 8.f, 0, 1) * 4.f + lfoAmt * 2.f * lfo_.sine();
        const float fc = clampf(base * std::exp2(oct), 30, sr_ * 0.42f);
        const float w = std::tan(kPi * fc / sr_);
        g = w / (1 + w);
      }
      // four one-pole stages with tanh feedback (Huovilainen-style, simplified)
      const float in = tanhFast(x - res * s_[3]);
      s_[0] += g * (in - s_[0]);
      s_[1] += g * (s_[0] - s_[1]);
      s_[2] += g * (s_[1] - s_[2]);
      s_[3] += g * (s_[2] - s_[3]);
      for (float& s : s_) s = undenormal(s);
      L[i] = (1 - mix) * x + mix * s_[3] * (1 + res * 0.5f);
    }
  }
private:
  float p_[6];
  Envelope env_;
  Lfo lfo_;
  float s_[4] = { 0, 0, 0, 0 };
};

// Wah (classic / vintage): Position (0..1), Q, Level (dB)
class Wah : public Block {
public:
  explicit Wah(bool vintage) : vintage_(vintage) { p_[0] = 0.5f; p_[1] = vintage ? 3.5f : 5.f; p_[2] = 0; }
  void setParam(int i, float v) override { if (i >= 0 && i < 3) { p_[i] = v; if (i == 0) pos_.set(clampf(v, 0, 1)); } }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); pos_.setTime(sr, 25); pos_.snap(clampf(p_[0], 0, 1)); }
  void reset() override { svf_.reset(); }
  void process(float* L, float*, int n) override {
    const float lo = vintage_ ? 380.f : 420.f, hi = vintage_ ? 1900.f : 2300.f;
    const float q = clampf(p_[1], 1, 15), lvl = dbToGain(p_[2]);
    for (int i = 0; i < n; i++) {
      const float pos = pos_.next();
      // the inductor wah sweeps roughly exponentially; Q drops a little toward the toe
      if ((i & 3) == 0) svf_.set(sr_, lo * std::pow(hi / lo, pos), q * (1.1f - 0.3f * pos));
      svf_.run(L[i]);
      // mostly band-pass with some low-pass body, like the real circuit
      L[i] = (svf_.bp * (vintage_ ? 1.6f : 2.0f) + svf_.lp * (vintage_ ? 0.35f : 0.2f)) * lvl;
    }
  }
private:
  bool vintage_;
  float p_[3];
  Smooth pos_;
  Svf svf_;
};

} // namespace

Block* createFilter(int type) {
  switch (type) {
    case B_ENV_FILTER: return new EnvFilter();
    case B_SYNTH_FILTER: return new SynthFilter();
    case B_WAH_CLASSIC: return new Wah(false);
    case B_WAH_VINTAGE: return new Wah(true);
    default: return nullptr;
  }
}

} // namespace forge
