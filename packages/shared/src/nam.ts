// Compiles a Neural Amp Modeler (.nam) file into a small program for the forge-dsp engine.
//
// The engine does not parse JSON. It runs a flat list of operations over numbered buffers,
// with weights rearranged into the layout it wants. Weight order and processing follow
// NeuralAmpModelerCore (MIT) so results match the reference implementation.
//
// Supported: WaveNet (A1 and A2 features: bottleneck, grouped convs, per-layer kernel sizes and
// activations, gated/blended activations, layer1x1/head1x1, FiLM, condition_dsp, post-stack head),
// LSTM, Linear, ConvNet and SlimmableContainer (the largest submodel is used).

export const NAM_PROGRAM_MAGIC = 0x464e414d; // 'FNAM'
export const NAM_PROGRAM_VERSION = 1;

export enum Op {
  Conv = 1, // dst(view) src(view) K dil hasBias accumulate wOff
  Add = 2, // dst a b
  AddTo = 3, // dst src
  Copy = 4, // dst src
  Zero = 5, // dst
  Scale = 6, // dst wOff
  Act = 7, // dst type pOff
  Gate = 8, // z(view of 2*b rows, rows=b) mode act1 p1 act2 p2
  Film = 9, // x(view) ss(view) shift
  BatchNorm = 10, // dst scaleOff locOff
  Lstm = 11, // src(view) dst(view) inputSize hidden layers wOff
}

export enum Act {
  Identity = 0,
  Tanh = 1,
  Hardtanh = 2,
  Fasttanh = 3,
  ReLU = 4,
  LeakyReLU = 5,
  Sigmoid = 6,
  SiLU = 7,
  Hardswish = 8,
  LeakyHardtanh = 9,
  PReLU = 10,
  Softsign = 11,
}

export interface NamInfo {
  architecture: string;
  /** what actually runs (for containers, the chosen submodel) */
  runArchitecture: string;
  version: string;
  sampleRate: number;
  name?: string;
  modeledBy?: string;
  gearType?: string;
  gearMake?: string;
  gearModel?: string;
  toneType?: string;
  /** dB loudness of the model's output for the standard test signal */
  loudness?: number;
  inputLevelDbu?: number;
  outputLevelDbu?: number;
  /** multiply-accumulates per sample, a rough cost figure */
  macsPerSample: number;
  prewarmSamples: number;
  parameters: number;
}

export interface CompiledNam {
  info: NamInfo;
  /** program header + ops, see engine/src/nam.cpp */
  code: Int32Array;
  weights: Float32Array;
}

export class NamError extends Error {}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface View { b: number; r: number; n: number }

class Builder {
  buffers: number[] = [];
  ops: number[] = [];
  w: number[] = [];
  macs = 0;
  params = 0;
  buffer(channels: number): number {
    this.buffers.push(channels);
    return this.buffers.length - 1;
  }
  view(b: number, r = 0, n = this.buffers[b]): View {
    return { b, r, n };
  }
  op(code: number, ...args: number[]) {
    this.ops.push(code, args.length + 2, ...args);
  }
  v(x: View) {
    return [x.b, x.r, x.n];
  }
  weightsAt(values: number[] | Float32Array): number {
    const off = this.w.length;
    for (let i = 0; i < values.length; i++) this.w.push(values[i]);
    return off;
  }
}

class Weights {
  i = 0;
  constructor(private readonly src: ArrayLike<number>) {}
  next(): number {
    if (this.i >= this.src.length) throw new NamError('The model file has fewer weights than its architecture needs.');
    return this.src[this.i++];
  }
  take(n: number): number[] {
    const out = new Array<number>(n);
    for (let k = 0; k < n; k++) out[k] = this.next();
    return out;
  }
  get remaining() {
    return this.src.length - this.i;
  }
}

// ------------------------------------------------------------------ activations

interface ActSpec { type: Act; params: number[] }

const ACT_NAMES: Record<string, Act> = {
  Tanh: Act.Tanh, Hardtanh: Act.Hardtanh, Fasttanh: Act.Fasttanh, ReLU: Act.ReLU, LeakyReLU: Act.LeakyReLU,
  Sigmoid: Act.Sigmoid, SiLU: Act.SiLU, Hardswish: Act.Hardswish, LeakyHardtanh: Act.LeakyHardtanh,
  LeakyHardTanh: Act.LeakyHardtanh, PReLU: Act.PReLU, Softsign: Act.Softsign,
};

