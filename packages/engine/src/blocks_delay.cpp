// Delays (stereo, time-based: they keep ringing when bypassed with trails on).
// Mix is the wet level; the dry signal always passes at unity.
#include <cmath>

#include "blocks.h"
#include "dsp.h"

namespace forge {
namespace {

constexpr float kMaxDelaySec = 2.6f;

class DelayBase : public Block {
public:
  bool stereo() const override { return true; }
  bool timeBased() const override { return true; }
  void setParam(int i, float v) override { if (i >= 0 && i < 8) { p_[i] = v; dirty_ = true; } }
  void setTempo(float bpm) override { if (bpm != bpm_) { bpm_ = bpm; dirty_ = true; } }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    dl_[0].alloc((int)(maxSeconds() * sr) + 8);
    dl_[1].alloc((int)(maxSeconds() * sr) + 8);
    mix_.setTime(sr, 20);
    time_[0].setTime(sr, 120);
    time_[1].setTime(sr, 120);
    configure();
    mix_.snap(mix_.target);
    time_[0].snap(time_[0].target);
    time_[1].snap(time_[1].target);
    dirty_ = false;
  }
  void reset() override { dl_[0].clear(); dl_[1].clear(); fb_[0] = fb_[1] = 0; resetState(); }
protected:
  virtual float maxSeconds() const { return kMaxDelaySec; }
  virtual void configure() = 0;
  virtual void resetState() {}
  /** delay time in samples from a ms value and a sync division */
  float samples(float ms, int sync) const {
    const float s = syncSeconds(sync, bpm_);
    const float sec = s > 0 ? s : clampf(ms, 1, 2500) * 0.001f;
    // read before write, so one sample less
    return clampf(sec, 0.001f, maxSeconds() - 0.01f) * sr_ - 1.f;
  }
  void check() { if (dirty_) { configure(); dirty_ = false; } }
  float p_[8] = {};
  bool dirty_ = true;
  float bpm_ = 120;
  DelayLine dl_[2];
  Smooth mix_, time_[2];
  float fb_[2] = { 0, 0 };
};

// Digital: Time, Feedback, Mix, Sync, Low Cut, High Cut
class DigitalDelay : public DelayBase {
public:
  DigitalDelay() { p_[0] = 380; p_[1] = 0.35f; p_[2] = 0.35f; p_[3] = 0; p_[4] = 80; p_[5] = 9000; }
  void process(float* L, float* R, int n) override {
    check();
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      const float m = mix_.next();
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        const float y = dl_[c].cubic(time_[c].next());
        const float f = hc_[c].run(lc_[c].run(y));
        dl_[c].push(x + undenormal(f * feedback_));
        ch[c][i] = x + m * y;
      }
    }
  }
protected:
  void configure() override {
    const float t = samples(p_[0], (int)p_[3]);
    time_[0].set(t); time_[1].set(t);
    feedback_ = clampf(p_[1], 0, 1);
    mix_.set(clampf(p_[2], 0, 1));
    for (int c = 0; c < 2; c++) {
      if (p_[4] > 10) lc_[c].lowCut(sr_, p_[4]); else lc_[c].bypass();
      if (p_[5] > 100 && p_[5] < sr_ * 0.45f) hc_[c].highCut(sr_, p_[5]); else hc_[c].bypass();
    }
  }
  void resetState() override { for (int c = 0; c < 2; c++) { lc_[c].reset(); hc_[c].reset(); } }
private:
  Biquad lc_[2], hc_[2];
  float feedback_ = 0.3f;
};

// Analog (BBD): Time, Feedback, Mix, Tone, Mod, Sync
class AnalogDelay : public DelayBase {
public:
  AnalogDelay() { p_[0] = 320; p_[1] = 0.4f; p_[2] = 0.35f; p_[3] = 0.5f; p_[4] = 0.3f; p_[5] = 0; }
  void process(float* L, float* R, int n) override {
    check();
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      lfo_.step();
      const float m = mix_.next();
      const float mod = 1 + modDepth_ * lfo_.sine();
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        const float y = dl_[c].cubic(time_[c].next() * (c ? 2 - mod : mod));
        const float f = lp2_[c].lp(lp_[c].lp(y));
        dl_[c].push(tanhFast(x + f * feedback_));
        ch[c][i] = x + m * f;
      }
    }
  }
