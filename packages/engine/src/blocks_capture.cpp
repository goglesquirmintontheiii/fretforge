// NAM captures (amp, preamp, pedal, cab, full rig), IR cabs, amp + cab, and the looper.
// Models and IRs are created outside the audio thread and owned by the graph.
#include <cmath>

#include "blocks.h"
#include "convolver.h"
#include "dsp.h"
#include "nam.h"

namespace forge {
namespace {

/** post-model tone stack shared by NAM blocks */
struct ToneStack {
  Biquad bass, mid, treble, presence;
  void set(float sr, float b, float m, float t, float p) {
    bass.lowShelf(sr, 120, clampf(b, -15, 15));
    mid.peak(sr, 750, 0.7f, clampf(m, -15, 15));
    treble.highShelf(sr, 3000, clampf(t, -15, 15));
    presence.highShelf(sr, 6500, clampf(p, -15, 15));
  }
  inline float run(float x) {
    if (bass.active) x = bass.run(x);
    if (mid.active) x = mid.run(x);
    if (treble.active) x = treble.run(x);
    if (presence.active) x = presence.run(x);
    return x;
  }
  void reset() { bass.reset(); mid.reset(); treble.reset(); presence.reset(); }
};

// NAM capture: Input (dB), Bass, Mid, Treble, Presence, Output (dB), Mix
class NamBlock : public Block {
public:
  NamBlock() { p_[6] = 1; }
  void setParam(int i, float v) override { if (i >= 0 && i < 7) { p_[i] = v; dirty_ = true; } }
  void setNam(NamModel* m, float gain) override { nam_ = m; modelGain_ = gain > 0 ? gain : 1.f; dirty_ = true; }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    std::free(dry_);
    dry_ = zalloc<float>(maxBlock);
    in_.setTime(sr, 20); out_.setTime(sr, 20); mix_.setTime(sr, 20);
    configure();
    in_.snap(in_.target); out_.snap(out_.target); mix_.snap(mix_.target);
    dirty_ = false;
  }
  ~NamBlock() override { std::free(dry_); }
  void reset() override { if (nam_) nam_->reset(); tone_.reset(); }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    if (!nam_) return;
    for (int i = 0; i < n; i++) { dry_[i] = L[i]; L[i] *= in_.next(); }
    nam_->process(L, L, n);
    for (int i = 0; i < n; i++) {
      const float y = tone_.run(L[i]) * out_.next();
      const float m = mix_.next();
      L[i] = m * y + (1 - m) * dry_[i];
    }
  }
private:
  void configure() {
    in_.set(dbToGain(clampf(p_[0], -24, 24)));
    tone_.set(sr_, p_[1], p_[2], p_[3], p_[4]);
    out_.set(dbToGain(clampf(p_[5], -40, 24)) * modelGain_);
    mix_.set(clampf(p_[6], 0, 1));
  }
  float p_[7] = {};
  bool dirty_ = true;
  NamModel* nam_ = nullptr;
  float modelGain_ = 1;
  float* dry_ = nullptr;
  ToneStack tone_;
  Smooth in_, out_, mix_;
};

// IR Cab: Mix, Low Cut, High Cut, Level (dB)
class IrCab : public Block {
public:
  IrCab() { p_[0] = 1; p_[1] = 80; p_[2] = 9000; p_[3] = 0; }
  void setParam(int i, float v) override { if (i >= 0 && i < 4) { p_[i] = v; dirty_ = true; } }
  void setIr(int slot, Convolver* c) override { if (slot == 0) ir_ = c; }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    std::free(dry_);
    dry_ = zalloc<float>(maxBlock);
    mix_.setTime(sr, 20); level_.setTime(sr, 20);
    configure();
    mix_.snap(mix_.target); level_.snap(level_.target);
    dirty_ = false;
  }
  ~IrCab() override { std::free(dry_); }
  void reset() override { if (ir_) ir_->reset(); lc_.reset(); hc_.reset(); }
  void process(float* L, float*, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    if (ir_) {
      std::memcpy(dry_, L, sizeof(float) * n);
      ir_->process(L, L, n);
      for (int i = 0; i < n; i++) { const float m = mix_.next(); L[i] = m * L[i] + (1 - m) * dry_[i]; }
    }
    for (int i = 0; i < n; i++) {
      float x = L[i];
      if (lc_.active) x = lc_.run(x);
      if (hc_.active) x = hc_.run(x);
      L[i] = x * level_.next();
    }
  }
private:
  void configure() {
    mix_.set(clampf(p_[0], 0, 1));
    if (p_[1] > 10) lc_.lowCut(sr_, p_[1]); else lc_.bypass();
    if (p_[2] > 100 && p_[2] < sr_ * 0.45f) hc_.highCut(sr_, p_[2]); else hc_.bypass();
    level_.set(dbToGain(clampf(p_[3], -40, 24)));
  }
  float p_[4];
  bool dirty_ = true;
  Convolver* ir_ = nullptr;
  float* dry_ = nullptr;
  Biquad lc_, hc_;
  Smooth mix_, level_;
};

