// Modulation: chorus, dimension, flanger, phasers, vibe, tremolo, rotary, ring mod.
// Mix blends dry and wet: out = (1 - mix) * dry + mix * wet.
#include <cmath>

#include "blocks.h"
#include "dsp.h"

namespace forge {
namespace {

class ModBase : public Block {
public:
  void setParam(int i, float v) override { if (i >= 0 && i < 8) { p_[i] = v; dirty_ = true; } }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    mix_.setTime(sr, 20);
    alloc();
    configure();
    mix_.snap(mix_.target);
    dirty_ = false;
  }
  void setTempo(float bpm) override { bpm_ = bpm; dirty_ = true; }
protected:
  virtual void alloc() {}
  virtual void configure() = 0;
  float p_[8] = {};
  bool dirty_ = true;
  float bpm_ = 120;
  Smooth mix_;
};

// Chorus: Rate, Depth, Delay (ms), Tone (Hz), Mix
class Chorus : public ModBase {
public:
  Chorus() { p_[0] = 0.8f; p_[1] = 0.5f; p_[2] = 8; p_[3] = 8000; p_[4] = 0.5f; }
  bool stereo() const override { return true; }
  void reset() override { dl_[0].clear(); dl_[1].clear(); tone_[0].reset(); tone_[1].reset(); }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      lfo_.step();
      const float m = mix_.next();
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        dl_[c].push(x);
        const float d = base_ + depth_ * (0.5f + 0.5f * lfo_.triangle(c * 0.25f));
        const float wet = tone_[c].lp(dl_[c].cubic(d));
        ch[c][i] = (1 - m) * x + m * wet;
      }
    }
  }
protected:
  void alloc() override { dl_[0].alloc((int)(0.06f * sr_)); dl_[1].alloc((int)(0.06f * sr_)); }
  void configure() override {
    lfo_.setRate(sr_, clampf(p_[0], 0.02f, 10));
    base_ = clampf(p_[2], 1, 30) * 0.001f * sr_;
    depth_ = clampf(p_[1], 0, 1) * 0.006f * sr_;
    for (auto& t : tone_) t.lowpass(sr_, clampf(p_[3], 800, 20000));
    mix_.set(clampf(p_[4], 0, 1));
  }
private:
  DelayLine dl_[2];
  OnePole tone_[2];
  Lfo lfo_;
  float base_ = 300, depth_ = 100;
};

// Dimension Chorus: Mode (1..4), Mix
class Dimension : public ModBase {
public:
  Dimension() { p_[0] = 2; p_[1] = 0.6f; }
  bool stereo() const override { return true; }
  void reset() override { dl_.clear(); }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      lfo_.step();
      const float x = 0.5f * (L[i] + R[i]);
      dl_.push(x);
      const float t = lfo_.triangle();
      const float a = tone_[0].lp(dl_.cubic(base_ + depth_ * t));
      const float b = tone_[1].lp(dl_.cubic(base_ - depth_ * t));
      const float m = mix_.next();
      // each BBD feeds its own side and, inverted, the other side
      L[i] = (1 - 0.5f * m) * L[i] + m * (0.7f * a - 0.35f * b);
      R[i] = (1 - 0.5f * m) * R[i] + m * (0.7f * b - 0.35f * a);
    }
  }
protected:
  void alloc() override { dl_.alloc((int)(0.03f * sr_)); }
  void configure() override {
    static const float rate[4] = { 0.25f, 0.25f, 0.5f, 0.5f }, depth[4] = { 0.6f, 1.1f, 1.4f, 2.0f };
    const int m = (int)clampf(p_[0], 1, 4) - 1;
    lfo_.setRate(sr_, rate[m]);
    base_ = 0.0065f * sr_;
    depth_ = depth[m] * 0.001f * sr_;
    tone_[0].lowpass(sr_, 7500);
    tone_[1].lowpass(sr_, 7500);
    mix_.set(clampf(p_[1], 0, 1));
  }
private:
  DelayLine dl_;
  OnePole tone_[2];
  Lfo lfo_;
  float base_ = 300, depth_ = 50;
};

