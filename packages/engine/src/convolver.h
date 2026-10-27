// forge-dsp: zero-latency IR convolution.
//
// The first block of taps is convolved directly in the time domain, so the output has no added
// latency. Later taps use uniformly partitioned FFT convolution (overlap-save) with a
// frequency-domain delay line. All memory is allocated in create().
#pragma once
#include <complex>

#include "signalsmith-linear/fft.h"

namespace forge {

class Convolver {
public:
  static Convolver* create(const float* ir, int length, int block);
  ~Convolver();
  void process(const float* in, float* out, int n);
  void reset();
  int length() const { return length_; }

private:
  Convolver() = default;
  void blockStep();

  using Complex = std::complex<float>;
  signalsmith::linear::RealFFT<float> fft_;
  int B_ = 128, N_ = 256, bins_ = 128;
  int length_ = 0;
  int direct_ = 0;       // taps handled in the time domain
  int parts_ = 0;        // FFT partitions
  float* head_ = nullptr; // direct taps, reversed for a forward dot product
  float* hist_ = nullptr; // 2*B history so the dot product never wraps
  int histPos_ = 0;
  Complex* H_ = nullptr;   // parts_ * bins_
  Complex* fdl_ = nullptr; // parts_ * bins_ ring of input spectra
  int fdlPos_ = 0;
  Complex* acc_ = nullptr;
  float* frame_ = nullptr; // 2B: previous block + current block
  float* time_ = nullptr;  // 2B scratch
  float* tail_ = nullptr;  // B: FFT-part output for the current block
  int fill_ = 0;
};

} // namespace forge
