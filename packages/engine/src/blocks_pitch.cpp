// Pitch: whammy, simple shift, intelligent harmony, poly capo and an analog-style octaver.
#include <cmath>

#include "blocks.h"
#include "dsp.h"
#include "pitch.h"

namespace forge {
namespace {

class ShiftBase : public Block {
public:
  void setParam(int i, float v) override { if (i >= 0 && i < 6) { p_[i] = v; dirty_ = true; } }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    sh_.prepare(sr, 60);
    det_.prepare(sr);
    dry_.alloc(4096);
    mix_.setTime(sr, 20);
    semis_.setTime(sr, 12);
    configure();
    mix_.snap(mix_.target);
    semis_.snap(semis_.target);
    dirty_ = false;
  }
  void reset() override { sh_.reset(); det_.reset(); dry_.clear(); }
  int latency() const override { return (int)sh_.latencySamples(); }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      const float x = L[i];
      if (track_) {
        det_.push(x);
        sh_.setPeriod(det_.confidence() > 0.8f ? det_.period() : 0.f, windowMs_);
        if (harmony_) semis_.set(harmonySemis());
      }
      const float s = semis_.next();
      sh_.setRatio(std::exp2(s / 12.f));
      dry_.push(x);
      // near unison the two heads would comb; fade to the (latency-matched) dry signal
      const float amt = clampf((std::fabs(s) - 0.05f) * 4.f, 0.f, 1.f);
      const float shifted = sh_.process(x);
      const float wet = amt * shifted + (1 - amt) * dry_.linear(sh_.latencySamples());
      const float m = mix_.next();
      L[i] = (1 - m) * x + m * wet * level_;
    }
  }
protected:
  virtual void configure() = 0;
  virtual float harmonySemis() { return 0; }
  float p_[6] = {};
  bool dirty_ = true, track_ = true, harmony_ = false;
  float windowMs_ = 16, level_ = 1;
  PitchShifter sh_;
  PitchDetector det_;
  DelayLine dry_;
  Smooth mix_, semis_;
};

// Whammy: Position (0..1), Heel (semitones), Toe (semitones), Mix
class Whammy : public ShiftBase {
public:
  Whammy() { p_[0] = 0; p_[1] = 0; p_[2] = 12; p_[3] = 1; }
protected:
  void configure() override {
    windowMs_ = 16;
    sh_.setWindowMs(windowMs_);
    semis_.set(lerp(clampf(p_[1], -24, 24), clampf(p_[2], -24, 24), clampf(p_[0], 0, 1)));
    mix_.set(clampf(p_[3], 0, 1));
  }
};

// Simple Pitch: Interval (semitones), Cents, Mix
class SimplePitch : public ShiftBase {
public:
  SimplePitch() { p_[0] = 12; p_[1] = 0; p_[2] = 0.5f; }
protected:
  void configure() override {
    windowMs_ = 24;
    sh_.setWindowMs(windowMs_);
    semis_.set(clampf(p_[0], -24, 24) + clampf(p_[1], -50, 50) / 100.f);
    mix_.set(clampf(p_[2], 0, 1));
  }
};

// Poly Capo: Semitones, Mix
class PolyCapo : public ShiftBase {
public:
  PolyCapo() { p_[0] = 2; p_[1] = 1; }
protected:
  void configure() override {
    track_ = false;
    windowMs_ = 40;
    sh_.setWindowMs(windowMs_);
    semis_.set(clampf(p_[0], -12, 12));
    mix_.set(clampf(p_[1], 0, 1));
  }
};

