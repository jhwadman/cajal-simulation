/**
 * engine/microcircuit.ts — the neuron-level model.
 *
 * A random network of Izhikevich (2003) spiking neurons: regular-spiking
 * excitatory cells and fast-spiking inhibitory cells in the cortical 4:1
 * ratio, sparse random synapses, and independent noisy "thalamic" input. It
 * is the classic pulse-coupled network that shows asynchronous firing,
 * gamma-band population rhythms and, when inhibition is weakened, runaway
 * synchronous bursting — the microscopic counterpart of what the
 * whole-brain model shows region by region.
 *
 * Output is the spike raster and a binned population rate, which the page
 * draws directly.
 */

import { mulberry32, seedFrom } from './random.ts';

export interface MicrocircuitParams {
  /** total neurons, 100–1500 (80% excitatory) */
  neurons?: number;
  duration_ms?: number;
  /** scales excitatory synaptic weights and thalamic drive (1 = Izhikevich's defaults) */
  excitability?: number;
  /** scales inhibitory synaptic weights */
  inhibition?: number;
  /** scales the noisy thalamic input */
  noise?: number;
  /** synapses per neuron as a fraction of the population (Izhikevich: 1.0 = all-to-all) */
  connectivity?: number;
  /** a constant extra current into every excitatory cell, pA-ish model units */
  drive?: number;
  seed?: number | string;
}

export interface ResolvedMicroParams {
  neurons: number;
  excitatory: number;
  duration_ms: number;
  excitability: number;
  inhibition: number;
  noise: number;
  connectivity: number;
  drive: number;
  seed: number;
}

export interface MicrocircuitRun {
  kind: 'microcircuit';
  params: ResolvedMicroParams;
  /** spike times in ms, parallel to `spikeIds` */
  spikeTimes: Float32Array;
  spikeIds: Int16Array;
  /** population spike count per 1 ms bin */
  rate: Float32Array;
  /** per-neuron spike counts */
  counts: Int32Array;
}

const DT = 0.5;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function resolveMicroParams(p: MicrocircuitParams): ResolvedMicroParams {
  const neurons = Math.round(clamp(p.neurons ?? 600, 100, 1500));
  const excitatory = Math.round(neurons * 0.8);
  const seed = typeof p.seed === 'string' ? seedFrom(p.seed) : (p.seed ?? 11) >>> 0;
  return {
    neurons,
    excitatory,
    duration_ms: Math.round(clamp(p.duration_ms ?? 1000, 200, 3000)),
    excitability: clamp(p.excitability ?? 1, 0, 3),
    inhibition: clamp(p.inhibition ?? 1, 0, 3),
    noise: clamp(p.noise ?? 1, 0, 3),
    connectivity: clamp(p.connectivity ?? 0.15, 0.02, 1),
    drive: clamp(p.drive ?? 0, -10, 20),
    seed,
  };
}

export function simulateMicrocircuit(input: MicrocircuitParams): MicrocircuitRun {
  const params = resolveMicroParams(input);
  const { neurons: Nn, excitatory: Ne } = params;
  const rng = mulberry32(params.seed);

  // Izhikevich 2003 parameter draws
  const a = new Float64Array(Nn);
  const b = new Float64Array(Nn);
  const c = new Float64Array(Nn);
  const dd = new Float64Array(Nn);
  for (let i = 0; i < Nn; i++) {
    const r = rng.next();
    if (i < Ne) {
      a[i] = 0.02; b[i] = 0.2; c[i] = -65 + 15 * r * r; dd[i] = 8 - 6 * r * r;
    } else {
      a[i] = 0.02 + 0.08 * r; b[i] = 0.25 - 0.05 * r; c[i] = -65; dd[i] = 2;
    }
  }

  // sparse synapses: each presynaptic neuron projects to K random targets.
  // Weights are Izhikevich's (0.5·rand for E, −rand for I at 1000 neurons,
  // all-to-all), rescaled so the total input per neuron matches his network.
  const K = Math.max(1, Math.round(params.connectivity * Nn));
  // Each postsynaptic cell receives K synapses on average; Izhikevich's cells
  // received 1000. Weights are scaled so the SUMMED input per spike volley
  // matches his network at the reference gain, then tuned (SYN_GAIN) so the
  // baseline sits in the asynchronous-irregular regime rather than at the
  // synchronous edge sparse random weights push it towards.
  const SYN_GAIN = 0.35;
  const wE = 0.5 * params.excitability * (1000 / K) * SYN_GAIN;
  const wI = -1.0 * params.inhibition * (1000 / K) * SYN_GAIN;
  const targets = new Int32Array(Nn * K);
  const weights = new Float64Array(Nn * K);
  for (let i = 0; i < Nn; i++) {
    for (let k = 0; k < K; k++) {
      targets[i * K + k] = Math.floor(rng.next() * Nn);
      weights[i * K + k] = (i < Ne ? wE : wI) * rng.next();
    }
  }

  const v = new Float64Array(Nn).fill(-65);
  const u = new Float64Array(Nn);
  for (let i = 0; i < Nn; i++) u[i] = b[i]! * v[i]!;
  const Iin = new Float64Array(Nn);

  const steps = Math.round(params.duration_ms / DT);
  const times: number[] = [];
  const ids: number[] = [];
  const rate = new Float32Array(params.duration_ms);
  const counts = new Int32Array(Nn);
  const fired: number[] = [];

  const noiseE = 5 * params.noise * params.excitability;
  const noiseI = 2 * params.noise;

  for (let step = 0; step < steps; step++) {
    const t = step * DT;
    // thalamic input, fresh each millisecond like the reference, held for the half-step
    if (step % 2 === 0) {
      for (let i = 0; i < Nn; i++) Iin[i] = (i < Ne ? noiseE * rng.normal() + params.drive : noiseI * rng.normal());
      // synaptic input from last millisecond's spikes
      for (const j of fired) {
        for (let k = 0; k < K; k++) Iin[targets[j * K + k]!] += weights[j * K + k]!;
      }
      fired.length = 0;
    }
    for (let i = 0; i < Nn; i++) {
      const vi = v[i]!;
      const ui = u[i]!;
      const dv = 0.04 * vi * vi + 5 * vi + 140 - ui + Iin[i]!;
      let vn = vi + DT * dv;
      const un = ui + DT * a[i]! * (b[i]! * vi - ui);
      if (vn >= 30) {
        times.push(t);
        ids.push(i);
        counts[i]!++;
        fired.push(i);
        const bin = Math.min(rate.length - 1, Math.floor(t));
        rate[bin]!++;
        vn = c[i]!;
        u[i] = un + dd[i]!;
      } else {
        u[i] = un;
      }
      v[i] = vn;
    }
  }

  return {
    kind: 'microcircuit',
    params,
    spikeTimes: Float32Array.from(times),
    spikeIds: Int16Array.from(ids),
    rate,
    counts,
  };
}
