/**
 * service/engine/sweep.ts — the discovery instrument.
 *
 * A single run is a point. Science is about the CURVE: what happens to the
 * system as one thing is varied and everything else is held still. This
 * module runs the model across a range of one parameter and reports the
 * shape of the response — in particular whether the change is gradual or
 * whether the system TIPS, and where.
 *
 * Two honesties are built in:
 *   ONE VARIABLE. Every point uses the same seed and the same duration, so a
 *   difference between points is the parameter and not the noise.
 *   SHARPNESS IS MEASURED, NOT ASSERTED. A linear system spreads its total
 *   change evenly over the sweep. `sharpness` is the biggest single step
 *   divided by that even share, so 1 means "a straight line" and 5 means
 *   "five times the average change happened in one step". That number, not a
 *   picture, is the evidence for a tipping point.
 *
 * Pure TypeScript, no dependencies, like the rest of the engine: the agent's
 * tool and the page both run it, so a sweep is the same numbers either way.
 */

import { simulateWholeBrain } from './wholeBrain.ts';
import { summarizeWholeBrain } from './analysis.ts';
import { applyTreatment, treatmentById } from './medications.ts';
import { simulateNeuron, DEFAULT_IONS, DEFAULT_PERM } from './neuron.ts';
import type { WholeBrainParams, WholeBrainRun } from './wholeBrain.ts';
import type { WholeBrainSummary } from './analysis.ts';
import type { Ions, Permeability, NeuronParams } from './neuron.ts';

/* ── what can be varied ──────────────────────────────────────────────────── */

export const SWEEP_KNOBS = ['excitability', 'inhibition', 'coupling', 'noise', 'adaptation', 'arousal'] as const;
export type SweepKnob = (typeof SWEEP_KNOBS)[number];
export type BrainVariable = SweepKnob | 'dose';
export const BRAIN_MEASURES = ['synchrony', 'mean', 'amplitude', 'peakHz'] as const;
export type BrainMeasure = (typeof BRAIN_MEASURES)[number];

/** sensible defaults: wide enough to cross the interesting ground, short enough to stay fast */
export const DEFAULT_RANGE: Record<BrainVariable, [number, number]> = {
  excitability: [0.6, 1.8],
  inhibition: [0.4, 1.4],
  coupling: [0.4, 2.2],
  noise: [0, 2],
  adaptation: [0.4, 3],
  arousal: [0, 1.5],
  dose: [0, 1.5],
};

/* ── the shape of a response ─────────────────────────────────────────────── */

export interface Transition {
  /** the parameter value the biggest single step straddles */
  at: number;
  /** the measure either side of that step */
  before: number;
  after: number;
  /** how big that step was */
  jump: number;
  /** the biggest step over the average step: 1 = a straight line, >3 = a tipping point */
  sharpness: number;
  /** where the measure crosses half of its total range, interpolated: a threshold estimate */
  half: number | null;
}

export interface BrainSweepPoint {
  value: number;
  mean: number;
  amplitude: number;
  synchrony: number;
  peakHz: number;
  dominantBand: string;
}

export interface BrainSweep {
  kind: 'brain';
  /** the parameter varied */
  variable: BrainVariable;
  treatment?: string;
  measure: BrainMeasure;
  from: number;
  to: number;
  steps: number;
  seed: number;
  duration_ms: number;
  points: BrainSweepPoint[];
  transition: Transition | null;
  /** does the measure only ever move one way across the sweep? */
  monotone: boolean;
  range: [number, number];
  base: WholeBrainParams;
  computeMs: number;
}

export interface BrainSweepSpec {
  base?: WholeBrainParams;
  variable: BrainVariable;
  /** the drug whose dose is swept; required when variable is 'dose' */
  treatment?: string;
  from?: number;
  to?: number;
  steps?: number;
  measure?: BrainMeasure;
  duration_ms?: number;
  seed?: number;
}

/**
 * The biggest single step in `m`, measured against the step an even, linear
 * response would have taken. Returns null when nothing moves.
 */
