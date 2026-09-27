/**
 * engine/wholeBrain.ts — the whole-brain model.
 *
 * One Wilson–Cowan excitatory/inhibitory pair per region, coupled through the
 * connectome with conduction delays, plus a slow adaptation current on the
 * excitatory population. That is enough for the phenomena the page exists to
 * show — rhythms at every band, synchrony and its loss, slow waves under
 * adaptation, seizure-like hypersynchrony when inhibition fails, travelling
 * responses to stimulation, disconnection after a lesion — and it runs in a
 * few hundred milliseconds in plain JavaScript, so the same file serves the
 * agent's tool and the browser.
 *
 * The state a caller sets is a short list of KNOBS (0 = off, 1 = the
 * baseline awake brain, 2 = double), stimulation events and lesions. The
 * knob → parameter mapping lives in `derive()` below and is the thing to read
 * when a scenario looks wrong.
 *
 * This is a mechanistic model, not a fitted one: it is faithful to the kind
 * of dynamics a cortex has, never to a particular person's.
 */

import { REGIONS, N, resolveRegion } from './atlas.ts';
import { connectome } from './connectome.ts';
import { mulberry32, seedFrom } from './random.ts';

export interface Stimulation {
  /** region reference, resolved by atlas.resolveRegion */
  region: string;
  /** input amplitude in model units (1 ≈ a strong sensory drive) */
  amplitude?: number;
  /** oscillation frequency in Hz; 0 or absent = constant */
  frequency_hz?: number;
  onset_ms?: number;
  duration_ms?: number;
  waveform?: 'sine' | 'pulse' | 'dc';
}

export interface Lesion {
  region: string;
  /** surviving tissue: 0 = intact, 0.5 = half the region destroyed, 1 = silenced and
   *  disconnected. Activity falls monotonically to zero as this rises. */
  severity?: number;
}

export interface Modulators {
  /** gain and signal-to-noise; reward, motor vigour */
  dopamine?: number;
  /** cortical desynchronisation, attention; lowers recurrent excitation and adaptation */
  acetylcholine?: number;
  /** arousal; raises drive and noise */
  noradrenaline?: number;
  /** raised: flattened hierarchy, more entropy (the psychedelic direction) */
  serotonin?: number;
  /** sleep pressure: adaptation up, drive down */
  adenosine?: number;
}

/** a region reference and a multiplier on its external drive: 1 = unchanged, 1.3 = engaged, 0.7 = disengaged */
export interface RegionalDrive {
  region: string;
  factor: number;
}

export interface WholeBrainParams {
  duration_ms?: number;
  /** recurrent excitation and external drive */
  excitability?: number;
  /** inhibitory feedback onto the excitatory population */
  inhibition?: number;
  /** global coupling through the connectome */
  coupling?: number;
  /** input noise */
  noise?: number;
  /** slow adaptation on the excitatory population; high values give slow waves */
  adaptation?: number;
  /** ascending drive from brainstem/thalamus; 0 is deep anaesthesia territory */
  arousal?: number;
  modulators?: Modulators;
  stimulation?: Stimulation[];
  lesions?: Lesion[];
  /** which regions the state engages or disengages: multipliers on their drive (the regional signature of a state) */
  regional_drive?: RegionalDrive[];
  seed?: number | string;
  /** expert mode: override any derived Wilson–Cowan parameter after the knobs are applied */
  overrides?: Partial<DerivedParams>;
  /** multipliers on derived parameters, applied LAST (after knobs and overrides): how a drug acts on a state */
  scale?: Partial<DerivedParams>;
}

export interface ResolvedParams {
  duration_ms: number;
  excitability: number;
  inhibition: number;
  coupling: number;
  noise: number;
  adaptation: number;
  arousal: number;
  modulators: Required<Modulators>;
  stimulation: Array<Required<Stimulation> & { nodes: number[] }>;
  lesions: Array<Required<Lesion> & { nodes: number[] }>;
  regional_drive: Array<RegionalDrive & { nodes: number[] }>;
  seed: number;
  /** region references that resolved to nothing, reported rather than guessed */
  unresolved: string[];
  overrides: Partial<DerivedParams>;
  scale: Partial<DerivedParams>;
}

