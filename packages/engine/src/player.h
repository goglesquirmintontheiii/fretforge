// forge-dsp: the song player of the desktop engine.
//
// Plays pre-rendered tab tracks and recordings/stems on the same clock as the live rig: per
// source gain, pan, mute and solo (ramped, so nothing clicks), a metronome and count-in,
// seamless loops, and time-stretch/pitch-shift (Signalsmith Stretch). It is the native twin of
// the browser's "ff-mixer" worklet (packages/web/src/audio/mixer.worklet.ts).
//
// Threads: sources and click lists are built on the control thread and published through
// atomic slot pointers; old ones are freed by collect() once the audio thread has moved on
// (epoch counter). Transport and mix changes go through a lock-free command queue. The audio
// thread never allocates, locks or waits.
#pragma once
#include <atomic>
#include <cstdint>

namespace forge {

struct PlayerSource {
  int16_t* ch[2] = { nullptr, nullptr }; // owned; ch[1] may equal ch[0] (mono)
  int length = 0;
  float scale = 1.f / 32767.f;
  ~PlayerSource();
};

struct PlayerClicks {
  double* frames = nullptr; // click times in frames
  uint8_t* accent = nullptr;
  int count = 0;
  ~PlayerClicks();
};

class Player {
public:
  static constexpr int kSlots = 64;
  Player(float sampleRate, int maxBlock);
  ~Player();

  // ---- control thread
  /** takes ownership of the source; replaces what the slot held (mix settings stay) */
  void setSource(int slot, PlayerSource* s);
  void removeSource(int slot) { setSource(slot, nullptr); }
  void setClicks(PlayerClicks* c);
  void mix(int slot, float gain, float pan, bool mute, bool solo) { post(OP_MIX, slot, gain, pan, (mute ? 1 : 0) | (solo ? 2 : 0)); }
  void setOffset(int slot, double frames) { post(OP_OFFSET, slot, 0, 0, 0, frames); }
  void play(int countBeats, double intervalFrames) { post(OP_PLAY, countBeats, (float)intervalFrames, 0, 0); }
  void pause() { post(OP_PAUSE, 0, 0, 0, 0); }
  void seek(double frames) { post(OP_SEEK, 0, (float)frames, 0, 0, frames); }
  void setRate(float r) { post(OP_RATE, 0, r, 0, 0); }
  void setPitch(float semis) { post(OP_PITCH, 0, semis, 0, 0); }
  void setMaster(float g) { post(OP_MASTER, 0, g, 0, 0); }
  void setDuration(double frames) { post(OP_DURATION, 0, 0, 0, 0, frames); }
  void setLoop(double start, double end) { post(OP_LOOP, 0, 0, 0, 0, (double)(long long)(start + 0.5), (double)(long long)(end + 0.5)); }
  void setMetronome(bool on, float vol) { post(OP_METRO, on ? 1 : 0, vol, 0, 0); }
  /** frees sources and click lists the audio thread no longer uses */
  void collect();

  // state for the UI (relaxed reads)
  double heardFrames() const { return heard_.load(std::memory_order_relaxed); }
  bool playing() const { return playingFlag_.load(std::memory_order_relaxed); }
  bool counting() const { return countingFlag_.load(std::memory_order_relaxed); }
  uint32_t endedCount() const { return ended_.load(std::memory_order_relaxed); }
  float takePeak() { return peak_.exchange(0, std::memory_order_relaxed); }
  int latency() const { return inLat_ + outLat_; }

  // ---- audio thread
  /** writes the song mix (stereo) for n frames; silence while stopped */
  void render(float* L, float* R, int n);

private:
  enum { OP_MIX = 1, OP_OFFSET, OP_PLAY, OP_PAUSE, OP_SEEK, OP_RATE, OP_PITCH, OP_MASTER, OP_DURATION, OP_LOOP, OP_METRO };
  struct Cmd { int op, slot; float a, b; int flags; double d0, d1; };
  static constexpr int kQueue = 1024;
  void post(int op, int slot, float a, float b, int flags, double d0 = 0, double d1 = 0);
  void apply(const Cmd& c);
  void retire(void* p, bool clicks);

  struct Mix { float gain = 1, pan = 0; bool mute = false, solo = false; double offset = 0; float curL = -1, curR = -1; };

  bool looping() const { return loopEnd_ > loopStart_; }
  double wrap(double f) const;
  double heard() const;
  void seekFrames(double f);
  void setStretch(float rate, float semis);
  void mixRange(double start, int count, float* L, float* R, int o);
  void mixSegment(double start, int n, float* L, float* R, int o);
  void mixClicks(double start, int n, float* L, float* R, int o);
  void chunk(float* L, float* R, int n);
  void output(const float* sl, const float* sr, float* L, float* R, int n);

  float sr_;
  int maxBlock_;
  Cmd queue_[kQueue];
  std::atomic<uint32_t> head_{ 0 }, tail_{ 0 };
  std::atomic<PlayerSource*> slots_[kSlots];
  std::atomic<PlayerClicks*> clicks_{ nullptr };
  Mix mix_[kSlots];
  // deferred frees (control thread only)
  struct Retired { void* p; bool clicks; uint64_t epoch; };
  static constexpr int kRetired = 256;
  Retired retired_[kRetired];
  int nRetired_ = 0;
  std::atomic<uint64_t> epoch_{ 0 };

  // transport (audio thread)
  bool playing_ = false;
  double pos_ = 0;
  bool stretching_ = false, needPrime_ = true;
  double acc_ = 0;
  float rate_ = 1, semis_ = 0, master_ = 1;
  double duration_ = 0, loopStart_ = 0, loopEnd_ = 0;
  bool metroOn_ = false;
  float metroVol_ = 0.8f;
  int countLeft_ = 0, countInterval_ = 0, countPhase_ = 0;
  float* clickHi_ = nullptr;
  float* clickLo_ = nullptr;
  int clickHiLen_ = 0, clickLoLen_ = 0;

  void* st_ = nullptr; // signalsmith stretcher
  int inLat_ = 0, outLat_ = 0;
  static constexpr int kBig = 32768;
  float* bigL_ = nullptr;
  float* bigR_ = nullptr;
  float* tmpL_ = nullptr;
  float* tmpR_ = nullptr;

  std::atomic<double> heard_{ 0 };
  std::atomic<bool> playingFlag_{ false }, countingFlag_{ false };
  std::atomic<uint32_t> ended_{ 0 };
  std::atomic<float> peak_{ 0 };
};

} // namespace forge
