/**
 * engine/connectome.ts — the wiring between regions.
 *
 * SYNTHETIC, and said so everywhere it is described. There is no measured
 * tractography here. Weights follow the exponential distance rule that real
 * cortical connectomes approximately obey (weight falls off as exp(−d/λ)),
 * boosted within a lobe, with the handful of long-range systems that matter
 * most for what the page shows added by hand: homotopic (mirror) links,
 * thalamocortical loops, the hippocampal formation, the amygdala's limbic
 * partners, fronto-striatal loops, and the brainstem–thalamus–cerebellum
 * axis. Rows are normalised to sum to one so the global coupling knob is
 * the only gain.
 *
 * Conduction delays are distance / velocity, so activity visibly travels.
 */

import { REGIONS, N, distance, REGION_INDEX } from './atlas.ts';
import type { Region } from './atlas.ts';

export interface Connectome {
  /** N×N row-major weights; row i lists inputs TO node i */
  weights: Float64Array;
  /** N×N conduction delays in milliseconds */
  delays: Float64Array;
  /** edges for drawing: undirected, strongest first, deduplicated */
  edges: Array<{ a: number; b: number; w: number }>;
}

const LAMBDA_MM = 32;
const VELOCITY_MM_PER_MS = 6; // ~6 m/s myelinated cortico-cortical
const KEEP_PER_ROW = 14;
const MIN_WEIGHT = 0.03;

function idx(id: string): number {
  const i = REGION_INDEX.get(id);
  if (i === undefined) throw new Error(`connectome: unknown region ${id}`);
  return i;
}

function link(w: Float64Array, a: string, b: string, add: number): void {
  const i = idx(a);
  const j = idx(b);
  w[i * N + j] += add;
  w[j * N + i] += add;
}

let cached: Connectome | null = null;

export function connectome(): Connectome {
  if (cached) return cached;
  const w = new Float64Array(N * N);
  const d = new Float64Array(N * N);

  for (let i = 0; i < N; i++) {
    const ri = REGIONS[i]!;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const rj = REGIONS[j]!;
      const dist = distance(ri, rj);
      d[i * N + j] = dist / VELOCITY_MM_PER_MS;
      let weight = Math.exp(-dist / LAMBDA_MM);
      if (ri.lobe === rj.lobe && ri.hemi === rj.hemi) weight *= 1.6;
      // cross-hemisphere links other than homotopic ones are weak in reality
      if (ri.hemi !== rj.hemi && ri.hemi !== 'M' && rj.hemi !== 'M') weight *= 0.35;
      w[i * N + j] = weight;
    }
  }

  // homotopic: the same parcel in the other hemisphere, via the callosum
  for (const r of REGIONS) {
    if (r.hemi !== 'L') continue;
    link(w, r.id, `R_${r.name}`, r.cortical ? 0.35 : 0.15);
  }

  const cortical = (r: Region) => r.cortical;
  for (const hemi of ['L', 'R'] as const) {
    const h = (name: string) => `${hemi}_${name}`;
    // thalamocortical loops: the thalamus is the hub every cortical parcel talks to
    for (const r of REGIONS) if (cortical(r) && r.hemi === hemi) link(w, h('thalamus'), r.id, 0.12);
    // hippocampal formation
    link(w, h('hippocampus'), h('entorhinal'), 0.6);
    link(w, h('hippocampus'), h('parahippocampal'), 0.45);
    link(w, h('entorhinal'), h('parahippocampal'), 0.4);
    link(w, h('hippocampus'), h('isthmuscingulate'), 0.2);
    link(w, h('hippocampus'), h('precuneus'), 0.12);
    // amygdala and its limbic partners
    for (const p of ['lateralorbitofrontal', 'medialorbitofrontal', 'temporalpole', 'hippocampus', 'insula', 'rostralanteriorcingulate', 'entorhinal']) {
      link(w, h('amygdala'), h(p), 0.3);
    }
    // fronto-striatal loops
    for (const s of ['caudate', 'putamen', 'accumbens']) {
      for (const f of ['superiorfrontal', 'rostralmiddlefrontal', 'caudalmiddlefrontal', 'precentral', 'medialorbitofrontal', 'rostralanteriorcingulate']) {
        link(w, h(s), h(f), 0.15);
      }
      link(w, h(s), h('pallidum'), 0.35);
    }
    link(w, h('pallidum'), h('thalamus'), 0.4);
    link(w, h('accumbens'), h('amygdala'), 0.2);
    // the ascending axis
    link(w, 'brainstem', h('thalamus'), 0.4);
    link(w, 'brainstem', h('cerebellum'), 0.3);
    // cerebellum talks to the CONTRALATERAL thalamus and motor cortex
    const other = hemi === 'L' ? 'R' : 'L';
    link(w, h('cerebellum'), `${other}_thalamus`, 0.3);
    link(w, h('cerebellum'), `${other}_precentral`, 0.1);
    // dorsal attention / language / visual streams, lightly
    link(w, h('parsopercularis'), h('bankssts'), 0.15);
    link(w, h('superiorparietal'), h('caudalmiddlefrontal'), 0.15);
    link(w, h('pericalcarine'), h('lateraloccipital'), 0.2);
    link(w, h('lateraloccipital'), h('fusiform'), 0.15);
  }

  // sparsify: keep the strongest inputs per row, then row-normalise
  for (let i = 0; i < N; i++) {
    const row = Array.from({ length: N }, (_, j) => j).filter((j) => j !== i && w[i * N + j]! > MIN_WEIGHT);
    row.sort((a, b) => w[i * N + b]! - w[i * N + a]!);
    const keep = new Set(row.slice(0, KEEP_PER_ROW));
    let sum = 0;
    for (let j = 0; j < N; j++) {
      if (!keep.has(j)) w[i * N + j] = 0;
      sum += w[i * N + j]!;
    }
    if (sum > 0) for (let j = 0; j < N; j++) w[i * N + j]! /= sum;
  }

  const edges: Array<{ a: number; b: number; w: number }> = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const ww = Math.max(w[i * N + j]!, w[j * N + i]!);
      if (ww > 0) edges.push({ a: i, b: j, w: Number(ww.toFixed(4)) });
    }
  }
  edges.sort((p, q) => q.w - p.w);

  cached = { weights: w, delays: d, edges };
  return cached;
}
