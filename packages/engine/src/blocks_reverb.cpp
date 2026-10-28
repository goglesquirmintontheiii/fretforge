// Reverbs (stereo, time-based). Room, hall, chamber, plate and ambient share an 8-line
// feedback delay network with a Householder matrix, input diffusion, per-line damping and
// slow modulation; they differ in line lengths, diffusion, early reflections and modulation.
// Shimmer puts a pitch shifter in the feedback path. Spring is its own model: a loop with a
// long chain of first-order allpasses, which gives the dispersive "boing".
#include <cmath>

#include "blocks.h"
#include "dsp.h"
#include "pitch.h"

namespace forge {
namespace {

struct Variant {
  float lines[8];   // ms at size 0.5
  float diffuse;    // input allpass gain
  float diffMs;     // scale of the input allpass lengths
  float modMs;      // modulation depth
  float er;         // early reflection level
  float maxDecay;
};

const Variant ROOM = { { 9.7f, 11.3f, 13.1f, 15.7f, 17.9f, 21.1f, 24.3f, 28.3f }, 0.6f, 0.5f, 0.15f, 0.6f, 6 };
const Variant HALL = { { 29.3f, 34.7f, 41.1f, 47.9f, 55.3f, 62.9f, 71.3f, 83.7f }, 0.7f, 1.0f, 0.6f, 0.25f, 20 };
const Variant PLATE = { { 13.3f, 16.9f, 19.7f, 23.9f, 27.1f, 31.7f, 35.3f, 41.9f }, 0.75f, 0.8f, 0.3f, 0.f, 12 };
const Variant CHAMBER = { { 19.1f, 23.3f, 26.9f, 30.7f, 34.1f, 39.7f, 44.3f, 50.9f }, 0.65f, 0.7f, 0.3f, 0.45f, 10 };
const Variant AMBIENT = { { 43.7f, 53.1f, 61.9f, 73.3f, 85.7f, 97.1f, 113.9f, 131.3f }, 0.75f, 1.4f, 1.6f, 0.f, 60 };

class FdnReverb : public Block {
public:
  FdnReverb(const Variant& v, bool shimmer) : v_(v), shimmer_(shimmer) {
    // Decay, Predelay, Size, Tone, Low Cut, Mix   (shimmer: Decay, Predelay, Shimmer, Interval, Tone, Mix)
    if (shimmer) { p_[0] = 6; p_[1] = 30; p_[2] = 0.5f; p_[3] = 12; p_[4] = 6000; p_[5] = 0.35f; }
    else { p_[0] = v.maxDecay > 15 ? 3.5f : 1.6f; p_[1] = 15; p_[2] = 0.5f; p_[3] = 6500; p_[4] = 100; p_[5] = 0.3f; }
    if (&v == &AMBIENT) { p_[0] = 12; p_[3] = 5000; p_[5] = 0.4f; }
  }
  bool stereo() const override { return true; }
  bool timeBased() const override { return true; }
  void setParam(int i, float v) override { if (i >= 0 && i < 6) { p_[i] = v; dirty_ = true; } }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    for (int k = 0; k < 8; k++) lines_[k].alloc((int)(v_.lines[k] * 1.6f * 0.001f * sr + v_.modMs * 0.002f * sr) + 16);
    static const float diffMs[4] = { 4.77f, 3.59f, 12.73f, 9.31f };
    for (int c = 0; c < 2; c++) for (int k = 0; k < 4; k++) {
      diffLen_[c][k] = diffMs[k] * v_.diffMs * (c ? 1.13f : 1.f) * 0.001f * sr;
      diff_[c][k].alloc((int)diffLen_[c][k] + 4);
    }
    pre_[0].alloc((int)(0.6f * sr)); pre_[1].alloc((int)(0.6f * sr));
    for (int k = 0; k < 8; k++) lfo_[k].setRate(sr, 0.11f + 0.07f * k);
    for (int k = 0; k < 8; k++) lfo_[k].phase = k * 0.125;
    if (shimmer_) shifter_.prepare(sr, 80);
    mix_.setTime(sr, 20);
    configure();
    mix_.snap(mix_.target);
    dirty_ = false;
  }
  void reset() override {
    for (auto& l : lines_) l.clear();
    for (auto& c : diff_) for (auto& d : c) d.clear();
    pre_[0].clear(); pre_[1].clear();
    for (auto& d : damp_) d.reset();
    lc_[0].reset(); lc_[1].reset();
    if (shimmer_) shifter_.reset();
    shimFb_ = 0;
  }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      const float m = mix_.next();
      float in[2] = { lc_[0].run(L[i]), lc_[1].run(R[i]) };
      // predelay and early reflections
      float er[2] = { 0, 0 };
      for (int c = 0; c < 2; c++) {
        pre_[c].push(in[c]);
        in[c] = pre_[c].at(preSamples_);
        if (v_.er > 0) {
          static const float taps[6] = { 0.0043f, 0.0071f, 0.0109f, 0.0151f, 0.0197f, 0.0263f };
          for (int t = 0; t < 6; t++) er[c] += pre_[c].at(preSamples_ + (int)(taps[t] * erScale_ * (c ? 1.07f : 1.f))) * (t & 1 ? -0.5f : 0.6f) / (1 + t * 0.4f);
        }
      }
      if (shimmer_) { in[0] += shimFb_; in[1] += shimFb_; }
      // input diffusion
      for (int c = 0; c < 2; c++) {
        float x = in[c];
        for (int k = 0; k < 4; k++) {
          const float d = diff_[c][k].linear(diffLen_[c][k]);
          const float y = -diffuse_ * x + d;
          diff_[c][k].push(x + diffuse_ * y);
          x = y;
        }
        in[c] = x;
      }
      // the network
      float o[8], sum = 0;
      for (int k = 0; k < 8; k++) {
        lfo_[k].step();
        const float d = len_[k] + modDepth_ * lfo_[k].sine();
        o[k] = damp_[k].lp(lines_[k].linear(d)) * gain_[k];
        sum += o[k];
      }
      sum *= 0.25f; // 2/N
      float outL = 0, outR = 0;
      for (int k = 0; k < 8; k++) {
        const float fbk = o[k] - sum;
        lines_[k].push(undenormal(fbk + (k < 4 ? in[0] : in[1]) * 0.5f));
        if (k & 1) { outL += o[k]; outR -= o[k] * 0.6f; } else { outR += o[k]; outL -= o[k] * 0.6f; }
      }
      outL *= 0.35f; outR *= 0.35f;
      if (shimmer_) shimFb_ = undenormal(shifter_.process(0.5f * (outL + outR)) * shimAmt_ * 0.7f);
      const float wl = outL + er[0] * v_.er, wr = outR + er[1] * v_.er;
      L[i] += m * wl;
      R[i] += m * wr;
    }
  }

