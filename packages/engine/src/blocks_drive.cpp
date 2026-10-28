// Drives, boosts and fuzzes. Each pedal is a pre-filter at the base rate, a non-linear core
// that runs oversampled (2x standard, 4x high quality, off in eco), and a tone stage after
// the down-sampler. Levels are calibrated so a pedal at its default settings comes out near
// unity for a guitar-level input; the circuits' input sensitivity is kept (turning the guitar
// down cleans them up).
#include <cmath>

#include "blocks.h"
#include "dsp.h"
#include "oversampler.h"

namespace forge {
namespace {

class DriveBase : public Block {
public:
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    std::free(upA_); std::free(upB_); std::free(aux_);
    upA_ = zalloc<float>((long)maxBlock * 4);
    upB_ = zalloc<float>((long)maxBlock * 4);
    aux_ = zalloc<float>(maxBlock);
    level_.setTime(sr, 25);
    applyQuality();
    configure();
    level_.snap(level_.target);
    dirty_ = false;
  }
  ~DriveBase() override { std::free(upA_); std::free(upB_); std::free(aux_); }
  void setParam(int i, float v) override { if (i >= 0 && i < 8) { p_[i] = v; dirty_ = true; } }
  void setQuality(int q) override { quality_ = q; applyQuality(); dirty_ = true; }
  int latency() const override { return (int)std::lround(os_.latency()); }
  void reset() override { os_.reset(); osB_.reset(); resetState(); }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) pre(L[i], aux_[i]);
    const int f = os_.factor, m = n * f;
    os_.up(L, upA_, n);
    if (useAux_) { osB_.up(aux_, upB_, n); for (int j = 0; j < m; j++) upA_[j] = core(upA_[j], upB_[j]); }
    else for (int j = 0; j < m; j++) upA_[j] = core(upA_[j], 0.f);
    os_.down(upA_, L, n);
    for (int i = 0; i < n; i++) L[i] = post(L[i]) * level_.next();
  }

protected:
  virtual void configure() = 0;
  virtual void pre(float& x, float& aux) { (void)x; (void)aux; }
  virtual float core(float x, float aux) = 0;
  virtual float post(float x) { return x; }
  virtual void resetState() {}
  /** knob 0..10 -> 0..1 */
  float k(int i) const { return clampf(p_[i], 0.f, 10.f) * 0.1f; }
  float osr() const { return sr_ * (float)os_.factor; }

  float p_[8] = {};
  bool useAux_ = false;
  Smooth level_;
  Oversampler os_, osB_;

private:
  void applyQuality() { const int f = quality_ <= 0 ? 1 : (quality_ == 1 ? 2 : 4); os_.setFactor(f); osB_.setFactor(f); }
  float* upA_ = nullptr;
  float* upB_ = nullptr;
  float* aux_ = nullptr;
  int quality_ = 1;
  bool dirty_ = true;
};

// ------------------------------------------------------------------ Mid Drive (TS-style)
// Drive, Tone, Level
class MidDrive : public DriveBase {
public:
  MidDrive() { p_[0] = 5; p_[1] = 5; p_[2] = 0; useAux_ = true; }
protected:
  void configure() override {
    gain_ = dbToGain(k(0) * 41.f);
    hp_.lowpass(sr_, 720);
    inHp_.lowpass(sr_, 40);
    // feedback capacitor: the clipped path loses top end as drive goes up
    const float rDrive = 51e3f + k(0) * 500e3f;
    capLp_.lowpass(osr(), 1.f / (kTwoPi * rDrive * 51e-12f));
    tone_.lowpass(sr_, 723);
    toneAmt_ = k(1);
    hiCut_.highCut(sr_, 7500);
    level_.set(dbToGain(p_[2]) * 0.63f);
  }
  void pre(float& x, float& aux) override {
    const float in = inHp_.hp(x);
    aux = in;
    x = hp_.hp(in) * gain_;
  }
  float core(float x, float clean) override { return clean + diodeSoft(capLp_.lp(x), 0.55f); }
  float post(float x) override {
    const float lo = tone_.lp(x);
    return hiCut_.run(lo + toneAmt_ * 1.6f * (x - lo)) * 0.75f;
  }
  void resetState() override { hp_.reset(); inHp_.reset(); capLp_.reset(); tone_.reset(); hiCut_.reset(); }
private:
  float gain_ = 1, toneAmt_ = 0.5f;
  OnePole hp_, inHp_, capLp_, tone_;
  Biquad hiCut_;
};

