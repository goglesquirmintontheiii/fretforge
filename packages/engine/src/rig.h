// forge-dsp: a mono amp chain used for tab tracks, the browser rig and the native rig.
//
//   input gain -> noise gate -> NAM -> IR -> EQ (low cut, bass, mid, treble, high cut) -> output gain
//
// Blocks with nothing loaded or switched off are skipped. NAM and IR objects are owned by the
// caller so they can be swapped without touching the rest of the chain.
#pragma once

namespace forge {

class NamModel;
class Convolver;

struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  float z1 = 0, z2 = 0;
  bool active = false;
  inline float run(float x) {
    const float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
  void reset() { z1 = z2 = 0; }
  void lowCut(float sr, float hz);
  void highCut(float sr, float hz);
  void peak(float sr, float hz, float q, float db);
  void lowShelf(float sr, float hz, float db);
  void highShelf(float sr, float hz, float db);
};

enum RigParam {
  P_INPUT_DB = 0,
  P_OUTPUT_DB,
  P_GATE_ON,
  P_GATE_DB,
  P_NAM_ON,
  P_IR_ON,
  P_LOWCUT_HZ, // 0 = off
  P_HIGHCUT_HZ, // 0 = off
  P_BASS_DB,
  P_MID_DB,
  P_TREBLE_DB,
  P_NAM_GAIN, // linear output normalisation for the loaded model
  P_IR_MIX,   // 0..1 wet
  P_COUNT
};

class Rig {
public:
  explicit Rig(float sampleRate, int maxBlock);
  ~Rig();
  void setNam(NamModel* m) { nam_ = m; }
  void setIr(Convolver* c) { ir_ = c; }
  void set(int param, float value);
  float get(int param) const { return (param >= 0 && param < P_COUNT) ? p_[param] : 0.f; }
  void process(const float* in, float* out, int n);
  void reset();
  // peak input/output since the last call, for meters
  float takeInPeak() { float v = inPeak_; inPeak_ = 0; return v; }
  float takeOutPeak() { float v = outPeak_; outPeak_ = 0; return v; }
  float gateReduction() const { return gateGain_; }

private:
  void updateEq();
  float sr_;
  int maxBlock_;
  float p_[P_COUNT];
  NamModel* nam_ = nullptr;
  Convolver* ir_ = nullptr;
  float* tmp_ = nullptr;
  float inGain_ = 1, outGain_ = 1;
  // gate
  float env_ = 0, gateGain_ = 1, gateOpen_ = 0.001f, gateClose_ = 0.0007f;
  bool gateIsOpen_ = false;
  float attack_, release_, envRelease_;
  Biquad eq_[5];
  float inPeak_ = 0, outPeak_ = 0;
};

} // namespace forge
