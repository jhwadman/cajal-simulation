/**
 * src/lib/render.ts — drawing. Pure functions over canvases: the brain view
 * (a procedural brain surface of ~9,000 lit points in the matter colour,
 * with each region's excitation blended over the cortex it owns, and the
 * deep structures glowing inside), the traces, the band bars, the spike
 * raster and the single-cell scatter. The surface is built once from the
 * atlas; the client module decides what to draw each frame.
 *
 * Canvas 2D only, no library: nine thousand small rectangles sorted back to
 * front are a couple of milliseconds a frame on a laptop.
 */

import { activation, overlayMix, excite, divergence, diffStrength } from './colormap.ts';

export interface RegionLite {
  id: string;
  label: string;
  hemi: string;
  lobe: string;
  x: number;
  y: number;
  z: number;
  cortical: boolean;
}
export interface EdgeLite { a: number; b: number; w: number }

export interface View {
  /** rotation about the vertical axis, radians (0 = right lateral, π = left lateral, π/2 = front) */
  yaw: number;
  /** tilt, radians (positive looks from above) */
  pitch: number;
  auto: boolean;
  /** 1 = fit; a little either side */
  zoom?: number;
  /**
   * Pixels the fit leaves clear at the top and bottom of the canvas: the
   * head-up display and the legend sit over the picture, and a brain fitted
   * to the full height had its crown under the title and its base under the
   * scale. The same numbers go to gl.ts, so the mesh and the overlay agree.
   */
  inset?: { top: number; bottom: number };
}

/**
 * The offset that centres the mesh on the origin, mm, added to every MNI
 * coordinate before the view rotates it (the atlas regions in the overlay,
 * the vertices in the shader, the floor). public/brain/meta.json bounds:
 * y −104.7…69.2, z −71.3…79.2, so the midpoints are y −17.8 and z +4.
 */
export const MESH_OFFSET = { x: 0, y: 18, z: -4 } as const;
/** the brain's half-extents about MESH_OFFSET, mm, from the same bounds */
const HALF = { x: 70, y: 88, z: 76 } as const;
/** room for the perspective term (near points scale up to ~1.17) */
const FIT_MARGIN = 1.04;

/**
 * The shared fit: px per mm and the vertical centre, honouring the inset.
 * The brain is fitted to the band by what it PROJECTS to at this pitch, so
 * its base clears the legend and its crown the head-up display in every
 * view — a side view uses its height, a top view its length. The width is
 * the worst case over yaw rather than the current one, so the auto-orbit
 * does not breathe.
 */
export function fitView(w: number, h: number, view: View): { s: number; cy: number } {
  const top = view.inset?.top ?? 0;
  const bottom = view.inset?.bottom ?? 0;
  const hh = Math.max(40, h - top - bottom);
  const footprint = Math.hypot(HALF.x, HALF.y); // the box's reach in the horizontal plane, any yaw
  const halfW = footprint * FIT_MARGIN;
  const halfH = (Math.abs(Math.sin(view.pitch)) * footprint + Math.cos(view.pitch) * HALF.z) * FIT_MARGIN;
  return { s: Math.min(w / (2 * halfW), hh / (2 * halfH)) * (view.zoom ?? 1), cy: top + hh / 2 };
}

export interface Marks {
  /** region indices with a stimulation ring */
  stimulated: Set<number>;
  /** region indices drawn as lesioned */
  lesioned: Set<number>;
  /** region indices not carrying data (drawn hollow) */
  masked: Set<number>;
}

const TAU = Math.PI * 2;
const EMPTY_MARKS: Marks = { stimulated: new Set(), lesioned: new Set(), masked: new Set() };

/* ── anatomy, and the scale over it ─────────────────────────────────────────────────────── */

/** brain matter: a pale, lit tissue grey; shading carries the structure */
const MATTER: [number, number, number] = [196, 190, 182];

/** activity → its colour on the scale (the connectome, the deep glows) */
export const ramp = activation;

