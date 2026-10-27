#include "convolver.h"

#include <cstdlib>
#include <cstring>

namespace forge {

namespace {
template <class T> T* zalloc(long n) { return (T*)std::calloc((size_t)(n > 0 ? n : 1), sizeof(T)); }
}

Convolver* Convolver::create(const float* ir, int length, int block) {
  if (length < 1) return nullptr;
  int B = 16;
  while (B < block) B <<= 1;
  Convolver* c = new Convolver();
  c->B_ = B;
  c->N_ = 2 * B;
  c->bins_ = B; // RealFFT packs DC and Nyquist into bin 0
  c->length_ = length;
  c->direct_ = length < B ? length : B;
  c->parts_ = length > B ? (length - B + B - 1) / B : 0;
  c->fft_.resize(c->N_);
  c->head_ = zalloc<float>(B);
  for (int q = 0; q < c->direct_; q++) c->head_[B - 1 - q] = ir[q]; // head_[B-1-q] pairs with x[n-q]
  c->hist_ = zalloc<float>(2 * B);
  c->frame_ = zalloc<float>(c->N_);
  c->time_ = zalloc<float>(c->N_);
  c->tail_ = zalloc<float>(B);
  if (c->parts_ > 0) {
    c->H_ = zalloc<Complex>((long)c->parts_ * c->bins_);
    c->fdl_ = zalloc<Complex>((long)c->parts_ * c->bins_);
    c->acc_ = zalloc<Complex>(c->bins_);
    const float scale = 1.0f / (float)c->N_; // fold the inverse FFT's normalisation into H
    for (int p = 0; p < c->parts_; p++) {
      std::memset(c->time_, 0, sizeof(float) * c->N_);
      const int start = (p + 1) * B;
      for (int q = 0; q < B && start + q < length; q++) c->time_[q] = ir[start + q] * scale;
      c->fft_.fft(c->time_, c->H_ + (long)p * c->bins_);
    }
  }
  return c;
}

Convolver::~Convolver() {
  std::free(head_); std::free(hist_); std::free(frame_); std::free(time_); std::free(tail_);
  std::free(H_); std::free(fdl_); std::free(acc_);
}

void Convolver::reset() {
  std::memset(hist_, 0, sizeof(float) * 2 * B_);
  std::memset(frame_, 0, sizeof(float) * N_);
  std::memset(tail_, 0, sizeof(float) * B_);
  if (fdl_) std::memset((void*)fdl_, 0, sizeof(Complex) * (size_t)parts_ * bins_);
  histPos_ = 0;
  fdlPos_ = 0;
  fill_ = 0;
}

void Convolver::blockStep() {
  // frame_ = [previous block, current block]
  fdlPos_ = (fdlPos_ + parts_ - 1) % parts_;
  Complex* X = fdl_ + (long)fdlPos_ * bins_;
  fft_.fft(frame_, X);
  std::memset((void*)acc_, 0, sizeof(Complex) * bins_);
  for (int p = 0; p < parts_; p++) {
    const Complex* Xp = fdl_ + (long)((fdlPos_ + p) % parts_) * bins_;
    const Complex* Hp = H_ + (long)p * bins_;
    // bin 0 holds DC (real) and Nyquist (imag), which multiply separately
    acc_[0] += Complex(Xp[0].real() * Hp[0].real(), Xp[0].imag() * Hp[0].imag());
    for (int k = 1; k < bins_; k++) acc_[k] += Xp[k] * Hp[k];
  }
  fft_.ifft(acc_, time_);
  std::memcpy(tail_, time_ + B_, sizeof(float) * B_);
  std::memcpy(frame_, frame_ + B_, sizeof(float) * B_);
}

void Convolver::process(const float* in, float* out, int n) {
  const int B = B_;
  for (int i = 0; i < n; i++) {
    const float x = in[i];
    // history: write twice so hist_[histPos_ .. histPos_+B) is always the last B inputs in order
    hist_[histPos_] = x;
    hist_[histPos_ + B] = x;
    histPos_ = (histPos_ + 1) & (B - 1);
    const float* h = hist_ + histPos_; // oldest .. newest
    float y = 0.f;
    for (int q = B - direct_; q < B; q++) y += head_[q] * h[q];
    if (parts_ > 0) {
      y += tail_[fill_];
      frame_[B + fill_] = x;
      if (++fill_ == B) { fill_ = 0; blockStep(); }
    }
    out[i] = y;
  }
}

} // namespace forge