// ------------------------------------------------------------------ Clear Drive (Klon-style)
// Gain, Treble, Output
class ClearDrive : public DriveBase {
public:
  ClearDrive() { p_[0] = 3; p_[1] = 5; p_[2] = 0; useAux_ = true; }
protected:
  void configure() override {
    gain_ = dbToGain(4 + k(0) * 34.f);
    clean_ = 1.f - 0.85f * k(0);
    driven_ = 0.35f + 0.65f * k(0);
    hp_.lowCut(sr_, 400, 0.6f);
    lp_.highCut(osr(), 4500, 0.6f);
    treble_.highShelf(sr_, 1800, (p_[1] - 5) * 2.4f);
    hiCut_.highCut(sr_, 9000);
    level_.set(dbToGain(p_[2]) * 1.49f);
  }
  void pre(float& x, float& aux) override { aux = x; x = hp_.run(x) * gain_; }
  float core(float x, float clean) override { return clean * clean_ + driven_ * diodeSoft(lp_.run(x), 0.33f); }
  float post(float x) override { return hiCut_.run(treble_.active ? treble_.run(x) : x); }
  void resetState() override { hp_.reset(); lp_.reset(); treble_.reset(); hiCut_.reset(); }
private:
  float gain_ = 1, clean_ = 1, driven_ = 0.5f;
  Biquad hp_, lp_, treble_, hiCut_;
};

// ------------------------------------------------------------------ Clean Boost (EP-style)
// Boost (dB), Bright (0/1)
class CleanBoost : public DriveBase {
public:
  CleanBoost() { p_[0] = 8; p_[1] = 0; }
protected:
  void configure() override {
    gain_ = dbToGain(clampf(p_[0], 0, 24));
    hp_.lowCut(sr_, 35);
    bright_ = p_[1] > 0.5f;
    shelf_.highShelf(sr_, 2500, 4);
    body_.peak(sr_, 180, 0.8f, 1.5f);
    level_.set(1);
  }
  void pre(float& x, float&) override { x = hp_.run(x) * gain_; }
  // JFET preamp: gentle asymmetric saturation, mostly even harmonics
  float core(float x, float) override { return asymClip(x + 0.08f * x * x, 1.6f, 1.1f); }
  float post(float x) override { x = body_.run(x); return bright_ ? shelf_.run(x) : x; }
  void resetState() override { hp_.reset(); shelf_.reset(); body_.reset(); }
private:
  float gain_ = 1;
  bool bright_ = false;
  Biquad hp_, shelf_, body_;
};

// ------------------------------------------------------------------ Smooth Drive (Timmy-style)
// Gain, Bass, Treble, Volume, Clip (0 symmetric, 1 asymmetric, 2 open)
class SmoothDrive : public DriveBase {
public:
  SmoothDrive() { p_[0] = 4; p_[1] = 7; p_[2] = 6; p_[3] = 0; p_[4] = 0; }
protected:
  void configure() override {
    gain_ = dbToGain(2 + k(0) * 33.f);
    bass_.lowCut(sr_, expMap(1 - k(1), 30, 600), 0.6f);
    treble_.highCut(sr_, expMap(k(2), 1200, 18000), 0.6f);
    clip_ = (int)p_[4];
    level_.set(dbToGain(p_[3]) * (clip_ == 2 ? 0.3f : 0.41f));
  }
  void pre(float& x, float&) override { x = bass_.run(x) * gain_; }
  float core(float x, float) override {
    if (clip_ == 1) return asymClip(x, 0.6f, 0.42f);
    if (clip_ == 2) return diodeSoft(x, 0.9f);
    return diodeSoft(x, 0.5f);
  }
  float post(float x) override { return treble_.run(x); }
  void resetState() override { bass_.reset(); treble_.reset(); }
private:
  float gain_ = 1;
  int clip_ = 0;
  Biquad bass_, treble_;
};

// ------------------------------------------------------------------ Crunch Drive (OCD-style)
// Drive, Tone, Volume, Mode (0 LP, 1 HP)
class CrunchDrive : public DriveBase {
public:
  CrunchDrive() { p_[0] = 5; p_[1] = 5; p_[2] = 0; p_[3] = 1; }
protected:
  void configure() override {
    gain_ = dbToGain(6 + k(0) * 44.f);
    hp_.lowCut(sr_, 70);
    const bool hpMode = p_[3] > 0.5f;
    mode_.highShelf(sr_, 2000, hpMode ? 3.f : -2.f);
    body_.lowShelf(sr_, 200, hpMode ? -3.f : 1.f);
    tone_.highCut(sr_, expMap(k(1), 900, 9000), 0.65f);
    level_.set(dbToGain(p_[2]) * (hpMode ? 0.175f : 0.2f));
  }
  void pre(float& x, float&) override { x = body_.run(hp_.run(x)) * gain_; }
  // MOSFET clipping: a soft body with a firmer ceiling
  float core(float x, float) override { return 0.6f * tanhFast(1.4f * x) + 0.3f * hardKnee(x, 0.7f); }
  float post(float x) override { return tone_.run(mode_.run(x)); }
  void resetState() override { hp_.reset(); mode_.reset(); body_.reset(); tone_.reset(); }
private:
  float gain_ = 1;
  Biquad hp_, mode_, body_, tone_;
};

