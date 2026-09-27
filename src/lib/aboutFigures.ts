/**
 * src/lib/aboutFigures.ts — the four figures on the About page.
 *
 * Each section of that page describes one thing this studio does. Each one is
 * now shown doing it, and NOTHING HERE IS AN ILLUSTRATION: every figure is
 * computed by the same engine the rest of the studio runs, at a smaller size,
 * the first time the tab is opened. A drawn-by-hand diagram of a spike train
 * would be a claim about the model; a spike train the model produced is the
 * model. On a page whose whole argument is "we compute this in front of you",
 * a mock-up would be the one dishonest thing on it.
 *
 * The work is done once and cached, after the tab is visible, so the landing
 * page paints before anything integrates.
 */

import {
  simulateWholeBrain, summarizeWholeBrain, simulateMicrocircuit, simulateNeuron, presetById, applyTreatment,
} from '../../service/engine/index.ts';

const EMBER = '#ff6a3d';
const CYAN = '#35d6ff';
const WARM = '#ffb45c';
const DIM = '#9aa4b2';
const DIMMER = '#7b8594';

interface Box { x: number; y: number; w: number; h: number }

function prep(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = c.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!ctx || w === 0 || h === 0) return null;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function plot(ctx: CanvasRenderingContext2D, vals: ArrayLike<number>, box: Box, lo: number, hi: number, color: string, width = 1.4, dash: number[] = []): void {
  const n = vals.length;
  if (n < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = box.x + (i / (n - 1)) * box.w;
    const v = Math.max(lo, Math.min(hi, vals[i]!));
    const y = box.y + box.h - ((v - lo) / (hi - lo || 1)) * box.h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = DIM, align: CanvasTextAlign = 'left'): void {
  ctx.fillStyle = color;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

/* ── the data, computed once ─────────────────────────────────────────────── */

interface Data {
  micro: { t: Float32Array; id: Int16Array; rate: Float32Array; neurons: number; excitatory: number; duration: number };
  neuronV: Float32Array;
  meanAwake: number[];
  meanSeizure: number[];
  meanTreated: number[];
  repeatA: number[];
  repeatB: number[];
}
let data: Data | null = null;

const meanFieldOf = (p: Parameters<typeof simulateWholeBrain>[0]): number[] =>
  Array.from(summarizeWholeBrain(simulateWholeBrain(p)).meanField);

function compute(): Data {
  const micro = simulateMicrocircuit({ duration_ms: 600, neurons: 180, seed: 7 });
  const neuron = simulateNeuron({ current_ua: 15, onset_ms: 5, pulse_ms: 55, duration_ms: 70 });
  const awake = presetById('awake')!.brain!;
  const seizure = presetById('seizure')!.brain!;
  const short = { duration_ms: 1400, seed: 1 };
  return {
    micro: {
      t: micro.spikeTimes,
      id: micro.spikeIds,
      rate: micro.rate,
      neurons: micro.params.neurons,
      excitatory: micro.params.excitatory,
      duration: micro.params.duration_ms,
    },
    neuronV: neuron.V,
    meanAwake: meanFieldOf({ ...awake, ...short }),
    meanSeizure: meanFieldOf({ ...seizure, ...short }),
    meanTreated: meanFieldOf({ ...applyTreatment({ ...seizure, ...short }, 'benzodiazepine', 1) }),
    // the same parameters, integrated twice: the point of the figure is that
    // the second line lands exactly on the first
    repeatA: meanFieldOf({ ...awake, ...short }),
    repeatB: meanFieldOf({ ...awake, ...short }),
  };
}

/* ── the four figures ────────────────────────────────────────────────────── */

/** one dot per spike, and the single curve those dots add up to */
function figPopulations(c: HTMLCanvasElement, d: Data): void {
  const p = prep(c);
  if (!p) return;
  const { ctx, w, h } = p;
  const pad = 4;
  const raster: Box = { x: pad, y: 14, w: w - pad * 2, h: h * 0.52 };
  const rate: Box = { x: pad, y: h * 0.62 + 12, w: w - pad * 2, h: h - (h * 0.62 + 12) - 4 };
  label(ctx, `${d.micro.neurons} cells · every dot is one spike`, pad, 1);
  for (let i = 0; i < d.micro.t.length; i++) {
    const id = d.micro.id[i]!;
    const x = raster.x + (d.micro.t[i]! / d.micro.duration) * raster.w;
    const y = raster.y + (id / d.micro.neurons) * raster.h;
    ctx.fillStyle = id < d.micro.excitatory ? EMBER : CYAN;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x, y, 1.3, 1.3);
  }
  ctx.globalAlpha = 1;
  label(ctx, 'the population rate it tracks instead', pad, rate.y - 12);
  let hi = 0;
  for (const v of d.micro.rate) hi = Math.max(hi, v);
  plot(ctx, d.micro.rate, rate, 0, hi || 1, EMBER, 1.4);
}

/** the same machinery at three sizes */
function figScales(c: HTMLCanvasElement, d: Data): void {
  const p = prep(c);
  if (!p) return;
  const { ctx, w, h } = p;
  const pad = 4;
  const rowH = (h - 6) / 3;
  const rows: Array<[string, ArrayLike<number>, number, number, string]> = [
    ['one membrane · millivolts', d.neuronV, -90, 50, WARM],
    ['one circuit · spikes per millisecond', d.micro.rate, 0, Math.max(...Array.from(d.micro.rate)) || 1, CYAN],
    ['85 regions · mean activity', d.meanAwake, 0, 0.35, EMBER],
  ];
  rows.forEach(([name, vals, lo, hi, color], i) => {
    const y = 2 + i * rowH;
    label(ctx, name, pad, y);
    plot(ctx, vals, { x: pad, y: y + 12, w: w - pad * 2, h: rowH - 15 }, lo, hi, color, 1.3);
  });
}

/** a healthy state, the same brain seizing, and the seizure treated */
function figStates(c: HTMLCanvasElement, d: Data): void {
  const p = prep(c);
  if (!p) return;
  const { ctx, w, h } = p;
  const pad = 4;
  const rowH = (h - 6) / 3;
  const rows: Array<[string, number[], string]> = [
    ['awake', d.meanAwake, EMBER],
    ['the same brain, inhibition lowered', d.meanSeizure, EMBER],
    ['and given a benzodiazepine', d.meanTreated, CYAN],
  ];
  rows.forEach(([name, vals, color], i) => {
    const y = 2 + i * rowH;
    label(ctx, name, pad, y);
    plot(ctx, vals, { x: pad, y: y + 12, w: w - pad * 2, h: rowH - 15 }, 0, 1, color, 1.3);
  });
}

/** the same settings twice: the second line is drawn on top of the first */
function figRepeat(c: HTMLCanvasElement, d: Data): void {
  const p = prep(c);
  if (!p) return;
  const { ctx, w, h } = p;
  const pad = 4;
  const box: Box = { x: pad, y: 18, w: w - pad * 2, h: h - 24 };
  label(ctx, 'run once', pad, 1, EMBER);
  label(ctx, 'run again, same settings', w - pad, 1, CYAN, 'right');
  // the second run is drawn dashed and on top: the reader has to be able to
  // SEE two lines occupying one path, or the figure looks like a single run
  plot(ctx, d.repeatA, box, 0, 0.35, EMBER, 3);
  plot(ctx, d.repeatB, box, 0, 0.35, CYAN, 1.6, [7, 6]);
  let same = true;
  for (let i = 0; i < d.repeatA.length; i++) if (d.repeatA[i] !== d.repeatB[i]) { same = false; break; }
  label(ctx, same ? 'every sample identical' : 'the runs differ', pad, h - 12, same ? DIM : WARM);
}

const FIGURES: Record<string, (c: HTMLCanvasElement, d: Data) => void> = {
  populations: figPopulations,
  scales: figScales,
  states: figStates,
  repeat: figRepeat,
};

export interface AboutFigures {
  /** draw (computing the runs the first time); safe to call on every tab open */
  draw(): void;
}

export function startAboutFigures(): AboutFigures {
  let scheduled = false;
  const paint = (): void => {
    const canvases = document.querySelectorAll<HTMLCanvasElement>('canvas[data-figure]');
    if (!canvases.length) return;
    if (!data) data = compute();
    for (const c of canvases) {
      const fn = FIGURES[c.dataset.figure ?? ''];
      if (fn) fn(c, data);
    }
  };
  window.addEventListener('resize', () => {
    if (!data) return;
    paint();
  });
  // the first paint can land before the column has its final width (the
  // fonts, the container query): a canvas that changes size is painted again
  // at the size it actually has, so the figures are never a blurry upscale
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (data) paint(); });
    for (const c of document.querySelectorAll<HTMLCanvasElement>('canvas[data-figure]')) ro.observe(c);
  }
  return {
    draw(): void {
      // let the tab paint before integrating anything
      if (scheduled) { paint(); return; }
      scheduled = true;
      requestAnimationFrame(() => requestAnimationFrame(paint));
    },
  };
}