function parseAct(j: Json): ActSpec {
  if (j == null) return { type: Act.Identity, params: [] };
  const name = typeof j === 'string' ? j : j?.type;
  const type = ACT_NAMES[name];
  if (type === undefined) throw new NamError(`Unsupported activation "${name}".`);
  const o = typeof j === 'object' ? j : {};
  switch (type) {
    case Act.LeakyReLU:
      return { type, params: [o.negative_slope ?? 0.01] };
    case Act.PReLU: {
      const slopes: number[] = o.negative_slopes ?? [o.negative_slope ?? 0.01];
      return { type, params: [slopes.length, ...slopes] };
    }
    case Act.LeakyHardtanh:
      return { type, params: [o.min_val ?? -1, o.max_val ?? 1, o.min_slope ?? 0.01, o.max_slope ?? 0.01] };
    default:
      return { type, params: [] };
  }
}

function emitAct(B: Builder, dst: View, a: ActSpec) {
  if (a.type === Act.Identity) return;
  B.op(Op.Act, ...B.v(dst), a.type, B.weightsAt(a.params.length ? a.params : [0]));
}

// ------------------------------------------------------------------ convolutions

/** Reads NAM-ordered conv weights (grouped) and stores them as W[k][in][out] then bias[out]. */
function readConv(W: Weights, inCh: number, outCh: number, K: number, bias: boolean, groups: number): number[] {
  if (inCh % groups || outCh % groups) throw new NamError('Convolution channels do not divide evenly by groups.');
  const dense = new Array<number>(K * inCh * outCh).fill(0);
  const opg = outCh / groups, ipg = inCh / groups;
  for (let g = 0; g < groups; g++)
    for (let i = 0; i < opg; i++)
      for (let j = 0; j < ipg; j++)
        for (let k = 0; k < K; k++) {
          const o = g * opg + i, c = g * ipg + j;
          dense[(k * inCh + c) * outCh + o] = W.next();
        }
  const b = bias ? W.take(outCh) : [];
  return [...dense, ...b];
}

function emitConv(B: Builder, W: Weights, dst: View, src: View, K: number, dil: number, bias: boolean, groups: number, accumulate = false) {
  const data = readConv(W, src.n, dst.n, K, bias, groups);
  B.params += (K * src.n * dst.n) / groups + (bias ? dst.n : 0);
  B.macs += (K * src.n * dst.n) / groups;
  B.op(Op.Conv, ...B.v(dst), ...B.v(src), K, dil, bias ? 1 : 0, accumulate ? 1 : 0, B.weightsAt(data));
}

/** FiLM: scale (and shift) computed from the condition by a 1x1 conv with bias. */
function emitFilm(B: Builder, W: Weights, x: View, cond: View, shift: boolean, groups: number) {
  const ss = B.view(B.buffer((shift ? 2 : 1) * x.n));
  emitConv(B, W, ss, cond, 1, 1, true, groups);
  B.op(Op.Film, ...B.v(x), ...B.v(ss), shift ? 1 : 0);
}

// ------------------------------------------------------------------ WaveNet

interface FilmP { active: boolean; shift: boolean; groups: number }
const FILM_KEYS = ['conv_pre_film', 'conv_post_film', 'input_mixin_pre_film', 'input_mixin_post_film', 'activation_pre_film', 'activation_post_film', 'layer1x1_post_film', 'head1x1_post_film'] as const;

interface ArrayParams {
  inputSize: number;
  conditionSize: number;
  headSize: number;
  headKernel: number;
  headDilation: number;
  headBias: boolean;
  channels: number;
  bottleneck: number;
  kernelSizes: number[];
  dilations: number[];
  acts: ActSpec[];
  gating: number[]; // 0 none, 1 gated, 2 blended
  secondary: ActSpec[];
  groupsInput: number;
  groupsMixin: number;
  layer1x1: { active: boolean; groups: number };
  head1x1: { active: boolean; out: number; groups: number };
  film: Record<(typeof FILM_KEYS)[number], FilmP>;
}