// ------------------------------------------------------------------ Grit Distortion (RAT-style)
// Distortion, Filter, Volume
class GritDist : public DriveBase {
public:
  GritDist() { p_[0] = 5; p_[1] = 4; p_[2] = 0; }
protected:
  void configure() override {
    // op-amp gain: low below ~60 Hz, medium up to ~1.5 kHz, highest above (limited by GBW)
    const float r = 100.f + k(0) * k(0) * 100e3f;
    gm_ = r / 560.f;
    gh_ = r / 47.f;
    hp60_.lowpass(sr_, 60);
    hp1k5_.lowpass(sr_, 1500);
    const float g = 1 + gm_ + gh_;
    gbw_.lowpass(osr(), clampf(1.0e6f / g, 1500.f, 20000.f));
    filter_.lowpass(sr_, 1.f / (kTwoPi * (1.5e3f + k(1) * 100e3f) * 3.3e-9f));
    level_.set(dbToGain(p_[2]) * 0.166f);
  }
  void pre(float& x, float&) override {
    const float a = hp60_.hp(x), b = hp1k5_.hp(x);
    x = x + gm_ * a + gh_ * b;
  }
  float core(float x, float) override { return hardKnee(gbw_.lp(x), 0.6f); }
  float post(float x) override { return filter_.lp(x) * 1.25f; }
  void resetState() override { hp60_.reset(); hp1k5_.reset(); gbw_.reset(); filter_.reset(); }
private:
  float gm_ = 1, gh_ = 1;
  OnePole hp60_, hp1k5_, gbw_, filter_;
};

// ------------------------------------------------------------------ Wall Fuzz (Big Muff-style)
// Sustain, Tone, Volume
class WallFuzz : public DriveBase {
public:
  WallFuzz() { p_[0] = 6; p_[1] = 5; p_[2] = 0; }
protected:
  void configure() override {
    g1_ = dbToGain(10 + k(0) * 30.f);
    inHp_.lowCut(sr_, 90);
    stHp1_.lowpass(osr(), 140);
    stLp1_.lowpass(osr(), 3200);
    stHp2_.lowpass(osr(), 160);
    stLp2_.lowpass(osr(), 2600);
    toneLp_.lowpass(sr_, 1000);
    toneHp_.lowpass(sr_, 720);
    t_ = k(1);
    level_.set(dbToGain(p_[2]) * 0.425f);
  }
  void pre(float& x, float&) override { x = diodeSoft(inHp_.run(x) * 4.f, 0.9f) * g1_; }
  float core(float x, float) override {
    float a = diodeSoft(x, 0.45f);
    a = stLp1_.lp(stHp1_.hp(a)) * 18.f;
    float b = diodeSoft(a, 0.45f);
    return stLp2_.lp(stHp2_.hp(b));
  }
  float post(float x) override {
    const float lo = toneLp_.lp(x), hi = toneHp_.hp(x);
    return (1 - t_) * lo * 1.3f + t_ * hi * 1.6f;
  }
  void resetState() override { inHp_.reset(); stHp1_.reset(); stLp1_.reset(); stHp2_.reset(); stLp2_.reset(); toneLp_.reset(); toneHp_.reset(); }
private:
  float g1_ = 1, t_ = 0.5f;
  Biquad inHp_;
  OnePole stHp1_, stLp1_, stHp2_, stLp2_, toneLp_, toneHp_;
};

// ------------------------------------------------------------------ Round Fuzz (Fuzz Face-style)
// Fuzz, Volume, Type (0 germanium, 1 silicon)
class RoundFuzz : public DriveBase {
public:
  RoundFuzz() { p_[0] = 7; p_[1] = 0; p_[2] = 0; }
protected:
  void configure() override {
    silicon_ = p_[2] > 0.5f;
    gain_ = dbToGain((silicon_ ? 14.f : 8.f) + k(0) * (silicon_ ? 40.f : 34.f));
    bias_ = silicon_ ? 0.18f : 0.32f;
    hp_.lowCut(sr_, silicon_ ? 90 : 70);
    lp_.highCut(sr_, silicon_ ? 7000 : 5200, 0.6f);
    dc_.lowpass(sr_, 25);
    // a fuzz face at low fuzz settings is thin and gated
    thin_.lowShelf(sr_, 250, -6.f * (1 - k(0)));
    level_.set(dbToGain(p_[1]) * (silicon_ ? 0.114f : 0.143f));
    off_ = tanhFast(bias_);
  }
  void pre(float& x, float&) override { x = thin_.run(hp_.run(x)) * gain_; }
  float core(float x, float) override {
    if (silicon_) return 0.75f * (hardKnee(x + bias_, 0.9f) - hardKnee(bias_, 0.9f));
    return tanhFast(x + bias_) - off_;
  }
  float post(float x) override { return lp_.run(dc_.hp(x)); }
  void resetState() override { hp_.reset(); lp_.reset(); dc_.reset(); thin_.reset(); }
private:
  bool silicon_ = false;
  float gain_ = 1, bias_ = 0.3f, off_ = 0;
  Biquad hp_, lp_, thin_;
  OnePole dc_;
};