/** matter lit by `shade`, with excitation `e` (0–1) painted over it */
function tissue(shade: number, e: number): [number, number, number] {
  // the scale carries the level; the lighting stays on the coloured tissue so
  // the folds still read when the whole cortex is firing
  const ex = activation(e);
  const k = overlayMix(e);
  const lit = 0.55 + 0.45 * shade;
  return [
    (MATTER[0] * shade) * (1 - k) + ex[0] * lit * k,
    (MATTER[1] * shade) * (1 - k) + ex[1] * lit * k,
    (MATTER[2] * shade) * (1 - k) + ex[2] * lit * k,
  ];
}

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/* ── projection ──────────────────────────────────────────────────────────── */

interface Projected { x: number; y: number; depth: number; scale: number }

/** rotation for a view: MNI (x right, y anterior, z superior) → screen right / up / toward viewer */
function basis(view: View): { rx: [number, number, number]; ry: [number, number, number]; rd: [number, number, number] } {
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  // screen-right = (−sy, cy, 0); up tilts with pitch; toward-viewer = right × up,
  // so the frame is right-handed and the painter's order matches the picture.
  // yaw 0 = the viewer at +x (right lateral); π = left lateral; π/2 = the front.
  return {
    rx: [-sy, cy, 0],
    ry: [-cy * sp, -sy * sp, cp],
    rd: [cy * cp, sy * cp, sp],
  };
}

function project(px: number, py: number, pz: number, b: ReturnType<typeof basis>, cx: number, cy: number, s: number): Projected {
  const X = px + MESH_OFFSET.x;
  const Y = py + MESH_OFFSET.y;
  const Z = pz + MESH_OFFSET.z;
  const sx = X * b.rx[0] + Y * b.rx[1] + Z * b.rx[2];
  const sy = X * b.ry[0] + Y * b.ry[1] + Z * b.ry[2];
  const depth = X * b.rd[0] + Y * b.rd[1] + Z * b.rd[2];
  const scale = 1 + depth * 0.0022;
  return { x: cx + sx * s * scale, y: cy - sy * s * scale, depth, scale };
}

/* ── the brain view ──────────────────────────────────────────────────────── */

export interface BrainFrame {
  regions: RegionLite[];
  edges: EdgeLite[];
  /** activity per region in [0,1]; null = nothing loaded */
  activity: ArrayLike<number> | null;
  view: View;
  marks?: Marks;
  hover?: number | null;
  /** true when the WebGL mesh was drawn underneath this overlay */
  meshDrawn?: boolean;
  /** organ: the surface alone; depth: connectome and deep structures showing through */
  mode?: 'organ' | 'depth';
  /**
   * `activity` holds a signed CHANGE already mapped to 0..1 (0.5 = no change)
   * rather than a level, so paint it on the diverging scale: unchanged tissue
   * stays grey and only what moved takes colour. Used by the still contrast
   * figure; the live view never sets it.
   */
  signed?: boolean;
  /** draw the anterior / superior words; a small still says its orientation in its caption instead */
  orientation?: boolean;
}

