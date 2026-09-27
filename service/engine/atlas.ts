/**
 * engine/atlas.ts — the parcellation the model runs on.
 *
 * 85 nodes: the 68 cortical regions of the Desikan-Killiany atlas (34 per
 * hemisphere), 7 subcortical structures per hemisphere, one cerebellar
 * hemisphere each, and the brainstem on the midline.
 *
 * COORDINATES ARE APPROXIMATE. They are hand-set MNI-space centroids (mm),
 * good enough to draw a recognisable brain and to derive plausible
 * distance-based connectivity; they are not a measured atlas and must not be
 * quoted as one. The right hemisphere mirrors the left across x = 0.
 *
 * Region ids are stable strings the tools and the page share: `L_precentral`,
 * `R_hippocampus`, `brainstem`.
 */

export type Hemisphere = 'L' | 'R' | 'M';
export type Lobe =
  | 'frontal'
  | 'parietal'
  | 'temporal'
  | 'occipital'
  | 'cingulate'
  | 'insula'
  | 'subcortical'
  | 'cerebellum'
  | 'brainstem';

export interface Region {
  /** stable id, e.g. `L_precentral` */
  id: string;
  /** atlas name without hemisphere, e.g. `precentral` */
  name: string;
  /** a readable label, e.g. `left precentral gyrus` */
  label: string;
  hemi: Hemisphere;
  lobe: Lobe;
  /** approximate MNI centroid, mm */
  x: number;
  y: number;
  z: number;
  /** true for the 68 cortical parcels */
  cortical: boolean;
}

/** left-hemisphere seeds: [name, label, lobe, x, y, z] */
const CORTEX: Array<[string, string, Lobe, number, number, number]> = [
  // frontal
  ['superiorfrontal', 'superior frontal gyrus', 'frontal', -12, 30, 45],
  ['rostralmiddlefrontal', 'rostral middle frontal gyrus', 'frontal', -35, 42, 22],
  ['caudalmiddlefrontal', 'caudal middle frontal gyrus', 'frontal', -36, 12, 48],
  ['parsopercularis', 'pars opercularis', 'frontal', -50, 14, 16],
  ['parstriangularis', 'pars triangularis', 'frontal', -47, 32, 6],
  ['parsorbitalis', 'pars orbitalis', 'frontal', -42, 40, -10],
  ['lateralorbitofrontal', 'lateral orbitofrontal cortex', 'frontal', -26, 32, -14],
  ['medialorbitofrontal', 'medial orbitofrontal cortex', 'frontal', -7, 42, -14],
  ['precentral', 'precentral gyrus (primary motor)', 'frontal', -40, -8, 48],
  ['paracentral', 'paracentral lobule', 'frontal', -7, -24, 60],
  ['frontalpole', 'frontal pole', 'frontal', -10, 62, -6],
  // parietal
  ['postcentral', 'postcentral gyrus (primary somatosensory)', 'parietal', -44, -24, 50],
  ['superiorparietal', 'superior parietal lobule', 'parietal', -24, -56, 58],
  ['inferiorparietal', 'inferior parietal lobule', 'parietal', -46, -64, 34],
  ['supramarginal', 'supramarginal gyrus', 'parietal', -56, -38, 34],
  ['precuneus', 'precuneus', 'parietal', -8, -60, 42],
  // temporal
  ['superiortemporal', 'superior temporal gyrus', 'temporal', -56, -14, 0],
  ['middletemporal', 'middle temporal gyrus', 'temporal', -58, -28, -12],
  ['inferiortemporal', 'inferior temporal gyrus', 'temporal', -50, -32, -26],
  ['bankssts', 'banks of the superior temporal sulcus', 'temporal', -54, -46, 10],
  ['transversetemporal', 'transverse temporal gyrus (primary auditory)', 'temporal', -46, -22, 10],
  ['fusiform', 'fusiform gyrus', 'temporal', -36, -44, -22],
  ['parahippocampal', 'parahippocampal gyrus', 'temporal', -24, -30, -18],
  ['entorhinal', 'entorhinal cortex', 'temporal', -24, -10, -32],
  ['temporalpole', 'temporal pole', 'temporal', -34, 14, -36],
  // occipital
  ['lateraloccipital', 'lateral occipital cortex', 'occipital', -34, -84, 4],
  ['cuneus', 'cuneus', 'occipital', -8, -80, 26],
  ['pericalcarine', 'pericalcarine cortex (primary visual)', 'occipital', -12, -80, 8],
  ['lingual', 'lingual gyrus', 'occipital', -14, -70, -6],
  // cingulate
  ['rostralanteriorcingulate', 'rostral anterior cingulate', 'cingulate', -6, 36, 8],
  ['caudalanteriorcingulate', 'caudal anterior cingulate', 'cingulate', -6, 16, 34],
  ['posteriorcingulate', 'posterior cingulate', 'cingulate', -6, -20, 38],
  ['isthmuscingulate', 'isthmus of the cingulate', 'cingulate', -8, -46, 24],
  // insula
  ['insula', 'insula', 'insula', -38, 0, 4],
];