// Dual Cab: Level A, Level B, Pan A, Pan B, Delay B (ms), Low Cut, High Cut
class DualCab : public Block {
public:
  DualCab() { p_[0] = 0; p_[1] = 0; p_[2] = -0.5f; p_[3] = 0.5f; p_[4] = 0; p_[5] = 80; p_[6] = 9000; }
  bool stereo() const override { return true; }
  void setParam(int i, float v) override { if (i >= 0 && i < 7) { p_[i] = v; dirty_ = true; } }
  void setIr(int slot, Convolver* c) override { if (slot == 0) a_ = c; else if (slot == 1) b_ = c; }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    std::free(ta_); std::free(tb_);
    ta_ = zalloc<float>(maxBlock); tb_ = zalloc<float>(maxBlock);
    delay_.alloc((int)(0.006f * sr));
    configure();
    dirty_ = false;
  }
  ~DualCab() override { std::free(ta_); std::free(tb_); }
  void reset() override { if (a_) a_->reset(); if (b_) b_->reset(); delay_.clear(); for (int c = 0; c < 2; c++) { lc_[c].reset(); hc_[c].reset(); } }
  void process(float* L, float* R, int n) override {
    if (dirty_) { configure(); dirty_ = false; }
    for (int i = 0; i < n; i++) { const float m = 0.5f * (L[i] + R[i]); ta_[i] = m; tb_[i] = m; }
    if (a_) a_->process(ta_, ta_, n);
    if (b_) b_->process(tb_, tb_, n);
    for (int i = 0; i < n; i++) {
      delay_.push(tb_[i]);
      const float b = delay_.linear(dSamples_);
      float l = ta_[i] * gal_ + b * gbl_, r = ta_[i] * gar_ + b * gbr_;
      if (lc_[0].active) { l = lc_[0].run(l); r = lc_[1].run(r); }
      if (hc_[0].active) { l = hc_[0].run(l); r = hc_[1].run(r); }
      L[i] = l; R[i] = r;
    }
  }
private:
  void configure() {
    const float la = dbToGain(clampf(p_[0], -40, 12)), lb = dbToGain(clampf(p_[1], -40, 12));
    const float pa = (clampf(p_[2], -1, 1) + 1) * 0.25f * kPi, pb = (clampf(p_[3], -1, 1) + 1) * 0.25f * kPi;
    gal_ = la * std::cos(pa); gar_ = la * std::sin(pa);
    gbl_ = lb * std::cos(pb); gbr_ = lb * std::sin(pb);
    dSamples_ = clampf(p_[4], 0, 5) * 0.001f * sr_;
    for (int c = 0; c < 2; c++) {
      if (p_[5] > 10) lc_[c].lowCut(sr_, p_[5]); else lc_[c].bypass();
      if (p_[6] > 100 && p_[6] < sr_ * 0.45f) hc_[c].highCut(sr_, p_[6]); else hc_[c].bypass();
    }
  }
  float p_[7];
  bool dirty_ = true;
  Convolver *a_ = nullptr, *b_ = nullptr;
  float *ta_ = nullptr, *tb_ = nullptr;
  DelayLine delay_;
  float gal_ = 0.7f, gar_ = 0.7f, gbl_ = 0.7f, gbr_ = 0.7f, dSamples_ = 0;
  Biquad lc_[2], hc_[2];
};

// Amp + Cab: Input, Bass, Mid, Treble, Presence, Output, Cab Mix, Low Cut, High Cut
class AmpCab : public Block {
public:
  AmpCab() { amp_.setParam(6, 1); cab_.setParam(0, 1); }
  void setParam(int i, float v) override {
    if (i >= 0 && i < 6) amp_.setParam(i, v);
    else if (i == 6) cab_.setParam(0, v);
    else if (i == 7) cab_.setParam(1, v);
    else if (i == 8) cab_.setParam(2, v);
  }
  void setNam(NamModel* m, float g) override { amp_.setNam(m, g); }
  void setIr(int slot, Convolver* c) override { cab_.setIr(slot, c); }
  void prepare(float sr, int maxBlock) override { Block::prepare(sr, maxBlock); amp_.prepare(sr, maxBlock); cab_.prepare(sr, maxBlock); }
  void reset() override { amp_.reset(); cab_.reset(); }
  void process(float* L, float* R, int n) override { amp_.process(L, R, n); cab_.process(L, R, n); }
private:
  NamBlock amp_;
  IrCab cab_;
};