export interface WholeBrainRun {
  kind: 'whole-brain';
  params: ResolvedParams;
  /** sample period in ms */
  dt_ms: number;
  /** number of frames */
  frames: number;
  /** excitatory activity per frame per node, frame-major, in [0, 1] */
  activity: Float32Array;
  /** the parameters the knobs became, for the curious */
  derived: DerivedParams;
}

export interface DerivedParams {
  c1: number; c2: number; c3: number; c4: number;
  ae: number; te: number; ai: number; ti: number;
  P: number; Q: number; G: number; sigma: number;
  k_adapt: number; tau_adapt: number;
}

export const SAMPLE_MS = 4; // 250 Hz
const DT = 0.5; // integration step, ms
/** settling time before recording starts: the model's onset transient is not part of any run */
const WARMUP_MS = 400;
const MAX_DELAY_STEPS = 128;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const knob = (v: number | undefined, dflt = 1, hi = 3) => clamp(v ?? dflt, 0, hi);

export function resolveParams(p: WholeBrainParams): ResolvedParams {
  const unresolved: string[] = [];
  const mods = p.modulators ?? {};
  const stimulation = (p.stimulation ?? []).map((s) => {
    const nodes = resolveRegion(s.region);
    if (!nodes.length) unresolved.push(s.region);
    return {
      region: s.region,
      amplitude: clamp(s.amplitude ?? 1.5, 0, 6),
      frequency_hz: clamp(s.frequency_hz ?? 0, 0, 200),
      onset_ms: Math.max(0, s.onset_ms ?? 500),
      duration_ms: Math.max(0, s.duration_ms ?? 1000),
      waveform: s.waveform ?? (s.frequency_hz ? 'sine' : 'dc'),
      nodes,
    };
  });
  const lesions = (p.lesions ?? []).map((l) => {
    const nodes = resolveRegion(l.region);
    if (!nodes.length) unresolved.push(l.region);
    return { region: l.region, severity: clamp(l.severity ?? 1, 0, 1), nodes };
  });
  const regional_drive = (p.regional_drive ?? []).map((d) => {
    const nodes = resolveRegion(d.region);
    if (!nodes.length) unresolved.push(d.region);
    return { region: d.region, factor: clamp(d.factor ?? 1, 0.3, 2), nodes };
  });
  const seed = typeof p.seed === 'string' ? seedFrom(p.seed) : (p.seed ?? 7) >>> 0;
  return {
    duration_ms: clamp(Math.round(p.duration_ms ?? 3000), 500, 10000),
    excitability: knob(p.excitability),
    inhibition: knob(p.inhibition),
    coupling: knob(p.coupling),
    noise: knob(p.noise, 1),
    adaptation: knob(p.adaptation, 1),
    arousal: knob(p.arousal, 1),
    modulators: {
      dopamine: knob(mods.dopamine),
      acetylcholine: knob(mods.acetylcholine),
      noradrenaline: knob(mods.noradrenaline),
      serotonin: knob(mods.serotonin),
      adenosine: knob(mods.adenosine),
    },
    stimulation,
    lesions,
    regional_drive,
    seed,
    unresolved,
    overrides: p.overrides ?? {},
    scale: p.scale ?? {},
  };
}

/** knobs → Wilson–Cowan parameters. Baseline (every knob 1) is an awake, lightly
 *  alpha-dominant cortex; the comments say which direction each knob pulls. */