const SUBCORTEX: Array<[string, string, Lobe, number, number, number]> = [
  ['thalamus', 'thalamus', 'subcortical', -11, -18, 8],
  ['caudate', 'caudate nucleus', 'subcortical', -13, 10, 10],
  ['putamen', 'putamen', 'subcortical', -25, 2, 0],
  ['pallidum', 'globus pallidus', 'subcortical', -20, -4, -2],
  ['hippocampus', 'hippocampus', 'subcortical', -27, -22, -14],
  ['amygdala', 'amygdala', 'subcortical', -24, -5, -18],
  ['accumbens', 'nucleus accumbens', 'subcortical', -9, 10, -8],
  ['cerebellum', 'cerebellar hemisphere', 'cerebellum', -26, -62, -36],
];

function mirror(
  seeds: Array<[string, string, Lobe, number, number, number]>,
  cortical: boolean,
): Region[] {
  const out: Region[] = [];
  for (const hemi of ['L', 'R'] as const) {
    for (const [name, label, lobe, x, y, z] of seeds) {
      out.push({
        id: `${hemi}_${name}`,
        name,
        label: `${hemi === 'L' ? 'left' : 'right'} ${label}`,
        hemi,
        lobe,
        x: hemi === 'L' ? x : -x,
        y,
        z,
        cortical,
      });
    }
  }
  return out;
}

export const REGIONS: readonly Region[] = [
  ...mirror(CORTEX, true),
  ...mirror(SUBCORTEX, false),
  { id: 'brainstem', name: 'brainstem', label: 'brainstem', hemi: 'M', lobe: 'brainstem', x: 0, y: -28, z: -36, cortical: false },
];

export const N = REGIONS.length;
export const REGION_INDEX = new Map(REGIONS.map((r, i) => [r.id, i]));
export const LOBES: readonly Lobe[] = [
  'frontal', 'parietal', 'temporal', 'occipital', 'cingulate', 'insula', 'subcortical', 'cerebellum', 'brainstem',
];

export function distance(a: Region, b: Region): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Resolve a human or model-written region reference to node indices.
 *
 * Accepts: an exact id (`L_precentral`), a bare name for both hemispheres
 * (`precentral`, `hippocampus`), a hemisphere prefix on a lobe (`L_temporal`,
 * `right occipital`), a lobe (`frontal`), `left`/`right`/`cortex`/`all`, and a
 * few common aliases (`motor cortex`, `visual cortex`, `V1`, `M1`, `S1`,
 * `A1`, `PFC`, `DLPFC`, `OFC`, `ACC`, `PCC`). Matching is case-insensitive
 * and ignores spaces, hyphens and underscores. Returns [] when nothing
 * matches; callers report that rather than guessing.
 */