protected:
  float maxSeconds() const override { return 1.0f; }
  void configure() override {
    const float t = samples(clampf(p_[0], 20, 900), (int)p_[5]);
    time_[0].set(t); time_[1].set(t);
    feedback_ = clampf(p_[1], 0, 1.1f);
    mix_.set(clampf(p_[2], 0, 1));
    // a BBD gets darker as the clock slows down for long times
    const float fc = lerp(6500.f, 2200.f, t / (0.9f * sr_)) * lerp(0.45f, 1.3f, clampf(p_[3], 0, 1));
    for (int c = 0; c < 2; c++) { lp_[c].lowpass(sr_, fc); lp2_[c].lowpass(sr_, fc * 1.4f); }
    lfo_.setRate(sr_, 0.45f);
    modDepth_ = clampf(p_[4], 0, 1) * 0.004f;
  }
  void resetState() override { for (int c = 0; c < 2; c++) { lp_[c].reset(); lp2_[c].reset(); } }
private:
  OnePole lp_[2], lp2_[2];
  Lfo lfo_;
  float feedback_ = 0.4f, modDepth_ = 0;
};

// Tape Echo: Time, Feedback, Mix, Wow, Flutter, Saturation, Tone (Hz), Sync
class TapeDelay : public DelayBase {
public:
  TapeDelay() { p_[0] = 350; p_[1] = 0.4f; p_[2] = 0.35f; p_[3] = 0.3f; p_[4] = 0.3f; p_[5] = 0.4f; p_[6] = 5500; p_[7] = 0; }
  void process(float* L, float* R, int n) override {
    check();
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      wow_.step(); flutter_.step(); drift_.step();
      const float m = mix_.next();
      const float speed = 1 + wowDepth_ * (0.7f * wow_.sine() + 0.3f * drift_.sine()) + flutterDepth_ * flutter_.sine();
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        const float y = dl_[c].cubic(time_[c].next() * speed);
        const float f = bump_[c].run(tone_[c].run(y));
        dl_[c].push(sat_ > 0 ? tanhFast((x + f * feedback_) * (1 + 2 * sat_)) / (1 + sat_) : x + f * feedback_);
        ch[c][i] = x + m * f;
      }
    }
  }
protected:
  void configure() override {
    const float t = samples(clampf(p_[0], 40, 2000), (int)p_[7]);
    time_[0].set(t); time_[1].set(t);
    feedback_ = clampf(p_[1], 0, 1.1f);
    mix_.set(clampf(p_[2], 0, 1));
    wow_.setRate(sr_, 0.55f); drift_.setRate(sr_, 0.13f); flutter_.setRate(sr_, 7.3f);
    wowDepth_ = clampf(p_[3], 0, 1) * 0.004f;
    flutterDepth_ = clampf(p_[4], 0, 1) * 0.0012f;
    sat_ = clampf(p_[5], 0, 1);
    for (int c = 0; c < 2; c++) { tone_[c].highCut(sr_, clampf(p_[6], 1000, 16000), 0.6f); bump_[c].peak(sr_, 110, 1.0f, 2.5f); }
  }
  void resetState() override { for (int c = 0; c < 2; c++) { tone_[c].reset(); bump_[c].reset(); } }
private:
  Biquad tone_[2], bump_[2];
  Lfo wow_, flutter_, drift_;
  float feedback_ = 0.4f, wowDepth_ = 0, flutterDepth_ = 0, sat_ = 0;
};