// Flanger: Rate, Depth, Manual (ms), Feedback (-0.95..0.95), Mix
class Flanger : public ModBase {
public:
  Flanger() { p_[0] = 0.3f; p_[1] = 0.7f; p_[2] = 1.5f; p_[3] = 0.5f; p_[4] = 0.5f; }
  bool stereo() const override { return true; }
  void reset() override { dl_[0].clear(); dl_[1].clear(); fb_[0] = fb_[1] = 0; }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      lfo_.step();
      const float m = mix_.next();
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        dl_[c].push(x + feedback_ * fb_[c]);
        const float d = base_ + depth_ * (0.5f + 0.5f * lfo_.triangle(c * 0.25f));
        const float wet = dl_[c].cubic(d);
        fb_[c] = undenormal(tanhFast(wet));
        ch[c][i] = (1 - m) * x + m * wet;
      }
    }
  }
protected:
  void alloc() override { dl_[0].alloc((int)(0.025f * sr_)); dl_[1].alloc((int)(0.025f * sr_)); }
  void configure() override {
    lfo_.setRate(sr_, clampf(p_[0], 0.02f, 8));
    base_ = clampf(p_[2], 0.1f, 8) * 0.001f * sr_;
    depth_ = clampf(p_[1], 0, 1) * 0.006f * sr_;
    feedback_ = clampf(p_[3], -0.95f, 0.95f);
    mix_.set(clampf(p_[4], 0, 1));
  }
private:
  DelayLine dl_[2];
  Lfo lfo_;
  float base_ = 50, depth_ = 100, feedback_ = 0.5f, fb_[2] = { 0, 0 };
};

// Phaser: Rate, Depth, Feedback, Stages (4..12), Mix
// Script Phase (Phase 90-style): Speed, Feedback (0 script, 1 block)
class Phaser : public ModBase {
public:
  explicit Phaser(bool script) : script_(script) {
    if (script) { p_[0] = 0.6f; p_[1] = 0; } else { p_[0] = 0.5f; p_[1] = 0.8f; p_[2] = 0.4f; p_[3] = 6; p_[4] = 0.5f; }
  }
  bool stereo() const override { return !script_; }
  void reset() override { for (auto& c : ap_) for (auto& a : c) a.reset(); fb_[0] = fb_[1] = 0; }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    const int chans = script_ ? 1 : 2;
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      lfo_.step();
      const float m = mix_.next();
      for (int c = 0; c < chans; c++) {
        const float x = ch[c][i];
        const float sweep = 0.5f + 0.5f * lfo_.sine(c * 0.25f);
        const float f = lo_ * std::pow(hi_ / lo_, sweep);
        const float t = std::tan(kPi * f / sr_);
        const float a = (t - 1) / (t + 1);
        float y = x + feedback_ * fb_[c];
        for (int s = 0; s < stages_; s++) y = ap_[c][s].run(y, a);
        fb_[c] = undenormal(y);
        ch[c][i] = (1 - m) * x + m * y;
      }
    }
  }
protected:
  void configure() override {
    if (script_) {
      lfo_.setRate(sr_, expMap(clampf(p_[0], 0, 1), 0.1f, 8));
      stages_ = 4; lo_ = 250; hi_ = 1700;
      feedback_ = p_[1] > 0.5f ? 0.45f : 0.f;
      mix_.set(0.5f);
    } else {
      lfo_.setRate(sr_, clampf(p_[0], 0.02f, 10));
      lo_ = 180; hi_ = 180 + clampf(p_[1], 0, 1) * 3800;
      feedback_ = clampf(p_[2], 0, 0.9f);
      stages_ = ((int)clampf(p_[3], 2, 12)) & ~1;
      mix_.set(clampf(p_[4], 0, 1));
    }
  }
private:
  bool script_;
  Allpass1 ap_[2][12];
  Lfo lfo_;
  int stages_ = 4;
  float lo_ = 200, hi_ = 2000, feedback_ = 0, fb_[2] = { 0, 0 };
};

