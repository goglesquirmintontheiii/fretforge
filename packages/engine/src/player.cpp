// forge-dsp song player (see player.h). Mirrors the "ff-mixer" worklet frame for frame.
#include "player.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "signalsmith-stretch.h"

namespace forge {

namespace {
using Stretch = signalsmith::stretch::SignalsmithStretch<float>;
constexpr int kChunk = 256;

float* makeClick(float sr, float freq, float ms, int* len) {
  const int n = (int)std::lround(ms / 1000.f * sr);
  float* out = (float*)std::calloc((size_t)n, sizeof(float));
  for (int i = 0; i < n; i++) {
    const float t = i / sr;
    const float env = std::exp(-t * 90.f) * (1.f - std::exp(-t * 4000.f));
    out[i] = 0.6f * env * std::sin(2.f * 3.14159265f * freq * t);
  }
  *len = n;
  return out;
}
} // namespace

PlayerSource::~PlayerSource() {
  if (ch[1] && ch[1] != ch[0]) std::free(ch[1]);
  std::free(ch[0]);
}

PlayerClicks::~PlayerClicks() {
  std::free(frames);
  std::free(accent);
}

Player::Player(float sampleRate, int maxBlock) : sr_(sampleRate), maxBlock_(maxBlock) {
  for (auto& s : slots_) s.store(nullptr, std::memory_order_relaxed);
  clickHi_ = makeClick(sr_, 1760, 45, &clickHiLen_);
  clickLo_ = makeClick(sr_, 1320, 35, &clickLoLen_);
  auto* st = new Stretch();
  st->presetDefault(2, sr_);
  st_ = st;
  inLat_ = st->inputLatency();
  outLat_ = st->outputLatency();
  bigL_ = (float*)std::calloc(kBig, sizeof(float));
  bigR_ = (float*)std::calloc(kBig, sizeof(float));
  tmpL_ = (float*)std::calloc(kChunk, sizeof(float));
  tmpR_ = (float*)std::calloc(kChunk, sizeof(float));
}

Player::~Player() {
  for (auto& s : slots_) delete s.load();
  delete clicks_.load();
  for (int i = 0; i < nRetired_; i++) {
    if (retired_[i].clicks) delete (PlayerClicks*)retired_[i].p;
    else delete (PlayerSource*)retired_[i].p;
  }
  delete (Stretch*)st_;
  std::free(clickHi_); std::free(clickLo_);
  std::free(bigL_); std::free(bigR_); std::free(tmpL_); std::free(tmpR_);
}

// ------------------------------------------------------------------ control thread
void Player::post(int op, int slot, float a, float b, int flags, double d0, double d1) {
  const uint32_t h = head_.load(std::memory_order_relaxed);
  if (h - tail_.load(std::memory_order_acquire) >= (uint32_t)kQueue) return; // full: drop (never blocks)
  queue_[h % kQueue] = Cmd{ op, slot, a, b, flags, d0, d1 };
  head_.store(h + 1, std::memory_order_release);
}

void Player::retire(void* p, bool clicks) {
  if (!p) return;
  if (nRetired_ == kRetired) collect();
  if (nRetired_ == kRetired) return; // leak rather than free something in use
  retired_[nRetired_++] = Retired{ p, clicks, epoch_.load(std::memory_order_acquire) };
}

void Player::setSource(int slot, PlayerSource* s) {
  if (slot < 0 || slot >= kSlots) { delete s; return; }
  retire(slots_[slot].exchange(s, std::memory_order_acq_rel), false);
}

void Player::setClicks(PlayerClicks* c) { retire(clicks_.exchange(c, std::memory_order_acq_rel), true); }

void Player::collect() {
  // an object retired at epoch e may be read by the render call running during e; once the
  // epoch moved on by two, no render call can still hold it
  const uint64_t now = epoch_.load(std::memory_order_acquire);
  int k = 0;
  for (int i = 0; i < nRetired_; i++) {
    if (now >= retired_[i].epoch + 2) {
      if (retired_[i].clicks) delete (PlayerClicks*)retired_[i].p;
      else delete (PlayerSource*)retired_[i].p;
    } else retired_[k++] = retired_[i];
  }
  nRetired_ = k;
}

// ------------------------------------------------------------------ audio thread
void Player::apply(const Cmd& c) {
  switch (c.op) {
    case OP_MIX:
      if (c.slot >= 0 && c.slot < kSlots) { auto& m = mix_[c.slot]; m.gain = c.a; m.pan = c.b; m.mute = c.flags & 1; m.solo = c.flags & 2; }
      break;
    case OP_OFFSET: if (c.slot >= 0 && c.slot < kSlots) mix_[c.slot].offset = c.d0; break;
    case OP_PLAY:
      if (c.slot > 0 && c.a > 0) {
        countInterval_ = (int)std::max(1.0, (double)std::round(c.a / rate_));
        countLeft_ = countInterval_ * c.slot;
        countPhase_ = 0;
      }
      if (duration_ > 0 && heard() >= duration_ - kChunk) seekFrames(0);
      playing_ = true;
      break;
    case OP_PAUSE:
      if (stretching_) { pos_ = heard(); needPrime_ = true; }
      playing_ = false;
      countLeft_ = 0;
      break;
    case OP_SEEK: seekFrames(std::max(0.0, c.d0)); break;
    case OP_RATE: setStretch(std::min(4.f, std::max(0.1f, c.a)), semis_); break;
    case OP_PITCH: setStretch(rate_, c.a); break;
    case OP_MASTER: master_ = c.a; break;
    case OP_DURATION: duration_ = c.d0; break;
    case OP_LOOP:
      if (c.d1 <= c.d0) loopStart_ = loopEnd_ = 0;
      else { loopStart_ = c.d0; loopEnd_ = c.d1; }
      break;
    case OP_METRO: metroOn_ = c.slot != 0; metroVol_ = c.a; break;
  }
}

double Player::wrap(double f) const {
  if (looping() && f >= loopEnd_) return loopStart_ + std::fmod(f - loopStart_, loopEnd_ - loopStart_);
  return f;
}

double Player::heard() const {
  if (!stretching_) return pos_;
  double h = pos_ - inLat_ - outLat_ * rate_;
  if (looping() && h < loopStart_ && pos_ >= loopStart_ && pos_ < loopEnd_ + inLat_) h += loopEnd_ - loopStart_;
  return std::max(0.0, h);
}

void Player::seekFrames(double f) {
  pos_ = f;
  needPrime_ = true;
  acc_ = 0;
}

void Player::setStretch(float rate, float semis) {
  const bool was = stretching_;
  const double h = heard();
  rate_ = rate;
  semis_ = semis;
  stretching_ = std::fabs(rate - 1.f) > 1e-4f || semis != 0.f;
  ((Stretch*)st_)->setTransposeSemitones(semis, 8000.f / 48000.f);
  if (was != stretching_) { pos_ = h; needPrime_ = true; }
}

void Player::mixRange(double start, int count, float* L, float* R, int o) {
  double f = wrap(start);
  while (count > 0) {
    const int n = looping() && f < loopEnd_ ? (int)std::min<double>(count, std::ceil(loopEnd_ - f)) : count;
    mixSegment(f, n, L, R, o);
    o += n;
    count -= n;
    f = looping() && f + n >= loopEnd_ ? loopStart_ : f + n;
  }
}

void Player::mixSegment(double start, int n, float* L, float* R, int o) {
  bool anySolo = false;
  for (int s = 0; s < kSlots; s++) if (mix_[s].solo && slots_[s].load(std::memory_order_acquire)) { anySolo = true; break; }
  const long base = (long)std::floor(start);
  for (int s = 0; s < kSlots; s++) {
    PlayerSource* src = slots_[s].load(std::memory_order_acquire);
    Mix& m = mix_[s];
    if (!src) { m.curL = m.curR = -1; continue; }
    const bool silent = m.mute || (anySolo && !m.solo) || m.gain <= 0;
    const float g = silent ? 0.f : m.gain * src->scale;
    const float tl = g * std::min(1.f, 1.f - m.pan), tr = g * std::min(1.f, 1.f + m.pan);
    const float cl = m.curL < 0 ? tl : m.curL, cr = m.curR < 0 ? tr : m.curR;
    m.curL = tl;
    m.curR = tr;
    if (tl == 0 && tr == 0 && cl == 0 && cr == 0) continue;
    const long a = base - (long)std::llround(m.offset);
    const int from = (int)std::max<long>(0, -a), to = (int)std::min<long>(n, (long)src->length - a);
    if (to <= from) continue;
    const int16_t* c0 = src->ch[0];
    const int16_t* c1 = src->ch[1] ? src->ch[1] : src->ch[0];
    const float dl = (tl - cl) / n, dr = (tr - cr) / n;
    for (int i = from; i < to; i++) {
      const float gl = cl + dl * i, gr = cr + dr * i;
      L[o + i] += c0[a + i] * gl;
      R[o + i] += c1[a + i] * gr;
    }
  }
  if (metroOn_) mixClicks(start, n, L, R, o);
}

void Player::mixClicks(double start, int n, float* L, float* R, int o) {
  PlayerClicks* c = clicks_.load(std::memory_order_acquire);
  if (!c || !c->count) return;
  const int maxLen = clickHiLen_;
  int lo = 0, hi = c->count;
  while (lo < hi) { const int mid = (lo + hi) >> 1; if (c->frames[mid] + maxLen <= start) lo = mid + 1; else hi = mid; }
  for (int k = lo; k < c->count && c->frames[k] < start + n; k++) {
    const float* w = c->accent[k] ? clickHi_ : clickLo_;
    const int wl = c->accent[k] ? clickHiLen_ : clickLoLen_;
    const long b = std::lround(c->frames[k]);
    const long s0 = (long)std::floor(start);
    const int from = (int)std::max<long>(0, b - s0), to = (int)std::min<long>(n, b - s0 + wl);
    for (int i = from; i < to; i++) {
      const float v = w[s0 + i - b] * metroVol_;
      L[o + i] += v;
      R[o + i] += v;
    }
  }
}

void Player::output(const float* sl, const float* sr, float* L, float* R, int n) {
  const float g = master_ * 0.75f;
  float peak = peak_.load(std::memory_order_relaxed);
  for (int i = 0; i < n; i++) {
    float l = sl[i] * g, r = sr[i] * g;
    const float pre = std::max(std::fabs(l), std::fabs(r));
    if (pre > peak) peak = pre;
    if (std::fabs(l) > 0.89f) l = std::copysign(0.89f + 0.11f * std::tanh((std::fabs(l) - 0.89f) / 0.11f), l);
    if (std::fabs(r) > 0.89f) r = std::copysign(0.89f + 0.11f * std::tanh((std::fabs(r) - 0.89f) / 0.11f), r);
    L[i] = l;
    R[i] = r;
  }
  peak_.store(peak, std::memory_order_relaxed);
}

void Player::chunk(float* L, float* R, int n) {
  if (!playing_) { std::memset(L, 0, sizeof(float) * n); std::memset(R, 0, sizeof(float) * n); return; }
  if (countLeft_ > 0) {
    for (int i = 0; i < n; i++) {
      float v = 0;
      if (countLeft_ > 0) {
        const int beatPos = countPhase_ % countInterval_;
        const bool first = countPhase_ / countInterval_ == 0;
        const float* w = first ? clickHi_ : clickLo_;
        const int wl = first ? clickHiLen_ : clickLoLen_;
        v = beatPos < wl ? w[beatPos] * 0.9f : 0.f;
        countPhase_++;
        countLeft_--;
      }
      L[i] = R[i] = v;
    }
    return;
  }
  Stretch* st = (Stretch*)st_;
  if (!stretching_) {
    std::memset(tmpL_, 0, sizeof(float) * n);
    std::memset(tmpR_, 0, sizeof(float) * n);
    mixRange(pos_, n, tmpL_, tmpR_, 0);
    pos_ = wrap(pos_ + n);
    output(tmpL_, tmpR_, L, R, n);
  } else {
    if (needPrime_) {
      const int len = std::min(kBig, inLat_ + outLat_);
      const double startF = pos_ + inLat_ - len;
      std::memset(bigL_, 0, sizeof(float) * len);
      std::memset(bigR_, 0, sizeof(float) * len);
      const int skip = (int)std::max(0.0, -startF);
      if (len - skip > 0) mixRange(std::max(0.0, startF), len - skip, bigL_, bigR_, skip);
      float* in[2] = { bigL_, bigR_ };
      st->seek(in, len, rate_);
      pos_ = wrap(pos_ + inLat_);
      needPrime_ = false;
      acc_ = 0;
    }
    acc_ += n * (double)rate_;
    const int inN = std::min(kBig, (int)std::floor(acc_));
    acc_ -= inN;
    std::memset(bigL_, 0, sizeof(float) * inN);
    std::memset(bigR_, 0, sizeof(float) * inN);
    if (inN > 0) mixRange(pos_, inN, bigL_, bigR_, 0);
    pos_ = wrap(pos_ + inN);
    float* in[2] = { bigL_, bigR_ };
    float* out[2] = { tmpL_, tmpR_ };
    st->process(in, inN, out, n);
    output(tmpL_, tmpR_, L, R, n);
  }
  if (!looping() && duration_ > 0 && heard() >= duration_) {
    playing_ = false;
    pos_ = duration_;
    needPrime_ = true;
    ended_.fetch_add(1, std::memory_order_relaxed);
  }
}

void Player::render(float* L, float* R, int n) {
  // commands first, then audio in chunks the stretcher and scratch buffers can take
  const uint32_t h = head_.load(std::memory_order_acquire);
  uint32_t t = tail_.load(std::memory_order_relaxed);
  for (; t != h; t++) apply(queue_[t % kQueue]);
  tail_.store(t, std::memory_order_release);
  for (int o = 0; o < n; o += kChunk) chunk(L + o, R + o, std::min(kChunk, n - o));
  heard_.store(heard(), std::memory_order_relaxed);
  playingFlag_.store(playing_, std::memory_order_relaxed);
  countingFlag_.store(countLeft_ > 0, std::memory_order_relaxed);
  epoch_.fetch_add(1, std::memory_order_acq_rel);
}

} // namespace forge