export function derive(r: ResolvedParams): DerivedParams {
  const m = r.modulators;
  const ach = m.acetylcholine;
  const da = m.dopamine;
  const na = m.noradrenaline;
  const ht = m.serotonin;
  const ado = m.adenosine;
  // acetylcholine suppresses recurrent excitation (desynchronises) and adaptation
  const c1 = 16 * r.excitability * (1.1 - 0.1 * ach);
  // inhibition onto E is the seizure brake; dopamine sharpens it slightly
  const c2 = 12 * r.inhibition * (0.95 + 0.05 * da);
  const c3 = 15;
  const c4 = 3;
  // dopamine raises gain (steeper sigmoid)
  const ae = 1.3 * (0.85 + 0.15 * da);
  // drive: arousal and noradrenaline lift it, adenosine drops it
  const P = 1.25 * r.excitability * (0.6 + 0.4 * r.arousal) * (0.9 + 0.1 * na) * (1.1 - 0.1 * ado);
  const Q = 0;
  // coupling: serotonin (psychedelic direction) loosens the hierarchy
  const G = G_BASE * r.coupling * (1.15 - 0.15 * ht);
  // noise: noradrenaline and serotonin add it, dopamine trims it
  const sigma = 0.45 * r.noise * (0.9 + 0.1 * na) * (0.85 + 0.15 * ht) * (1.1 - 0.1 * da);
  // adaptation: adenosine (sleep pressure) and low arousal deepen it, acetylcholine lifts it
  const k_adapt = K_ADAPT_BASE * r.adaptation * (0.7 + 0.3 * ado) * (1.2 - 0.2 * ach) * (1.3 - 0.3 * Math.min(r.arousal, 1));
  const tau_adapt = TAU_ADAPT;
  const d: DerivedParams = { c1, c2, c3, c4, ae, te: TE, ai: 2, ti: TI, P, Q, G, sigma, k_adapt, tau_adapt, ...r.overrides };
  for (const [k, f] of Object.entries(r.scale) as Array<[keyof DerivedParams, number]>) {
    if (typeof f === 'number' && Number.isFinite(f)) d[k] = d[k] * f;
  }
  return d;
}

// the tuned constants behind the knobs (see the sweep notes in README)
const G_BASE = 2.5;
const K_ADAPT_BASE = 2.6;
const TAU_ADAPT = 300;
const TE = 8;
const TI = 9;
const THETA_E = 4;
const THETA_I = 3.7;

function sigmoid(x: number, a: number, theta: number): number {
  return 1 / (1 + Math.exp(-a * (x - theta))) - 1 / (1 + Math.exp(a * theta));
}

