// forge-dsp: small building blocks shared by the rig blocks.
//
// Everything here is header-only and allocation-free after setup. Objects that need memory
// (delay lines) allocate in alloc(), which callers only use outside the audio thread.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace forge {

constexpr float kPi = 3.14159265358979f;
constexpr float kTwoPi = 6.28318530717959f;

inline float dbToGain(float db) { return std::exp(db * 0.115129254649702f); }
inline float gainToDb(float g) { return 20.f * std::log10(g > 1e-9f ? g : 1e-9f); }
inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }
inline float lerp(float a, float b, float t) { return a + (b - a) * t; }
/** maps 0..1 onto lo..hi exponentially (for frequencies and times) */
inline float expMap(float t, float lo, float hi) { return lo * std::pow(hi / lo, clampf(t, 0.f, 1.f)); }
/** flushes values that would turn into denormals in feedback paths */
inline float undenormal(float x) { return std::fabs(x) < 1e-15f ? 0.f : x; }

template <class T> inline T* zalloc(long n) { return (T*)std::calloc((size_t)(n > 0 ? n : 1), sizeof(T)); }

// ------------------------------------------------------------------ saturation
/** smooth tanh approximation (Padé, exact at 0, saturates at +-1) */
inline float tanhFast(float x) {
  x = clampf(x, -3.f, 3.f);
  const float x2 = x * x;
  return x * (27.f + x2) / (27.f + 9.f * x2);
}
/** diode pair in a feedback loop: soft knee, limits near +-limit */
inline float diodeSoft(float x, float limit) { return limit * tanhFast(x / limit); }
/** asymmetric soft clip: the negative side clips harder, adding even harmonics */
inline float asymClip(float x, float pos, float neg) { return x >= 0 ? pos * tanhFast(x / pos) : neg * tanhFast(x / neg); }
/** hard clip with a short rounded knee */
inline float hardKnee(float x, float limit) {
  const float a = std::fabs(x), k = limit * 0.8f;
  if (a <= k) return x;
  const float over = a - k, room = limit - k;
  const float y = k + room * over / (over + room);
  return x < 0 ? -y : y;
}

// ------------------------------------------------------------------ parameter smoothing
struct Smooth {
  float cur = 0, target = 0, coef = 1;
  void setTime(float sr, float ms) { coef = ms <= 0 ? 1.f : 1.f - std::exp(-1.f / (0.001f * ms * sr)); }
  void set(float v) { target = v; }
  void snap(float v) { cur = target = v; }
  inline float next() { cur += coef * (target - cur); return cur; }
  bool settled() const { return std::fabs(cur - target) < 1e-5f; }
};

// ------------------------------------------------------------------ filters
struct OnePole {
  float a = 1, z = 0;
  void lowpass(float sr, float hz) { a = 1.f - std::exp(-kTwoPi * clampf(hz, 1.f, sr * 0.49f) / sr); }
  inline float lp(float x) { z += a * (x - z); z = undenormal(z); return z; }
  inline float hp(float x) { return x - lp(x); }
  void reset() { z = 0; }
};

struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  float z1 = 0, z2 = 0;
  bool active = false;
  inline float run(float x) {
    const float y = b0 * x + z1;
    z1 = undenormal(b1 * x - a1 * y + z2);
    z2 = undenormal(b2 * x - a2 * y);
    return y;
  }
  void reset() { z1 = z2 = 0; }
  void bypass() { b0 = 1; b1 = b2 = a1 = a2 = 0; active = false; }
  void set(float nb0, float nb1, float nb2, float na0, float na1, float na2) {
    b0 = nb0 / na0; b1 = nb1 / na0; b2 = nb2 / na0; a1 = na1 / na0; a2 = na2 / na0; active = true;
  }
  void lowCut(float sr, float hz, float q = 0.7071f) {
    const float w = kTwoPi * clampf(hz, 5.f, sr * 0.45f) / sr, c = std::cos(w), al = std::sin(w) / (2 * q);
    set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  void highCut(float sr, float hz, float q = 0.7071f) {
    const float w = kTwoPi * clampf(hz, 20.f, sr * 0.45f) / sr, c = std::cos(w), al = std::sin(w) / (2 * q);
    set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  void bandpass(float sr, float hz, float q) { // 0 dB peak gain
    const float w = kTwoPi * clampf(hz, 20.f, sr * 0.45f) / sr, c = std::cos(w), al = std::sin(w) / (2 * q);
    set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  void allpass(float sr, float hz, float q) {
    const float w = kTwoPi * clampf(hz, 20.f, sr * 0.45f) / sr, c = std::cos(w), al = std::sin(w) / (2 * q);
    set(1 - al, -2 * c, 1 + al, 1 + al, -2 * c, 1 - al);
  }
  void peak(float sr, float hz, float q, float db) {
    const float A = std::pow(10.f, db / 40.f), w = kTwoPi * clampf(hz, 20.f, sr * 0.45f) / sr, c = std::cos(w), al = std::sin(w) / (2 * q);
    set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
    active = std::fabs(db) > 0.01f;
  }
  void lowShelf(float sr, float hz, float db, float slope = 1.f) {
    const float A = std::pow(10.f, db / 40.f), w = kTwoPi * clampf(hz, 20.f, sr * 0.45f) / sr, c = std::cos(w), s = std::sin(w);
    const float al = s / 2 * std::sqrt((A + 1 / A) * (1 / slope - 1) + 2), sa = 2 * std::sqrt(A) * al;
    set(A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa),
        (A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa);
    active = std::fabs(db) > 0.01f;
  }
  void highShelf(float sr, float hz, float db, float slope = 1.f) {
    const float A = std::pow(10.f, db / 40.f), w = kTwoPi * clampf(hz, 20.f, sr * 0.45f) / sr, c = std::cos(w), s = std::sin(w);
    const float al = s / 2 * std::sqrt((A + 1 / A) * (1 / slope - 1) + 2), sa = 2 * std::sqrt(A) * al;
    set(A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa),
        (A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa);
    active = std::fabs(db) > 0.01f;
  }
};

/** Topology-preserving state variable filter (Zavalishin); safe to modulate per sample. */
struct Svf {
  float g = 0, k = 1, a1 = 0, a2 = 0, a3 = 0;
  float ic1 = 0, ic2 = 0;
  float lp = 0, bp = 0, hp = 0;
  void set(float sr, float hz, float q) {
    g = std::tan(kPi * clampf(hz, 10.f, sr * 0.48f) / sr);
    k = 1.f / (q > 0.05f ? q : 0.05f);
    a1 = 1.f / (1.f + g * (g + k)); a2 = g * a1; a3 = g * a2;
  }
  inline void run(float x) {
    const float v3 = x - ic2;
    const float v1 = a1 * ic1 + a2 * v3;
    const float v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = undenormal(2 * v1 - ic1);
    ic2 = undenormal(2 * v2 - ic2);
    bp = v1; lp = v2; hp = x - k * v1 - v2;
  }
  void reset() { ic1 = ic2 = 0; }
};

/** Fourth-order Linkwitz-Riley split (two cascaded Butterworth sections per side). */
struct Crossover {
  Biquad lp1, lp2, hp1, hp2;
  void set(float sr, float hz) { lp1.highCut(sr, hz); lp2.highCut(sr, hz); hp1.lowCut(sr, hz); hp2.lowCut(sr, hz); }
  inline void run(float x, float& low, float& high) { low = lp2.run(lp1.run(x)); high = hp2.run(hp1.run(x)); }
  void reset() { lp1.reset(); lp2.reset(); hp1.reset(); hp2.reset(); }
};

/** first-order allpass with a moving coefficient (phasers, vibe, spring dispersion) */
struct Allpass1 {
  float z = 0;
  inline float run(float x, float a) { const float y = a * x + z; z = undenormal(x - a * y); return y; }
  void reset() { z = 0; }
};

// ------------------------------------------------------------------ delay line
class DelayLine {
public:
  DelayLine() = default;
  DelayLine(const DelayLine&) = delete;
  DelayLine& operator=(const DelayLine&) = delete;
  ~DelayLine() { std::free(buf_); }
  void alloc(int maxSamples) {
    int n = 16;
    while (n < maxSamples + 4) n <<= 1;
    if (n != size_) { std::free(buf_); buf_ = zalloc<float>(n); size_ = n; mask_ = n - 1; }
    w_ = 0;
  }
  void clear() { if (buf_) std::memset(buf_, 0, sizeof(float) * size_); }
  int capacity() const { return size_ - 4; }
  inline void push(float x) { w_ = (w_ + 1) & mask_; buf_[w_] = x; }
  /** d = 0 is the sample just pushed */
  inline float at(int d) const { return buf_[(w_ - d) & mask_]; }
  inline float linear(float d) const {
    const int i = (int)d; const float f = d - (float)i;
    const float a = buf_[(w_ - i) & mask_], b = buf_[(w_ - i - 1) & mask_];
    return a + f * (b - a);
  }
  inline float cubic(float d) const {
    if (d < 1.f) return linear(d);
    const int i = (int)d; const float f = d - (float)i;
    const float y0 = buf_[(w_ - i + 1) & mask_], y1 = buf_[(w_ - i) & mask_], y2 = buf_[(w_ - i - 1) & mask_], y3 = buf_[(w_ - i - 2) & mask_];
    const float c1 = 0.5f * (y2 - y0), c2 = y0 - 2.5f * y1 + 2.f * y2 - 0.5f * y3, c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }
private:
  float* buf_ = nullptr;
  int size_ = 0, mask_ = 0, w_ = 0;
};

// ------------------------------------------------------------------ modulation
struct Lfo {
  double phase = 0, inc = 0;
  void setRate(float sr, float hz) { inc = hz / sr; }
  inline void step() { phase += inc; if (phase >= 1.0) phase -= 1.0; }
  /** values for the current phase shifted by `offset` (0..1) */
  inline float sine(float offset = 0) const { return std::sin(kTwoPi * (float)(phase + offset)); }
  inline float triangle(float offset = 0) const { double p = phase + offset; p -= std::floor(p); return (float)(p < 0.5 ? 4 * p - 1 : 3 - 4 * p); }
  inline float saw(float offset = 0) const { double p = phase + offset; p -= std::floor(p); return (float)(2 * p - 1); }
};

/** peak envelope with separate attack and release times */
struct Envelope {
  float env = 0, att = 1, rel = 1;
  void set(float sr, float attackMs, float releaseMs) {
    att = 1.f - std::exp(-1.f / (0.001f * (attackMs > 0.01f ? attackMs : 0.01f) * sr));
    rel = 1.f - std::exp(-1.f / (0.001f * (releaseMs > 0.01f ? releaseMs : 0.01f) * sr));
  }
  inline float run(float x) { const float a = std::fabs(x); env += (a > env ? att : rel) * (a - env); env = undenormal(env); return env; }
  void reset() { env = 0; }
};

/** musical note lengths for tempo sync: index 0 = off */
inline float syncSeconds(int division, float bpm) {
  static const float beats[] = { 0, 4, 2, 3, 4.f / 3, 1, 1.5f, 2.f / 3, 0.5f, 0.75f, 1.f / 3, 0.25f };
  if (division <= 0 || division > 11 || bpm <= 0) return 0;
  return beats[division] * 60.f / bpm;
}

} // namespace forge