// Vibe (Uni-Vibe-style): Speed, Intensity, Mode (0 chorus, 1 vibrato), Level (dB)
class Vibe : public ModBase {
public:
  Vibe() { p_[0] = 0.4f; p_[1] = 0.7f; p_[2] = 0; p_[3] = 0; }
  void reset() override { for (auto& a : ap_) a.reset(); }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    static const float base[4] = { 90, 280, 650, 1500 };
    for (int i = 0; i < n; i++) {
      lfo_.step();
      // the lamp: bright quickly, dims slowly, never fully dark
      const float s = 0.5f + 0.5f * lfo_.sine();
      const float lamp = std::pow(s, 1.8f);
      const float x = L[i];
      float y = x;
      for (int k = 0; k < 4; k++) {
        const float f = base[k] * (1 + intensity_ * 5.f * lamp);
        const float t = std::tan(kPi * clampf(f, 20, sr_ * 0.45f) / sr_);
        y = ap_[k].run(y, (t - 1) / (t + 1));
      }
      L[i] = (vibrato_ ? y : 0.5f * (x + y)) * level_;
    }
  }
protected:
  void configure() override {
    lfo_.setRate(sr_, expMap(clampf(p_[0], 0, 1), 0.5f, 10));
    intensity_ = clampf(p_[1], 0, 1);
    vibrato_ = p_[2] > 0.5f;
    level_ = dbToGain(p_[3]);
  }
private:
  Allpass1 ap_[4];
  Lfo lfo_;
  float intensity_ = 0.7f, level_ = 1;
  bool vibrato_ = false;
};

// Tremolo: Rate, Depth, Shape (0 sine, 1 triangle, 2 square), Mode (0 bias, 1 optical, 2 harmonic, 3 pan), Sync
class Tremolo : public ModBase {
public:
  Tremolo() { p_[0] = 4; p_[1] = 0.6f; p_[2] = 0; p_[3] = 0; p_[4] = 0; }
  bool stereo() const override { return true; }
  void reset() override { for (auto& x : xo_) x.reset(); opt_ = 0; }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      lfo_.step();
      float w;
      if (shape_ == 1) w = lfo_.triangle();
      else if (shape_ == 2) w = tanhFast(lfo_.sine() * 4.f);
      else w = lfo_.sine();
      w = 0.5f + 0.5f * w; // 0..1
      if (mode_ == 1) { opt_ += (w > opt_ ? 0.02f : 0.003f) * (w - opt_); w = opt_; }
      const float g = 1 - depth_ * w;
      if (mode_ == 2) {
        float lo, hi, lo2, hi2;
        xo_[0].run(L[i], lo, hi);
        xo_[1].run(R[i], lo2, hi2);
        const float g2 = 1 - depth_ * (1 - w);
        L[i] = lo * g + hi * g2;
        R[i] = lo2 * g + hi2 * g2;
      } else if (mode_ == 3) {
        const float pl = std::sqrt(1 - depth_ * w), pr = std::sqrt(1 - depth_ * (1 - w));
        L[i] *= pl; R[i] *= pr;
      } else {
        L[i] *= g; R[i] *= g;
      }
    }
  }
protected:
  void configure() override {
    const float sync = syncSeconds((int)p_[4], bpm_);
    lfo_.setRate(sr_, sync > 0 ? 1.f / sync : clampf(p_[0], 0.1f, 20));
    depth_ = clampf(p_[1], 0, 1);
    shape_ = (int)p_[2];
    mode_ = (int)p_[3];
    xo_[0].set(sr_, 600);
    xo_[1].set(sr_, 600);
  }
private:
  Lfo lfo_;
  Crossover xo_[2];
  float depth_ = 0.5f, opt_ = 0;
  int shape_ = 0, mode_ = 0;
};

