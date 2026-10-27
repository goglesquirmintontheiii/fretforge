#include "nam.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

namespace forge {

namespace {

constexpr int32_t MAGIC = 0x464e414d;
constexpr int32_t VERSION = 1;

enum OpCode { OP_CONV = 1, OP_ADD, OP_ADDTO, OP_COPY, OP_ZERO, OP_SCALE, OP_ACT, OP_GATE, OP_FILM, OP_BN, OP_LSTM };
enum ActType { A_ID = 0, A_TANH, A_HARDTANH, A_FASTTANH, A_RELU, A_LEAKY, A_SIGMOID, A_SILU, A_HARDSWISH, A_LEAKYHT, A_PRELU, A_SOFTSIGN };

// exp and tanh with ~1e-7 relative error, written so the compiler can vectorise them
// (libm calls cannot be). Coefficients from Cephes.
inline float expApprox(float x) {
  x = x < -87.3f ? -87.3f : (x > 88.3f ? 88.3f : x);
  const float n = __builtin_rintf(x * 1.44269504088896341f);
  const float r = (x - n * 0.693359375f) + n * 2.12194440e-4f;
  float p = 1.9875691500e-4f;
  p = p * r + 1.3981999507e-3f;
  p = p * r + 8.3334519073e-3f;
  p = p * r + 4.1665795894e-2f;
  p = p * r + 1.6666665459e-1f;
  p = p * r + 5.0000001201e-1f;
  const float e = r + r * r * p + 1.0f;
  const int bits = ((int)n + 127) << 23;
  float scale;
  __builtin_memcpy(&scale, &bits, 4);
  return e * scale;
}
inline float tanhApprox(float x) {
  const float a = x < 0 ? -x : x;
  const float z = x * x;
  float p = -5.70498872745e-3f;
  p = p * z + 2.06390887954e-2f;
  p = p * z - 5.37397155531e-2f;
  p = p * z + 1.33314422036e-1f;
  p = p * z - 3.33332819422e-1f;
  const float small = x + x * z * p;
  const float e = expApprox(2.0f * (a < 9.0f ? a : 9.0f));
  float big = 1.0f - 2.0f / (e + 1.0f);
  big = x < 0 ? -big : big;
  return a < 0.625f ? small : big;
}
inline float sigmoidf(float x) { return 1.0f / (1.0f + expApprox(-x)); }
inline float fastTanh(float x) {
  const float ax = std::fabs(x), x2 = x * x;
  return (x * (2.45550750702956f + 2.45550750702956f * ax + (0.893229853513558f + 0.821226666969744f * ax) * x2)
          / (2.44506634652299f + (2.44506634652299f + x2) * std::fabs(x + 0.814642734961073f * x * ax)));
}

inline float act1(int type, const float* p, int row, float x) {
  switch (type) {
    case A_TANH: return tanhApprox(x);
    case A_HARDTANH: return x < -1.f ? -1.f : (x > 1.f ? 1.f : x);
    case A_FASTTANH: return fastTanh(x);
    case A_RELU: return x > 0.f ? x : 0.f;
    case A_LEAKY: return x > 0.f ? x : p[0] * x;
    case A_SIGMOID: return sigmoidf(x);
    case A_SILU: return x * sigmoidf(x);
    case A_HARDSWISH: { float t = x + 3.f; t = t < 0.f ? 0.f : (t > 6.f ? 6.f : t); return x * t * (1.f / 6.f); }
    case A_LEAKYHT:
      if (x < p[0]) return (x - p[0]) * p[2] + p[0];
      if (x > p[1]) return (x - p[1]) * p[3] + p[1];
      return x;
    case A_PRELU: { const int n = (int)p[0]; const float s = p[1 + row % n]; return x > 0.f ? x : s * x; }
    case A_SOFTSIGN: return x / (1.f + std::fabs(x));
    default: return x;
  }
}

void applyAct(int type, const float* p, float* base, int stride, int rows, int n) {
  if (type == A_ID) return;
  if (type == A_TANH) {
    for (int f = 0; f < n; f++) { float* r = base + f * stride; for (int c = 0; c < rows; c++) r[c] = tanhApprox(r[c]); }
    return;
  }
  if (type == A_RELU) {
    for (int f = 0; f < n; f++) { float* r = base + f * stride; for (int c = 0; c < rows; c++) r[c] = r[c] > 0.f ? r[c] : 0.f; }
    return;
  }
  if (type == A_LEAKY) {
    const float s = p[0];
    for (int f = 0; f < n; f++) { float* r = base + f * stride; for (int c = 0; c < rows; c++) r[c] = r[c] > 0.f ? r[c] : s * r[c]; }
    return;
  }
  for (int f = 0; f < n; f++) {
    float* r = base + f * stride;
    for (int c = 0; c < rows; c++) r[c] = act1(type, p, c, r[c]);
  }
}

// y[f] (+)= bias + sum_k W_k * x[f - dil*(K-1-k)], with O output channels known at compile time
// so the accumulators stay in registers.
template <int O>
void convFixed(const float* __restrict W, bool bias, bool acc, int K, int dil, int I, float* ring, int mask, int& pos,
               const float* src, int srcStride, float* dst, int dstStride, int n) {
  const float* B = W + (long)K * I * O;
  for (int f = 0; f < n; f++) {
    float y[O];
    float* out = dst + (long)f * dstStride;
    const float* x = src + (long)f * srcStride;
    for (int o = 0; o < O; o++) y[o] = (acc ? out[o] : 0.f) + (bias ? B[o] : 0.f);
    if (K == 1) {
      for (int i = 0; i < I; i++) {
        const float xi = x[i];
        const float* wr = W + i * O;
        for (int o = 0; o < O; o++) y[o] += wr[o] * xi;
      }
    } else {
      float* slot = ring + (long)(pos & mask) * I;
      for (int i = 0; i < I; i++) slot[i] = x[i];
      for (int k = 0; k < K; k++) {
        const float* xs = ring + (long)((pos - dil * (K - 1 - k)) & mask) * I;
        const float* Wk = W + (long)k * I * O;
        for (int i = 0; i < I; i++) {
          const float xi = xs[i];
          const float* wr = Wk + i * O;
          for (int o = 0; o < O; o++) y[o] += wr[o] * xi;
        }
      }
      pos++;
    }
    for (int o = 0; o < O; o++) out[o] = y[o];
  }
}

void convGeneric(const float* __restrict W, bool bias, bool acc, int K, int dil, int I, int O, float* ring, int mask, int& pos,
                 const float* src, int srcStride, float* dst, int dstStride, int n) {
  const float* B = W + (long)K * I * O;
  for (int f = 0; f < n; f++) {
    float* __restrict y = dst + (long)f * dstStride;
    const float* x = src + (long)f * srcStride;
    for (int o = 0; o < O; o++) y[o] = (acc ? y[o] : 0.f) + (bias ? B[o] : 0.f);
    const float* base = x;
    if (K > 1) {
      float* slot = ring + (long)(pos & mask) * I;
      for (int i = 0; i < I; i++) slot[i] = x[i];
    }
    for (int k = 0; k < K; k++) {
      const float* xs = K == 1 ? base : ring + (long)((pos - dil * (K - 1 - k)) & mask) * I;
      const float* Wk = W + (long)k * I * O;
      for (int i = 0; i < I; i++) {
        const float xi = xs[i];
        const float* __restrict wr = Wk + i * O;
        for (int o = 0; o < O; o++) y[o] += wr[o] * xi;
      }
    }
    if (K > 1) pos++;
  }
}

int nextPow2(int v) { int p = 1; while (p < v) p <<= 1; return p; }

} // namespace

NamModel* NamModel::create(const int32_t* code, int codeLen, const float* weights, int weightLen, int maxBlock, const char** error) {
  auto fail = [&](const char* msg) -> NamModel* { if (error) *error = msg; return nullptr; };
  if (codeLen < 8 || code[0] != MAGIC) return fail("not a forge NAM program");
  if (code[1] != VERSION) return fail("unsupported NAM program version");
  if (maxBlock < 1) maxBlock = 128;
  int p = 2;
  const int nBuf = code[p++];
  if (nBuf < 1 || p + nBuf + 4 > codeLen) return fail("corrupt program header");
  const int32_t* bufCh = code + p;
  p += nBuf;
  const int outB = code[p++], outR = code[p++], prewarm = code[p++], opsLen = code[p++];
  if (p + opsLen != codeLen || outB < 0 || outB >= nBuf) return fail("corrupt program");

  NamModel* m = new NamModel();
  m->maxBlock_ = maxBlock;
  m->prewarm_ = prewarm;
  m->nBuffers_ = nBuf;
  m->weights_ = (float*)std::malloc(sizeof(float) * (weightLen > 0 ? weightLen : 1));
  if (weightLen > 0) std::memcpy(m->weights_, weights, sizeof(float) * weightLen);

  // first pass: count ops and arena size
  long arena = 0;
  for (int i = 0; i < nBuf; i++) {
    if (bufCh[i] < 1) { delete m; return fail("buffer with no channels"); }
    arena += (long)bufCh[i] * maxBlock;
  }
  int nOps = 0;
  for (int q = p; q < codeLen;) {
    const int len = code[q + 1];
    if (len < 2 || q + len > codeLen) { delete m; return fail("corrupt op"); }
    const int oc = code[q];
    if (oc == OP_CONV) {
      const int K = code[q + 8], dil = code[q + 9], inCh = code[q + 7];
      if (K > 1) arena += (long)nextPow2((K - 1) * dil + 1) * inCh;
    } else if (oc == OP_LSTM) {
      const int H = code[q + 9], L = code[q + 10];
      arena += (long)L * (2 * H) + 4 * H + (code[q + 8] + H); // h,c per layer + gates + xh
    }
    nOps++;
    q += len;
  }
  m->arenaFloats_ = arena;
  m->arena_ = (float*)std::calloc((size_t)arena + 1, sizeof(float));
  m->buffers_ = (Buffer*)std::calloc(nBuf, sizeof(Buffer));
  m->ops_ = (Op*)std::calloc(nOps > 0 ? nOps : 1, sizeof(Op));
  m->nOps_ = nOps;
  float* cursor = m->arena_;
  for (int i = 0; i < nBuf; i++) {
    m->buffers_[i].ch = bufCh[i];
    m->buffers_[i].data = cursor;
    cursor += (long)bufCh[i] * maxBlock;
  }
  auto view = [&](const int32_t* v, View& out) -> bool {
    const int b = v[0], r = v[1], n = v[2];
    if (b < 0 || b >= nBuf || r < 0 || n < 1 || r + n > m->buffers_[b].ch) return false;
    out.base = m->buffers_[b].data + r;
    out.stride = m->buffers_[b].ch;
    out.rows = n;
    return true;
  };
  auto wptr = [&](int off, long count) -> const float* {
    if (off < 0 || off + count > weightLen) return nullptr;
    return m->weights_ + off;
  };

  int oi = 0;
  for (int q = p; q < codeLen; q += code[q + 1]) {
    Op& op = m->ops_[oi++];
    const int32_t* a = code + q + 2;
    op.code = code[q];
    bool ok = true;
    switch (op.code) {
      case OP_CONV: {
        ok = view(a, op.a) && view(a + 3, op.b);
        if (!ok) break;
        const int K = a[6], dil = a[7], bias = a[8], acc = a[9];
        op.i0 = K; op.i1 = dil; op.i2 = bias; op.i3 = acc;
        op.w = wptr(a[10], (long)K * op.a.rows * op.b.rows + (bias ? op.a.rows : 0));
        if (!op.w || K < 1 || dil < 1) { ok = false; break; }
        if (K > 1) {
          const int frames = nextPow2((K - 1) * dil + 1);
          op.state = cursor;
          op.mask = frames - 1;
          cursor += (long)frames * op.b.rows;
        }
        break;
      }
      case OP_ADD: ok = view(a, op.a) && view(a + 3, op.b) && view(a + 6, op.c) && op.a.rows == op.b.rows && op.a.rows == op.c.rows; break;
      case OP_ADDTO:
      case OP_COPY: ok = view(a, op.a) && view(a + 3, op.b) && op.a.rows == op.b.rows; break;
      case OP_ZERO: ok = view(a, op.a); break;
      case OP_SCALE: ok = view(a, op.a) && (op.w = wptr(a[3], 1)); break;
      case OP_ACT: ok = view(a, op.a) && (op.w = wptr(a[4], 1)); op.i0 = a[3]; break;
      case OP_GATE: // z top view (rows = bottleneck, buffer has 2*bottleneck)
        ok = view(a, op.a) && (op.w = wptr(a[5], 1)) && (op.w2 = wptr(a[7], 1)) && op.a.stride >= 2 * op.a.rows;
        op.i0 = a[3]; op.i1 = a[4]; op.i2 = a[6];
        break;
      case OP_FILM:
        ok = view(a, op.a) && view(a + 3, op.b);
        op.i0 = a[6];
        if (ok) ok = op.b.rows == (op.i0 ? 2 : 1) * op.a.rows;
        break;
      case OP_BN: ok = view(a, op.a) && (op.w = wptr(a[3], op.a.rows)) && (op.w2 = wptr(a[4], op.a.rows)); break;
      case OP_LSTM: {
        ok = view(a, op.a) && view(a + 3, op.b);
        if (!ok) break;
        const int I = a[6], H = a[7], L = a[8];
        op.i0 = I; op.i1 = H; op.i2 = L;
        long count = 0;
        for (int l = 0; l < L; l++) { const int in = l == 0 ? I : H; count += 4L * H * (in + H) + 4 * H + 2 * H; }
        op.w = wptr(a[9], count);
        if (!op.w || op.a.rows != I || op.b.rows != H) { ok = false; break; }
        op.state = cursor;
        cursor += (long)L * 2 * H + 4 * H + (I + H);
        break;
      }
      default: ok = false;
    }
    if (!ok) { delete m; return fail("invalid op in program"); }
  }
  m->in_ = View{ m->buffers_[0].data, m->buffers_[0].ch, 1 };
  m->out_ = View{ m->buffers_[outB].data + outR, m->buffers_[outB].ch, 1 };
  m->reset();
  return m;
}

NamModel::~NamModel() {
  std::free(arena_);
  std::free(buffers_);
  std::free(ops_);
  std::free(weights_);
}

void NamModel::reset() {
  std::memset(arena_, 0, sizeof(float) * (size_t)arenaFloats_);
  for (int i = 0; i < nOps_; i++) {
    Op& op = ops_[i];
    op.pos = 0;
    if (op.code == OP_LSTM) {
      // restore initial hidden/cell states from the weights
      const int I = op.i0, H = op.i1, L = op.i2;
      const float* w = op.w;
      for (int l = 0; l < L; l++) {
        const int in = l == 0 ? I : H;
        w += 4L * H * (in + H) + 4 * H;
        std::memcpy(op.state + l * 2 * H, w, sizeof(float) * H);         // h0
        std::memcpy(op.state + l * 2 * H + H, w + H, sizeof(float) * H); // c0
        w += 2 * H;
      }
    }
  }
  // prewarm on silence
  // like NeuralAmpModelerCore: whole blocks until at least prewarm samples have run
  int left = prewarm_ > 0 ? ((prewarm_ + maxBlock_ - 1) / maxBlock_) * maxBlock_ : 0;
  while (left > 0) {
    const int n = left < maxBlock_ ? left : maxBlock_;
    for (int f = 0; f < n; f++) in_.base[f * in_.stride] = 0.f;
    run(n);
    left -= n;
  }
}

void NamModel::process(const float* in, float* out, int n) {
  while (n > 0) {
    const int k = n < maxBlock_ ? n : maxBlock_;
    for (int f = 0; f < k; f++) in_.base[f * in_.stride] = in[f];
    run(k);
    for (int f = 0; f < k; f++) out[f] = out_.base[f * out_.stride];
    in += k; out += k; n -= k;
  }
}

void NamModel::runConv(Op& op, int n) {
  const int K = op.i0, dil = op.i1, O = op.a.rows, I = op.b.rows;
  const bool bias = op.i2 != 0, acc = op.i3 != 0;
#define FF_CONV(N) case N: convFixed<N>(op.w, bias, acc, K, dil, I, op.state, op.mask, op.pos, op.b.base, op.b.stride, op.a.base, op.a.stride, n); return;
  switch (O) {
    FF_CONV(1) FF_CONV(2) FF_CONV(3) FF_CONV(4) FF_CONV(5) FF_CONV(6) FF_CONV(7) FF_CONV(8) FF_CONV(10) FF_CONV(12)
    FF_CONV(16) FF_CONV(20) FF_CONV(24) FF_CONV(32) FF_CONV(48) FF_CONV(64)
    default: break;
  }
#undef FF_CONV
  convGeneric(op.w, bias, acc, K, dil, I, O, op.state, op.mask, op.pos, op.b.base, op.b.stride, op.a.base, op.a.stride, n);
}

void NamModel::run(int n) {
  for (int oi = 0; oi < nOps_; oi++) {
    Op& op = ops_[oi];
    switch (op.code) {
      case OP_CONV:
        runConv(op, n);
        break;
      case OP_ADD:
        for (int f = 0; f < n; f++) {
          float* y = op.a.base + f * op.a.stride;
          const float* p = op.b.base + f * op.b.stride;
          const float* q = op.c.base + f * op.c.stride;
          for (int c = 0; c < op.a.rows; c++) y[c] = p[c] + q[c];
        }
        break;
      case OP_ADDTO:
        for (int f = 0; f < n; f++) {
          float* y = op.a.base + f * op.a.stride;
          const float* p = op.b.base + f * op.b.stride;
          for (int c = 0; c < op.a.rows; c++) y[c] += p[c];
        }
        break;
      case OP_COPY:
        for (int f = 0; f < n; f++) {
          float* y = op.a.base + f * op.a.stride;
          const float* p = op.b.base + f * op.b.stride;
          for (int c = 0; c < op.a.rows; c++) y[c] = p[c];
        }
        break;
      case OP_ZERO:
        for (int f = 0; f < n; f++) {
          float* y = op.a.base + f * op.a.stride;
          for (int c = 0; c < op.a.rows; c++) y[c] = 0.f;
        }
        break;
      case OP_SCALE: {
        const float s = op.w[0];
        for (int f = 0; f < n; f++) {
          float* y = op.a.base + f * op.a.stride;
          for (int c = 0; c < op.a.rows; c++) y[c] *= s;
        }
        break;
      }
      case OP_ACT:
        applyAct(op.i0, op.w, op.a.base, op.a.stride, op.a.rows, n);
        break;
      case OP_GATE: {
        const int bott = op.a.rows, mode = op.i0, t1 = op.i1, t2 = op.i2;
        for (int f = 0; f < n; f++) {
          float* z = op.a.base + f * op.a.stride;
          for (int c = 0; c < bott; c++) {
            const float pre = z[c];
            const float a = act1(t1, op.w, c, pre);
            const float g = act1(t2, op.w2, c, z[c + bott]);
            z[c] = mode == 1 ? a * g : g * a + (1.f - g) * pre;
          }
        }
        break;
      }
      case OP_FILM: {
        const int rows = op.a.rows;
        const bool shift = op.i0 != 0;
        for (int f = 0; f < n; f++) {
          float* x = op.a.base + f * op.a.stride;
          const float* ss = op.b.base + f * op.b.stride;
          if (shift) for (int c = 0; c < rows; c++) x[c] = x[c] * ss[c] + ss[rows + c];
          else for (int c = 0; c < rows; c++) x[c] *= ss[c];
        }
        break;
      }
      case OP_BN:
        for (int f = 0; f < n; f++) {
          float* x = op.a.base + f * op.a.stride;
          for (int c = 0; c < op.a.rows; c++) x[c] = x[c] * op.w[c] + op.w2[c];
        }
        break;
      case OP_LSTM: {
        const int I = op.i0, H = op.i1, L = op.i2;
        float* gates = op.state + (long)L * 2 * H;
        float* xh = gates + 4 * H;
        for (int f = 0; f < n; f++) {
          const float* x = op.a.base + f * op.a.stride;
          const float* w = op.w;
          const float* layerIn = x;
          int inSize = I;
          for (int l = 0; l < L; l++) {
            float* h = op.state + l * 2 * H;
            float* c = h + H;
            const int cols = inSize + H;
            for (int i = 0; i < inSize; i++) xh[i] = layerIn[i];
            for (int i = 0; i < H; i++) xh[inSize + i] = h[i];
            const float* Wm = w;
            const float* b = w + 4L * H * cols;
            for (int r = 0; r < 4 * H; r++) {
              const float* wr = Wm + (long)r * cols;
              float s = b[r];
              for (int j = 0; j < cols; j++) s += wr[j] * xh[j];
              gates[r] = s;
            }
            for (int i = 0; i < H; i++)
              c[i] = sigmoidf(gates[H + i]) * c[i] + sigmoidf(gates[i]) * tanhApprox(gates[2 * H + i]);
            for (int i = 0; i < H; i++) h[i] = sigmoidf(gates[3 * H + i]) * tanhApprox(c[i]);
            w = b + 4 * H + 2 * H;
            layerIn = h;
            inSize = H;
          }
          const float* hl = op.state + (long)(L - 1) * 2 * H;
          float* dv = op.b.base + f * op.b.stride;
          for (int i = 0; i < H; i++) dv[i] = hl[i];
        }
        break;
      }
    }
  }
}

} // namespace forge