function parseArray(lc: Json): ArrayParams {
  const channels: number = lc.channels;
  const n = (lc.dilations as number[]).length;
  let headSize = 0, headKernel = 1, headDilation = 1, headBias = false;
  if (lc.head && typeof lc.head === 'object') {
    headSize = lc.head.out_channels;
    headKernel = lc.head.kernel_size;
    headBias = !!lc.head.bias;
    headDilation = lc.head.head_dilation ?? 1;
  } else if (lc.head_size != null) {
    headSize = lc.head_size;
    headBias = !!lc.head_bias;
  } else throw new NamError('A WaveNet layer array has no head settings.');

  let kernelSizes: number[];
  if (Array.isArray(lc.kernel_sizes)) kernelSizes = lc.kernel_sizes;
  else if (lc.kernel_size != null) kernelSizes = new Array(n).fill(lc.kernel_size);
  else throw new NamError('A WaveNet layer array has no kernel size.');
  if (kernelSizes.length !== n) throw new NamError('kernel_sizes and dilations have different lengths.');

  const acts = Array.isArray(lc.activation) ? (lc.activation as Json[]).map(parseAct) : new Array(n).fill(parseAct(lc.activation));
  if (acts.length !== n) throw new NamError('activation and dilations have different lengths.');

  const parseMode = (s: string) => {
    if (s === 'none') return 0;
    if (s === 'gated') return 1;
    if (s === 'blended') return 2;
    throw new NamError(`Unknown gating mode "${s}".`);
  };
  let gating: number[];
  let secondary: ActSpec[];
  const sigmoid: ActSpec = { type: Act.Sigmoid, params: [] };
  const sec = (i: number) => {
    const s = lc.secondary_activation;
    if (s == null) return sigmoid;
    const v = Array.isArray(s) ? s[i] : s;
    return v == null ? sigmoid : parseAct(v);
  };
  if (lc.gating_mode != null) {
    gating = Array.isArray(lc.gating_mode) ? (lc.gating_mode as string[]).map(parseMode) : new Array(n).fill(parseMode(lc.gating_mode));
    secondary = gating.map((g, i) => (g ? sec(i) : { type: Act.Identity, params: [] }));
  } else if (lc.gated != null) {
    gating = new Array(n).fill(lc.gated ? 1 : 0);
    secondary = gating.map((g) => (g ? sigmoid : { type: Act.Identity, params: [] }));
  } else {
    gating = new Array(n).fill(0);
    secondary = new Array(n).fill({ type: Act.Identity, params: [] });
  }
  if (gating.length !== n) throw new NamError('gating_mode and dilations have different lengths.');

  const film = {} as ArrayParams['film'];
  for (const k of FILM_KEYS) {
    const f = lc[k];
    if (f == null || f === false) film[k] = { active: false, shift: false, groups: 1 };
    else film[k] = { active: f.active ?? true, shift: f.shift ?? true, groups: f.groups ?? 1 };
  }
  const layer1x1 = lc.layer1x1 ? { active: !!lc.layer1x1.active, groups: lc.layer1x1.groups ?? 1 } : { active: true, groups: 1 };
  const head1x1 = lc.head1x1
    ? { active: !!lc.head1x1.active, out: lc.head1x1.out_channels ?? channels, groups: lc.head1x1.groups ?? 1 }
    : { active: false, out: channels, groups: 1 };
  const bottleneck = lc.bottleneck ?? channels;
  if (!layer1x1.active && bottleneck !== channels) throw new NamError('bottleneck must equal channels when layer1x1 is off.');
  return {
    inputSize: lc.input_size, conditionSize: lc.condition_size, headSize, headKernel, headDilation, headBias,
    channels, bottleneck, kernelSizes, dilations: lc.dilations, acts, gating, secondary,
    groupsInput: lc.groups_input ?? 1, groupsMixin: lc.groups_input_mixin ?? 1, layer1x1, head1x1, film,
  };
}

interface Compiled { out: View; prewarm: number; outChannels: number }

