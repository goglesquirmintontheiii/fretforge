// forge-dsp: 2x / 4x oversampling with polyphase IIR half-band filters.
//
// The filters are pairs of allpass chains (the structure of Laurent de Soras' HIIR), designed
// at startup from an elliptic prototype. They are nearly minimum phase, so the added latency is
// only a couple of samples, which keeps the live rig tight. 8 coefficients with a 0.04
// transition band give about 95 dB of image rejection.
#pragma once
#include <cmath>

namespace forge {

namespace hiir {

inline double accNum(double q, int order, int c) {
  double result = 0, cur;
  int i = 0, j = 1;
  do {
    cur = std::pow(q, i * (i + 1)) * std::sin((i * 2 + 1) * c * 3.141592653589793 / order) * j;
    result += cur; j = -j; ++i;
  } while (std::fabs(cur) > 1e-30 && i < 100);
  return result;
}
inline double accDen(double q, int order, int c) {
  double result = 0, cur;
  int i = 1, j = -1;
  do {
    cur = std::pow(q, i * i) * std::cos(i * 2 * c * 3.141592653589793 / order) * j;
    result += cur; j = -j; ++i;
  } while (std::fabs(cur) > 1e-30 && i < 100);
  return result;
}
/** fills coef[0..n) for a half-band filter with the given transition width (0..0.5) */
inline void design(double* coef, int n, double transition) {
  double k = std::tan((1 - transition * 2) * 3.141592653589793 / 4);
  k *= k;
  const double kksqrt = std::pow(1 - k * k, 0.25);
  const double e = 0.5 * (1 - kksqrt) / (1 + kksqrt);
  const double e2 = e * e, e4 = e2 * e2;
  const double q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const int order = n * 2 + 1;
  for (int i = 0; i < n; i++) {
    const int c = i + 1;
    const double num = accNum(q, order, c) * std::pow(q, 0.25);
    const double den = accDen(q, order, c) + 0.5;
    const double ww = num / den, wwsq = ww * ww;
    const double x = std::sqrt((1 - wwsq * k) * (1 - wwsq / k)) / (1 + wwsq);
    coef[i] = (1 - x) / (1 + x);
  }
}

constexpr int N = 8;

struct Coefs {
  float c[N];
  Coefs() { double d[N]; design(d, N, 0.04); for (int i = 0; i < N; i++) c[i] = (float)d[i]; }
};
inline const Coefs& coefs() { static const Coefs k; return k; }

/** one half-band stage: 2x up or down */
struct Stage {
  float x[N] = {}, y[N] = {};
  // Two allpass chains in parallel: even coefficients on path 0, odd on path 1.
  inline void paths(float& p0, float& p1) {
    const float* c = coefs().c;
    for (int i = 0; i < N; i += 2) {
      const float t0 = (p0 - y[i]) * c[i] + x[i];
      x[i] = p0; y[i] = t0; p0 = t0;
      const float t1 = (p1 - y[i + 1]) * c[i + 1] + x[i + 1];
      x[i + 1] = p1; y[i + 1] = t1; p1 = t1;
    }
  }
  inline void up(float in, float& o0, float& o1) { float a = in, b = in; paths(a, b); o0 = a; o1 = b; }
  inline float down(float i0, float i1) { float a = i1, b = i0; paths(a, b); return 0.5f * (a + b); }
  void reset() { for (int i = 0; i < N; i++) x[i] = y[i] = 0; }
};

} // namespace hiir

/** Up/down sampler for one channel; factor 1, 2 or 4. Buffers are owned by the caller. */
struct Oversampler {
  int factor = 1;
  hiir::Stage u1, u2, d1, d2;
  void setFactor(int f) { factor = f >= 4 ? 4 : (f >= 2 ? 2 : 1); reset(); }
  void reset() { u1.reset(); u2.reset(); d1.reset(); d2.reset(); }
  /** writes n*factor samples to out */
  void up(const float* in, float* out, int n) {
    if (factor == 1) { for (int i = 0; i < n; i++) out[i] = in[i]; return; }
    if (factor == 2) { for (int i = 0; i < n; i++) u1.up(in[i], out[2 * i], out[2 * i + 1]); return; }
    for (int i = 0; i < n; i++) {
      float a, b;
      u1.up(in[i], a, b);
      u2.up(a, out[4 * i], out[4 * i + 1]);
      u2.up(b, out[4 * i + 2], out[4 * i + 3]);
    }
  }
  /** reads n*factor samples from in */
  void down(const float* in, float* out, int n) {
    if (factor == 1) { for (int i = 0; i < n; i++) out[i] = in[i]; return; }
    if (factor == 2) { for (int i = 0; i < n; i++) out[i] = d1.down(in[2 * i], in[2 * i + 1]); return; }
    for (int i = 0; i < n; i++) {
      const float a = d2.down(in[4 * i], in[4 * i + 1]);
      const float b = d2.down(in[4 * i + 2], in[4 * i + 3]);
      out[i] = d1.down(a, b);
    }
  }
  /** approximate group delay at low frequencies, in base-rate samples */
  float latency() const { return factor == 1 ? 0.f : (factor == 2 ? 3.1f : 4.6f); }
};

} // namespace forge
