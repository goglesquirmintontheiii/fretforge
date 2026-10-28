// forge-dsp: rig blocks (pedals, amps, cabs, effects).
//
// A block processes a chunk of at most maxBlock samples in place. Mono blocks only read and
// write L; the chain sums stereo to mono before them and copies L to R afterwards, the way
// Helix treats mono blocks after stereo ones. Stereo blocks read and write both channels.
//
// Parameter ids, ranges and defaults live in packages/shared/src/rigBlocks.ts; the indices
// here must match the order there. Values arrive in natural units (dB, Hz, ms, 0..1, enums).
// setParam() is called on the audio thread and never allocates; prepare() may allocate.
#pragma once
#include <cstdint>

namespace forge {

class NamModel;
class Convolver;

enum BlockType : int {
  // drives
  B_OD_MID = 1, B_OD_CLEAR, B_BOOST_CLEAN, B_OD_SMOOTH, B_OD_CRUNCH, B_DIST_GRIT, B_FUZZ_WALL, B_FUZZ_ROUND,
  B_FUZZ_BENDER, B_BOOST_TREBLE, B_FUZZ_OCTAVE,
  // dynamics
  B_COMP_SQUEEZE = 20, B_COMP_OPTO, B_COMP_STUDIO, B_COMP_MULTI, B_GATE_SIMPLE, B_GATE_HARD,
  // eq
  B_EQ_SIMPLE = 30, B_EQ_PARAM, B_EQ_GRAPHIC, B_EQ_CUT, B_EQ_FIVE,
  // volume and stereo
  B_VOLUME = 40, B_GAIN, B_PAN, B_WIDTH,
  // modulation
  B_CHORUS = 50, B_CHORUS_DIM, B_FLANGER, B_PHASER, B_PHASER_SCRIPT, B_VIBE, B_TREMOLO, B_ROTARY, B_RINGMOD,
  // delay
  B_DELAY_DIGITAL = 60, B_DELAY_ANALOG, B_DELAY_TAPE, B_DELAY_PINGPONG, B_DELAY_DUAL, B_DELAY_REVERSE, B_DELAY_DUCKED, B_DELAY_MULTITAP,
  // reverb
  B_REV_ROOM = 70, B_REV_HALL, B_REV_PLATE, B_REV_SPRING, B_REV_CHAMBER, B_REV_SHIMMER, B_REV_AMBIENT,
  // pitch
  B_PITCH_WHAMMY = 80, B_PITCH_SIMPLE, B_PITCH_HARMONY, B_PITCH_CAPO, B_OCTAVER,
  // filters and wahs
  B_ENV_FILTER = 90, B_SYNTH_FILTER, B_WAH_CLASSIC, B_WAH_VINTAGE,
  // captures and cabs
  B_NAM_AMP = 100, B_NAM_PREAMP, B_NAM_PEDAL, B_NAM_CAB, B_NAM_FULL, B_CAB_IR, B_CAB_DUAL, B_AMP_CAB,
  // tools
  B_LOOPER = 110,
};

class Block {
public:
  virtual ~Block() {}
  virtual void prepare(float sr, int maxBlock) { sr_ = sr; maxBlock_ = maxBlock; }
  virtual void reset() {}
  virtual void setParam(int index, float value) = 0;
  virtual void process(float* L, float* R, int n) = 0;
  virtual bool stereo() const { return false; }
  /** delays, reverbs and loopers keep ringing when bypassed (trails) */
  virtual bool timeBased() const { return false; }
  virtual int latency() const { return 0; }
  /** gain reduction in dB for compressors and gates, otherwise 0 */
  virtual float meter() const { return 0; }
  virtual void setTempo(float) {}
  /** 0 eco (no oversampling), 1 standard (2x), 2 high (4x) */
  virtual void setQuality(int) {}
  virtual void setNam(NamModel*, float) {}
  virtual void setIr(int, Convolver*) {}
  /** looper buttons */
  virtual void trigger(int) {}
  virtual int state() const { return 0; }

protected:
  float sr_ = 48000;
  int maxBlock_ = 128;
};

/** nullptr for unknown types */
Block* createBlock(int type);
int blockParamCount(int type);

// factories per family (blocks_*.cpp)
Block* createDrive(int type);
Block* createDynamics(int type);
Block* createEq(int type);
Block* createModulation(int type);
Block* createDelay(int type);
Block* createReverb(int type);
Block* createPitch(int type);
Block* createFilter(int type);
Block* createCapture(int type);

} // namespace forge