function compileWaveNet(B: Builder, cfg: Json, weights: ArrayLike<number>, input: View, sampleRate: number): Compiled {
  // condition_dsp is a nested model with its own weights
  let condition = input;
  let prewarm = 1;
  if (cfg.condition_dsp) {
    const sub = compileModel(B, cfg.condition_dsp, input, sampleRate);
    condition = sub.out;
    prewarm = sub.prewarm;
  }
  const W = new Weights(weights);
  const arrays = (cfg.layers as Json[]).map(parseArray);
  if (!arrays.length) throw new NamError('WaveNet has no layer arrays.');

  let layerInput = input; // first array takes the raw input
  let prevHead: View | null = null;
  for (let ai = 0; ai < arrays.length; ai++) {
    const p = arrays[ai];
    if (p.conditionSize !== condition.n) throw new NamError('condition_size does not match the condition signal.');
    if (layerInput.n !== p.inputSize) throw new NamError('Layer array input_size does not match the previous array.');
    const headIn = p.head1x1.active ? p.head1x1.out : p.bottleneck;
    // rechannel: Conv1x1 without bias
    let x = B.view(B.buffer(p.channels));
    emitConv(B, W, x, layerInput, 1, 1, false, 1);
    const headAcc = B.view(B.buffer(headIn));
    if (prevHead) {
      if (prevHead.n !== headIn) throw new NamError('Head sizes of consecutive layer arrays do not match.');
      B.op(Op.Copy, ...B.v(headAcc), ...B.v(prevHead));
    } else B.op(Op.Zero, ...B.v(headAcc));

    for (let li = 0; li < p.dilations.length; li++) {
      const K = p.kernelSizes[li], dil = p.dilations[li];
      const gated = p.gating[li] !== 0;
      const zCh = gated ? 2 * p.bottleneck : p.bottleneck;
      const z = B.view(B.buffer(zCh));
      const mix = B.view(B.buffer(zCh));
      const f = p.film;
      // weights in NAM order: conv, input_mixin, layer1x1, head1x1, then FiLMs. Read them all first.
      const convData = readConv(W, p.channels, zCh, K, true, p.groupsInput);
      const mixData = readConv(W, p.conditionSize, zCh, 1, false, p.groupsMixin);
      const l1Data = p.layer1x1.active ? readConv(W, p.bottleneck, p.channels, 1, true, p.layer1x1.groups) : null;
      const h1Data = p.head1x1.active ? readConv(W, p.bottleneck, p.head1x1.out, 1, true, p.head1x1.groups) : null;
      // FiLM weights come next, in FILM_KEYS order; capture each in a sub-reader
      const filmW: Partial<Record<(typeof FILM_KEYS)[number], Weights>> = {};
      const filmDims: Record<(typeof FILM_KEYS)[number], number> = {
        conv_pre_film: p.channels, conv_post_film: zCh, input_mixin_pre_film: p.conditionSize, input_mixin_post_film: zCh,
        activation_pre_film: zCh, activation_post_film: p.bottleneck, layer1x1_post_film: p.channels, head1x1_post_film: p.head1x1.out,
      };
      for (const k of FILM_KEYS) {
        if (!f[k].active) continue;
        const dim = filmDims[k];
        const n = ((f[k].shift ? 2 : 1) * dim * p.conditionSize) / f[k].groups + (f[k].shift ? 2 : 1) * dim;
        filmW[k] = new Weights(W.take(n));
      }

      const emitStored = (dst: View, src: View, data: number[], k: number, d: number, bias: boolean, acc = false) => {
        B.params += data.length;
        B.macs += k * src.n * dst.n;
        B.op(Op.Conv, ...B.v(dst), ...B.v(src), k, d, bias ? 1 : 0, acc ? 1 : 0, B.weightsAt(data));
      };

      // conv (with optional pre/post FiLM)
      let convIn = x;
      if (f.conv_pre_film.active) {
        const t = B.view(B.buffer(p.channels));
        B.op(Op.Copy, ...B.v(t), ...B.v(x));
        emitFilm(B, filmW.conv_pre_film!, t, condition, f.conv_pre_film.shift, f.conv_pre_film.groups);
        convIn = t;
      }
      emitStored(z, convIn, convData, K, dil, true);
      if (f.conv_post_film.active) emitFilm(B, filmW.conv_post_film!, z, condition, f.conv_post_film.shift, f.conv_post_film.groups);
      // input mixin
      let mixIn = condition;
      if (f.input_mixin_pre_film.active) {
        const t = B.view(B.buffer(p.conditionSize));
        B.op(Op.Copy, ...B.v(t), ...B.v(condition));
        emitFilm(B, filmW.input_mixin_pre_film!, t, condition, f.input_mixin_pre_film.shift, f.input_mixin_pre_film.groups);
        mixIn = t;
      }
      emitStored(mix, mixIn, mixData, 1, 1, false);
      if (f.input_mixin_post_film.active) emitFilm(B, filmW.input_mixin_post_film!, mix, condition, f.input_mixin_post_film.shift, f.input_mixin_post_film.groups);
      B.op(Op.AddTo, ...B.v(z), ...B.v(mix));
      if (f.activation_pre_film.active) emitFilm(B, filmW.activation_pre_film!, z, condition, f.activation_pre_film.shift, f.activation_pre_film.groups);

      const zTop = B.view(z.b, 0, p.bottleneck);
      if (!gated) emitAct(B, z, p.acts[li]);
      else {
        const a1 = p.acts[li], a2 = p.secondary[li];
        B.op(Op.Gate, ...B.v(zTop), p.gating[li], a1.type, B.weightsAt(a1.params.length ? a1.params : [0]), a2.type, B.weightsAt(a2.params.length ? a2.params : [0]));
      }
      if (f.activation_post_film.active) emitFilm(B, filmW.activation_post_film!, zTop, condition, f.activation_post_film.shift, f.activation_post_film.groups);

      const next = B.view(B.buffer(p.channels));
      if (l1Data) {
        const l1 = B.view(B.buffer(p.channels));
        emitStored(l1, zTop, l1Data, 1, 1, true);
        if (f.layer1x1_post_film.active) emitFilm(B, filmW.layer1x1_post_film!, l1, condition, f.layer1x1_post_film.shift, f.layer1x1_post_film.groups);
        B.op(Op.Add, ...B.v(next), ...B.v(x), ...B.v(l1));
      } else B.op(Op.Copy, ...B.v(next), ...B.v(x));

      if (h1Data) {
        const h1 = B.view(B.buffer(p.head1x1.out));
        emitStored(h1, zTop, h1Data, 1, 1, true);
        if (f.head1x1_post_film.active) emitFilm(B, filmW.head1x1_post_film!, h1, condition, f.head1x1_post_film.shift, f.head1x1_post_film.groups);
        B.op(Op.AddTo, ...B.v(headAcc), ...B.v(h1));
      } else B.op(Op.AddTo, ...B.v(headAcc), ...B.v(zTop));
      x = next;
      prewarm += dil * (K - 1);
    }
    // head rechannel: Conv1D headIn -> headSize
    const head = B.view(B.buffer(p.headSize));
    emitConv(B, W, head, headAcc, p.headKernel, p.headDilation, p.headBias, 1);
    prewarm += p.headDilation * (p.headKernel - 1);
    layerInput = x;
    prevHead = head;
    if (ai + 1 < arrays.length && arrays[ai + 1].channels !== p.headSize) {
      // NAM requires channels of the next array to equal this head size (head outputs feed its accumulator)
      throw new NamError('Layer array channels do not match the previous head size.');
    }
  }

  let out = prevHead!;
  if (cfg.head) {
    const h = cfg.head;
    const act = parseAct(h.activation);
    const ks: number[] = h.kernel_sizes;
    const scaled = B.view(B.buffer(out.n));
    B.op(Op.Copy, ...B.v(scaled), ...B.v(out));
    // head_scale is the last weight; it is written once all others are read (see below)
    const scaleOp = B.ops.length;
    B.op(Op.Scale, ...B.v(scaled), 0);
    let cur = scaled;
    for (let i = 0; i < ks.length; i++) {
      const cout = i + 1 === ks.length ? h.out_channels : h.channels;
      emitAct(B, cur, act);
      const nx = B.view(B.buffer(cout));
      emitConv(B, W, nx, cur, ks[i], 1, true, 1);
      cur = nx;
      prewarm += ks[i] - 1;
    }
    const s = W.next();
    B.ops[scaleOp + 5] = B.weightsAt([s]);
    out = cur;
  } else {
    const s = W.next();
    const scaled = B.view(B.buffer(out.n));
    B.op(Op.Copy, ...B.v(scaled), ...B.v(out));
    B.op(Op.Scale, ...B.v(scaled), B.weightsAt([s]));
    out = scaled;
  }
  if (W.remaining !== 0) throw new NamError(`The model file has ${W.remaining} more weights than its architecture uses.`);
  return { out, prewarm, outChannels: out.n };
}