// Ping Pong: Time, Feedback, Mix, Spread, Sync
class PingPong : public DelayBase {
public:
  PingPong() { p_[0] = 420; p_[1] = 0.45f; p_[2] = 0.35f; p_[3] = 1; p_[4] = 0; }
  void process(float* L, float* R, int n) override {
    check();
    for (int i = 0; i < n; i++) {
      const float m = mix_.next();
      const float x = 0.5f * (L[i] + R[i]);
      const float t = time_[0].next();
      const float yl = dl_[0].cubic(t), yr = dl_[1].cubic(t);
      dl_[0].push(x + undenormal(hc_[1].run(yr) * feedback_));
      dl_[1].push(undenormal(hc_[0].run(yl) * feedback_));
      const float s = spread_;
      L[i] += m * (yl * (0.5f + 0.5f * s) + yr * (0.5f - 0.5f * s));
      R[i] += m * (yr * (0.5f + 0.5f * s) + yl * (0.5f - 0.5f * s));
    }
  }
protected:
  void configure() override {
    time_[0].set(samples(p_[0], (int)p_[4]));
    feedback_ = clampf(p_[1], 0, 1);
    mix_.set(clampf(p_[2], 0, 1));
    spread_ = clampf(p_[3], 0, 1);
    hc_[0].highCut(sr_, 8000); hc_[1].highCut(sr_, 8000);
  }
  void resetState() override { hc_[0].reset(); hc_[1].reset(); }
private:
  Biquad hc_[2];
  float feedback_ = 0.4f, spread_ = 1;
};

// Dual: Time L, Time R, Feedback, Mix, High Cut
class DualDelay : public DelayBase {
public:
  DualDelay() { p_[0] = 300; p_[1] = 450; p_[2] = 0.35f; p_[3] = 0.35f; p_[4] = 8000; }
  void process(float* L, float* R, int n) override {
    check();
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      const float m = mix_.next();
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        const float y = dl_[c].cubic(time_[c].next());
        dl_[c].push(x + undenormal(hc_[c].run(y) * feedback_));
        ch[c][i] = x + m * y;
      }
    }
  }
protected:
  void configure() override {
    time_[0].set(samples(p_[0], 0));
    time_[1].set(samples(p_[1], 0));
    feedback_ = clampf(p_[2], 0, 1);
    mix_.set(clampf(p_[3], 0, 1));
    for (auto& h : hc_) h.highCut(sr_, clampf(p_[4], 1000, 18000));
  }
  void resetState() override { hc_[0].reset(); hc_[1].reset(); }
private:
  Biquad hc_[2];
  float feedback_ = 0.35f;
};

// Reverse: Time, Feedback, Mix
class ReverseDelay : public DelayBase {
public:
  ReverseDelay() { p_[0] = 700; p_[1] = 0.3f; p_[2] = 0.45f; }
  void process(float* L, float* R, int n) override {
    check();
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      const float m = mix_.next();
      phase_ += 1;
      if (phase_ >= T_) phase_ -= T_;
      float ph2 = phase_ + T_ * 0.5f;
      if (ph2 >= T_) ph2 -= T_;
      // two heads read the last segment backwards; sin^2 windows sum to one
      const float w1 = std::sin(kPi * phase_ / T_), w2 = std::sin(kPi * ph2 / T_);
      const float g1 = w1 * w1, g2 = w2 * w2;
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        const float y = g1 * dl_[c].linear(2 * phase_ + 1) + g2 * dl_[c].linear(2 * ph2 + 1);
        dl_[c].push(x + undenormal(y * feedback_));
        ch[c][i] = x + m * y;
      }
    }
  }
protected:
  float maxSeconds() const override { return 4.2f; }
  void configure() override {
    const float t = clampf(p_[0], 100, 2000) * 0.001f * sr_;
    if (std::fabs(t - T_) > 1) { T_ = t; phase_ = 0; }
    feedback_ = clampf(p_[1], 0, 0.95f);
    mix_.set(clampf(p_[2], 0, 1));
  }
private:
  float T_ = 30000, phase_ = 0, feedback_ = 0.3f;
};