/** Draws one frame and returns the region screen positions (for hit testing). */
export function drawBrain(canvas: HTMLCanvasElement, f: BrainFrame): Projected[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const marks = f.marks ?? EMPTY_MARKS;
  const cx = w / 2;
  const { s, cy } = fitView(w, h, f.view);
  const b = basis(f.view);
  const pos = f.regions.map((r) => project(r.x, r.y, r.z, b, cx, cy, s));
  const act = (i: number) => (f.activity ? Math.max(0, Math.min(1, f.activity[i] ?? 0)) : 0.1);
  // one switch for the whole frame: a level on the activation scale, or a
  // signed change on the diverging one. `level` is how strongly a region
  // paints, `tint` is the colour it paints in.
  const signed = f.signed === true;
  const level = (i: number) => (signed ? diffStrength(act(i)) : excite(act(i)));
  const tint = (i: number, e: number) => (signed ? divergence(act(i)) : ramp(0.10 + 0.90 * e));

  if (!f.meshDrawn) {
    // no WebGL surface underneath: the regions themselves, so the page is never blank
    for (let i = 0; i < f.regions.length; i++) {
      const p = pos[i]!;
      ctx.fillStyle = signed ? rgba(divergence(act(i)), 0.22 + 0.7 * level(i)) : rgba(ramp(excite(act(i))), 0.9);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * p.scale, 0, TAU);
      ctx.fill();
    }
  }

  const depthMode = f.mode !== 'organ' || !f.meshDrawn;

  // the connectome, faint, over the surface: the structure the light travels along
  ctx.lineWidth = 1;
  if (depthMode && !signed) for (const e of f.edges) {
    const pa = pos[e.a]!;
    const pb = pos[e.b]!;
    const a = Math.max(excite(act(e.a)), excite(act(e.b)));
    const depth = (pa.depth + pb.depth) / 2;
    const fade = depth > 0 ? 1 : 0.35;
    ctx.strokeStyle = rgba(ramp(0.10 + 0.90 * a), (0.05 + 0.24 * e.w * 2 + 0.3 * a) * fade);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // the deep structures glow inside: thalamus, striatum, hippocampus, amygdala
  // every region has a located point in depth mode: cortical parcels as small
  // dots at their centroid, deep structures as glows; nearer draws larger
  if (depthMode && f.meshDrawn) {
    for (let i = 0; i < f.regions.length; i++) {
      if (!f.regions[i]!.cortical) continue;
      const p = pos[i]!;
      const e = level(i);
      ctx.fillStyle = signed ? rgba(divergence(act(i)), 0.12 + 0.8 * e) : rgba(ramp(0.08 + 0.92 * e), 0.55 + 0.4 * e);
      ctx.beginPath();
      ctx.arc(p.x, p.y, (1.8 + 2.2 * e) * p.scale, 0, TAU);
      ctx.fill();
    }
  }
  const inner = depthMode ? f.regions.map((r, i) => (!r.cortical && r.lobe === 'subcortical' ? i : -1)).filter((i) => i >= 0) : [];
  for (const i of inner.sort((p, q) => pos[p]!.depth - pos[q]!.depth)) {
    const p = pos[i]!;
    const e = level(i);
    const c = tint(i, e);
    const radius = (4.5 + 5 * e) * p.scale;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 2.2);
    // a deep structure that did not move must not glow: in the signed view the
    // whole gradient fades with the size of the change, not just its colour
    g.addColorStop(0, rgba(c, signed ? 0.08 + 0.85 * e : 0.55 + 0.4 * e));
    g.addColorStop(0.45, rgba(c, signed ? 0.04 + 0.5 * e : 0.25 + 0.3 * e));
    g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // marks on top: stimulation rings, lesion crosses, the hovered region
  for (let i = 0; i < f.regions.length; i++) {
    const p = pos[i]!;
    const base = 4 * p.scale;
    if (marks.lesioned.has(i)) {
      ctx.strokeStyle = 'rgba(255,79,216,0.95)';
      ctx.lineWidth = 1.6;
      const k = base + 3;
      ctx.beginPath();
      ctx.moveTo(p.x - k, p.y - k);
      ctx.lineTo(p.x + k, p.y + k);
      ctx.moveTo(p.x + k, p.y - k);
      ctx.lineTo(p.x - k, p.y + k);
      ctx.stroke();
    }
    if (marks.stimulated.has(i)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (marks.masked.has(i) && f.regions[i]!.cortical) {
      ctx.strokeStyle = 'rgba(120,140,170,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (f.hover === i) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // orientation marks
  if (f.orientation === false) return pos;
  ctx.fillStyle = 'rgba(154,164,178,0.7)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const front = project(0, 100, 10, b, cx, cy, s);
  const top = project(0, -18, 84, b, cx, cy, s);
  ctx.fillText('anterior', front.x - 22, front.y);
  ctx.fillText('superior', top.x - 22, top.y - 4);
  return pos;
}

/** Nearest region to a screen point, within a radius; -1 if none. */
export function hitTest(pos: Projected[], x: number, y: number, radius = 14): number {
  let best = -1;
  let bd = radius * radius;
  for (let i = 0; i < pos.length; i++) {
    const d = (pos[i]!.x - x) ** 2 + (pos[i]!.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/* ── traces ──────────────────────────────────────────────────────────────── */

function prep(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function drawTraces(canvas: HTMLCanvasElement, series: Array<{ values: ArrayLike<number>; color: string; max?: number }>, playhead: number | null, labels?: { left?: string; right?: string }): void {
  const p = prep(canvas);
  if (!p) return;
  const { ctx, w, h } = p;
  const pad = 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let k = 1; k < 4; k++) {
    ctx.beginPath();
    ctx.moveTo(0, (h * k) / 4);
    ctx.lineTo(w, (h * k) / 4);
    ctx.stroke();
  }
  for (const s of series) {
    const n = s.values.length;
    if (!n) continue;
    const max = s.max ?? 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = pad + ((w - 2 * pad) * i) / (n - 1);
      const y = h - pad - (h - 2 * pad) * Math.max(0, Math.min(1, s.values[i]! / max));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  if (playhead !== null) {
    const x = pad + (w - 2 * pad) * playhead;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(154,164,178,0.9)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  if (labels?.left) ctx.fillText(labels.left, 8, 14);
  if (labels?.right) ctx.fillText(labels.right, w - 8 - ctx.measureText(labels.right).width, 14);
}

/* ── the raster ──────────────────────────────────────────────────────────── */

export function drawRaster(canvas: HTMLCanvasElement, spikes: { t: ArrayLike<number>; id: ArrayLike<number> }, neurons: number, excitatory: number, duration: number, rate: ArrayLike<number>, playhead: number | null): void {
  const p = prep(canvas);
  if (!p) return;
  const { ctx, w, h } = p;
  const rasterH = h * 0.72;
  const n = spikes.t.length;
  const step = n > 60000 ? Math.ceil(n / 60000) : 1;
  for (let k = 0; k < n; k += step) {
    const id = spikes.id[k]!;
    const x = (spikes.t[k]! / duration) * w;
    const y = rasterH - (id / neurons) * rasterH;
    ctx.fillStyle = id < excitatory ? 'rgba(255,106,61,0.8)' : 'rgba(53,214,255,0.85)';
    ctx.fillRect(x, y, 1.2, 1.2);
  }
  // population rate below
  let max = 1;
  for (let i = 0; i < rate.length; i++) if (rate[i]! > max) max = rate[i]!;
  ctx.strokeStyle = 'rgba(232,236,241,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < rate.length; i++) {
    const x = (i / (rate.length - 1)) * w;
    const y = h - 2 - (rate[i]! / max) * (h - rasterH - 6);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(0, rasterH + 2);
  ctx.lineTo(w, rasterH + 2);
  ctx.stroke();
  if (playhead !== null) {
    const x = playhead * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(154,164,178,0.9)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillText('excitatory', 8, 14);
  ctx.fillStyle = 'rgba(53,214,255,0.9)';
  ctx.fillText('inhibitory', 8, rasterH * 0.2 + 4);
  ctx.fillStyle = 'rgba(154,164,178,0.9)';
  ctx.fillText('population rate', 8, rasterH + 16);
}

/* ── single-cell scatter (UMAP coloured by cluster) ──────────────────────── */

export function drawScatter(canvas: HTMLCanvasElement, points: number[][], cluster: string[], legend: Record<string, string | null>): void {
  const p = prep(canvas);
  if (!p) return;
  const { ctx, w, h } = p;
  if (!points.length) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x!);
    maxX = Math.max(maxX, x!);
    minY = Math.min(minY, y!);
    maxY = Math.max(maxY, y!);
  }
  const ids = [...new Set(cluster)].sort((a, b) => Number(a) - Number(b));
  const hue = (c: string) => (ids.indexOf(c) * 137.5) % 360;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]!;
    const sx = 10 + ((x! - minX) / (maxX - minX || 1)) * (w - 20);
    const sy = h - 10 - ((y! - minY) / (maxY - minY || 1)) * (h - 20);
    ctx.fillStyle = `hsla(${hue(cluster[i]!)},80%,65%,0.8)`;
    ctx.fillRect(sx, sy, 2.2, 2.2);
  }
  ctx.font = '11px ui-monospace, Menlo, monospace';
  let ly = 14;
  for (const c of ids.slice(0, 12)) {
    ctx.fillStyle = `hsl(${hue(c)},80%,65%)`;
    ctx.fillRect(8, ly - 8, 8, 8);
    ctx.fillStyle = 'rgba(232,236,241,0.9)';
    ctx.fillText(`${c} ${legend[c] ?? ''}`, 20, ly);
    ly += 14;
  }
}