private:
  void configure() {
    const float decay = clampf(p_[0], 0.1f, v_.maxDecay);
    const float size = shimmer_ ? 0.6f : clampf(p_[2], 0, 1);
    const float scale = 0.6f + size * 0.9f;
    preSamples_ = (int)(clampf(p_[1], 0, 500) * 0.001f * sr_);
    erScale_ = sr_ * (0.5f + size);
    float tone, lowCut;
    if (shimmer_) {
      shimAmt_ = clampf(p_[2], 0, 1);
      shifter_.setRatio(std::pow(2.f, clampf(p_[3], -12, 24) / 12.f));
      shifter_.setWindowMs(60);
      tone = clampf(p_[4], 1000, 16000);
      lowCut = 150;
      mix_.set(clampf(p_[5], 0, 1));
    } else {
      tone = clampf(p_[3], 1000, 16000);
      lowCut = clampf(p_[4], 20, 1000);
      mix_.set(clampf(p_[5], 0, 1));
    }
    for (int k = 0; k < 8; k++) {
      len_[k] = v_.lines[k] * scale * 0.001f * sr_;
      // gain for a -60 dB decay over `decay` seconds
      gain_[k] = std::pow(10.f, -3.f * (len_[k] / sr_) / decay);
      damp_[k].lowpass(sr_, tone);
    }
    modDepth_ = v_.modMs * 0.001f * sr_;
    diffuse_ = v_.diffuse;
    lc_[0].lowCut(sr_, lowCut); lc_[1].lowCut(sr_, lowCut);
  }

  const Variant& v_;
  bool shimmer_;
  float p_[6] = {};
  bool dirty_ = true;
  DelayLine lines_[8], diff_[2][4], pre_[2];
  float diffLen_[2][4] = {};
  float len_[8] = {}, gain_[8] = {};
  OnePole damp_[8];
  Lfo lfo_[8];
  Biquad lc_[2];
  float modDepth_ = 0, diffuse_ = 0.7f, erScale_ = 48000;
  int preSamples_ = 0;
  Smooth mix_;
  PitchShifter shifter_;
  float shimAmt_ = 0, shimFb_ = 0;
};