// ------------------------------------------------------------------ LSTM, Linear, ConvNet

function compileLstm(B: Builder, cfg: Json, weights: ArrayLike<number>, input: View, sampleRate: number): Compiled {
  const W = new Weights(weights);
  const I: number = cfg.input_size, H: number = cfg.hidden_size, L: number = cfg.num_layers;
  if (input.n !== I) throw new NamError('LSTM input_size does not match the input.');
  const data: number[] = [];
  for (let l = 0; l < L; l++) {
    const inSize = l === 0 ? I : H;
    data.push(...W.take(4 * H * (inSize + H) + 4 * H + H + H));
    B.macs += 4 * H * (inSize + H);
  }
  B.params += data.length;
  const hidden = B.view(B.buffer(H));
  B.op(Op.Lstm, ...B.v(input), ...B.v(hidden), I, H, L, B.weightsAt(data));
  const outCh = cfg.out_channels ?? 1;
  const out = B.view(B.buffer(outCh));
  // head: weight (out x H) row-major then bias; store as conv W[0][in][out]
  const hw = W.take(outCh * H), hb = W.take(outCh);
  const conv = new Array<number>(H * outCh);
  for (let o = 0; o < outCh; o++) for (let h = 0; h < H; h++) conv[h * outCh + o] = hw[o * H + h];
  B.op(Op.Conv, ...B.v(out), ...B.v(hidden), 1, 1, 1, 0, B.weightsAt([...conv, ...hb]));
  B.macs += H * outCh;
  if (W.remaining !== 0) throw new NamError(`The model file has ${W.remaining} more weights than its architecture uses.`);
  return { out, prewarm: Math.max(1, Math.round(0.5 * sampleRate)), outChannels: outCh };
}

