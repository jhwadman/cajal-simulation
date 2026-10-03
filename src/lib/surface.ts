/**
 * src/lib/surface.ts — the brain mesh the view renders, loaded from real
 * anatomy: public/brain/mesh.bin, baked by models/scripts/build_brain_mesh.py
 * from the FreeSurfer fsaverage6 pial surface (real gyri at 40,962 vertices
 * a hemisphere, measured sulcal depth) and the MNI152 brain mask
 * (cerebellum, brainstem). Same origin, ~3.2 MB (1.6 MB compressed), fetched
 * once.
 *
 * Each vertex carries a position, a smoothed normal, an occlusion value and
 * a part tag; the region weights (which atlas regions colour the vertex) are
 * computed here from the atlas, so the asset stays free of any parcellation.
 */

import type { RegionLite } from './render.ts';

export interface BrainMesh {
  nv: number;
  nf: number;
  pos: Float32Array; // xyz, mm
  nrm: Float32Array; // xyz, unit
  occ: Float32Array; // 0 sulcus … 1 gyrus crown
  gain: Float32Array; // excitation gain per vertex
  part: Uint8Array; // 0 cortex L, 1 cortex R, 2 cerebellum L, 3 cerebellum R, 4 brainstem
  faces: Uint32Array; // 3 per triangle
  ridx: Float32Array; // 3 region indices per vertex (as floats, for the GPU)
  rw: Float32Array; // 3 weights per vertex
  lobe: Float32Array; // lobe index of the nearest region (LOBE_ORDER), for hover highlighting
}

/** the same order as the engine's LOBES */
export const LOBE_ORDER = ['frontal', 'parietal', 'temporal', 'occipital', 'cingulate', 'insula', 'subcortical', 'cerebellum', 'brainstem'] as const;

const GAIN_BY_PART = [1, 1, 0.75, 0.75, 0.6];

export function parseMesh(buf: ArrayBuffer, regions: RegionLite[]): BrainMesh {
  const dv = new DataView(buf);
  const nv = dv.getUint32(0, true);
  const nf = dv.getUint32(4, true);
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const occ = new Float32Array(nv);
  const gain = new Float32Array(nv);
  const part = new Uint8Array(nv);
  let o = 8;
  for (let k = 0; k < nv; k++) {
    pos[k * 3] = dv.getInt16(o, true) / 10;
    pos[k * 3 + 1] = dv.getInt16(o + 2, true) / 10;
    pos[k * 3 + 2] = dv.getInt16(o + 4, true) / 10;
    nrm[k * 3] = dv.getInt8(o + 6) / 127;
    nrm[k * 3 + 1] = dv.getInt8(o + 7) / 127;
    nrm[k * 3 + 2] = dv.getInt8(o + 8) / 127;
    occ[k] = dv.getUint8(o + 9) / 255;
    part[k] = dv.getUint8(o + 10);
    gain[k] = GAIN_BY_PART[part[k]!] ?? 1;
    o += 12;
  }
  const faces = new Uint32Array(nf * 3);
  for (let k = 0; k < nf * 3; k++) {
    faces[k] = dv.getUint32(o, true);
    o += 4;
  }
  const { ridx, rw } = regionWeights(pos, part, nv, regions);
  const lobe = new Float32Array(nv);
  for (let k = 0; k < nv; k++) lobe[k] = LOBE_ORDER.indexOf(regions[ridx[k * 3]!]!.lobe as (typeof LOBE_ORDER)[number]);
  return { nv, nf, pos, nrm, occ, gain, part, faces, ridx, rw, lobe };
}

/** cortex vertices read the cortical regions of their hemisphere, the cerebellum its own, the brainstem the brainstem */
export function regionWeights(pos: Float32Array, part: ArrayLike<number>, n: number, regions: RegionLite[]): { ridx: Float32Array; rw: Float32Array } {
  const pools: number[][] = [
    regions.map((r, i) => (r.cortical && r.hemi === 'L' ? i : -1)).filter((i) => i >= 0),
    regions.map((r, i) => (r.cortical && r.hemi === 'R' ? i : -1)).filter((i) => i >= 0),
    regions.map((r, i) => (r.lobe === 'cerebellum' && r.hemi === 'L' ? i : -1)).filter((i) => i >= 0),
    regions.map((r, i) => (r.lobe === 'cerebellum' && r.hemi === 'R' ? i : -1)).filter((i) => i >= 0),
    regions.map((r, i) => (r.lobe === 'brainstem' ? i : -1)).filter((i) => i >= 0),
  ];
  const ridx = new Float32Array(n * 3);
  const rw = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const pool = pools[part[k]!] ?? pools[0]!;
    const x = pos[k * 3]!;
    const y = pos[k * 3 + 1]!;
    const z = pos[k * 3 + 2]!;
    const best: Array<[number, number]> = [];
    for (const i of pool) {
      const r = regions[i]!;
      best.push([i, (r.x - x) ** 2 + (r.y - y) ** 2 + (r.z - z) ** 2]);
    }
    best.sort((a, b) => a[1] - b[1]);
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const b = best[j] ?? best[0]!;
      const w = 1 / (b[1] + 120);
      ridx[k * 3 + j] = b[0];
      rw[k * 3 + j] = w;
      sum += w;
    }
    for (let j = 0; j < 3; j++) rw[k * 3 + j] = rw[k * 3 + j]! / sum;
  }
  return { ridx, rw };
}

export async function loadMesh(url: string, regions: RegionLite[]): Promise<BrainMesh> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`brain mesh: ${res.status}`);
  return parseMesh(await res.arrayBuffer(), regions);
}