// ------------------------------------------------------------------ Bender Fuzz (Tone Bender-style)
// Attack, Level
class BenderFuzz : public DriveBase {
public:
  BenderFuzz() { p_[0] = 7; p_[1] = 0; }
protected:
  void configure() override {
    gain_ = dbToGain(12 + k(0) * 36.f);
    hp_.lowCut(sr_, 180);
    mid_.peak(sr_, 850, 0.9f, 4);
    lp_.highCut(sr_, 4800, 0.6f);
    dc_.lowpass(sr_, 30);
    level_.set(dbToGain(p_[1]) * 0.17f);
  }
  void pre(float& x, float&) override { x = hp_.run(x) * gain_; }
  float core(float x, float) override {
    float a = asymClip(x, 0.9f, 0.6f);
    a = asymClip(a * 3.f, 0.8f, 0.55f);
    return asymClip(a * 2.f, 0.7f, 0.5f);
  }
  float post(float x) override { return lp_.run(mid_.run(dc_.hp(x))); }
  void resetState() override { hp_.reset(); mid_.reset(); lp_.reset(); dc_.reset(); }
private:
  float gain_ = 1;
  Biquad hp_, mid_, lp_;
  OnePole dc_;
};

// ------------------------------------------------------------------ Treble Boost (Rangemaster-style)
// Range, Level (boost dB)
class TrebleBoost : public DriveBase {
public:
  TrebleBoost() { p_[0] = 6; p_[1] = 14; }
protected:
  void configure() override {
    hp_.lowCut(sr_, expMap(1 - k(0), 400, 3000), 0.6f);
    gain_ = dbToGain(clampf(p_[1], 0, 30));
    dc_.lowpass(sr_, 20);
    level_.set(1);
  }
  void pre(float& x, float&) override { x = hp_.run(x) * gain_; }
  float core(float x, float) override { return asymClip(x, 1.0f, 0.7f); }
  float post(float x) override { return dc_.hp(x); }
  void resetState() override { hp_.reset(); dc_.reset(); }
private:
  float gain_ = 1;
  Biquad hp_;
  OnePole dc_;
};

// ------------------------------------------------------------------ Octave Fuzz (Octavia-style)
// Fuzz, Octave, Level
class OctaveFuzz : public DriveBase {
public:
  OctaveFuzz() { p_[0] = 6; p_[1] = 6; p_[2] = 0; }
protected:
  void configure() override {
    gain_ = dbToGain(10 + k(0) * 32.f);
    oct_ = k(1);
    hp_.lowCut(sr_, 110);
    dcOs_.lowpass(osr(), 40);
    lp_.highCut(sr_, 6000, 0.6f);
    level_.set(dbToGain(p_[2]) * 0.21f);
  }
  void pre(float& x, float&) override { x = hp_.run(x) * 2.f; }
  float core(float x, float) override {
    const float rect = dcOs_.hp(std::fabs(x) * 2.f);
    const float s = (1 - oct_) * x + oct_ * rect;
    return hardKnee(s * gain_, 0.6f);
  }
  float post(float x) override { return lp_.run(x); }
  void resetState() override { hp_.reset(); dcOs_.reset(); lp_.reset(); }
private:
  float gain_ = 1, oct_ = 0.5f;
  Biquad hp_, lp_;
  OnePole dcOs_;
};

} // namespace

Block* createDrive(int type) {
  switch (type) {
    case B_OD_MID: return new MidDrive();
    case B_OD_CLEAR: return new ClearDrive();
    case B_BOOST_CLEAN: return new CleanBoost();
    case B_OD_SMOOTH: return new SmoothDrive();
    case B_OD_CRUNCH: return new CrunchDrive();
    case B_DIST_GRIT: return new GritDist();
    case B_FUZZ_WALL: return new WallFuzz();
    case B_FUZZ_ROUND: return new RoundFuzz();
    case B_FUZZ_BENDER: return new BenderFuzz();
    case B_BOOST_TREBLE: return new TrebleBoost();
    case B_FUZZ_OCTAVE: return new OctaveFuzz();
    default: return nullptr;
  }
}

} // namespace forge