function compileLinear(B: Builder, cfg: Json, weights: ArrayLike<number>, input: View): Compiled {
  const rf: number = cfg.receptive_field;
  const bias = !!cfg.bias;
  if (input.n !== 1) throw new NamError('Only mono Linear models are supported.');
  const ir = Array.from(weights).slice(0, rf);
  if (weights.length !== rf + (bias ? 1 : 0)) throw new NamError('Linear model weight count does not match receptive_field.');
  const out = B.view(B.buffer(1));
  const data = new Array<number>(rf);
  for (let k = 0; k < rf; k++) data[k] = ir[rf - 1 - k];
  if (bias) data.push(weights[rf]);
  B.op(Op.Conv, ...B.v(out), ...B.v(input), rf, 1, bias ? 1 : 0, 0, B.weightsAt(data));
  B.macs += rf;
  B.params += data.length;
  return { out, prewarm: rf, outChannels: 1 };
}

function compileConvNet(B: Builder, cfg: Json, weights: ArrayLike<number>, input: View): Compiled {
  const W = new Weights(weights);
  const C: number = cfg.channels;
  const dil: number[] = cfg.dilations;
  const bn = !!cfg.batchnorm;
  const act = parseAct(cfg.activation);
  const groups: number = cfg.groups ?? 1;
  let cur = input;
  let prewarm = 1;
  for (let i = 0; i < dil.length; i++) {
    const nx = B.view(B.buffer(C));
    emitConv(B, W, nx, cur, 2, dil[i], !bn, groups);
    if (bn) {
      const mean = W.take(C), varr = W.take(C), wt = W.take(C), bias = W.take(C), eps = W.next();
      const scale = wt.map((w, c) => w / Math.sqrt(eps + varr[c]));
      const loc = bias.map((b, c) => b - scale[c] * mean[c]);
      B.op(Op.BatchNorm, ...B.v(nx), B.weightsAt(scale), B.weightsAt(loc));
    }
    emitAct(B, nx, act);
    cur = nx;
    prewarm += dil[i];
  }
  const outCh = cfg.out_channels ?? 1;
  const out = B.view(B.buffer(outCh));
  const hw = W.take(outCh * C), hb = W.take(outCh);
  const conv = new Array<number>(C * outCh);
  for (let o = 0; o < outCh; o++) for (let c = 0; c < C; c++) conv[c * outCh + o] = hw[o * C + c];
  B.op(Op.Conv, ...B.v(out), ...B.v(cur), 1, 1, 1, 0, B.weightsAt([...conv, ...hb]));
  if (W.remaining !== 0) throw new NamError(`The model file has ${W.remaining} more weights than its architecture uses.`);
  return { out, prewarm, outChannels: outCh };
}

