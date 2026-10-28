// forge-dsp: low-latency pitch shifting and monophonic pitch detection.
#pragma once
#include <cmath>

#include "dsp.h"

namespace forge {

/**
 * Two read heads sweep through a short delay line at a rate set by the pitch ratio and
 * crossfade with sin^2 windows. Latency is about half the window, so a 16 ms window keeps a
 * whammy under 10 ms. When a period is known (monophonic playing), the window snaps to a
 * multiple of it, which removes most of the warble.
 */
class PitchShifter {
public:
  void prepare(float sr, float maxWindowMs) {
    sr_ = sr;
    maxWindow_ = maxWindowMs * 0.001f * sr;
    dl_.alloc((int)(maxWindow_ * 2) + 64);
    window_ = maxWindow_;
    reset();
  }
  void reset() { dl_.clear(); phase_ = 0; }
  void setRatio(float r) { ratio_ = clampf(r, 0.125f, 8.f); }
  void setWindowMs(float ms) { window_ = clampf(ms * 0.001f * sr_, 64.f, maxWindow_); }
  /** align the window to a detected period (samples), or 0 to keep the set window */
  void setPeriod(float period, float baseMs) {
    const float base = clampf(baseMs * 0.001f * sr_, 64.f, maxWindow_);
    if (period > 16) {
      float k = std::round(base / period);
      if (k < 1) k = 1;
      target_ = clampf(k * period, 64.f, maxWindow_);
    } else target_ = base;
  }
  inline float process(float x) {
    dl_.push(x);
    if (target_ > 0) window_ += 0.002f * (target_ - window_);
    phase_ += (1.f - ratio_) / window_;
    phase_ -= std::floor(phase_);
    float ph2 = phase_ + 0.5f;
    if (ph2 >= 1) ph2 -= 1;
    const float s1 = std::sin(kPi * phase_), s2 = std::sin(kPi * ph2);
    return s1 * s1 * dl_.cubic(2.f + phase_ * window_) + s2 * s2 * dl_.cubic(2.f + ph2 * window_);
  }
  float latencySamples() const { return window_ * 0.5f; }

private:
  DelayLine dl_;
  float sr_ = 48000, maxWindow_ = 2048, window_ = 1024, target_ = 0, phase_ = 0, ratio_ = 1;
};

/**
 * YIN pitch detector on a 4x decimated copy of the input. update() runs every hop samples
 * (call it with every input sample); frequency() is 0 when there is no clear pitch.
 */
class PitchDetector {
public:
  static constexpr int W = 256;   // analysis window at the decimated rate
  static constexpr int TAU = 256; // longest period: ~47 Hz at 48 kHz
  void prepare(float sr) { sr_ = sr; reset(); aa_.highCut(sr, 2500); aa2_.highCut(sr, 2500); }
  void reset() { for (float& v : buf_) v = 0; pos_ = 0; dec_ = 0; hop_ = 0; freq_ = 0; conf_ = 0; }
  inline void push(float x) {
    const float y = aa2_.run(aa_.run(x));
    if (++dec_ < 4) return;
    dec_ = 0;
    buf_[pos_] = y;
    pos_ = (pos_ + 1) % (W + TAU);
    if (++hop_ >= 64) { hop_ = 0; analyse(); }
  }
  float frequency() const { return freq_; }
  float confidence() const { return conf_; }
  /** period at the full rate, in samples, or 0 */
  float period() const { return freq_ > 0 ? sr_ / freq_ : 0.f; }

private:
  void analyse() {
    float x[W + TAU];
    for (int i = 0; i < W + TAU; i++) x[i] = buf_[(pos_ + i) % (W + TAU)];
    float energy = 0;
    for (int i = 0; i < W; i++) energy += x[i] * x[i];
    if (energy < 1e-6f) { freq_ = 0; conf_ = 0; return; }
    float d[TAU];
    d[0] = 1;
    float running = 0;
    int best = -1;
    for (int tau = 1; tau < TAU; tau++) {
      float s = 0;
      for (int i = 0; i < W; i++) { const float df = x[i] - x[i + tau]; s += df * df; }
      running += s;
      d[tau] = running > 0 ? s * (float)tau / running : 1;
      if (best < 0 && tau > 4 && d[tau] < 0.15f) {
        // walk to the local minimum
        best = tau;
      } else if (best > 0 && tau == best + 1 && d[tau] < d[best]) best = tau;
    }
    if (best < 2 || best >= TAU - 1) { freq_ = 0; conf_ = 0; return; }
    // parabolic interpolation
    const float a = d[best - 1], b = d[best], c = d[best + 1];
    const float den = a - 2 * b + c;
    const float t = den != 0 ? (float)best + 0.5f * (a - c) / den : (float)best;
    freq_ = (sr_ / 4.f) / t;
    conf_ = 1 - b;
  }
  float sr_ = 48000;
  float buf_[W + TAU] = {};
  int pos_ = 0, dec_ = 0, hop_ = 0;
  float freq_ = 0, conf_ = 0;
  Biquad aa_, aa2_;
};

} // namespace forge