// Rotary: Speed (0 slow, 1 fast), Balance (-1 drum .. 1 horn), Drive, Width, Mix
class Rotary : public ModBase {
public:
  Rotary() { p_[0] = 0; p_[1] = 0; p_[2] = 2; p_[3] = 0.8f; p_[4] = 1; }
  bool stereo() const override { return true; }
  void reset() override { dl_.clear(); xo_.reset(); }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      // speeds ramp like the real motors: the horn quickly, the drum slowly
      const float hT = fast_ ? 6.7f : 0.8f, dT = fast_ ? 5.9f : 0.7f;
      hornHz_ += (hT > hornHz_ ? hornUp_ : hornDown_) * (hT - hornHz_);
      drumHz_ += (dT > drumHz_ ? drumUp_ : drumDown_) * (dT - drumHz_);
      hornPh_ += hornHz_ / sr_; if (hornPh_ >= 1) hornPh_ -= 1;
      drumPh_ += drumHz_ / sr_; if (drumPh_ >= 1) drumPh_ -= 1;
      const float dry = 0.5f * (L[i] + R[i]);
      const float x = drive_ > 0 ? tanhFast(dry * drive_) / tanhFast(drive_) : dry;
      float lo, hi;
      xo_.run(x, lo, hi);
      dl_.push(hi);
      const float sl = std::sin(kTwoPi * hornPh_), sr = std::sin(kTwoPi * (hornPh_ + 0.25f));
      const float hl = dl_.linear(hornBase_ + hornDepth_ * sl) * (1 - 0.3f * (1 - sl));
      const float hr = dl_.linear(hornBase_ + hornDepth_ * sr) * (1 - 0.3f * (1 - sr));
      const float dl = std::sin(kTwoPi * drumPh_), dr = std::sin(kTwoPi * (drumPh_ + 0.25f));
      const float bl = lo * (1 - 0.18f * (1 - dl)), br = lo * (1 - 0.18f * (1 - dr));
      float wl = hornGain_ * hl + drumGain_ * bl, wr = hornGain_ * hr + drumGain_ * br;
      const float mid = 0.5f * (wl + wr), side = 0.5f * (wl - wr) * width_;
      wl = mid + side; wr = mid - side;
      const float m = mix_.next();
      L[i] = (1 - m) * L[i] + m * wl;
      R[i] = (1 - m) * R[i] + m * wr;
    }
  }
protected:
  void alloc() override { dl_.alloc((int)(0.01f * sr_)); }
  void configure() override {
    fast_ = p_[0] > 0.5f;
    const float b = clampf(p_[1], -1, 1);
    hornGain_ = b > 0 ? 1 : 1 + b; drumGain_ = b < 0 ? 1 : 1 - b;
    drive_ = clampf(p_[2], 0, 10) * 0.4f;
    width_ = clampf(p_[3], 0, 1.5f);
    mix_.set(clampf(p_[4], 0, 1));
    xo_.set(sr_, 800);
    hornBase_ = 0.0012f * sr_; hornDepth_ = 0.0006f * sr_;
    hornUp_ = 1.f - std::exp(-1.f / (0.7f * sr_)); hornDown_ = 1.f - std::exp(-1.f / (1.6f * sr_));
    drumUp_ = 1.f - std::exp(-1.f / (3.5f * sr_)); drumDown_ = 1.f - std::exp(-1.f / (5.0f * sr_));
  }
private:
  DelayLine dl_;
  Crossover xo_;
  bool fast_ = false;
  float hornHz_ = 0.8f, drumHz_ = 0.7f, hornPh_ = 0, drumPh_ = 0;
  float hornUp_ = 0, hornDown_ = 0, drumUp_ = 0, drumDown_ = 0;
  float hornBase_ = 50, hornDepth_ = 30, hornGain_ = 1, drumGain_ = 1, drive_ = 0, width_ = 1;
};

// Ring Modulator: Frequency (Hz), Mix
class RingMod : public ModBase {
public:
  RingMod() { p_[0] = 440; p_[1] = 0.5f; }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) {
      lfo_.step();
      const float m = mix_.next();
      L[i] = (1 - m) * L[i] + m * L[i] * lfo_.sine();
    }
  }
protected:
  void configure() override { lfo_.setRate(sr_, clampf(p_[0], 1, 4000)); mix_.set(clampf(p_[1], 0, 1)); }
private:
  Lfo lfo_;
};

} // namespace

Block* createModulation(int type) {
  switch (type) {
    case B_CHORUS: return new Chorus();
    case B_CHORUS_DIM: return new Dimension();
    case B_FLANGER: return new Flanger();
    case B_PHASER: return new Phaser(false);
    case B_PHASER_SCRIPT: return new Phaser(true);
    case B_VIBE: return new Vibe();
    case B_TREMOLO: return new Tremolo();
    case B_ROTARY: return new Rotary();
    case B_RINGMOD: return new RingMod();
    default: return nullptr;
  }
}

} // namespace forge
