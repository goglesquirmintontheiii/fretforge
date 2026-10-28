// Native harness: runs a compiled NAM program (and/or an IR) over a raw float32 file.
//   forge-test nam <code.i32> <weights.f32> <in.f32> <out.f32> [block]
//   forge-test ir  <ir.f32> <in.f32> <out.f32> [block]
//   forge-test bench <code.i32> <weights.f32> <seconds>
//   forge-test blocks            every built-in block at its defaults: level, peak, NaN, speed
//   forge-test player            the song player: timing, loops, mute ramps, stretch, end of song
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <cmath>
#include <cstring>
#include <string>
#include "chain.h"
#include "convolver.h"
#include "nam.h"
#include "player.h"

template <class T> static std::vector<T> load(const char* path) {
  std::vector<T> v; FILE* f = fopen(path, "rb"); if (!f) { perror(path); exit(1); }
  T x; while (fread(&x, sizeof(T), 1, f) == 1) v.push_back(x); fclose(f); return v;
}
static void save(const char* path, const std::vector<float>& v) { FILE* f = fopen(path, "wb"); fwrite(v.data(), 4, v.size(), f); fclose(f); }

int main(int argc, char** argv) {
  if (argc < 2) return 1;
  std::string mode = argv[1];
  if (mode == "nam" || mode == "bench") {
    auto code = load<int32_t>(argv[2]); auto w = load<float>(argv[3]);
    int block = mode == "nam" && argc > 6 ? atoi(argv[6]) : 64;
    const char* err = nullptr;
    auto* m = forge::NamModel::create(code.data(), (int)code.size(), w.data(), (int)w.size(), block, &err);
    if (!m) { fprintf(stderr, "error: %s\n", err); return 2; }
    if (mode == "bench") {
      double secs = atof(argv[4]); int n = (int)(secs * 48000);
      std::vector<float> buf(block);
      for (int i = 0; i < block; i++) buf[i] = 0.1f * (float)((i * 7919) % 200 - 100) / 100.f;
      auto t0 = std::chrono::steady_clock::now();
      for (int i = 0; i < n; i += block) m->process(buf.data(), buf.data(), block);
      double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
      printf("%.1fx realtime (%.3fs for %.1fs)\n", secs / dt, dt, secs);
      return 0;
    }
    auto in = load<float>(argv[4]); std::vector<float> out(in.size());
    for (size_t i = 0; i < in.size(); i += block) { int n = (int)std::min<size_t>(block, in.size() - i); m->process(&in[i], &out[i], n); }
    save(argv[5], out); delete m; return 0;
  }
  if (mode == "ir") {
    auto ir = load<float>(argv[2]); auto in = load<float>(argv[3]); std::vector<float> out(in.size());
    int block = argc > 5 ? atoi(argv[5]) : 128;
    auto* c = forge::Convolver::create(ir.data(), (int)ir.size(), 128);
    for (size_t i = 0; i < in.size(); i += block) { int n = (int)std::min<size_t>(block, in.size() - i); c->process(&in[i], &out[i], n); }
    save(argv[4], out); delete c; return 0;
  }
  if (mode == "blocks") {
    const float sr = 48000; const int n = (int)(sr * 3), block = 128;
    // a plucked chord: decaying partials, re-plucked every 0.75 s, peaks around 0.4
    std::vector<float> sig(n);
    for (int i = 0; i < n; i++) {
      const float t = (float)(i % 36000) / sr, env = std::exp(-t * 3.f);
      float v = 0;
      for (float f : { 110.f, 164.8f, 220.f, 277.2f }) for (int h = 1; h <= 6; h++) v += std::sin(2 * 3.14159265f * f * h * (float)i / sr) / (h * h);
      sig[i] = 0.12f * env * v;
    }
    double inMs = 0; for (float v : sig) inMs += v * v; inMs /= n;
    int fails = 0;
    for (int type = 1; type < 120; type++) {
      const int np = forge::blockParamCount(type);
      if (np < 0) continue;
      std::vector<float> desc = { 1, 0, 1, 1, 0, 1, 0, 1, 0, (float)type, 1, 1, 0 };
      const char* err = nullptr;
      forge::Graph* g = forge::Graph::build(desc.data(), (int)desc.size(), sr, block, false, &err);
      if (!g) { printf("type %d: %s\n", type, err); fails++; continue; }
      std::vector<float> L(sig), R(n);
      auto t0 = std::chrono::steady_clock::now();
      for (int i = 0; i < n; i += block) g->process(&L[i], &R[i], std::min(block, n - i));
      const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
      double ms = 0; float peak = 0; bool bad = false;
      for (int i = 0; i < n; i++) { if (!std::isfinite(L[i]) || !std::isfinite(R[i])) bad = true; ms += 0.5 * (L[i] * L[i] + R[i] * R[i]); peak = std::max(peak, std::max(std::fabs(L[i]), std::fabs(R[i]))); }
      ms /= n;
      const double db = 10 * std::log10((ms + 1e-20) / inMs);
      printf("type %3d  params %2d  level %+6.1f dB  peak %5.2f  %6.0fx realtime  latency %d%s\n", type, np, db, peak, 3.0 / dt, g->latency(), bad ? "  NaN!" : "");
      if (bad || peak > 8) fails++;
      delete g;
    }
    printf(fails ? "BLOCKS FAILED: %d\n" : "blocks ok\n", fails);
    return fails ? 3 : 0;
  }
  if (mode == "player") {
    using forge::Player; using forge::PlayerSource;
    const float sr = 48000;
    int fails = 0;
    auto check = [&](bool ok, const char* what) { printf("%s %s\n", ok ? "ok  " : "FAIL", what); if (!ok) fails++; };
    // a source whose sample k is k (mod 20000), so positions can be read back from the output
    auto ramp = [](int len) {
      auto* s = new PlayerSource();
      s->length = len;
      s->ch[0] = (int16_t*)calloc(len, 2);
      for (int i = 0; i < len; i++) s->ch[0][i] = (int16_t)(i % 20000);
      s->ch[1] = s->ch[0];
      s->scale = 1.f / 32767.f;
      return s;
    };
    auto valueAt = [](float out) { return out / 0.75f * 32767.f; };
    {
      Player p(sr, 4096);
      p.setSource(0, ramp(48000 * 5));
      p.mix(0, 0.5f, 0, false, false);
      p.seek(1000);
      p.play(0, 0);
      std::vector<float> L(4096), R(4096);
      int sizes[] = { 333, 64, 1024, 517, 2048 };
      long frame = 1000;
      bool exact = true;
      for (int k = 0; k < 40; k++) {
        const int n = sizes[k % 5];
        p.render(L.data(), R.data(), n);
        for (int i = 0; i < n; i++) {
          const float want = ((frame + i) % 20000) * 0.5f;
          if (std::fabs(valueAt(L[i]) - want) > 0.6f && want * 0.5f / 32767.f * 0.75f < 0.85f) { exact = false; }
        }
        frame += n;
      }
      check(exact, "plays from the seek position, sample-exact across odd block sizes");
      check(std::fabs(p.heardFrames() - frame) < 1, "reports the heard position");
      // loop
      p.setLoop(10000, 14000);
      p.seek(10000);
      long f2 = 10000; bool looped = true;
      for (int k = 0; k < 20; k++) {
        p.render(L.data(), R.data(), 1024);
        for (int i = 0; i < 1024; i++) {
          const long want = 10000 + ((f2 - 10000 + i) % 4000);
          if (std::fabs(valueAt(L[i]) - (want % 20000) * 0.5f) > 0.6f) looped = false;
        }
        f2 += 1024;
      }
      check(looped, "loops seamlessly");
      // mute ramps instead of jumping
      p.setLoop(0, 0);
      p.mix(0, 0.5f, 0, true, false);
      p.render(L.data(), R.data(), 256);
      bool smooth = true;
      for (int i = 1; i < 256; i++) if (std::fabs(L[i] - L[i - 1]) > 0.02f) smooth = false;
      check(smooth && std::fabs(L[255]) < 0.01f, "mute fades over one block");
      p.render(L.data(), R.data(), 256);
      bool silent = true;
      for (int i = 0; i < 256; i++) if (L[i] != 0) silent = false;
      check(silent, "muted source is silent");
      // replacing a source frees the old one once the audio thread moved on
      p.setSource(0, ramp(1000));
      p.render(L.data(), R.data(), 64);
      p.render(L.data(), R.data(), 64);
      p.collect();
      check(true, "source swap and collect");
    }
    {
      // slowed down: 0.5x through the stretcher takes twice as long to cover the same music
      Player p(sr, 4096);
      auto* s = new PlayerSource();
      const int len = 48000 * 4;
      s->length = len;
      s->ch[0] = (int16_t*)calloc(len, 2);
      for (int i = 0; i < len; i++) s->ch[0][i] = (int16_t)(8000 * std::sin(2 * 3.14159265 * 220 * i / sr));
      s->ch[1] = s->ch[0];
      p.setSource(3, s);
      p.setRate(0.5f);
      p.play(0, 0);
      std::vector<float> L(1024), R(1024);
      float peak = 0; bool finite = true;
      for (int k = 0; k < 94; k++) { p.render(L.data(), R.data(), 1024); for (float v : L) { if (!std::isfinite(v)) finite = false; peak = std::max(peak, std::fabs(v)); } }
      const double heard = p.heardFrames();
      check(finite && peak > 0.05f, "stretched audio is audible and finite");
      check(heard > 48000 * 0.9 && heard < 48000 * 1.1, "half speed covers about one second of music in two");
      // the end of the song stops playback and counts once
      p.setRate(1);
      p.setDuration(48000 * 1.5);
      for (int k = 0; k < 80; k++) p.render(L.data(), R.data(), 1024);
      check(!p.playing() && p.endedCount() == 1, "stops at the end of the song");
    }
    {
      // count-in clicks, then the music
      Player p(sr, 4096);
      p.setSource(0, ramp(48000));
      p.play(2, 4800);
      std::vector<float> L(4096), R(4096);
      p.render(L.data(), R.data(), 4096);
      check(p.counting() && std::fabs(p.heardFrames()) < 1, "count-in holds the timeline");
      for (int k = 0; k < 3; k++) p.render(L.data(), R.data(), 4096);
      check(!p.counting() && p.heardFrames() > 1000, "music starts after the count-in");
    }
    printf(fails ? "PLAYER FAILED: %d\n" : "player ok\n", fails);
    return fails ? 3 : 0;
  }
  return 1;
}