// Ducked: Time, Feedback, Mix, Threshold (dB), Amount (dB), Sync
class DuckedDelay : public DelayBase {
public:
  DuckedDelay() { p_[0] = 420; p_[1] = 0.4f; p_[2] = 0.45f; p_[3] = -30; p_[4] = -18; p_[5] = 0; }
  void process(float* L, float* R, int n) override {
    check();
    float* ch[2] = { L, R };
    for (int i = 0; i < n; i++) {
      const float e = env_.run(0.5f * (L[i] + R[i]));
      const float target = e > thr_ ? duck_ : 1.f;
      gain_ += (target < gain_ ? 0.01f : rel_) * (target - gain_);
      const float m = mix_.next() * gain_;
      const float t = time_[0].next();
      for (int c = 0; c < 2; c++) {
        const float x = ch[c][i];
        const float y = dl_[c].cubic(t);
        dl_[c].push(x + undenormal(hc_[c].run(y) * feedback_));
        ch[c][i] = x + m * y;
      }
    }
  }
protected:
  void configure() override {
    time_[0].set(samples(p_[0], (int)p_[5]));
    feedback_ = clampf(p_[1], 0, 1);
    mix_.set(clampf(p_[2], 0, 1));
    thr_ = dbToGain(clampf(p_[3], -70, 0));
    duck_ = dbToGain(clampf(p_[4], -60, 0));
    env_.set(sr_, 1, 120);
    rel_ = 1.f - std::exp(-1.f / (0.25f * sr_));
    for (auto& h : hc_) h.highCut(sr_, 8000);
  }
  void resetState() override { env_.reset(); gain_ = 1; hc_[0].reset(); hc_[1].reset(); }
private:
  Envelope env_;
  Biquad hc_[2];
  float feedback_ = 0.4f, thr_ = 0.03f, duck_ = 0.1f, gain_ = 1, rel_ = 0.001f;
};

// Multi-Tap: Time, Taps (2..8), Feedback, Mix, Spread, Decay
class MultiTap : public DelayBase {
public:
  MultiTap() { p_[0] = 600; p_[1] = 4; p_[2] = 0.25f; p_[3] = 0.35f; p_[4] = 0.8f; p_[5] = 0.7f; }
  void process(float* L, float* R, int n) override {
    check();
    for (int i = 0; i < n; i++) {
      const float m = mix_.next();
      const float x = 0.5f * (L[i] + R[i]);
      const float t = time_[0].next();
      float wl = 0, wr = 0, last = 0;
      for (int k = 1; k <= taps_; k++) {
        const float y = dl_[0].cubic(t * (float)k / (float)taps_);
        const float g = gain_[k - 1];
        const float pan = (k & 1) ? spread_ : -spread_;
        wl += y * g * (0.5f - 0.5f * pan) * 2;
        wr += y * g * (0.5f + 0.5f * pan) * 2;
        last = y;
      }
      dl_[0].push(x + undenormal(hc_.run(last) * feedback_));
      L[i] += m * wl * 0.6f;
      R[i] += m * wr * 0.6f;
    }
  }
protected:
  void configure() override {
    time_[0].set(samples(p_[0], 0));
    taps_ = (int)clampf(p_[1], 2, 8);
    feedback_ = clampf(p_[2], 0, 0.95f);
    mix_.set(clampf(p_[3], 0, 1));
    spread_ = clampf(p_[4], 0, 1);
    decay_ = clampf(p_[5], 0.1f, 1);
    for (int k = 0; k < 8; k++) gain_[k] = std::pow(decay_, (float)k);
    hc_.highCut(sr_, 7000);
  }
  void resetState() override { hc_.reset(); }
private:
  Biquad hc_;
  int taps_ = 4;
  float feedback_ = 0.25f, spread_ = 0.8f, decay_ = 0.7f, gain_[8] = {};
};

} // namespace

Block* createDelay(int type) {
  switch (type) {
    case B_DELAY_DIGITAL: return new DigitalDelay();
    case B_DELAY_ANALOG: return new AnalogDelay();
    case B_DELAY_TAPE: return new TapeDelay();
    case B_DELAY_PINGPONG: return new PingPong();
    case B_DELAY_DUAL: return new DualDelay();
    case B_DELAY_REVERSE: return new ReverseDelay();
    case B_DELAY_DUCKED: return new DuckedDelay();
    case B_DELAY_MULTITAP: return new MultiTap();
    default: return nullptr;
  }
}

} // namespace forge
