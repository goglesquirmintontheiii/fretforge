// forge-dsp: Neural Amp Modeler runtime.
//
// Runs a program compiled from a .nam file by packages/shared/src/nam.ts. All memory is
// allocated in create(); process() never allocates, locks or throws.
#pragma once
#include <cstdint>

namespace forge {

class NamModel {
public:
  // Returns nullptr and sets *error on failure.
  static NamModel* create(const int32_t* code, int codeLen, const float* weights, int weightLen, int maxBlock, const char** error);
  ~NamModel();

  // in and out may alias.
  void process(const float* in, float* out, int n);
  // Clears all state and runs the model on silence so the first real samples are clean.
  void reset();
  int prewarmSamples() const { return prewarm_; }

private:
  NamModel() = default;
  void run(int n);
  struct Op;
  void runConv(Op& op, int n);

  struct Buffer { float* data; int ch; };
  struct View { float* base; int stride; int rows; };
  struct Op {
    int code;
    View a, b, c;
    int i0, i1, i2, i3, i4;
    const float* w;
    const float* w2;
    // Conv history ring / LSTM state
    float* state;
    int mask;
    int pos;
  };

  Buffer* buffers_ = nullptr;
  int nBuffers_ = 0;
  Op* ops_ = nullptr;
  int nOps_ = 0;
  float* weights_ = nullptr;
  View in_{}, out_{};
  int maxBlock_ = 0;
  int prewarm_ = 0;
  // one allocation for buffers + rings so reset() can clear it in one go
  float* arena_ = nullptr;
  long arenaFloats_ = 0;
};

} // namespace forge