export function resolveRegion(query: string): number[] {
  const raw = query.trim();
  if (!raw) return [];
  const exact = REGION_INDEX.get(raw);
  if (exact !== undefined) return [exact];

  let q = raw.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  let hemi: Hemisphere | null = null;
  const hm = q.match(/^(l|r|left|right|lh|rh)\b\s*(.*)$/);
  if (hm) {
    hemi = hm[1]!.startsWith('l') ? 'L' : 'R';
    q = hm[2]!.trim();
  }
  const alias = ALIASES[q] ?? q;
  const key = alias.replace(/\s+/g, '');
  const byHemi = (r: Region) => hemi === null || r.hemi === hemi || r.hemi === 'M';

  if (key === 'all' || key === 'brain' || key === 'everything') {
    return REGIONS.map((_, i) => i).filter((i) => byHemi(REGIONS[i]!));
  }
  if (key === 'cortex' || key === 'cortical' || key === 'neocortex') {
    return REGIONS.map((r, i) => (r.cortical && byHemi(r) ? i : -1)).filter((i) => i >= 0);
  }
  if (key === '' && hemi) {
    return REGIONS.map((r, i) => (r.hemi === hemi ? i : -1)).filter((i) => i >= 0);
  }
  if ((LOBES as readonly string[]).includes(key)) {
    return REGIONS.map((r, i) => (r.lobe === key && byHemi(r) ? i : -1)).filter((i) => i >= 0);
  }
  // a region name, both hemispheres unless one was named
  const hits = REGIONS.map((r, i) => (r.name === key && byHemi(r) ? i : -1)).filter((i) => i >= 0);
  if (hits.length) return hits;
  // a fuzzy fallback: the name is a prefix or the label contains the words
  const loose = REGIONS
    .map((r, i) => ((r.name.startsWith(key) || r.label.replace(/[\s_-]+/g, '').includes(key)) && byHemi(r) ? i : -1))
    .filter((i) => i >= 0);
  return loose;
}

const ALIASES: Record<string, string> = {
  'motor cortex': 'precentral',
  'primary motor cortex': 'precentral',
  m1: 'precentral',
  'somatosensory cortex': 'postcentral',
  s1: 'postcentral',
  'visual cortex': 'pericalcarine',
  'primary visual cortex': 'pericalcarine',
  v1: 'pericalcarine',
  'auditory cortex': 'transversetemporal',
  a1: 'transversetemporal',
  'prefrontal cortex': 'rostralmiddlefrontal',
  pfc: 'rostralmiddlefrontal',
  dlpfc: 'rostralmiddlefrontal',
  'dorsolateral prefrontal cortex': 'rostralmiddlefrontal',
  'orbitofrontal cortex': 'lateralorbitofrontal',
  ofc: 'lateralorbitofrontal',
  'anterior cingulate': 'rostralanteriorcingulate',
  acc: 'rostralanteriorcingulate',
  'posterior cingulate': 'posteriorcingulate',
  pcc: 'posteriorcingulate',
  "broca's area": 'parsopercularis',
  broca: 'parsopercularis',
  "wernicke's area": 'bankssts',
  wernicke: 'bankssts',
  striatum: 'putamen',
  'basal ganglia': 'putamen',
  'temporal lobe': 'temporal',
  'frontal lobe': 'frontal',
  'parietal lobe': 'parietal',
  'occipital lobe': 'occipital',
  'limbic': 'cingulate',
  'default mode network': 'precuneus',
  dmn: 'precuneus',
};

/** Compact listing for the model: one line per region. */
export function describeAtlas(): string {
  const lines: string[] = [];
  lines.push(`${N} regions. Ids are <L|R>_<name> for paired structures and 'brainstem' for the midline. Coordinates are approximate MNI centroids in mm (x: left−/right+, y: back−/front+, z: down−/up+).`);
  for (const lobe of LOBES) {
    const rs = REGIONS.filter((r) => r.lobe === lobe && r.hemi !== 'R');
    lines.push(`\n${lobe.toUpperCase()}:`);
    for (const r of rs) {
      const pair = r.hemi === 'M' ? r.id : `L_${r.name} / R_${r.name}`;
      lines.push(`  ${pair} — ${r.label.replace(/^left /, '')} (${r.x < 0 ? '±' : ''}${Math.abs(r.x)}, ${r.y}, ${r.z})`);
    }
  }
  lines.push('\nAlso accepted as region references: a lobe name (optionally with L/R), left, right, cortex, all, and aliases such as M1, S1, V1, A1, PFC, DLPFC, OFC, ACC, PCC, Broca, Wernicke, striatum, DMN.');
  return lines.join('\n');
}