// Looper: Level (dB). Buttons via trigger(): 0 record/play/overdub, 1 play/stop, 2 undo, 3 clear, 4 half speed, 5 reverse
// Undo restores the last overdub layer. Samples are stamped with the layer that last changed
// them, so starting an overdub costs nothing and undo runs in slices across callbacks.
class Looper : public Block {
public:
  static constexpr float kSeconds = 30;
  bool stereo() const override { return true; }
  bool timeBased() const override { return true; }
  void setParam(int i, float v) override { if (i == 0) level_ = dbToGain(clampf(v, -40, 12)); }
  void prepare(float sr, int maxBlock) override {
    Block::prepare(sr, maxBlock);
    cap_ = (int)(kSeconds * sr);
    for (int c = 0; c < 2; c++) { std::free(buf_[c]); std::free(undo_[c]); buf_[c] = zalloc<float>(cap_); undo_[c] = zalloc<float>(cap_); }
    std::free(stamp_);
    stamp_ = zalloc<uint16_t>(cap_);
  }
  ~Looper() override { for (int c = 0; c < 2; c++) { std::free(buf_[c]); std::free(undo_[c]); } std::free(stamp_); }
  void trigger(int a) override { pending_ = a + 1; }
  int state() const override { return mode_ | (half_ ? 8 : 0) | (reverse_ ? 16 : 0) | (layer_ > 0 && !undoing_ ? 32 : 0); }
  void process(float* L, float* R, int n) override {
    if (pending_) { act(pending_ - 1); pending_ = 0; }
    if (!buf_[0]) return;
    if (undoing_) stepUndo();
    for (int i = 0; i < n; i++) {
      if (mode_ == REC) {
        if (len_ < cap_) { buf_[0][len_] = L[i]; buf_[1][len_] = R[i]; stamp_[len_] = 0; len_++; }
        else { mode_ = PLAY; pos_ = 0; }
        continue;
      }
      if ((mode_ == PLAY || mode_ == DUB) && len_ > 0) {
        const int idx = (int)pos_;
        const float l = buf_[0][idx], r = buf_[1][idx];
        if (mode_ == DUB && !undoing_) {
          if (stamp_[idx] != layer_) { undo_[0][idx] = l; undo_[1][idx] = r; stamp_[idx] = layer_; }
          buf_[0][idx] = l * 0.98f + L[i];
          buf_[1][idx] = r * 0.98f + R[i];
        }
        L[i] += l * level_; R[i] += r * level_;
        const double step = (half_ ? 0.5 : 1.0) * (reverse_ ? -1 : 1);
        pos_ += step;
        if (pos_ >= len_) pos_ -= len_;
        if (pos_ < 0) pos_ += len_;
      }
    }
  }
private:
  enum { EMPTY = 0, REC = 1, PLAY = 2, DUB = 3, STOP = 4 };
  void stepUndo() {
    const int end = undoPos_ + 32768 < len_ ? undoPos_ + 32768 : len_;
    for (int i = undoPos_; i < end; i++) if (stamp_[i] == layer_) { buf_[0][i] = undo_[0][i]; buf_[1][i] = undo_[1][i]; stamp_[i] = 0; }
    undoPos_ = end;
    if (undoPos_ >= len_) { undoing_ = false; layer_ = 0; }
  }
  void act(int a) {
    switch (a) {
      case 0:
        if (mode_ == EMPTY) { len_ = 0; mode_ = REC; }
        else if (mode_ == REC) { mode_ = PLAY; pos_ = 0; }
        else if ((mode_ == PLAY || mode_ == STOP) && !undoing_) { layer_ = (uint16_t)(nextLayer_++ % 65000 + 1); mode_ = DUB; }
        else if (mode_ == DUB) mode_ = PLAY;
        break;
      case 1:
        if (mode_ == REC) { mode_ = PLAY; pos_ = 0; }
        else if (mode_ == PLAY || mode_ == DUB) mode_ = STOP;
        else if (mode_ == STOP) { mode_ = PLAY; pos_ = reverse_ ? len_ - 1 : 0; }
        break;
      case 2:
        if (layer_ > 0 && !undoing_) { undoing_ = true; undoPos_ = 0; if (mode_ == DUB) mode_ = PLAY; }
        break;
      case 3: mode_ = EMPTY; len_ = 0; pos_ = 0; layer_ = 0; undoing_ = false; break;
      case 4: half_ = !half_; break;
      case 5: reverse_ = !reverse_; break;
      default: break;
    }
  }
  float* buf_[2] = { nullptr, nullptr };
  float* undo_[2] = { nullptr, nullptr };
  uint16_t* stamp_ = nullptr;
  uint16_t layer_ = 0;
  uint32_t nextLayer_ = 0;
  int cap_ = 0, len_ = 0, mode_ = EMPTY, pending_ = 0, undoPos_ = 0;
  double pos_ = 0;
  bool half_ = false, reverse_ = false, undoing_ = false;
  float level_ = 1;
};

} // namespace

Block* createCapture(int type) {
  switch (type) {
    case B_NAM_AMP: case B_NAM_PREAMP: case B_NAM_PEDAL: case B_NAM_CAB: case B_NAM_FULL: return new NamBlock();
    case B_CAB_IR: return new IrCab();
    case B_CAB_DUAL: return new DualCab();
    case B_AMP_CAB: return new AmpCab();
    case B_LOOPER: return new Looper();
    default: return nullptr;
  }
}

} // namespace forge