// Spring: Decay, Tone (Hz), Mix, Drip
class SpringReverb : public Block {
public:
  SpringReverb() { p_[0] = 0.5f; p_[1] = 4500; p_[2] = 0.35f; p_[3] = 0.5f; }
  bool stereo() const override { return true; }
  bool timeBased() const override { return true; }
  void setParam(int i, float v) override { if (i >= 0 && i < 4) { p_[i] = v; dirty_ = true; } }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    for (int s = 0; s < 2; s++) dl_[s].alloc((int)(0.06f * sr));
    mix_.setTime(sr, 20);
    configure();
    mix_.snap(mix_.target);
    dirty_ = false;
  }
  void reset() override { for (int s = 0; s < 2; s++) { dl_[s].clear(); for (auto& a : ap_[s]) a.reset(); lp_[s].reset(); hp_[s].reset(); fb_[s] = 0; } }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      const float m = mix_.next();
      const float x = 0.5f * (L[i] + R[i]);
      float out[2];
      for (int s = 0; s < 2; s++) {
        // the transducer drives the spring; dispersion comes from the allpass chain
        float y = hp_[s].run(x) + fb_[s];
        for (int k = 0; k < kStages; k++) y = ap_[s][k].run(y, apCoef_);
        dl_[s].push(y);
        const float d = lp_[s].run(dl_[s].at(len_[s]));
        fb_[s] = undenormal(d * gain_);
        out[s] = d;
      }
      L[i] += m * (out[0] * 0.8f + out[1] * 0.2f);
      R[i] += m * (out[1] * 0.8f + out[0] * 0.2f);
    }
  }
private:
  static constexpr int kStages = 48;
  void configure() {
    gain_ = 0.55f + 0.4f * clampf(p_[0], 0, 1);
    apCoef_ = 0.45f + 0.25f * clampf(p_[3], 0, 1);
    len_[0] = (int)(0.0337f * sr_);
    len_[1] = (int)(0.0391f * sr_);
    for (int s = 0; s < 2; s++) { lp_[s].highCut(sr_, clampf(p_[1], 1500, 9000), 0.8f); hp_[s].lowCut(sr_, 180); }
    mix_.set(clampf(p_[2], 0, 1));
  }
  float p_[4] = {};
  bool dirty_ = true;
  DelayLine dl_[2];
  Allpass1 ap_[2][kStages];
  Biquad lp_[2], hp_[2];
  int len_[2] = { 1600, 1800 };
  float gain_ = 0.7f, apCoef_ = 0.6f, fb_[2] = { 0, 0 };
  Smooth mix_;
};

} // namespace

Block* createReverb(int type) {
  switch (type) {
    case B_REV_ROOM: return new FdnReverb(ROOM, false);
    case B_REV_HALL: return new FdnReverb(HALL, false);
    case B_REV_PLATE: return new FdnReverb(PLATE, false);
    case B_REV_SPRING: return new SpringReverb();
    case B_REV_CHAMBER: return new FdnReverb(CHAMBER, false);
    case B_REV_SHIMMER: return new FdnReverb(HALL, true);
    case B_REV_AMBIENT: return new FdnReverb(AMBIENT, false);
    default: return nullptr;
  }
}

} // namespace forge