export function findTransition(values: number[], m: number[]): Transition | null {
  const n = m.length;
  if (n < 3 || values.length !== n) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of m) {
    if (!Number.isFinite(v)) return null;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const total = hi - lo;
  if (total <= 1e-9) return null;
  const even = total / (n - 1);
  let bi = 0;
  let best = -1;
  for (let i = 0; i < n - 1; i++) {
    const d = Math.abs(m[i + 1]! - m[i]!);
    if (d > best) { best = d; bi = i; }
  }
  // where the measure passes the middle of its own range, interpolated
  const mid = lo + total / 2;
  let half: number | null = null;
  for (let i = 0; i < n - 1; i++) {
    const a = m[i]!;
    const b = m[i + 1]!;
    if ((a - mid) * (b - mid) <= 0 && a !== b) {
      const f = (mid - a) / (b - a);
      half = values[i]! + f * (values[i + 1]! - values[i]!);
      break;
    }
  }
  return {
    at: (values[bi]! + values[bi + 1]!) / 2,
    before: m[bi]!,
    after: m[bi + 1]!,
    jump: m[bi + 1]! - m[bi]!,
    sharpness: even > 0 ? best / even : 1,
    half,
  };
}

function isMonotone(m: number[], tol: number): boolean {
  let up = 0;
  let down = 0;
  for (let i = 0; i < m.length - 1; i++) {
    const d = m[i + 1]! - m[i]!;
    if (d > tol) up++;
    else if (d < -tol) down++;
  }
  return up === 0 || down === 0;
}

const measureOf = (p: BrainSweepPoint, k: BrainMeasure): number => p[k];

/* ── the whole-brain sweep ───────────────────────────────────────────────── */

/** one computed point, handed out as the sweep runs */
export interface SweepStep {
  index: number;
  total: number;
  point: BrainSweepPoint;
  run: WholeBrainRun;
  summary: WholeBrainSummary;
}

/**
 * The sweep, one point at a time.
 *
 * A generator because the two callers need different things from the same
 * loop: the service drains it in one go, while the page wants to draw each
 * point and hand the browser a frame before computing the next. Writing the
 * loop twice would let the two drift apart, and a sweep has to be the same
 * numbers wherever it runs.
 */
export function* sweepBrainSteps(spec: BrainSweepSpec): Generator<SweepStep, BrainSweep, void> {
  const variable = spec.variable;
  const [d0, d1] = DEFAULT_RANGE[variable] ?? [0, 2];
  const from = spec.from ?? d0;
  const to = spec.to ?? d1;
  const steps = Math.max(3, Math.min(24, Math.round(spec.steps ?? 11)));
  const measure: BrainMeasure = spec.measure ?? 'synchrony';
  // the same seed and the same duration at every point: the only thing that
  // differs between two points is the parameter
  const seed = spec.seed ?? 1;
  const duration_ms = spec.duration_ms ?? 2000;
  const base: WholeBrainParams = { ...(spec.base ?? {}), duration_ms, seed };
  // the model's own time only. The page hands the browser a frame between
  // points, and wall-clock here would report its drawing as simulation cost.
  let computeMs = 0;

  const points: BrainSweepPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const value = steps === 1 ? from : from + ((to - from) * i) / (steps - 1);
    let params: WholeBrainParams;
    if (variable === 'dose') {
      const t = spec.treatment ? treatmentById(spec.treatment) : undefined;
      params = t ? applyTreatment(base, t.id, value) : base;
    } else {
      params = { ...base, [variable]: value };
    }
    const c0 = Date.now();
    const run = simulateWholeBrain(params);
    const summary = summarizeWholeBrain(run);
    computeMs += Date.now() - c0;
    const g = summary.global;
    const point: BrainSweepPoint = {
      value: +value.toFixed(4),
      mean: +g.mean.toFixed(4),
      amplitude: +g.amplitude.toFixed(4),
      synchrony: +g.synchrony.toFixed(4),
      peakHz: +g.peakHz.toFixed(2),
      dominantBand: g.dominantBand,
    };
    points.push(point);
    yield { index: i, total: steps, point, run, summary };
  }
  const series = points.map((p) => measureOf(p, measure));
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  return {
    kind: 'brain',
    variable,
    treatment: spec.treatment,
    measure,
    from,
    to,
    steps,
    seed,
    duration_ms,
    points,
    transition: findTransition(points.map((p) => p.value), series),
    monotone: isMonotone(series, (hi - lo) * 0.02),
    range: [lo, hi],
    base: spec.base ?? {},
    computeMs,
  };
}

