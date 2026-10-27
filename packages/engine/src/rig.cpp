#include "rig.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

#include "convolver.h"
#include "nam.h"

namespace forge {

namespace {
constexpr float PI = 3.14159265358979f;
inline float dbToGain(float db) { return std::pow(10.f, db / 20.f); }
}

void Biquad::lowCut(float sr, float hz) {
  const float w = 2 * PI * hz / sr, c = std::cos(w), s = std::sin(w), alpha = s / (2 * 0.7071f);
  const float a0 = 1 + alpha;
  b0 = (1 + c) / 2 / a0; b1 = -(1 + c) / a0; b2 = (1 + c) / 2 / a0;
  a1 = -2 * c / a0; a2 = (1 - alpha) / a0;
  active = true;
}
void Biquad::highCut(float sr, float hz) {
  const float w = 2 * PI * hz / sr, c = std::cos(w), s = std::sin(w), alpha = s / (2 * 0.7071f);
  const float a0 = 1 + alpha;
  b0 = (1 - c) / 2 / a0; b1 = (1 - c) / a0; b2 = (1 - c) / 2 / a0;
  a1 = -2 * c / a0; a2 = (1 - alpha) / a0;
  active = true;
}
void Biquad::peak(float sr, float hz, float q, float db) {
  const float A = std::pow(10.f, db / 40.f), w = 2 * PI * hz / sr, c = std::cos(w), alpha = std::sin(w) / (2 * q);
  const float a0 = 1 + alpha / A;
  b0 = (1 + alpha * A) / a0; b1 = -2 * c / a0; b2 = (1 - alpha * A) / a0;
  a1 = -2 * c / a0; a2 = (1 - alpha / A) / a0;
  active = std::fabs(db) > 0.01f;
}
void Biquad::lowShelf(float sr, float hz, float db) {
  const float A = std::pow(10.f, db / 40.f), w = 2 * PI * hz / sr, c = std::cos(w), s = std::sin(w);
  const float alpha = s / 2 * std::sqrt(2.f), sa = 2 * std::sqrt(A) * alpha;
  const float a0 = (A + 1) + (A - 1) * c + sa;
  b0 = A * ((A + 1) - (A - 1) * c + sa) / a0;
  b1 = 2 * A * ((A - 1) - (A + 1) * c) / a0;
  b2 = A * ((A + 1) - (A - 1) * c - sa) / a0;
  a1 = -2 * ((A - 1) + (A + 1) * c) / a0;
  a2 = ((A + 1) + (A - 1) * c - sa) / a0;
  active = std::fabs(db) > 0.01f;
}
void Biquad::highShelf(float sr, float hz, float db) {
  const float A = std::pow(10.f, db / 40.f), w = 2 * PI * hz / sr, c = std::cos(w), s = std::sin(w);
  const float alpha = s / 2 * std::sqrt(2.f), sa = 2 * std::sqrt(A) * alpha;
  const float a0 = (A + 1) - (A - 1) * c + sa;
  b0 = A * ((A + 1) + (A - 1) * c + sa) / a0;
  b1 = -2 * A * ((A - 1) + (A + 1) * c) / a0;
  b2 = A * ((A + 1) + (A - 1) * c - sa) / a0;
  a1 = 2 * ((A - 1) - (A + 1) * c) / a0;
  a2 = ((A + 1) - (A - 1) * c - sa) / a0;
  active = std::fabs(db) > 0.01f;
}

Rig::Rig(float sampleRate, int maxBlock) : sr_(sampleRate), maxBlock_(maxBlock) {
  tmp_ = (float*)std::calloc((size_t)maxBlock, sizeof(float));
  for (float& v : p_) v = 0;
  p_[P_NAM_ON] = 1;
  p_[P_IR_ON] = 1;
  p_[P_GATE_DB] = -70;
  p_[P_NAM_GAIN] = 1;
  p_[P_IR_MIX] = 1;
  attack_ = 1 - std::exp(-1.f / (0.001f * sr_));
  release_ = 1 - std::exp(-1.f / (0.08f * sr_));
  envRelease_ = 1 - std::exp(-1.f / (0.02f * sr_));
  updateEq();
}

Rig::~Rig() { std::free(tmp_); }

void Rig::set(int param, float v) {
  if (param < 0 || param >= P_COUNT) return;
  p_[param] = v;
  switch (param) {
    case P_INPUT_DB: inGain_ = dbToGain(v); break;
    case P_OUTPUT_DB: outGain_ = dbToGain(v); break;
    case P_GATE_DB: gateOpen_ = dbToGain(v); gateClose_ = dbToGain(v - 3); break;
    case P_LOWCUT_HZ: case P_HIGHCUT_HZ: case P_BASS_DB: case P_MID_DB: case P_TREBLE_DB: updateEq(); break;
    default: break;
  }
}

void Rig::updateEq() {
  const float lc = p_[P_LOWCUT_HZ], hc = p_[P_HIGHCUT_HZ];
  if (lc > 10) eq_[0].lowCut(sr_, lc); else eq_[0].active = false;
  eq_[1].lowShelf(sr_, 120, p_[P_BASS_DB]);
  eq_[2].peak(sr_, 800, 0.7f, p_[P_MID_DB]);
  eq_[3].highShelf(sr_, 3200, p_[P_TREBLE_DB]);
  if (hc > 100 && hc < sr_ * 0.49f) eq_[4].highCut(sr_, hc); else eq_[4].active = false;
}

void Rig::reset() {
  if (nam_) nam_->reset();
  if (ir_) ir_->reset();
  for (auto& b : eq_) b.reset();
  env_ = 0;
  gateGain_ = 1;
  gateIsOpen_ = false;
}

void Rig::process(const float* in, float* out, int n) {
  while (n > 0) {
    const int k = n < maxBlock_ ? n : maxBlock_;
    float* x = tmp_;
    float pk = inPeak_;
    for (int i = 0; i < k; i++) { const float v = in[i] * inGain_; x[i] = v; const float a = std::fabs(v); if (a > pk) pk = a; }
    inPeak_ = pk;
    if (p_[P_GATE_ON] > 0.5f) {
      for (int i = 0; i < k; i++) {
        const float a = std::fabs(x[i]);
        env_ += (a > env_ ? attack_ : envRelease_) * (a - env_);
        if (gateIsOpen_) { if (env_ < gateClose_) gateIsOpen_ = false; }
        else if (env_ > gateOpen_) gateIsOpen_ = true;
        const float target = gateIsOpen_ ? 1.f : 0.f;
        gateGain_ += (target > gateGain_ ? attack_ : release_) * (target - gateGain_);
        x[i] *= gateGain_;
      }
    }
    if (nam_ && p_[P_NAM_ON] > 0.5f) {
      nam_->process(x, x, k);
      const float g = p_[P_NAM_GAIN];
      if (g != 1.f) for (int i = 0; i < k; i++) x[i] *= g;
    }
    if (ir_ && p_[P_IR_ON] > 0.5f) {
      const float wet = p_[P_IR_MIX];
      if (wet >= 0.999f) ir_->process(x, x, k);
      else {
        // dry/wet: out holds the dry copy temporarily
        for (int i = 0; i < k; i++) out[i] = x[i];
        ir_->process(x, x, k);
        for (int i = 0; i < k; i++) x[i] = wet * x[i] + (1 - wet) * out[i];
      }
    }
    for (auto& b : eq_) if (b.active) for (int i = 0; i < k; i++) x[i] = b.run(x[i]);
    float op = outPeak_;
    for (int i = 0; i < k; i++) {
      float v = x[i] * outGain_;
      if (!(v == v)) v = 0; // never pass NaN on
      out[i] = v;
      const float a = std::fabs(v);
      if (a > op) op = a;
    }
    outPeak_ = op;
    in += k; out += k; n -= k;
  }
}

} // namespace forge