// Harmony: Key (0..11, C..B), Scale, Voice (scale steps, -7..7), Mix
class Harmony : public ShiftBase {
public:
  Harmony() { p_[0] = 4; p_[1] = 0; p_[2] = 2; p_[3] = 0.5f; harmony_ = true; }
protected:
  void configure() override {
    windowMs_ = 20;
    sh_.setWindowMs(windowMs_);
    key_ = (int)clampf(p_[0], 0, 11);
    scale_ = (int)clampf(p_[1], 0, 6);
    voice_ = (int)clampf(p_[2], -7, 7);
    mix_.set(clampf(p_[3], 0, 1));
  }
  float harmonySemis() override {
    static const int scales[7][7] = {
      { 0, 2, 4, 5, 7, 9, 11 },  // major
      { 0, 2, 3, 5, 7, 8, 10 },  // natural minor
      { 0, 2, 3, 5, 7, 9, 10 },  // dorian
      { 0, 2, 4, 5, 7, 9, 10 },  // mixolydian
      { 0, 2, 3, 5, 7, 8, 11 },  // harmonic minor
      { 0, 2, 4, 7, 9, 12, 14 }, // major pentatonic (5 notes, padded)
      { 0, 3, 5, 7, 10, 12, 15 },// minor pentatonic
    };
    const int len = scale_ >= 5 ? 5 : 7;
    const float f = det_.frequency();
    if (f <= 0 || det_.confidence() < 0.75f) return last_;
    const float midi = 69.f + 12.f * std::log2(f / 440.f);
    const int note = (int)std::lround(midi);
    const int rel = ((note - key_) % 12 + 12) % 12;
    // nearest scale degree
    int deg = 0, bestDist = 99;
    for (int d = 0; d < len; d++) { const int dist = std::abs(scales[scale_][d] - rel); if (dist < bestDist) { bestDist = dist; deg = d; } }
    const int target = deg + voice_;
    const int oct = target >= 0 ? target / len : -((-target + len - 1) / len);
    const int idx = target - oct * len;
    const int semis = scales[scale_][idx] + 12 * oct - scales[scale_][deg];
    last_ = (float)semis;
    return last_;
  }
private:
  int key_ = 0, scale_ = 0, voice_ = 2;
  float last_ = 0;
};

// Octaver: Octave 1, Octave 2, Dry
class Octaver : public Block {
public:
  Octaver() { p_[0] = 0.8f; p_[1] = 0.3f; p_[2] = 1; }
  void setParam(int i, float v) override { if (i >= 0 && i < 3) p_[i] = v; }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    track_.highCut(sr, 320, 0.6f); track2_.highCut(sr, 320, 0.6f);
    out_.highCut(sr, 1600, 0.6f);
    hp_.lowCut(sr, 50);
    env_.set(sr, 2, 60);
  }
  void reset() override { track_.reset(); track2_.reset(); out_.reset(); hp_.reset(); env_.reset(); ff1_ = ff2_ = 1; armed_ = true; }
  void process(float* L, float*, int n) override {
    for (int i = 0; i < n; i++) {
      const float x = L[i];
      const float t = track2_.run(track_.run(x));
      const float e = env_.run(t);
      // flip-flops on rising zero crossings (with hysteresis) divide the frequency by 2 and 4
      const float hyst = 0.1f * e;
      if (armed_ && t > hyst) { armed_ = false; ff1_ = -ff1_; if (ff1_ > 0) ff2_ = -ff2_; }
      else if (!armed_ && t < -hyst) armed_ = true;
      const float o1 = t * ff1_, o2 = t * ff2_;
      const float sub = out_.run(hp_.run(p_[0] * o1 + p_[1] * o2)) * 2.f;
      L[i] = x * p_[2] + sub;
    }
  }
private:
  float p_[3];
  Biquad track_, track2_, out_, hp_;
  Envelope env_;
  float ff1_ = 1, ff2_ = 1;
  bool armed_ = true;
};

} // namespace

Block* createPitch(int type) {
  switch (type) {
    case B_PITCH_WHAMMY: return new Whammy();
    case B_PITCH_SIMPLE: return new SimplePitch();
    case B_PITCH_HARMONY: return new Harmony();
    case B_PITCH_CAPO: return new PolyCapo();
    case B_OCTAVER: return new Octaver();
    default: return nullptr;
  }
}

} // namespace forge