/** the whole sweep at once: drains the generator */
export function sweepBrain(spec: BrainSweepSpec): BrainSweep {
  const g = sweepBrainSteps(spec);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/* ── the single-neuron sweep ─────────────────────────────────────────────── */

export const NEURON_FIELDS = ['K_out', 'K_in', 'Na_out', 'Na_in', 'Cl_out', 'Cl_in', 'P_K', 'P_Na', 'P_Cl', 'temperature_c', 'current_ua'] as const;
export type NeuronField = (typeof NEURON_FIELDS)[number];
export const NEURON_MEASURES = ['rate_hz', 'rest_mv', 'ghk', 'spikes', 'peak_mv'] as const;
export type NeuronMeasure = (typeof NEURON_MEASURES)[number];

export const NEURON_RANGE: Record<NeuronField, [number, number]> = {
  K_out: [2, 30],
  K_in: [60, 180],
  Na_out: [80, 180],
  Na_in: [4, 40],
  Cl_out: [60, 160],
  Cl_in: [2, 60],
  P_K: [0.2, 4],
  P_Na: [0.005, 1],
  P_Cl: [0, 3],
  temperature_c: [5, 44],
  current_ua: [0, 60],
};

export interface NeuronSweepPoint {
  value: number;
  ghk: number;
  rest_mv: number;
  spikes: number;
  rate_hz: number;
  peak_mv: number | null;
  width_ms: number | null;
  threshold_mv: number | null;
}

export interface NeuronSweep {
  kind: 'neuron';
  field: NeuronField;
  measure: NeuronMeasure;
  from: number;
  to: number;
  steps: number;
  points: NeuronSweepPoint[];
  transition: Transition | null;
  monotone: boolean;
  range: [number, number];
  base: NeuronParams;
  computeMs: number;
}

export interface NeuronSweepSpec {
  base?: NeuronParams;
  field: NeuronField;
  from?: number;
  to?: number;
  steps?: number;
  measure?: NeuronMeasure;
}

export function sweepNeuron(spec: NeuronSweepSpec): NeuronSweep {
  const field = spec.field;
  const [d0, d1] = NEURON_RANGE[field] ?? [0, 1];
  const from = spec.from ?? d0;
  const to = spec.to ?? d1;
  const steps = Math.max(3, Math.min(40, Math.round(spec.steps ?? 15)));
  const measure: NeuronMeasure = spec.measure ?? 'rate_hz';
  const base: NeuronParams = spec.base ?? {};
  const baseIons: Ions = { ...DEFAULT_IONS, ...(base.ions ?? {}) };
  const basePerm: Permeability = { ...DEFAULT_PERM, ...(base.perm ?? {}) };
  const t0 = Date.now();

  const points: NeuronSweepPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const value = steps === 1 ? from : from + ((to - from) * i) / (steps - 1);
    const p: NeuronParams = { ...base, ions: { ...baseIons }, perm: { ...basePerm } };
    if (field === 'temperature_c') p.temperature_c = value;
    else if (field === 'current_ua') p.current_ua = value;
    else if (field.startsWith('P_')) p.perm![field.slice(2) as keyof Permeability] = value;
    else p.ions![field as keyof Ions] = value;
    const r = simulateNeuron(p);
    points.push({
      value: +value.toFixed(4),
      ghk: +r.ghk.toFixed(2),
      rest_mv: +r.rest_mv.toFixed(2),
      spikes: r.spikes.length,
      rate_hz: +r.rate_hz.toFixed(1),
      peak_mv: r.peak_mv === null || r.peak_mv === undefined ? null : +r.peak_mv.toFixed(1),
      width_ms: r.width_ms === null || r.width_ms === undefined ? null : +r.width_ms.toFixed(2),
      threshold_mv: r.threshold_mv === null || r.threshold_mv === undefined ? null : +r.threshold_mv.toFixed(1),
    });
  }
  const series = points.map((p) => Number(p[measure] ?? 0));
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  return {
    kind: 'neuron',
    field,
    measure,
    from,
    to,
    steps,
    points,
    transition: findTransition(points.map((p) => p.value), series),
    monotone: isMonotone(series, (hi - lo) * 0.02),
    range: [lo, hi],
    base,
    computeMs: Date.now() - t0,
  };
}

/* ── reading a sweep out loud ────────────────────────────────────────────── */

const f2 = (x: number) => x.toFixed(2);

/** a small ASCII profile, so the shape survives into a text answer */
function profile(series: number[]): string {
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const chars = ' ▁▂▃▄▅▆▇█';
  if (hi - lo <= 1e-9) return chars[4]!.repeat(series.length);
  return series.map((v) => chars[Math.max(0, Math.min(8, Math.round(((v - lo) / (hi - lo)) * 8)))]!).join('');
}