let preferLite = false;

function compileModel(B: Builder, model: Json, input: View, sampleRate: number): Compiled {
  const arch = model.architecture;
  const cfg = model.config ?? {};
  const weights: number[] = model.weights ?? [];
  switch (arch) {
    case 'WaveNet':
      return compileWaveNet(B, cfg, weights, input, sampleRate);
    case 'LSTM':
      return compileLstm(B, cfg, weights, input, sampleRate);
    case 'Linear':
      return compileLinear(B, cfg, weights, input);
    case 'ConvNet':
      return compileConvNet(B, cfg, weights, input);
    case 'SlimmableContainer':
    case 'Container': {
      const subs: Json[] = cfg.submodels ?? [];
      if (!subs.length) throw new NamError('The container model has no submodels.');
      return compileModel(B, subs[preferLite ? 0 : subs.length - 1].model, input, sampleRate);
    }
    default:
      throw new NamError(`Unsupported NAM architecture "${arch}".`);
  }
}

function innermost(model: Json): Json {
  if ((model.architecture === 'SlimmableContainer' || model.architecture === 'Container') && model.config?.submodels?.length)
    return innermost(model.config.submodels[preferLite ? 0 : model.config.submodels.length - 1].model);
  return model;
}

/**
 * Reads a .nam file (as text or parsed JSON) and compiles it. Throws NamError with a readable message.
 * `lite` picks the smallest variant of models that ship several (slimmable containers).
 */
export function compileNam(file: string | Json, opts: { lite?: boolean } = {}): CompiledNam {
  preferLite = !!opts.lite;
  let model: Json;
  try {
    model = typeof file === 'string' ? JSON.parse(file) : file;
  } catch {
    throw new NamError('This is not a valid .nam file (it is not JSON).');
  }
  if (!model || typeof model !== 'object' || !model.architecture) throw new NamError('This is not a .nam file (no architecture).');
  const inner = innermost(model);
  const sampleRate: number = inner.sample_rate ?? model.sample_rate ?? 48000;
  const B = new Builder();
  const inChannels = inner.config?.in_channels ?? 1;
  if (inChannels !== 1) throw new NamError('Only mono-input models are supported.');
  const input = B.view(B.buffer(1));
  let res: Compiled;
  try {
    res = compileModel(B, model, input, sampleRate);
  } catch (e) {
    if (e instanceof NamError) throw e;
    throw new NamError(`Could not read this model: ${(e as Error)?.message ?? e}`);
  }
  if (res.out.n < 1) throw new NamError('The model has no output.');
  const meta = inner.metadata ?? model.metadata ?? {};
  const header = [NAM_PROGRAM_MAGIC, NAM_PROGRAM_VERSION, B.buffers.length, ...B.buffers, res.out.b, res.out.r, res.prewarm, B.ops.length];
  const code = Int32Array.from([...header, ...B.ops]);
  return {
    info: {
      architecture: model.architecture,
      runArchitecture: inner.architecture,
      version: String(model.version ?? ''),
      sampleRate,
      name: meta.name || undefined,
      modeledBy: meta.modeled_by || undefined,
      gearType: meta.gear_type || undefined,
      gearMake: meta.gear_make || undefined,
      gearModel: meta.gear_model || undefined,
      toneType: meta.tone_type || undefined,
      loudness: typeof meta.loudness === 'number' ? meta.loudness : undefined,
      inputLevelDbu: typeof meta.input_level_dbu === 'number' ? meta.input_level_dbu : undefined,
      outputLevelDbu: typeof meta.output_level_dbu === 'number' ? meta.output_level_dbu : undefined,
      macsPerSample: Math.round(B.macs),
      prewarmSamples: res.prewarm,
      parameters: Math.round(B.params),
    },
    code,
    weights: Float32Array.from(B.w),
  };
}

/** Output gain (linear) that brings the model to a -18 dB loudness target, like the NAM plugin's normalize option. */
export function namNormalizeGain(info: Pick<NamInfo, 'loudness'>, targetDb = -18): number {
  if (info.loudness == null || !Number.isFinite(info.loudness)) return 1;
  return Math.pow(10, (targetDb - info.loudness) / 20);
}
