// Native harness: runs a compiled NAM program (and/or an IR) over a raw float32 file.
//   forge-test nam <code.i32> <weights.f32> <in.f32> <out.f32> [block]
//   forge-test ir  <ir.f32> <in.f32> <out.f32> [block]
//   forge-test bench <code.i32> <weights.f32> <seconds>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include "convolver.h"
#include "nam.h"

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
  return 1;
}