export function simulateWholeBrain(input: WholeBrainParams): WholeBrainRun {
  const params = resolveParams(input);
  const d = derive(params);
  const C = connectome();
  const rng = mulberry32(params.seed);

  const warmSteps = Math.round(WARMUP_MS / DT);
  const steps = Math.round(params.duration_ms / DT) + warmSteps;
  const sampleEvery = Math.round(SAMPLE_MS / DT);
  const frames = Math.floor((steps - warmSteps) / sampleEvery);
  const activity = new Float32Array(frames * N);

  // per-node drive with a little deterministic heterogeneity, and the surviving
  // tissue fraction per node (1 = intact, 0 = destroyed)
  const drive = new Float64Array(N);
  const alive = new Float64Array(N).fill(1);
  for (let i = 0; i < N; i++) {
    const r = REGIONS[i]!;
    let het = 1 + 0.08 * (rng.normal() * 0.5);
    if (r.lobe === 'subcortical' || r.lobe === 'brainstem') het *= 1.05;
    drive[i] = d.P * het;
  }
  for (const l of params.lesions) for (const i of l.nodes) alive[i] = Math.min(alive[i]!, 1 - l.severity);
  // the state's regional signature: engaged regions get more drive, disengaged less
  for (const rd of params.regional_drive) for (const i of rd.nodes) drive[i] = drive[i]! * rd.factor;

  // delays in steps, clamped to the ring buffer
  const delaySteps = new Int32Array(N * N);
  for (let k = 0; k < N * N; k++) delaySteps[k] = Math.min(MAX_DELAY_STEPS - 1, Math.round(C.delays[k]! / DT));

  // sparse input lists per node: [j, w]
  const inputs: Array<Array<[number, number, number]>> = [];
  for (let i = 0; i < N; i++) {
    const list: Array<[number, number, number]> = [];
    for (let j = 0; j < N; j++) {
      const w = C.weights[i * N + j]!;
      if (w > 0) list.push([j, w, delaySteps[i * N + j]!]);
    }
    inputs.push(list);
  }

  const E = new Float64Array(N);
  const I = new Float64Array(N);
  const A = new Float64Array(N);
  const hist = new Float64Array(MAX_DELAY_STEPS * N); // ring buffer of E
  for (let i = 0; i < N; i++) {
    // scaled by the surviving tissue, like every later step: a region lesioned at
    // severity 1 starts at zero, stays at zero, and needs no special case
    E[i] = (0.1 + 0.05 * rng.next()) * alive[i]!;
    I[i] = (0.05 + 0.05 * rng.next()) * alive[i]!;
  }
  for (let s = 0; s < MAX_DELAY_STEPS; s++) for (let i = 0; i < N; i++) hist[s * N + i] = E[i]!;

  const stim = new Float64Array(N);
  const dtE = DT / d.te;
  const dtI = DT / d.ti;
  const dtA = DT / d.tau_adapt;

  for (let step = 0; step < steps; step++) {
    const t = (step - warmSteps) * DT; // run time; negative during the warm-up
    const slot = step % MAX_DELAY_STEPS;

    // stimulation this step
    stim.fill(0);
    for (const s of params.stimulation) {
      if (t < s.onset_ms || t >= s.onset_ms + s.duration_ms) continue;
      const phase = (t - s.onset_ms) / 1000 * s.frequency_hz * 2 * Math.PI;
      let v: number;
      if (s.frequency_hz <= 0 || s.waveform === 'dc') v = 1;
      else if (s.waveform === 'pulse') v = Math.sin(phase) > 0.8 ? 1 : 0;
      else v = 0.5 + 0.5 * Math.sin(phase);
      for (const i of s.nodes) stim[i] += s.amplitude * v;
    }

    for (let i = 0; i < N; i++) {
      // delayed network input
      let net = 0;
      for (const [j, w, dl] of inputs[i]!) {
        const from = (slot - dl + MAX_DELAY_STEPS) % MAX_DELAY_STEPS;
        net += w * hist[from * N + j]!;
      }
      const e = E[i]!;
      const inh = I[i]!;
      const xe = d.c1 * e - d.c2 * inh - d.k_adapt * A[i]! + drive[i]! + d.G * net + stim[i]! + d.sigma * rng.normal();
      const xi = d.c3 * e - d.c4 * inh + d.Q + 0.5 * d.sigma * rng.normal();
      // a lesion removes tissue: the surviving fraction `alive` scales the rate the
      // region can reach, not how fast it gets there. E settles at `alive` times the
      // rate its inputs justify, so the region excites itself and the network that
      // much less (`hist` carries E, so the connectome sees the loss too) and falls
      // monotonically to silence. Scaling the derivative instead only slows a region
      // toward the same fixed point, which leaves a damaged region as busy as before.
      const eNext = e + dtE * (-e + alive[i]! * sigmoid(xe, d.ae, THETA_E));
      const iNext = inh + dtI * (-inh + alive[i]! * sigmoid(xi, d.ai, THETA_I));
      A[i] = A[i]! + dtA * (-A[i]! + e);
      E[i] = clamp(eNext, 0, 1);
      I[i] = clamp(iNext, 0, 1);
    }

    const nextSlot = (step + 1) % MAX_DELAY_STEPS;
    for (let i = 0; i < N; i++) hist[nextSlot * N + i] = E[i]!;

    if (step >= warmSteps && (step - warmSteps) % sampleEvery === 0) {
      const f = (step - warmSteps) / sampleEvery;
      if (f < frames) for (let i = 0; i < N; i++) activity[f * N + i] = E[i]!;
    }
  }

  return { kind: 'whole-brain', params, dt_ms: SAMPLE_MS, frames, activity, derived: d };
}
