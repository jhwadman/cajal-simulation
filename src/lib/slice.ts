/**
 * src/lib/slice.ts — the cross-section view: axial, coronal and sagittal
 * planes through a focus point, drawn from public/brain/volume.bin (the
 * MNI152 T1 template as tissue, a label volume naming the atlas region of
 * every voxel), baked by models/scripts/build_brain_volume.py.
 *
 * The scale carries over from the 3D view: tissue intensity in the matter grey,
 * excitation blended over each region's voxels by its activity. A crosshair
 * marks the focus in every pane; clicking in one pane moves it, and the
 * other two follow. Hovering names the region under the cursor.
 */

import { activation, overlayMix, excite } from './colormap.ts';

export interface Volume {
  nx: number;
  ny: number;
  nz: number;
  origin: [number, number, number];
  /** signed mm per voxel along x; y and z step +2 mm */
  xStep: number;
  step: number;
  t1: Uint8Array;
  label: Uint8Array;
}

export type Plane = 'axial' | 'coronal' | 'sagittal';
export const PLANES: readonly Plane[] = ['sagittal', 'coronal', 'axial'];

export function parseVolume(buf: ArrayBuffer): Volume {
  const dv = new DataView(buf);
  const nx = dv.getUint16(0, true);
  const ny = dv.getUint16(2, true);
  const nz = dv.getUint16(4, true);
  const origin: [number, number, number] = [dv.getFloat32(6, true), dv.getFloat32(10, true), dv.getFloat32(14, true)];
  const xStep = dv.getFloat32(18, true);
  const n = nx * ny * nz;
  const t1 = new Uint8Array(buf, 22, n);
  const label = new Uint8Array(buf, 22 + n, n);
  return { nx, ny, nz, origin, xStep, step: 2, t1, label };
}

export async function loadVolume(url: string): Promise<Volume> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`brain volume: ${res.status}`);
  return parseVolume(await res.arrayBuffer());
}

/** world mm → voxel index (rounded, clamped) */
export function toVoxel(v: Volume, x: number, y: number, z: number): [number, number, number] {
  const i = Math.round((x - v.origin[0]) / v.xStep);
  const j = Math.round((y - v.origin[1]) / v.step);
  const k = Math.round((z - v.origin[2]) / v.step);
  return [Math.max(0, Math.min(v.nx - 1, i)), Math.max(0, Math.min(v.ny - 1, j)), Math.max(0, Math.min(v.nz - 1, k))];
}

export function toWorld(v: Volume, i: number, j: number, k: number): [number, number, number] {
  return [v.origin[0] + i * v.xStep, v.origin[1] + j * v.step, v.origin[2] + k * v.step];
}

export function labelAt(v: Volume, i: number, j: number, k: number): number {
  const l = v.label[i + v.nx * (j + v.ny * k)]!;
  return l === 255 ? -1 : l;
}

/* ── anatomy and the scale, as in the 3D view ─────────────────────────────────── */

const MATTER = [196, 190, 182];

/** in-plane dimensions and the world axes each pane shows (horizontal, vertical) */
export function paneDims(v: Volume, plane: Plane): { w: number; h: number; hAxis: 'x' | 'y' | 'z'; vAxis: 'x' | 'y' | 'z' } {
  if (plane === 'axial') return { w: v.nx, h: v.ny, hAxis: 'x', vAxis: 'y' };
  if (plane === 'coronal') return { w: v.nx, h: v.nz, hAxis: 'x', vAxis: 'z' };
  return { w: v.ny, h: v.nz, hAxis: 'y', vAxis: 'z' };
}

/**
 * Draw one pane. `focus` is the voxel the crosshair sits on; the pane shows
 * the plane through it. Returns the pixel size and offset so the caller can
 * map clicks back to voxels. `highlight` outlines one region.
 */