export function printBrainSweep(runId: string, s: BrainSweep): string {
  const lines: string[] = [];
  const what = s.variable === 'dose' ? `the dose of ${s.treatment}` : s.variable;
  lines.push(`RUN_ID: ${runId}`);
  lines.push(`SWEEP · ${what} from ${s.from} to ${s.to} in ${s.steps} steps, everything else held still (seed ${s.seed}, ${s.duration_ms} ms per point, ${(s.computeMs / 1000).toFixed(1)} s of compute).`);
  lines.push('');
  lines.push(`${s.variable.padEnd(12)} mean   amp    sync   rhythm`);
  for (const p of s.points) {
    lines.push(`${String(p.value).padEnd(12)} ${f2(p.mean)}   ${f2(p.amplitude)}   ${f2(p.synchrony)}   ${p.peakHz.toFixed(1)} Hz ${p.dominantBand}`);
  }
  lines.push('');
  const series = s.points.map((p) => measureOf(p, s.measure));
  lines.push(`${s.measure} across the sweep: ${profile(series)}  (${f2(s.range[0])} → ${f2(s.range[1])})`);
  if (s.transition) {
    const t = s.transition;
    lines.push(
      `TRANSITION in ${s.measure}: the biggest single step is at ${what} ≈ ${f2(t.at)}, where it goes ${f2(t.before)} → ${f2(t.after)} (${t.jump > 0 ? '+' : ''}${f2(t.jump)}).`,
    );
    lines.push(
      `SHARPNESS ${t.sharpness.toFixed(1)}× — a straight line would score 1, so ${t.sharpness >= 3 ? 'this is a tipping point, not a gradual slope: most of the change happens in one step' : t.sharpness >= 1.8 ? 'the response is clearly steeper in one place than elsewhere' : 'the response is close to gradual'}.` +
        (t.half !== null ? ` The halfway crossing is at ${f2(t.half)}.` : ''),
    );
  } else {
    lines.push(`NO TRANSITION: ${s.measure} barely moves across this range, so this parameter does not control it here.`);
  }
  lines.push(`MONOTONE: ${s.monotone ? 'yes — the measure only ever moves one way' : 'NO — the measure reverses direction inside the sweep, so a single number cannot describe the effect'}.`);
  lines.push('');
  const step = s.steps > 1 ? (s.to - s.from) / (s.steps - 1) : 0;
  lines.push(`RESOLUTION: the sweep sampled every ${step.toFixed(3)}, so the transition is located to within one step of that grid. A finer sweep over a narrower range moves the reported value; it does not move the shape. Say "between ${(((s.transition?.at ?? 0) - step / 2)).toFixed(2)} and ${(((s.transition?.at ?? 0) + step / 2)).toFixed(2)}" rather than quoting a single number as if it were measured.`);
  lines.push('Each point is a full simulation of the 85-region model, not an interpolation. The connectome is synthetic, so the VALUE at which the system tips is a property of this model, not a measured constant of any brain; the SHAPE of the response is the finding.');
  return lines.join('\n');
}

export function printNeuronSweep(runId: string, s: NeuronSweep): string {
  const lines: string[] = [];
  lines.push(`RUN_ID: ${runId}`);
  lines.push(`SWEEP · ${s.field} from ${s.from} to ${s.to} in ${s.steps} steps (${(s.computeMs / 1000).toFixed(1)} s of compute).`);
  lines.push('');
  lines.push(`${s.field.padEnd(10)} GHK     rest    spikes  rate    peak`);
  for (const p of s.points) {
    lines.push(`${String(p.value).padEnd(10)} ${f2(p.ghk).padEnd(7)} ${f2(p.rest_mv).padEnd(7)} ${String(p.spikes).padEnd(7)} ${p.rate_hz.toFixed(0).padEnd(7)} ${p.peak_mv === null ? '—' : f2(p.peak_mv)}`);
  }
  lines.push('');
  const series = s.points.map((p) => Number(p[s.measure] ?? 0));
  lines.push(`${s.measure} across the sweep: ${profile(series)}  (${f2(s.range[0])} → ${f2(s.range[1])})`);
  if (s.transition) {
    const t = s.transition;
    lines.push(`TRANSITION in ${s.measure}: biggest step at ${s.field} ≈ ${f2(t.at)}, ${f2(t.before)} → ${f2(t.after)}. SHARPNESS ${t.sharpness.toFixed(1)}× (1 = a straight line).`);
  }
  lines.push(`MONOTONE: ${s.monotone ? 'yes' : 'NO — the measure reverses inside the sweep: the same change helps and then hurts'}.`);
  const nstep = s.steps > 1 ? (s.to - s.from) / (s.steps - 1) : 0;
  lines.push(`RESOLUTION: sampled every ${nstep.toFixed(3)}, so any transition is located to within one step of that grid.`);
  return lines.join('\n');
}