export function drawSlice(
  canvas: HTMLCanvasElement,
  v: Volume,
  plane: Plane,
  focus: [number, number, number],
  activity: ArrayLike<number> | null,
  highlight: number,
  scratch: { img?: ImageData; key?: string },
  zoom = 1,
): { scale: number; ox: number; oy: number; w: number; h: number } {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (!ctx || cw === 0) return { scale: 1, ox: 0, oy: 0, w: 1, h: 1 };
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const { w, h } = paneDims(v, plane);
  const key = `${plane}:${w}x${h}`;
  if (!scratch.img || scratch.key !== key) {
    scratch.img = new ImageData(w, h);
    scratch.key = key;
  }
  const img = scratch.img;
  const px = img.data;

  // fill the plane: radiological convention avoided — the viewer's left is the brain's left
  // (x increases to the right in world mm; the x step is signed in the volume)
  const [fi, fj, fk] = focus;
  const xFlip = v.xStep < 0;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let i: number;
      let j: number;
      let k: number;
      if (plane === 'axial') {
        i = xFlip ? w - 1 - col : col;
        j = h - 1 - row; // anterior up
        k = fk;
      } else if (plane === 'coronal') {
        i = xFlip ? w - 1 - col : col;
        j = fj;
        k = h - 1 - row; // superior up
      } else {
        i = fi;
        j = col; // anterior to the right
        k = h - 1 - row;
      }
      const idx = i + v.nx * (j + v.ny * k);
      const t = v.t1[idx]! / 255;
      const l = v.label[idx]!;
      const o = (row * w + col) * 4;
      if (t <= 0.02) {
        px[o] = 0;
        px[o + 1] = 0;
        px[o + 2] = 0;
        px[o + 3] = 0;
        continue;
      }
      const shade = 0.25 + 0.85 * t;
      let r = MATTER[0]! * shade;
      let g = MATTER[1]! * shade;
      let b = MATTER[2]! * shade;
      if (l !== 255) {
        const e = excite(activity ? activity[l] ?? 0 : 0.1);
        const kk = overlayMix(e);
        if (kk > 0) {
          const ex = activation(e);
          const lit = 0.6 + 0.4 * Math.min(1, shade);
          r = r * (1 - kk) + ex[0]! * lit * kk;
          g = g * (1 - kk) + ex[1]! * lit * kk;
          b = b * (1 - kk) + ex[2]! * lit * kk;
        }
        if (l === highlight) {
          r = r * 0.5 + 53 * 0.5;
          g = g * 0.5 + 214 * 0.5;
          b = b * 0.5 + 255 * 0.5;
        }
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }

  // the crosshair's place in this pane's image, in voxels
  const colF = plane === 'sagittal' ? fj : xFlip ? w - 1 - fi : fi;
  const rowF = plane === 'axial' ? h - 1 - fj : h - 1 - fk;
  // scale to fit, keeping voxels square; zoomed in, the view centres on the crosshair
  // The section is fitted INSIDE a margin that holds its own letters (A/P,
  // L/R, the plane's name), so no text is ever over the tissue — the rule
  // the whole frame follows (knowledge/01). Zoomed in, the image is clipped
  // to that inner rectangle rather than allowed to run under the letters.
  const MX = 18;
  const MY = 18;
  const iw = Math.max(1, cw - 2 * MX);
  const ih = Math.max(1, ch - 2 * MY);
  const scale = Math.min(iw / w, ih / h) * zoom;
  const place = (size: number, span: number, at: number) => (size <= span ? (span - size) / 2 : Math.min(0, Math.max(span - size, span / 2 - at)));
  const ox = MX + place(w * scale, iw, (colF + 0.5) * scale);
  const oy = MY + place(h * scale, ih, (rowF + 0.5) * scale);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  // draw via a temporary canvas so the image can be scaled with smoothing
  const tmp = scratch as { tmp?: HTMLCanvasElement };
  if (!tmp.tmp) tmp.tmp = document.createElement('canvas');
  const tc = tmp.tmp;
  if (tc.width !== w || tc.height !== h) {
    tc.width = w;
    tc.height = h;
  }
  tc.getContext('2d')!.putImageData(img, 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(MX, MY, iw, ih);
  ctx.clip();
  ctx.drawImage(tc, ox, oy, w * scale, h * scale);
  ctx.restore();

  // crosshair at the focus
  const cx = ox + (colF + 0.5) * scale;
  const cy = oy + (rowF + 0.5) * scale;
  ctx.strokeStyle = 'rgba(53,214,255,0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, oy);
  ctx.lineTo(cx, oy + h * scale);
  ctx.moveTo(ox, cy);
  ctx.lineTo(ox + w * scale, cy);
  ctx.stroke();

  // orientation marks
  ctx.fillStyle = 'rgba(154,164,178,0.9)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const marks = plane === 'axial' ? ['L', 'R', 'A', 'P'] : plane === 'coronal' ? ['L', 'R', 'S', 'I'] : ['P', 'A', 'S', 'I'];
  ctx.fillText(marks[0]!, 6, ch / 2 + 4);
  ctx.fillText(marks[1]!, cw - 12, ch / 2 + 4);
  ctx.fillText(marks[2]!, cw / 2 - 3, 13);
  ctx.fillText(marks[3]!, cw / 2 - 3, ch - 5);
  ctx.fillText(plane, 6, 13);
  return { scale, ox, oy, w, h };
}

/** canvas point → voxel on this pane's plane, or null when outside the image */
export function pickVoxel(v: Volume, plane: Plane, focus: [number, number, number], geom: { scale: number; ox: number; oy: number; w: number; h: number }, x: number, y: number): [number, number, number] | null {
  const col = Math.floor((x - geom.ox) / geom.scale);
  const row = Math.floor((y - geom.oy) / geom.scale);
  if (col < 0 || row < 0 || col >= geom.w || row >= geom.h) return null;
  const xFlip = v.xStep < 0;
  const [fi, fj, fk] = focus;
  if (plane === 'axial') return [xFlip ? geom.w - 1 - col : col, geom.h - 1 - row, fk];
  if (plane === 'coronal') return [xFlip ? geom.w - 1 - col : col, fj, geom.h - 1 - row];
  return [fi, col, geom.h - 1 - row];
}
