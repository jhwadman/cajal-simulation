/**
 * src/lib/client.ts — the site's one client module.
 *
 * It owns the state — the current run, the playhead, the view — and does
 * three things: talks to the relay (ask the agent, fetch runs, store bench
 * runs), runs the engine in this browser when there is no relay, and drives
 * the drawing functions in render.ts every frame.
 *
 * EVERY STRING REACHES THE DOM THROUGH textContent OR createElement. Model
 * output goes on this page; innerHTML would make it a render path.
 */
import { cssGradient, cssGradientDiff, diffPos } from './colormap.ts';

import { drawBrain, drawTraces, drawRaster, drawScatter, hitTest } from './render.ts';
import { loadMesh, LOBE_ORDER } from './surface.ts';
import { renderMarkdown } from './markdown.ts';
import type { BrainMesh } from './surface.ts';
import { createBrainGL } from './gl.ts';
import { loadVolume, drawSlice, pickVoxel, toVoxel, toWorld, labelAt, PLANES } from './slice.ts';
import type { Volume, Plane } from './slice.ts';
import type { BrainGL } from './gl.ts';
import type { RegionLite, EdgeLite, View, Marks } from './render.ts';
import { REGIONS, connectome, PRESETS, presetById, simulateMicrocircuit, summarizeMicrocircuit, N, treatmentById, applyTreatment, rhythmLabel, FLAT_AMPLITUDE} from '../../service/engine/index.ts';
import type { Treatment, NeuronParams } from '../../service/engine/index.ts';
import { simulateBrain } from './sim.ts';
import { startNeuronTab } from './neuronTab.ts';
import { startAboutFigures } from './aboutFigures.ts';
import { startInvestigations } from './investigate.ts';
import type { InvestigationHost, Investigations } from './investigate.ts';
import { drawEegTrace, peakUv } from './eegTrace.ts';
import { drawSweepChart } from './sweepChart.ts';
import type { EegWaveform } from './eegTrace.ts';
import { renderTrace, choseFromParams } from './trace.ts';
import type { TraceEntry } from './trace.ts';
import type { WholeBrainParams, WholeBrainRun, WholeBrainSummary } from '../../service/engine/index.ts';

/* ── the run shapes the page draws (mirrors service/runs.ts payloads) ────── */

interface RunBase { id: string; kind: string; title: string; text?: string }
/** a run's time series: the engine's array in the browser, JSON's over the relay */
type Series = number[] | Float32Array;

interface BrainRun extends RunBase {
  kind: 'whole-brain';
  params: { duration_ms: number; stimulation: Array<{ nodes: number[] }>; lesions: Array<{ nodes: number[] }> };
  dt_ms: number;
  frames: number;
  n: number;
  /* A run made in the browser keeps the engine's own Float32Array; a run
     that came over the relay is JSON, so it arrives as number[]. Both are
     read by index and never mutated, so the page holds whichever it was
     given rather than copying 200k doubles into a second array. */
  activity: Series;
  meanField: Series;
  synchronyTrace: Series;
  summary: {
    global: { mean: number; synchrony: number; peakHz: number; dominantBand: string; bands: Record<string, number>; amplitude: number };
    lobes: Array<{ lobe: string; mean: number; peakHz: number; dominantBand: string }>;
    regions: Array<{ id: string; label: string; mean: number; std: number; peakHz: number }>;
    hemispheres: { left: number; right: number; homotopicCorrelation: number };
    latencies: Array<{ id: string; label: string; latency_ms: number }>;
    entrainment?: Array<{ id: string; label: string; hz: number; gain: number }>;
    notes: string[];
  };
}
interface MicroRun extends RunBase {
  kind: 'microcircuit';
  params: { neurons: number; excitatory: number; duration_ms: number };
  spikes: { t: number[]; id: number[] };
  rate: number[];
  summary: { rateE: number; rateI: number; synchrony: number; peakHz: number; dominantBand: string; bands: Record<string, number>; isiCv: number; silentFraction: number; notes: string[] };
}
interface DataRun extends RunBase { kind: 'eeg' | 'fmri' | 'singlecell' | 'imaging'; result: any; overlay?: string }
/* A sweep is one parameter varied, not one state integrated: it has points and
   a transition where the others have frames. `sweep` is the engine's
   BrainSweep or NeuronSweep, told apart by its own `kind`. */
interface SweepRun extends RunBase { kind: 'sweep'; sweep: any; computeMs?: number }
type Run = BrainRun | MicroRun | DataRun | SweepRun;

type LoopEvent =
  | { type: 'loop_start'; model: string; states: number; labramConfigured: boolean }
  | { type: 'stage'; stage: 'define' | 'simulate' | 'evaluate' | 'done'; note: string }
  | { type: 'scenarios'; scenarios: Array<{ name: string; preset: string; knobs: Record<string, number>; expected_eeg: string }>; raw: string; model: string }
  | { type: 'trial'; index: number; trial: { name: string; preset?: string; runId: string; eegRunId: string; labram: boolean; windows: number; dominantBand: string; morphology: Record<string, number> | null } }
  | { type: 'verdict'; index: number; verdict: { truth: string; pick: string; judgeConfidence: number; reason: string; correct: boolean; labramConfidence: number; labramPick: string; labramCorrect: boolean } }
  | { type: 'result'; result: { runId?: string; model?: string; pass: boolean; judgeAccuracy: number; labramAccuracy: number; overallConfidence: number; separability: { accuracy: number; windows: number; chance: number }; ms: number } }
  | { type: 'loop_error'; message: string };

interface StateSpec {
  id: string;
  created: number;
  title: string;
  summary: string;
  rationale: string;
  expect: string;
  basedOn?: string;
  params: WholeBrainParams;
  treatment?: { id: string; name: string; dose: number };
  unresolved: string[];
}

type PageEvent =
  | { type: 'loop'; event: LoopEvent }
  | { type: 'spec'; spec: StateSpec }
  | { type: 'accepted'; contextId: string; question: string }
  | { type: 'route'; route: string; reason: string }
  | { type: 'tool'; name: string }
  | { type: 'sim'; runId: string; kind: string; title: string }
  | { type: 'text'; text: string }
  | { type: 'done'; ms: number }
  | { type: 'error'; message: string };

/* ── DOM ─────────────────────────────────────────────────────────────────── */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const BAND_NAMES = ['delta', 'theta', 'alpha', 'beta', 'gamma'];

/**
 * Keeping a transcript on its newest message, without yanking a reader who
 * has scrolled up to re-read something: ask `follows()` BEFORE appending, and
 * `stickToEnd()` after.
 *
 * The scroll is explicitly instant. `.messages` carries
 * `scroll-behavior: smooth` for the reader's own scrolling, and under it a
 * plain `scrollTop = scrollHeight` silently does nothing at all — the
 * transcript sat at the top while four messages piled up below the fold.
 */
const FOLLOW_SLACK = 120;
const follows = (el: HTMLElement): boolean => el.scrollHeight - el.clientHeight - el.scrollTop < FOLLOW_SLACK;
const stickToEnd = (el: HTMLElement, was: boolean): void => {
  if (was) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
};

export function start(): void {
  const root = $('studio');
  // the legend's bar IS the scale the cortex is painted with: same table,
  // same clip, generated rather than written out a second time in CSS
  const scaleRamp = document.getElementById('scale-ramp');
  if (scaleRamp) scaleRamp.style.background = cssGradient();
  const contrastRamp = document.getElementById('contrast-ramp');
  if (contrastRamp) contrastRamp.style.background = cssGradient();
  const contrastRampDiff = document.getElementById('contrast-ramp-diff');
  if (contrastRampDiff) contrastRampDiff.style.background = cssGradientDiff();
  const neuronTab = startNeuronTab();
  const aboutFigures = startAboutFigures();
  type Tab = 'about' | 'sim' | 'bench' | 'neuron' | 'inv' | 'glossary';
  let activeTab: Tab = 'about';
  const relay = (root.dataset.relay ?? '').replace(/\/$/, '');
  const live = relay.length > 0;
  /** what hovering an AI control says when this build has no relay — one
      sentence, and it names the half of the studio that still works */
  const OFFLINE_HINT =
    'AI features are offline: this build has no relay, so Cajal cannot design a state. Everything under “pick a preset” runs in your browser and needs nothing.';

  const brain = $<HTMLCanvasElement>('brain');
  const traces = $<HTMLCanvasElement>('traces');
  const raster = $<HTMLCanvasElement>('raster');
  const auxPanel = $('aux-panel');
  const auxImg = $<HTMLImageElement>('aux-img');
  /* The aux panel hosts both kinds of answer, so its badge is set per run
     rather than fixed in the markup: no panel goes unbadged, and --ai means
     artificial intelligence wherever it appears. */
  const setAuxBadge = (kind: 'math' | 'ai', title: string) => {
    const b = $('aux-badge');
    b.className = `badge ${kind}`;
    b.textContent = kind === 'ai' ? 'AI' : 'math';
    b.title = title;
  };
  const playBtn = $<HTMLButtonElement>('play');
  const scrub = $<HTMLInputElement>('scrub');
  const timeEl = $('time');
  const speedSel = $<HTMLSelectElement>('speed');
  const status = $('status');
  const statusText = $('status-text');

  const regions: RegionLite[] = REGIONS.map((r) => ({ ...r }));
  // the real brain mesh (fsaverage6 + MNI152), same origin, once; WebGL draws it under the overlay
  const glCanvas = $<HTMLCanvasElement>('brain-gl');
  let brainGL: BrainGL | null = null;
  let brainMesh: BrainMesh | null = null;
  loadMesh('/brain/mesh.bin', regions)
    .then((mesh) => {
      brainMesh = mesh;
      brainGL = createBrainGL(glCanvas, mesh);
      if (!brainGL) console.warn('WebGL unavailable: drawing regions only');
      invalidate();
    })
    .catch((err) => console.warn('brain mesh not loaded:', err));
  const edges: EdgeLite[] = connectome().edges.slice(0, 260);
  const view: View = { yaw: Math.PI + 0.35, pitch: 0.32, auto: true, zoom: 1 };
  /** yaw carried past pointer-up, rad/ms: a flick keeps the brain turning and damping brings it to rest */
  let spin = 0;
  /** when a drag interrupted the orbit, the wall time at which it resumes; 0 = it does not */
  let resumeAt = 0;
  const marks: Marks = { stimulated: new Set(), lesioned: new Set(), masked: new Set() };

  let run: Run | null = null;
  /** per-frame activity for the brain: frame-major, n per frame */
  let frames: { data: ArrayLike<number>; count: number; n: number; dt: number } | null = null;
  /** a static painting (EEG) instead of frames */
  let staticActivity: number[] | null = null;
  let frame = 0;
  let playing = false;
  let lastT = 0;
  let positions: ReturnType<typeof drawBrain> = [];
  /** bumped whenever something the render loop cannot see cheaply has changed (see tick) */
  let revision = 0;
  const invalidate = () => { revision++; };
  let lastKey = '';
  let hover = -1;
  /** organ: opaque, hover names the lobe under the cursor; depth: glass brain, signals located in depth */
  let mode: 'organ' | 'depth' | 'slice' = 'organ';
  try {
    const saved = localStorage.getItem('cajal.mode');
    if (saved === 'depth' || saved === 'slice') mode = saved;
  } catch (_) { /* storage blocked: organ */ }

  // the cross-section view: a volume, a focus voxel, three panes
  let volume: Volume | null = null;
  let focus: [number, number, number] = [36, 45, 39];
  let focusRegion = -1;
  let sliceHover = -1;
  const sliceCanvas: Record<Plane, HTMLCanvasElement> = { sagittal: $<HTMLCanvasElement>('slice-sagittal'), coronal: $<HTMLCanvasElement>('slice-coronal'), axial: $<HTMLCanvasElement>('slice-axial') };
  const sliceScratch: Record<Plane, { img?: ImageData; key?: string }> = { sagittal: {}, coronal: {}, axial: {} };
  const sliceGeom: Partial<Record<Plane, { scale: number; ox: number; oy: number; w: number; h: number }>> = {};
  const sliceZoom: Record<Plane, number> = { sagittal: 1, coronal: 1, axial: 1 };
  /* The volume is loaded on the FIRST switch to the slice view, not at boot:
     it is the largest file the page ships and most visits never cut the
     brain. One promise, so a second click while it is in flight waits on the
     same download. */
  let volumeLoad: Promise<void> | null = null;
  function ensureVolume(): Promise<void> {
    if (!volumeLoad) {
      $('slice-focus').textContent = 'loading the sections…';
      volumeLoad = loadVolume('/brain/volume.bin')
        .then((v) => { volume = v; focusCentre(); invalidate(); })
        .catch((err) => {
          console.warn('brain volume not loaded:', err);
          $('slice-focus').textContent = 'the sections could not be loaded';
          volumeLoad = null;
        });
    }
    return volumeLoad;
  }

  /** the run's most relevant region: stimulated, else lesioned, else the most active */
  function relevantRegion(): number {
    if (!run) return -1;
    if (run.kind === 'whole-brain') {
      const st = run.params.stimulation[0]?.nodes[0];
      if (st !== undefined) return st;
      const le = run.params.lesions[0]?.nodes[0];
      if (le !== undefined) return le;
      let best = -1;
      let bm = -1;
      run.summary.regions.forEach((r, i) => { if (r.mean > bm) { bm = r.mean; best = i; } });
      return best;
    }
    if (run.kind === 'eeg') {
      const regs = run.result.features.regions as Record<string, number[]>;
      const alphaIdx = (run.result.features.bands as string[]).indexOf('alpha');
      let best = -1;
      let bv = -1;
      for (const [rid, vec] of Object.entries(regs)) { const i = REGIONS.findIndex((q) => q.id === rid); if (i >= 0 && vec[alphaIdx]! > bv) { bv = vec[alphaIdx]!; best = i; } }
      return best;
    }
    if (run.kind === 'fmri') {
      const hubs = run.result.graph.hubs_by_strength as string[] | undefined;
      const i = hubs?.length ? REGIONS.findIndex((q) => q.id === hubs[0]) : -1;
      return i;
    }
    return REGIONS.findIndex((q) => q.id === 'L_thalamus');
  }

  function focusOnPeak(): void {
    if (!volume) return;
    const i = relevantRegion();
    focusRegion = i;
    const r = i >= 0 ? regions[i]! : { x: 0, y: -18, z: 12, label: 'the centre' };
    focus = toVoxel(volume, r.x, r.y, r.z);
    $('slice-focus').textContent = i >= 0 ? `crosshair on ${r.label}` : 'crosshair at the centre';
  }

  /** the default: a crosshair at the centre of the brain and nothing highlighted */
  function focusCentre(): void {
    if (!volume) return;
    focus = [Math.floor(volume.nx / 2), Math.floor(volume.ny * 0.55), Math.floor(volume.nz / 2)];
    focusRegion = -1;
    $('slice-focus').textContent = 'hover to name a region · click to move the cut';
  }

  function drawSlices(activity: ArrayLike<number> | null): void {
    if (!volume) return;
    // a region is highlighted only while the cursor is over it
    const hl = sliceHover;
    for (const plane of PLANES) sliceGeom[plane] = drawSlice(sliceCanvas[plane], volume, plane, focus, activity, hl, sliceScratch[plane], sliceZoom[plane]);
  }

  for (const plane of PLANES) {
    const c = sliceCanvas[plane];
    const at = (e: PointerEvent) => {
      if (!volume || !sliceGeom[plane]) return null;
      const rect = c.getBoundingClientRect();
      return pickVoxel(volume, plane, focus, sliceGeom[plane]!, e.clientX - rect.left, e.clientY - rect.top);
    };
    c.addEventListener('pointerdown', (e) => {
      const vox = at(e);
      if (!vox || !volume) return;
      focus = vox;
      focusRegion = labelAt(volume, ...vox);
      const [wx, wy, wz] = toWorld(volume, ...vox);
      $('slice-focus').textContent = `crosshair on ${focusRegion >= 0 ? regions[focusRegion]!.label : 'tissue outside the atlas'} · MNI (${wx.toFixed(0)}, ${wy.toFixed(0)}, ${wz.toFixed(0)}) mm`;
    });
    c.addEventListener('pointermove', (e) => {
      const vox = at(e);
      const hv = $('hover');
      if (!vox || !volume) { sliceHover = -1; hv.textContent = ''; return; }
      sliceHover = labelAt(volume, ...vox);
      if (sliceHover >= 0) {
        const r = regions[sliceHover]!;
        const a = currentActivity();
        const lobe = r.lobe === 'cerebellum' || r.lobe === 'brainstem' || r.lobe === 'subcortical' ? r.lobe : `${r.lobe} lobe`;
        hv.textContent = `${lobe} · ${r.label}${a ? ` · ${(a[sliceHover] ?? 0).toFixed(2)}` : ''}`;
      } else hv.textContent = '';
    });
    c.addEventListener('pointerleave', () => { sliceHover = -1; $('hover').textContent = ''; });
  }
  $('slice-peak').addEventListener('click', () => focusOnPeak());
  let hoverLobe = -1;
  /** the phases of the current run: what is happening between which times */
  interface Phase { from: number; to: number; label: string; kind: 'stim' | 'lesion' | 'baseline' | 'after' }
  let phases: Phase[] = [];
  let staticNotes: string[] = [];
  /** what the bench ran, per run id: the chips say so even when a title cannot */
  const benchState = new Map<string, { condition: string; treatment: string; dose: number }>();
  /** what the run on screen IS: the rows under the control bench */
  let composition: Array<[string, string]> = [];
  /** the id of the last benchmark run stored by the relay, so Cajal can be asked about it */
  let lastBenchmarkId: string | null = null;
  let contextId = crypto.randomUUID();
  let busy = false;
  const runIndex = new Map<string, { id: string; kind: string; title: string }>();

  /**
   * The header status pill. `ready` means everything is connected and there is
   * nothing to say, and in that state THE PILL IS NOT ON THE PAGE — a chip that
   * reads "all good" permanently, in the corner of the eye, is chrome rather
   * than an instrument (owner call 2026-09-11). It appears only for the states
   * a reader can act on: `busy` while the model integrates, `off` when the
   * relay is absent, `error` with the reason. `live` is kept for the partly-up
   * cases (relay without an API key, tools without the model service), which
   * are news even though nothing failed.
   */
  /* The pill reports what is HAPPENING, never what is missing. `ready` is
     absent, and there is no resting state that sits in the header naming an
     absence: a build with no relay is the studio's ordinary public shape, not
     a fault, and a permanent badge announcing it makes the whole page look
     degraded. Where the agent is actually needed — the describe tab, its
     composer — the control says so itself, on hover and in place. Busy and
     error still show, because those are events. */
  const setStatus = (state: 'ready' | 'live' | 'busy' | 'error', text: string) => {
    status.dataset.state = state;
    statusText.textContent = text;
    status.hidden = state === 'ready';
  };

  /* ── loading a run ─────────────────────────────────────────────────────── */

  function clearMarks(): void {
    marks.stimulated.clear();
    marks.lesioned.clear();
    marks.masked.clear();
  }

  function setRun(r: Run): void {
    run = r;
    frames = null;
    staticActivity = null;
    frame = 0;
    playing = false;
    clearMarks();
    playBtn.setAttribute('aria-pressed', 'false');
    playBtn.textContent = 'play';
    $('run-title').textContent = r.title;
    $('run-kind').textContent = `${r.kind === 'whole-brain' ? 'whole-brain run' : r.kind === 'microcircuit' ? 'cell-by-cell run' : `${r.kind} analysis`} · ${r.id}`;
    $('legend-extra').textContent = '';
    /* The cortical viewport and the activity readout stand down when the CT panel is the picture. */
    const brainless = r.kind === 'sweep';
    $('brain-panel').hidden = brainless;
    $('traces-panel').hidden = brainless;
    auxPanel.hidden = true;
    auxImg.hidden = true;
    $('notes').hidden = true;
    $('notes').replaceChildren();
    $('summary').replaceChildren();
    $('aux-summary').replaceChildren();
    setBands(null);

    phases = [];
    staticNotes = [];
    composition = [];
    setChips(r);
    if (r.kind === 'whole-brain') {
      frames = { data: r.activity, count: r.frames, n: r.n, dt: r.dt_ms };
      for (const l of r.params.lesions) for (const i of l.nodes) marks.lesioned.add(i);
      // the run's phases: baseline, each stimulation window, and what follows
      const total = r.params.duration_ms;
      const stims = (r.params.stimulation as Array<{ region: string; nodes: number[]; onset_ms: number; duration_ms: number; frequency_hz: number; amplitude: number }>);
      const firstOn = stims.length ? Math.min(...stims.map((st) => st.onset_ms)) : total;
      if (stims.length && firstOn > 0) phases.push({ from: 0, to: Math.min(firstOn, total), label: 'baseline', kind: 'baseline' });
      for (const st of stims) {
        const names = st.nodes.slice(0, 3).map((i) => regions[i]!.label.replace(/^(left|right) /, (m) => `${m[0]!.toUpperCase()} `)).join(', ') + (st.nodes.length > 3 ? ` +${st.nodes.length - 3}` : '');
        phases.push({ from: st.onset_ms, to: Math.min(total, st.onset_ms + st.duration_ms), label: `stimulating ${names}${st.frequency_hz > 0 ? ` at ${st.frequency_hz} Hz` : ' (constant)'}, amplitude ${st.amplitude}`, kind: 'stim' });
      }
      const lastOff = stims.length ? Math.max(...stims.map((st) => st.onset_ms + st.duration_ms)) : 0;
      if (stims.length && lastOff < total) phases.push({ from: lastOff, to: total, label: 'after stimulation', kind: 'after' });
      if (r.params.lesions.length) {
        const les = r.params.lesions as Array<{ region: string; nodes: number[]; severity: number }>;
        const count = (ls: typeof les) => ls.reduce((a, l) => a + l.nodes.length, 0);
        const gone = les.filter((l) => l.severity >= 1);
        const part = les.filter((l) => l.severity < 1);
        const bits: string[] = [];
        if (gone.length) bits.push(`${gone.map((l) => l.region).join(', ')} — ${count(gone)} regions silenced`);
        if (part.length) bits.push(part.map((l) => `${l.region} ${Math.round(l.severity * 100)}% destroyed`).join(', '));
        composition.push(['lesioned', bits.join(' · ')]);
      }
      const rd = (r.params as { regional_drive?: Array<{ region: string; factor: number }> }).regional_drive ?? [];
      const up = rd.filter((d) => d.factor > 1).map((d) => d.region);
      const down = rd.filter((d) => d.factor < 1).map((d) => d.region);
      if (up.length) composition.push(['engaged', up.join(', ')]);
      if (down.length) composition.push(['quietened', down.join(', ')]);
      if (stims.length) composition.push(['stimulated', stims.map((st) => `${st.region} at ${st.frequency_hz > 0 ? `${st.frequency_hz} Hz` : 'DC'}`).join(', ')]);
      const g = r.summary.global;
      $('traces-title').textContent = 'Readout · activity over time';
      $('traces-sub').textContent = `${r.params.duration_ms} ms · 85 regions`;
      setBands(g.bands);
      lines('summary', [
        ['mean activity', g.mean.toFixed(2)],
        ['amplitude', g.amplitude.toFixed(3)],
        ['synchrony', g.synchrony.toFixed(2)],
        ['dominant rhythm', rhythmLabel(g.peakHz, g.dominantBand, g.amplitude)],
        ['left / right', `${r.summary.hemispheres.left.toFixed(2)} / ${r.summary.hemispheres.right.toFixed(2)} · homotopic r ${r.summary.hemispheres.homotopicCorrelation.toFixed(2)}`],
        ['most active', r.summary.regions.slice().sort((a, b) => b.mean - a.mean).slice(0, 4).map((x) => `${x.id} ${x.mean.toFixed(2)}`).join(', ')],
        ...(r.summary.latencies.length ? [['first responders', r.summary.latencies.slice(0, 4).map((l) => `${l.id} +${l.latency_ms} ms`).join(', ')] as [string, string]] : []),
        ...(r.summary.entrainment?.length ? [['entrained', r.summary.entrainment.slice(0, 4).map((e) => `${e.id} ×${e.gain}`).join(', ')] as [string, string]] : []),
      ]);
      setNotes(r.summary.notes);
      playing = true;
      playBtn.setAttribute('aria-pressed', 'true');
      playBtn.textContent = 'pause';
    } else if (r.kind === 'microcircuit') {
      const s = r.summary;
      auxPanel.hidden = false;
      setAuxBadge('math', 'plain mathematics: equations solved on this machine; no AI involved');
      $('aux-caption').textContent = 'Each dot is one neuron firing once: orange excitatory, cyan inhibitory, time left to right; the line underneath counts spikes per millisecond.';
      $('aux-title').textContent = 'Cell by cell';
      $('aux-sub').textContent = `${r.params.neurons} neurons · ${r.params.duration_ms} ms`;
      raster.hidden = false;
      $('traces-title').textContent = 'Readout · spikes per millisecond';
      $('traces-sub').textContent = 'spikes per ms';
      setBands(s.bands);
      lines('aux-summary', [
        ['firing', `E ${s.rateE.toFixed(1)} Hz · I ${s.rateI.toFixed(1)} Hz · ${Math.round(s.silentFraction * 100)}% silent`],
        ['synchrony (Fano)', s.synchrony.toFixed(1)],
        ['ISI CV', s.isiCv.toFixed(2)],
        ['rhythm', `${s.peakHz.toFixed(1)} Hz ${s.dominantBand}`],
      ]);
      setNotes(s.notes);
      // the brain view shows the population rate as a uniform glow
      const dt = 4;
      const count = Math.floor(r.params.duration_ms / dt);
      const data = new Float32Array(count * N);
      let max = 1;
      for (const v of r.rate) max = Math.max(max, v);
      for (let f = 0; f < count; f++) {
        let m = 0;
        for (let k = 0; k < dt; k++) m += r.rate[f * dt + k] ?? 0;
        const a = Math.min(1, m / dt / max) * 0.9 + 0.05;
        for (let i = 0; i < N; i++) data[f * N + i] = a;
      }
      frames = { data, count, n: N, dt };
      $('legend-extra').textContent = '· whole network lit by the population rate';
      playing = true;
      playBtn.setAttribute('aria-pressed', 'true');
      playBtn.textContent = 'pause';
    } else if (r.kind === 'eeg') {
      const f = r.result.features;
      const bands = f.bands as string[];
      const alphaIdx = bands.indexOf('alpha');
      staticActivity = new Array(N).fill(0);
      const painted = new Set<number>();
      for (const [rid, vec] of Object.entries(f.regions as Record<string, number[]>)) {
        const i = REGIONS.findIndex((q) => q.id === rid);
        if (i >= 0) {
          staticActivity[i] = Math.min(1, vec[alphaIdx]! * 1.4);
          painted.add(i);
        }
      }
      for (let i = 0; i < N; i++) if (!painted.has(i)) marks.masked.add(i);
      $('legend-extra').textContent = '· relative alpha power under each electrode';
      $('traces-title').textContent = 'Readout · rhythm over the recording';
      $('traces-sub').textContent = `${r.result.preprocessing.windows} windows · ${r.result.model}`;
      setBands(f.global);
      lines('summary', [
        ['recording', `${r.result.original.channels} ch @ ${r.result.original.sfreq} Hz · ${r.result.original.duration_s.toFixed(0)} s`],
        ['dominant band', f.dominant_band],
        ['model', r.result.model],
        ['regions painted', String(Object.keys(f.regions).length)],
      ]);
    } else if (r.kind === 'fmri') {
      const series = r.result.regions.series as number[][];
      const mask = r.result.regions.mask as boolean[];
      const count = series.length;
      const data = new Float32Array(count * N);
      for (let f = 0; f < count; f++) for (let i = 0; i < N; i++) data[f * N + i] = 1 / (1 + Math.exp(-(series[f]![i] ?? 0) * 1.2));
      frames = { data, count, n: N, dt: r.result.tr_s * 1000 };
      for (let i = 0; i < N; i++) if (!mask[i]) marks.masked.add(i);
      $('legend-extra').textContent = '· BOLD z-score per region; hollow = no parcel';
      $('traces-title').textContent = 'Readout · average signal over the scan';
      $('traces-sub').textContent = `${count} frames · TR ${r.result.tr_s} s · ${r.result.model}`;
      const g = r.result.graph;
      lines('summary', [
        ['mapped regions', `${r.result.regions.mapped.length} of 85`],
        ['mean FC', Number(g.mean_fc).toFixed(2)],
        ['interhemispheric FC', Number(g.interhemispheric_fc).toFixed(2)],
        ['hubs', (g.hubs_by_strength as string[]).slice(0, 5).join(', ')],
      ]);
      playing = true;
      playBtn.setAttribute('aria-pressed', 'true');
      playBtn.textContent = 'pause';
    } else if (r.kind === 'singlecell') {
      auxPanel.hidden = false;
      const embed = r.result.embedding?.model as string | undefined;
      setAuxBadge(embed && embed !== 'pca' ? 'ai' : 'math', `the cells were embedded by ${r.result.model}`);
      $('aux-caption').textContent = 'Each point is one cell, placed by its expression profile; colour is the Leiden cluster, and the label under each is a marker-panel guess rather than an annotation.';
      $('aux-title').textContent = 'Cells by type';
      $('aux-sub').textContent = `${r.result.cells} cells · ${r.result.model}`;
      raster.hidden = false;
      const sizes = r.result.clusters.sizes as Record<string, number>;
      const guess = r.result.clusters.guessed_type as Record<string, string | null>;
      lines('aux-summary', Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => [`cluster ${c}`, `${n} cells · ${guess[c] ?? 'unassigned'}`] as [string, string]));
      if (r.result.umap) drawScatter(raster, r.result.umap, r.result.cluster_of_cell, guess);
      $('traces-title').textContent = 'Readout';
      $('traces-sub').textContent = 'single-cell';
    } else if (r.kind === 'imaging') {
      auxPanel.hidden = false;
      setAuxBadge('ai', `segmented by ${r.result.model}, a neural network`);
      $('aux-caption').textContent = 'The image as it was given, with the outline the model drew around each cell it found.';
      $('aux-title').textContent = 'Cells found in the image';
      $('aux-sub').textContent = `${r.result.cells} cells · ${r.result.model}`;
      raster.hidden = true;
      if (live) {
        auxImg.src = `${relay}/runs/${r.id}/image`;
        auxImg.alt = 'the image with each segmented cell outlined';
        auxImg.hidden = false;
      }
      const a = r.result.area_px;
      lines('aux-summary', [
        ['cells', String(r.result.cells)],
        ['area px', `mean ${Math.round(a.mean)} · median ${Math.round(a.median)}`],
        ['coverage', `${Math.round(r.result.coverage * 100)}%`],
      ]);
      $('traces-title').textContent = 'Readout';
      $('traces-sub').textContent = 'imaging';
    } else if (r.kind === 'sweep') {
      /* Eleven runs with one thing changed between them. The page already
         draws exactly this on the Investigate tab; `drawSweepChart` is that
         one drawing, reused here rather than copied. */
      auxPanel.hidden = false;
      raster.hidden = false;
      auxImg.hidden = true;
      const sw = r.sweep;
      const neuron = sw.kind === 'neuron';
      const variable = String(neuron ? sw.field : sw.variable) + (sw.treatment ? ` · ${sw.treatment}` : '');
      const measure = String(sw.measure);
      const pts = (sw.points ?? []) as Array<Record<string, number | null>>;
      setAuxBadge('math', 'plain mathematics: one parameter varied, every other setting and the seed held still');
      $('aux-title').textContent = `Sweep · ${measure} against ${variable}`;
      $('aux-sub').textContent = `${pts.length} runs · ${neuron ? 'one neuron' : 'whole brain'} · ${sw.monotone ? 'monotone' : 'not monotone'}`;
      $('aux-caption').textContent = 'One parameter along the bottom, one measure up the side, one simulation per point — every other setting and the seed held still. The cyan mark is where the model turned, which is a property of the model rather than a measured constant of any brain.';
      const t = sw.transition;
      drawSweepChart(raster, {
        xs: pts.map((p) => Number(p.value)),
        series: [{ label: measure, values: pts.map((p) => (p[measure] == null ? null : Number(p[measure]))), color: '#35d6ff' }],
        xLabel: variable,
        yLabel: measure,
        filled: pts.length,
        marker: t ? { x: Number(t.at), label: `turns at ${Number(t.at).toFixed(2)}` } : null,
      });
      lines('aux-summary', gotFromRun(r as unknown as Record<string, any>));
      $('traces-title').textContent = 'Readout';
      $('traces-sub').textContent = 'sweep';
    }

    contrastOf = r;
    if (r.kind === 'whole-brain') toast('▶', `${r.title} — integrated, now playing`, `${r.params.duration_ms} ms · ${r.id}`);
    else if (r.kind === 'microcircuit') toast('▶', `${r.title} — integrated, now playing`, `${r.params.duration_ms} ms · ${r.id}`);
    else toast('◆', `${r.title} — analysis loaded`, r.id);
    focusCentre();
    const hasTime = !!frames && frames.count > 1;
    playBtn.disabled = !hasTime;
    scrub.disabled = !hasTime;
    scrub.max = hasTime ? String(frames!.count - 1) : '0';
    scrub.value = '0';
    drawInstruments();
    invalidate();
  }

  /* ── the still contrast figure ─────────────────────────────────────────
   * The animated brain shows what a run DOES; it is a poor way to see what a
   * condition or a drug CHANGED, because the reader has to hold the last run
   * in their head to compare. So every whole-brain run also gets three
   * stills: the awake baseline, this run, and the difference — one picture,
   * held still, on a scale that is printed rather than implied.
   *
   * The baseline is this page running the `awake` preset through the same
   * engine the run came from (the one-truth rule), so the two pictures are
   * comparable by construction. It is computed once and kept. */
  const STILL_VIEW: View = { yaw: -Math.PI / 2, pitch: 1.45, auto: false, zoom: 1 };
  /** below this, a difference is not worth a colour: the scale never zooms further in */
  const DIFF_FLOOR = 0.02;
  /**
   * The activity scale of the two stills never stretches BELOW this, so a
   * collapsed brain stays dark instead of being normalised into a bright one.
   * A run whose busiest region is above it sets its own top and the top is
   * printed: these are time-averages, an order of magnitude under the peaks
   * the live view paints, so the pair is windowed to its own range the way
   * the EEG strips are.
   */
  const STILL_TOP = 0.30;
  let awakeBaseline: { means: number[]; mean: number } | null = null;
  let contrastOf: Run | null = null;

  /**
   * The awake brain the contrast figure compares against. It is one run of a
   * fixed preset, so it is computed once, on the worker, and kept.
   *
   * Until it lands there is nothing honest to draw — a difference map with a
   * missing baseline is every region reading as changed — so the figure
   * waits rather than showing a wrong one, and redraws itself when the run
   * arrives.
   */
  let baselinePending: Promise<void> | null = null;
  function baseline(): { means: number[]; mean: number } | null {
    if (awakeBaseline) return awakeBaseline;
    baselinePending ??= simulateBrain(presetById('awake')!.brain!).then(({ summary: s }) => {
      awakeBaseline = { means: s.regions.map((r) => r.mean), mean: s.global.mean };
      if (contrastOf) drawContrast(contrastOf);
    });
    return null;
  }

  function still(id: string, activity: number[], signed: boolean): void {
    drawBrain($<HTMLCanvasElement>(id), { regions, edges, activity, view: STILL_VIEW, meshDrawn: false, mode: 'depth', signed, orientation: false });
  }

  function drawContrast(r: Run | null): void {
    const panel = $('contrast-panel');
    if (!r || r.kind !== 'whole-brain') {
      panel.hidden = true;
      contrastOf = null;
      return;
    }
    contrastOf = r;
    const base = baseline();
    if (!base) { panel.hidden = true; return; } // the awake run is still integrating
    panel.hidden = false;
    const cur = r.summary.regions.map((x) => x.mean);
    const diff = cur.map((v, i) => v - (base.means[i] ?? 0));
    let widest = 0;
    for (const d of diff) widest = Math.max(widest, Math.abs(d));
    const span = Math.max(DIFF_FLOOR, widest);

    // both activity pictures on ONE windowed scale, and the window is printed
    let top = STILL_TOP;
    for (const v of cur) top = Math.max(top, v);
    for (const v of base.means) top = Math.max(top, v);
    still('contrast-a', base.means.map((v) => v / top), false);
    still('contrast-b', cur.map((v) => v / top), false);
    still('contrast-d', diff.map((d) => diffPos(d, span)), true);

    $('contrast-act-hi').textContent = top.toFixed(2);
    $('contrast-sub').textContent = `${r.title} · mean activity per region`;
    const capMean = document.createElement('span');
    capMean.className = 'dim';
    capMean.textContent = `mean ${r.summary.global.mean.toFixed(2)}`;
    $('contrast-b-cap').replaceChildren(document.createTextNode(`${r.title} `), capMean);
    $('contrast-a-sub').textContent = `mean ${base.mean.toFixed(2)}`;
    $('contrast-d-sub').textContent = `scale ±${span.toFixed(2)}`;
    $('contrast-lo').textContent = `−${span.toFixed(2)}`;
    $('contrast-hi').textContent = `+${span.toFixed(2)}`;

    // what moved, named: the regions are the part that ties a picture to a
    // mechanism, and the difference map is unreadable without them
    const named = diff.map((d, i) => ({ id: regions[i]!.id, d })).filter((x) => Math.abs(x.d) >= DIFF_FLOOR);
    const up = named.filter((x) => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 4);
    const down = named.filter((x) => x.d < 0).sort((a, b) => a.d - b.d).slice(0, 4);
    const fmt = (xs: typeof up) => xs.map((x) => `${x.id} ${x.d > 0 ? '+' : ''}${x.d.toFixed(2)}`).join(', ');
    $('contrast-note').textContent = widest < DIFF_FLOOR
      ? `Nothing moved: no region differs from the awake baseline by as much as ${DIFF_FLOOR.toFixed(2)}, so the difference picture is plain tissue.`
      : `Busier than awake: ${up.length ? fmt(up) : 'nothing'}. Quieter: ${down.length ? fmt(down) : 'nothing'}. Units are mean activity on the 0–1 scale, averaged over the whole run.`;
  }

  // the chat drawer takes 500px out of the column without a window resize, so
  // the stills watch their own panel rather than the window
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (contrastOf) drawContrast(contrastOf); }).observe($('contrast-panel'));
  } else {
    window.addEventListener('resize', () => { if (contrastOf) drawContrast(contrastOf); });
  }

  /**
   * A run is computed and then replayed, and until now the moment it started
   * was silent: the picture simply changed. This says it over the brain and
   * then leaves. It is NEWS — absent the rest of the time, like the header
   * pill — and it never carries information that is not also somewhere
   * permanent, because a message that disappears cannot be the only copy.
   */
  let toastTimer: number | undefined;
  function toast(mark: string, text: string, detail?: string): void {
    const el = $('brain-toast');
    window.clearTimeout(toastTimer);
    el.replaceChildren();
    const m = document.createElement('span');
    m.className = 'mark';
    m.textContent = mark;
    const t = document.createElement('span');
    t.textContent = text;
    el.append(m, t);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'dim';
      d.textContent = detail;
      el.append(d);
    }
    el.dataset.leaving = 'false';
    el.hidden = false;
    toastTimer = window.setTimeout(() => {
      el.dataset.leaving = 'true';
      toastTimer = window.setTimeout(() => { el.hidden = true; }, 260);
    }, 4200);
  }

  function lines(id: string, rows: Array<[string, string]>): void {
    const ul = $(id);
    ul.replaceChildren();
    for (const [k, v] of rows) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = `${k}: `;
      li.append(b, document.createTextNode(v));
      ul.append(li);
    }
  }

  function setNotes(notes: string[]): void {
    const ul = $('notes');
    ul.replaceChildren();
    ul.hidden = notes.length === 0;
    for (const n of notes) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.append(li);
    }
  }

  function setBands(bands: Record<string, number> | null): void {
    for (const b of BAND_NAMES) {
      const bar = root.querySelector<HTMLElement>(`[data-band="${b}"]`);
      const val = root.querySelector<HTMLElement>(`[data-band-v="${b}"]`);
      const v = bands ? bands[b] ?? 0 : 0;
      if (bar) bar.style.height = `${Math.max(2, v * 100)}%`;
      if (val) val.textContent = bands ? `${Math.round(v * 100)}%` : '–';
    }
  }

  /* ── drawing ───────────────────────────────────────────────────────────── */

  function currentActivity(): ArrayLike<number> | null {
    if (staticActivity) return staticActivity;
    if (!frames) return null;
    const f = Math.min(frames.count - 1, Math.max(0, frame | 0));
    const start = f * frames.n;
    return frames.data instanceof Float32Array
      ? frames.data.subarray(start, start + frames.n)
      : (frames.data as number[]).slice(start, start + frames.n);
  }

  function drawInstruments(): void {
    // the stills are drawn on an event like the readout, so they redraw with
    // it: a canvas drawn while its tab was hidden has no size and stays blank
    drawContrast(contrastOf);
    if (!run) {
      drawTraces(traces, [], null);
      return;
    }
    const ph = frames && frames.count > 1 ? frame / (frames.count - 1) : null;
    if (run.kind === 'whole-brain') {
      drawTraces(traces, [
        { values: run.meanField, color: 'rgba(255,106,61,0.95)', max: Math.max(0.5, ...run.meanField.slice(0, 2000)) },
        { values: run.synchronyTrace, color: 'rgba(53,214,255,0.9)', max: 1 },
      ], ph, { left: 'mean activity', right: 'synchrony' });
    } else if (run.kind === 'microcircuit') {
      drawTraces(traces, [{ values: run.rate, color: 'rgba(255,106,61,0.95)', max: Math.max(1, ...run.rate) }], ph, { left: 'spikes / ms' });
      drawRaster(raster, run.spikes, run.params.neurons, run.params.excitatory, run.params.duration_ms, run.rate, ph);
    } else if (run.kind === 'eeg') {
      const pw = run.result.features.per_window as number[][];
      const alphaIdx = (run.result.features.bands as string[]).indexOf('alpha');
      drawTraces(traces, [{ values: pw.map((w) => w[alphaIdx]!), color: 'rgba(255,106,61,0.95)', max: 1 }], null, { left: 'alpha fraction per window' });
    } else if (run.kind === 'fmri' && frames) {
      const mean = new Array(frames.count).fill(0);
      for (let f = 0; f < frames.count; f++) {
        let m = 0;
        let c = 0;
        for (let i = 0; i < N; i++) if (!marks.masked.has(i)) { m += frames.data[f * N + i]!; c++; }
        mean[f] = c ? m / c : 0;
      }
      drawTraces(traces, [{ values: mean, color: 'rgba(255,106,61,0.95)', max: 1 }], ph, { left: 'mean BOLD (sigmoid of z)' });
    } else {
      drawTraces(traces, [], null);
    }
    // annotations: the phase strip under the scrubber and the live caption on the brain
    drawPhaseStrip();
    updateAnnotation();
    renderComposition();
    if (frames) {
      const ms = frame * frames.dt;
      timeEl.textContent = ms >= 10000 ? `${(ms / 1000).toFixed(1)} s / ${(frames.count * frames.dt / 1000).toFixed(0)} s` : `${Math.round(ms)} ms / ${Math.round(frames.count * frames.dt)} ms`;
      scrub.value = String(Math.round(frame));
    } else {
      timeEl.textContent = '—';
    }
  }

  /**
   * The chips over the brain, and the rows under the control bench.
   *
   * WHY. Choosing a treatment changes nothing on screen until the model is
   * run again, and a title reading "... + Benzodiazepine 90%" is too quiet to
   * carry that. These chips say what the picture you are looking at actually
   * IS — which condition, which drug at what dose, what was cut or driven —
   * so an applied treatment is visible rather than inferred.
   *
   * A bench run records its own condition and treatment (benchState); a run
   * that arrived from the agent or the relay has only its title, so the title
   * is split on the same " + " the bench joins with.
   */
  function setChips(r: Run): void {
    const el = $('state-chips');
    el.replaceChildren();
    if (r.kind !== 'whole-brain' && r.kind !== 'microcircuit') { el.hidden = true; return; }

    const known = benchState.get(r.id);
    const [titleCond, titleTreat] = (() => {
      const t = r.title.replace(/^Bench · /, '');
      const i = t.indexOf(' + ');
      const cond = i < 0 ? t : t.slice(0, i);
      // titles carry asides after a middle dot ("Awake, resting · an example,
      // drawn when the page opened"); the chip wants the state, not the aside
      return [cond.split(' · ')[0]!, i < 0 ? '' : t.slice(i + 3)];
    })();

    const chip = (kind: string, label: string, value: string): void => {
      const c = document.createElement('span');
      c.className = `state-chip ${kind}`;
      const k = document.createElement('b');
      k.textContent = label;
      c.append(k, document.createTextNode(value));
      el.append(c);
    };

    chip('condition', 'condition', known?.condition ?? titleCond);
    const treat = known ? (known.treatment ? `${known.treatment} · ${Math.round(known.dose * 100)}%` : '') : titleTreat;
    if (treat) chip('treatment', 'treatment', treat);
    if (r.kind === 'whole-brain') {
      const nLes = r.params.lesions.reduce((a, l) => a + l.nodes.length, 0);
      if (nLes) chip('lesion', 'lesion', `${nLes} region${nLes > 1 ? 's' : ''} silenced`);
      if (r.params.stimulation.length) chip('stim', 'stimulus', `${r.params.stimulation.reduce((a, x) => a + x.nodes.length, 0)} regions driven`);
    }
    el.hidden = el.childElementCount === 0;
    measureBands();
  }

  /** the composition rows: what was engaged, quietened, cut or driven */
  function renderComposition(): void {
    const box = $('composition');
    const dl = $('composition-rows');
    dl.replaceChildren();
    for (const [k, v] of composition) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    box.hidden = composition.length === 0;
  }

  function drawPhaseStrip(): void {
    const strip = $('phase-strip');
    strip.replaceChildren();
    if (!frames || !phases.length) { strip.hidden = true; return; }
    strip.hidden = false;
    const total = frames.count * frames.dt;
    for (const ph of phases) {
      const seg = document.createElement('span');
      seg.className = `phase ${ph.kind}`;
      seg.style.left = `${(ph.from / total) * 100}%`;
      seg.style.width = `${Math.max(0.5, ((ph.to - ph.from) / total) * 100)}%`;
      seg.title = `${ph.label} · ${Math.round(ph.from)}–${Math.round(ph.to)} ms`;
      strip.append(seg);
    }
  }

  function updateAnnotation(): void {
    const el = $('annotation');
    const parts: string[] = [];
    if (frames && phases.length) {
      const ms = frame * frames.dt;
      const ph = phases.find((p) => ms >= p.from && ms < p.to);
      if (ph) parts.push(`${ph.kind === 'stim' ? '● ' : ''}${ph.label} (${Math.round(ph.from)}–${Math.round(ph.to)} ms)`);
      // stimulation rings only while the stimulus is on
      marks.stimulated.clear();
      if (run?.kind === 'whole-brain') {
        for (const st of run.params.stimulation as Array<{ nodes: number[]; onset_ms: number; duration_ms: number }>) {
          if (ms >= st.onset_ms && ms < st.onset_ms + st.duration_ms) for (const i of st.nodes) marks.stimulated.add(i);
        }
      }
    }
    parts.push(...staticNotes);
    el.textContent = parts.join('  ·  ');
    el.hidden = parts.length === 0;
  }

  /**
   * The loop runs every frame; the DRAWING does not. Redrawing a brain that
   * has not changed costs a core and the GPU for as long as the page is open,
   * which is a fan running in a room where nothing is moving on screen.
   *
   * What counts as changed is a KEY over everything a frame is a function of.
   * The high-frequency state — the view, the play head, the cursor, the cut —
   * is read straight into it, so a new pixel can never be missed by
   * forgetting to announce it. State the key cannot see cheaply (a run
   * arriving, a painting, the mesh or the volume loading, the canvas being
   * resized) calls `invalidate()`, which bumps the revision the key carries.
   *
   * Invariant 9 cuts both ways here: a control that changes state without
   * integrating the model must say so — and a picture that HAS changed must
   * be drawn. When in doubt, call invalidate(): a redundant frame is cheap,
   * a stale brain is a lie.
   */
  function frameKey(): string {
    const a = [mode, revision, run?.id ?? '', playing ? 1 : 0];
    if (mode === 'slice') a.push(sliceHover, focus[0], focus[1], focus[2], sliceZoom.sagittal, sliceZoom.coronal, sliceZoom.axial);
    else a.push(view.yaw.toFixed(4), view.pitch.toFixed(4), (view.zoom ?? 1).toFixed(4), hover, hoverLobe);
    // the play head, quantised to the frame actually painted
    if (frames) a.push(Math.floor(frame));
    return a.join('|');
  }

  function tick(t: number): void {
    const dtWall = lastT ? Math.min(100, t - lastT) : 16;
    lastT = t;
    if (view.auto && mode !== 'slice') view.yaw += dtWall * 0.00012;
    // inertia after a flick: the same 8% damping per frame OrbitControls uses
    if (spin !== 0 && !drag) {
      view.yaw += spin * dtWall;
      spin *= Math.pow(0.92, dtWall / 16);
      if (Math.abs(spin) < 0.000005) spin = 0;
    }
    // a drag pauses the orbit rather than ending it: it resumes after a rest
    if (resumeAt && !drag && spin === 0 && t >= resumeAt) {
      resumeAt = 0;
      view.auto = true;
      $('view-orbit').setAttribute('aria-pressed', 'true');
    }
    if (playing && frames) {
      const speed = Number(speedSel.value);
      frame += (dtWall * speed) / frames.dt;
      if (frame >= frames.count) frame = 0;
      drawInstruments();
    }
    // draw only where the stage actually is. Naming the tabs here was a trap:
    // #stage moves between slots, and a hard-coded list silently stops drawing
    // the brain the moment one of them changes.
    const panel = stage.closest('.tabpanel') as HTMLElement | null;
    if (!panel || panel.hidden) {
      // the key is NOT remembered while hidden, so the first frame back on a
      // visible tab always draws
      requestAnimationFrame(tick);
      return;
    }
    const key = frameKey();
    if (key === lastKey) {
      requestAnimationFrame(tick);
      return;
    }
    lastKey = key;
    const activity = currentActivity();
    if (mode === 'slice') {
      drawSlices(activity);
    } else {
      if (brainGL) brainGL.draw(view, activity, { transparent: mode === 'depth', highlightLobe: mode === 'organ' ? hoverLobe : -1 });
      positions = drawBrain(brain, { regions, edges, activity, view, marks, hover: hover >= 0 ? hover : null, meshDrawn: !!brainGL, mode: mode === 'depth' ? 'depth' : 'organ' });
    }
    requestAnimationFrame(tick);
  }

  /* ── view controls ─────────────────────────────────────────────────────── */

  const setView = (id: string, yaw: number, pitch: number, auto: boolean) => {
    for (const b of ['view-orbit', 'view-lateral', 'view-dorsal', 'view-front']) $(b).setAttribute('aria-pressed', String(b === id));
    view.yaw = yaw;
    view.pitch = pitch;
    view.auto = auto;
    spin = 0;
    resumeAt = 0;
  };
  const setMode = (m: 'organ' | 'depth' | 'slice') => {
    mode = m;
    hoverLobe = -1;
    hover = -1;
    $('hover').textContent = '';
    for (const id of ['organ', 'depth', 'slice']) $(`mode-${id}`).setAttribute('aria-pressed', String(m === id));
    $('slices').hidden = m !== 'slice';
    $('brain').hidden = m === 'slice';
    $('brain-gl').hidden = m === 'slice';
    for (const b of ['view-orbit', 'view-lateral', 'view-dorsal', 'view-front']) $(b).hidden = m === 'slice';
    // the four views give way to the planes, and the slice bar appears under the frame
    $('slice-tabs').hidden = m !== 'slice';
    $('slice-bar').hidden = m !== 'slice';
    $('mode-note').textContent = m === 'organ' ? '· hover to name what is under the cursor' : m === 'depth' ? '· see-through: nearer signals draw larger' : '· click a pane to move the cut';
    if (m === 'slice') void ensureVolume();
    try {
      localStorage.setItem('cajal.mode', m);
    } catch (_) { /* fine */ }
  };
  // which section is shown: one of the three, or all side by side. On a
  // phone "all" is three 100px planes, so it is not offered there and the
  // page picks axial on its own — and goes back to all when the width allows
  let planeAuto = false;
  function setPlane(p: string, auto = false): void {
    $('slices').dataset.plane = p;
    planeAuto = auto;
    for (const o of root.querySelectorAll<HTMLButtonElement>('.slice-tabs [data-plane]')) o.setAttribute('aria-pressed', String(o.dataset.plane === p));
    invalidate();
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>('.slice-tabs [data-plane]')) b.addEventListener('click', () => setPlane(b.dataset.plane!));
  // the view controls sit over the brain where there is room and under it on
  // a phone: the same element, moved between its two homes as the width
  // crosses 560px (the breakpoint the CSS uses for the same decision)
  {
    const viewBtns = root.querySelector<HTMLElement>('.view-btns');
    const hud = root.querySelector<HTMLElement>('.brain-hud');
    const row = $('view-row');
    const narrow = window.matchMedia('(max-width: 560px)');
    const place = () => {
      if (!viewBtns || !hud) return;
      const home = narrow.matches ? row : hud;
      if (viewBtns.parentElement !== home) {
        if (home === hud) hud.insertBefore(viewBtns, $('state-chips'));
        else row.append(viewBtns);
      }
      const plane = $('slices').dataset.plane;
      if (narrow.matches && plane === 'all') setPlane('axial', true);
      else if (!narrow.matches && planeAuto) setPlane('all');
      measureBands();
    };
    narrow.addEventListener('change', place);
    place();
  }
  $('mode-organ').addEventListener('click', () => setMode('organ'));
  $('mode-depth').addEventListener('click', () => setMode('depth'));
  $('mode-slice').addEventListener('click', () => setMode('slice'));
  setMode(mode);
  $('view-orbit').addEventListener('click', () => setView('view-orbit', view.yaw, 0.32, true));
  $('view-lateral').addEventListener('click', () => setView('view-lateral', Math.PI, 0.05, false));
  $('view-dorsal').addEventListener('click', () => setView('view-dorsal', -Math.PI / 2, 1.45, false));
  $('view-front').addEventListener('click', () => setView('view-front', Math.PI / 2, 0.1, false));

  let drag: { x: number; y: number; yaw: number; pitch: number; wasAuto: boolean; t: number; lastYaw: number } | null = null;
  brain.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, wasAuto: view.auto || resumeAt > 0, t: e.timeStamp, lastYaw: view.yaw };
    spin = 0;
    resumeAt = 0;
    brain.setPointerCapture(e.pointerId);
  });
  brain.addEventListener('pointermove', (e) => {
    if (drag) {
      view.yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
      view.pitch = Math.max(-1.4, Math.min(1.5, drag.pitch + (e.clientY - drag.y) * 0.008));
      // the hand's speed, smoothed over the last few events, becomes the flick
      const dt = e.timeStamp - drag.t;
      if (dt > 0) {
        const v = (view.yaw - drag.lastYaw) / dt;
        spin = spin === 0 ? v : spin * 0.6 + v * 0.4;
        drag.t = e.timeStamp;
        drag.lastYaw = view.yaw;
      }
      view.auto = false;
      for (const b of ['view-orbit', 'view-lateral', 'view-dorsal', 'view-front']) $(b).setAttribute('aria-pressed', 'false');
      return;
    }
    const rect = brain.getBoundingClientRect();
    const hv = $('hover');
    if (mode === 'organ' && brainGL && brainMesh) {
      // the surface under the cursor names its lobe and its parcel
      const v = brainGL.pick(view, e.clientX - rect.left, e.clientY - rect.top);
      hover = -1;
      if (v >= 0) {
        const ri = brainMesh.ridx[v * 3]!;
        const r = regions[ri]!;
        hoverLobe = brainMesh.lobe[v]!;
        const lobeName = LOBE_ORDER[hoverLobe] ?? r.lobe;
        const a = currentActivity();
        const stat = run?.kind === 'whole-brain' ? run.summary.regions[ri] : undefined;
        hv.textContent = `${lobeName === 'cerebellum' || lobeName === 'brainstem' ? lobeName : `${lobeName} lobe`} · ${r.label}${a ? ` · ${(a[ri] ?? 0).toFixed(2)}` : ''}${stat ? ` · ${stat.peakHz.toFixed(1)} Hz` : ''}`;
      } else {
        hoverLobe = -1;
        hv.textContent = '';
      }
      return;
    }
    hoverLobe = -1;
    hover = hitTest(positions, e.clientX - rect.left, e.clientY - rect.top);
    if (hover >= 0) {
      const r = regions[hover]!;
      const a = currentActivity();
      const stat = run?.kind === 'whole-brain' ? run.summary.regions[hover] : undefined;
      hv.textContent = `${r.label}${a ? ` · ${(a[hover] ?? 0).toFixed(2)}` : ''}${stat ? ` · mean ${stat.mean.toFixed(2)} · ${stat.peakHz.toFixed(1)} Hz` : ''}`;
    } else hv.textContent = '';
  });
  brain.addEventListener('pointerup', (e) => {
    if (!drag) return;
    // a hand that stopped before letting go leaves no flick; one that was
    // orbiting before the drag goes back to it after a rest
    if (e.timeStamp - drag.t > 80 || Math.abs(spin) < 0.00002) spin = 0;
    if (drag.wasAuto) resumeAt = e.timeStamp + 2400;
    drag = null;
  });
  // touch-action is pan-y on the canvas: a vertical swipe scrolls the page
  // and the browser cancels the pointer, so the drag must let go here too
  brain.addEventListener('pointercancel', () => { drag = null; spin = 0; });
  brain.addEventListener('pointerleave', () => { drag = null; spin = 0; hover = -1; hoverLobe = -1; $('hover').textContent = ''; });

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.textContent = playing ? 'pause' : 'play';
  });
  scrub.addEventListener('input', () => {
    frame = Number(scrub.value);
    drawInstruments();
  });

  /* The workspace fills whatever the window has left under the tab bar. The
     height is MEASURED rather than hardcoded: a magic `100vh - 92px` is a
     number that goes stale the first time the header changes, and this page
     already learned that lesson once with the caption reserve. */
  function sizeWorkspace(): void {
    const grid = root.querySelector<HTMLElement>('.workspace-grid');
    if (!grid) return;
    const top = grid.getBoundingClientRect().top + window.scrollY;
    grid.style.setProperty('--workspace-h', `${Math.max(420, Math.round(window.innerHeight - top - 24))}px`);
  }
  window.addEventListener('resize', sizeWorkspace);

  /* A canvas that changed size must be repainted even though nothing about
     the run did — the drawer opening takes 500px a media query cannot see,
     and the stage moves between tabs. Watched rather than polled: reading
     clientWidth in the render loop would force a layout every frame, which
     is the cost this loop exists to avoid. */
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => invalidate()) : null;
  /* The brain is fitted BETWEEN the head-up display and the legend, not to
     the canvas: fitted to the full height its crown sat under the title and
     its base under the scale. The display's height is measured when it
     changes (a wrapped title, chips arriving, the view row leaving for the
     phone slot), never read in the frame loop. */
  function measureBands(): void {
    const hud = root.querySelector<HTMLElement>('.brain-hud');
    const legend = root.querySelector<HTMLElement>('.brain-legend');
    const wrap = root.querySelector<HTMLElement>('.brain-wrap');
    {
      // both bands are measured from the frame's edges, offsets included:
      // the display's own 12px from the top, the legend's 12px from the
      // foot, and 6px of air on each — never an assumed number
      const top = hud ? hud.offsetTop + hud.offsetHeight + 6 : 0;
      const bottom = wrap && legend ? wrap.clientHeight - legend.offsetTop + 6 : 0;
      view.inset = { top, bottom };
      // the sections read the same two bands, so they never sit under the
      // title or the legend either (the rule: no text over the subject)
      wrap?.style.setProperty('--hud-h', `${top}px`);
      wrap?.style.setProperty('--legend-h', `${bottom}px`);
      invalidate();
    }
  }
  // measured when the display changes — the chips arriving with a run, the
  // view controls leaving for the phone slot, the window resizing — and by
  // an observer for anything else that moves it, such as a title wrapping
  {
    const hud = root.querySelector<HTMLElement>('.brain-hud');
    if (ro && hud) new ResizeObserver(() => measureBands()).observe(hud);
    window.addEventListener('resize', measureBands);
    measureBands();
  }
  if (ro) {
    ro.observe(brain);
    ro.observe(glCanvas);
    for (const plane of PLANES) ro.observe(sliceCanvas[plane]);
  } else window.addEventListener('resize', invalidate);

  /* ── runs ──────────────────────────────────────────────────────────────── */
  /* The session-history panel is gone from the workspace: a list of every run
     you have ever made is a menu of ways to stop looking at the one on
     screen. The run INDEX stays — the agent looks runs up by id, the relay
     announces them, and showRun() reloads any of them. */

  /* The cache is a convenience, not the record: the relay holds the runs
     (40 of them, service/runs.ts) and showRun() refetches any id it does not
     have. Uncapped, a long session of sweeps keeps every frame of every run
     it ever drew — a 10 s whole-brain run is 212,500 floats — and the tab
     grows until it is the slowest thing on the machine. Oldest first, and
     never the run on screen. */
  const MAX_LOCAL_RUNS = 24;
  const localRuns = new Map<string, Run>();

  function cacheRun(r: Run): void {
    localRuns.delete(r.id); // re-inserting moves it to the end: newest last
    localRuns.set(r.id, r);
    for (const id of [...localRuns.keys()]) {
      if (localRuns.size <= MAX_LOCAL_RUNS) break;
      if (id === run?.id || id === r.id) continue;
      localRuns.delete(id);
    }
  }

  async function showRun(id: string): Promise<void> {
    const cached = localRuns.get(id);
    if (cached) { setRun(cached); return; }
    if (!live) return;
    try {
      const res = await fetch(`${relay}/runs/${id}`);
      if (!res.ok) throw new Error(`run ${id}: ${res.status}`);
      const r = (await res.json()) as Run & { params?: NeuronParams; result?: unknown };
      runIndex.set(id, { id, kind: r.kind, title: r.title });
      if ((r.kind as string) === 'neuron') {
        neuronTab.setParams(r.params as NeuronParams);
        switchTab('neuron');
        return;
      }
      if ((r.kind as string) === 'benchmark') {
        replayBenchmark(r.result, id);
        switchTab('bench');
        return;
      }
      cacheRun(r);
      setRun(r);
    } catch (err) {
      setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  /* ── the bench ─────────────────────────────────────────────────────────── */

  const presetSel = $<HTMLSelectElement>('preset');
  const blurb = $('preset-blurb');
  const touched = new Set<string>();
  const updateBlurb = () => { blurb.textContent = presetById(presetSel.value)?.blurb ?? ''; };
  presetSel.addEventListener('change', updateBlurb);
  updateBlurb();
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-knob]')) {
    const out = $(`out-${input.dataset.knob === 'duration_ms' ? 'duration' : input.dataset.knob}`);
    input.addEventListener('input', () => {
      touched.add(input.dataset.knob!);
      out.textContent = input.dataset.knob === 'duration_ms' ? input.value : Number(input.value).toFixed(2);
    });
  }
  function benchParams(): WholeBrainParams {
    const base = presetById(presetSel.value)?.brain ?? {};
    const p: Record<string, unknown> = { ...base };
    for (const input of root.querySelectorAll<HTMLInputElement>('[data-knob]')) {
      if (touched.has(input.dataset.knob!)) p[input.dataset.knob!] = Number(input.value);
    }
    return p as WholeBrainParams;
  }

  /* treatments: a drug acts on the chosen condition */
  const treatSel = $<HTMLSelectElement>('treatment');
  const doseIn = $<HTMLInputElement>('dose');
  const compareBtn = $<HTMLButtonElement>('bench-compare');
  const updateTreatment = () => {
    const t = treatmentById(treatSel.value);
    $('dose-out').textContent = `${doseIn.value}%`;
    // "no treatment" is what the menu already says: the blurb only speaks when there is a drug to describe
    $('treatment-blurb').textContent = t ? `${t.class}. ${t.mechanism} In the model: ${t.model} Expect: ${t.expect}` : '';
    $('treatment-blurb').hidden = !t;
    doseIn.disabled = !t;
    compareBtn.disabled = !t;
  };
  treatSel.addEventListener('change', updateTreatment);
  doseIn.addEventListener('input', updateTreatment);
  updateTreatment();

  /**
   * Settings changed but not yet run. Picking a drug moves no pixel until the
   * model is integrated again, so say plainly that the brain on screen is the
   * PREVIOUS state and point at the button that applies the new one.
   */
  function benchSignature(): string {
    const knobs = [...document.querySelectorAll<HTMLInputElement>('#knobs input')].map((i) => `${i.dataset.knob}=${i.value}`).join(',');
    return `${presetSel.value}|${treatSel.value}|${doseIn.value}|${knobs}`;
  }
  let shownSignature = '';
  function markPending(): void {
    const stale = benchSignature() !== shownSignature;
    $('bench-pending').hidden = !stale;
    $('bench-brain').classList.toggle('attention', stale);
  }
  for (const el of [presetSel, treatSel, doseIn]) el.addEventListener('change', markPending);
  doseIn.addEventListener('input', markPending);
  for (const i of document.querySelectorAll<HTMLInputElement>('#knobs input')) i.addEventListener('input', markPending);

  const remember = (r: Run) => {
    cacheRun(r);
    runIndex.set(r.id, { id: r.id, kind: r.kind, title: r.title });
  };

  async function makeBrainRun(params: WholeBrainParams, title: string): Promise<BrainRun> {
    if (live) {
      const res = await fetch(`${relay}/bench`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'brain', params, title }) });
      if (!res.ok) throw new Error(`bench: ${res.status}`);
      return (await res.json()) as BrainRun;
    }
    const { run: wb, summary: s } = await simulateBrain(params);
    return {
      id: `local-${Math.random().toString(16).slice(2, 8)}`, kind: 'whole-brain', title, params: wb.params as BrainRun['params'], dt_ms: wb.dt_ms, frames: wb.frames, n: N,
      activity: wb.activity, meanField: s.meanField, synchronyTrace: s.synchronyTrace,
      summary: { global: s.global, lobes: s.lobes, regions: s.regions, hemispheres: s.hemispheres, latencies: s.latencies, entrainment: s.entrainment, notes: s.notes },
    };
  }

  /** remember which condition and drug produced a run, for its chips */
  function recordBenchState(id: string, condition: string | undefined, treatment: string | undefined, dose: number): void {
    benchState.set(id, {
      condition: condition ?? 'custom',
      treatment: treatment ? treatment.split(' (')[0]! : '',
      dose,
    });
  }

  function treated(): { params: WholeBrainParams; label: string; t: Treatment | undefined; dose: number } {
    const base = benchParams();
    const t = treatmentById(treatSel.value);
    const dose = Number(doseIn.value) / 100;
    if (!t) return { params: base, label: '', t, dose };
    return { params: applyTreatment(base, t.id, dose), label: ` + ${t.name.split(' (')[0]} ${Math.round(dose * 100)}%`, t, dose };
  }

  /* On a wide screen the brain sits beside the bench and a run lands in
     view. Stacked — a phone, a narrow window — the brain is ABOVE the bench,
     so pressing run changes a picture the reader has scrolled past. Every
     action must show it landed (knowledge/01): bring the picture back. */
  function showTheBrain(): void {
    const panel = $('brain-panel');
    if (panel.hidden || panel.closest('.tabpanel')?.hasAttribute('hidden')) return;
    const box = panel.getBoundingClientRect();
    const bench = root.querySelector<HTMLElement>('.panel.bench')?.getBoundingClientRect();
    // stacked means the two panels share a left edge; measured, not a
    // breakpoint copied out of the CSS, which answers to the container
    const stacked = !!bench && Math.abs(bench.left - box.left) < 2;
    if (!stacked || (box.top >= 0 && box.bottom <= window.innerHeight)) return;
    const smooth = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
    panel.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }

  /* The header pill says the model is running, but on a phone the header is
     off-screen. The button that was pressed says it too: disabled, relabelled,
     and back to itself when the run lands or fails. */
  function pressing(btn: HTMLButtonElement, label: string): () => void {
    const was = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = label;
    return () => {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = was;
    };
  }

  async function benchRun(kind: 'brain' | 'micro'): Promise<void> {
    const preset = presetById(presetSel.value);
    setStatus('busy', 'running the model');
    const release = pressing($<HTMLButtonElement>(kind === 'micro' ? 'bench-micro' : 'bench-brain'), 'running…');
    await new Promise((r) => setTimeout(r, 10));
    try {
      if (kind === 'micro') {
        if (!preset?.micro) { setStatus('error', 'this condition has no cell-by-cell version'); return; }
        const { t, dose } = treated();
        const mp = { ...preset.micro };
        if (t) {
          // the same drug, mapped onto the spiking network's four dials
          const sc = t.scale;
          mp.inhibition = (mp.inhibition ?? 1) * Math.pow(sc.c2 ?? 1, dose);
          mp.excitability = (mp.excitability ?? 1) * Math.pow((sc.c1 ?? 1) * (sc.ae ?? 1), dose);
          mp.noise = (mp.noise ?? 1) * Math.pow(sc.sigma ?? 1, dose);
          if (sc.P) mp.drive = (mp.drive ?? 0) + 8 * (Math.pow(sc.P, dose) - 1);
        }
        const title = `Bench · ${preset.title} · cell by cell${t ? ` + ${t.name.split(' (')[0]}` : ''}`;
        let r: Run;
        if (live) {
          const res = await fetch(`${relay}/bench`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'micro', params: mp, title }) });
          if (!res.ok) throw new Error(`bench: ${res.status}`);
          r = (await res.json()) as Run;
        } else {
          const mc = simulateMicrocircuit(mp);
          const s = summarizeMicrocircuit(mc);
          r = { id: `local-${Math.random().toString(16).slice(2, 8)}`, kind: 'microcircuit', title, params: mc.params, spikes: { t: Array.from(mc.spikeTimes), id: Array.from(mc.spikeIds) }, rate: Array.from(mc.rate), summary: s };
        }
        remember(r);
        recordBenchState(r.id, preset?.title, t?.name, dose);
        setRun(r);
      } else {
        const { params, label, t, dose } = treated();
        const r = await makeBrainRun(params, `Bench · ${preset?.title ?? 'custom'}${label}`);
        remember(r);
        recordBenchState(r.id, preset?.title, t?.name, dose);
        setRun(r);
        $('effect-panel').hidden = true;
      }
      shownSignature = benchSignature();
      markPending();
      showTheBrain();
      setStatus('ready', live ? 'connected' : 'in the browser');
    } catch (err) {
      setStatus('error', `run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      release();
    }
  }

  /* ── describe mode: a state in words, proposed before it runs ─────────────
     The reader describes what they want; Cajal composes a complete set-up and
     the page draws it HERE, with its reasoning and its prediction, and a
     button. Nothing integrates until that button is pressed — the proposal is
     an intention, and only a person turns it into a run. */

  const describeIn = $<HTMLTextAreaElement>('describe-in');
  const benchMessages = $('bench-messages');
  /** the pane is the scroller now, not the transcript: one scroll per pane */
  const benchScroller = (benchMessages.closest('.pane-scroll') as HTMLElement | null) ?? benchMessages;
  /** every proposal card still on screen, so a new one supersedes the old */
  const liveCards = new Set<HTMLElement>();
  let lastSpec: StateSpec | null = null;

  function setBenchMode(mode: 'describe' | 'preset'): void {
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-bench-mode]')) b.setAttribute('aria-selected', String(b.dataset.benchMode === mode));
    $('bench-describe').hidden = mode !== 'describe';
    $('bench-preset').hidden = mode !== 'preset';
    // the composer is describe mode's input and hides with it, border and
    // padding included: in preset mode the bench ends at its last control
    $('describe-composer').hidden = mode !== 'describe';
    $('bench-composer').hidden = mode !== 'describe';
    try {
      localStorage.setItem('cajal.benchMode', mode);
    } catch (_) { /* fine */ }
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-bench-mode]')) {
    b.addEventListener('click', () => setBenchMode(b.dataset.benchMode as 'describe' | 'preset'));
  }

  /** the proposed settings, laid out so a reader can check them one by one */
  function specRows(spec: StateSpec): Array<[string, string]> {
    const p = spec.params;
    const rows: Array<[string, string]> = [];
    rows.push(['based on', spec.basedOn ? `the ${spec.basedOn} preset, adjusted` : 'no preset — composed from your description']);
    const knobs = (['excitability', 'inhibition', 'coupling', 'noise', 'adaptation', 'arousal'] as const)
      .filter((k) => typeof p[k] === 'number')
      .map((k) => `${k} ${p[k]}`);
    rows.push(['knobs', knobs.length ? knobs.join(' · ') : 'all at the awake baseline']);
    const mods = Object.entries(p.modulators ?? {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`);
    if (mods.length) rows.push(['modulators', mods.join(' · ')]);
    const drive = p.regional_drive ?? [];
    const up = drive.filter((d) => d.factor > 1).map((d) => `${d.region} ×${d.factor}`);
    const down = drive.filter((d) => d.factor < 1).map((d) => `${d.region} ×${d.factor}`);
    if (up.length) rows.push(['engaged', up.join(', ')]);
    if (down.length) rows.push(['quietened', down.join(', ')]);
    for (const st of p.stimulation ?? []) {
      rows.push(['stimulated', `${st.region} at ${st.frequency_hz ? `${st.frequency_hz} Hz` : 'DC'}, amplitude ${st.amplitude ?? 1.5}, ${st.onset_ms ?? 500}–${(st.onset_ms ?? 500) + (st.duration_ms ?? 1000)} ms`]);
    }
    for (const le of p.lesions ?? []) rows.push(['lesioned', `${le.region}, severity ${le.severity ?? 1}`]);
    if (spec.treatment) rows.push(['treatment', `${spec.treatment.name} at ${Math.round(spec.treatment.dose * 100)}% of a typical dose`]);
    rows.push(['duration', `${p.duration_ms ?? 3000} ms`]);
    return rows;
  }

  /**
   * A proposal is a message in the conversation that made it, not a panel
   * somewhere else on the page: the card is built here and appended to that
   * turn, carrying its own confirm button and its own spec. The decision sits
   * above the action — title, the state in a sentence, what it should show,
   * then confirm — and the full settings follow in a details whose summary
   * counts what is inside, so nothing is hidden from someone about to say yes.
   */
  function specCardEl(spec: StateSpec): HTMLElement {
    lastSpec = spec;
    const el = document.createElement('div');
    el.className = 'spec-card';
    el.dataset.ran = 'false';

    const head = document.createElement('div');
    head.className = 'sp-head';
    const label = document.createElement('span');
    label.className = 'label';
    label.append(document.createTextNode('proposed · nothing has run yet '));
    const badge = document.createElement('span');
    badge.className = 'badge ai';
    badge.textContent = 'AI';
    label.append(badge);
    const title = document.createElement('b');
    title.textContent = spec.title;
    head.append(label, title);

    const summary = document.createElement('p');
    summary.className = 'sp-summary';
    summary.textContent = spec.summary;

    const expect = document.createElement('p');
    expect.className = 'sp-expect';
    const expectLabel = document.createElement('span');
    expectLabel.className = 'label';
    expectLabel.textContent = 'what it should show';
    expect.append(expectLabel, document.createTextNode(spec.expect));

    el.append(head, summary, expect);

    if (spec.unresolved.length) {
      const warn = document.createElement('p');
      warn.className = 'sp-warn';
      warn.textContent = `Not applied: ${spec.unresolved.join(', ')} — the atlas has no such region. Ask for a different one before running this.`;
      el.append(warn);
    }

    const row = document.createElement('div');
    row.className = 'bench-row';
    const runBtn = document.createElement('button');
    runBtn.className = 'btn primary';
    runBtn.textContent = 'confirm and run';
    const adjustBtn = document.createElement('button');
    adjustBtn.className = 'btn';
    adjustBtn.textContent = 'adjust…';
    adjustBtn.title = 'say what to change; Cajal proposes a new version';
    adjustBtn.addEventListener('click', () => {
      describeIn.value = '';
      describeIn.placeholder = 'What should change? "make the seizure focal", "half the dose", "add a thalamic lesion"';
      describeIn.focus();
      $('describe-status').textContent = 'say what to change — the proposal stands until you confirm one';
    });
    runBtn.addEventListener('click', () => void runSpec(spec, el, runBtn));
    row.append(runBtn, adjustBtn);
    el.append(row);

    // the shape of what is inside, so a treatment or a lesion is never hidden
    // silently behind a collapsed summary
    const shape: string[] = [];
    shape.push(spec.basedOn ? `based on ${spec.basedOn}` : 'composed from your words');
    const engaged = (spec.params.regional_drive ?? []).filter((d) => d.factor > 1).length;
    const quiet = (spec.params.regional_drive ?? []).filter((d) => d.factor < 1).length;
    if (engaged) shape.push(`${engaged} engaged`);
    if (quiet) shape.push(`${quiet} quietened`);
    if (spec.params.stimulation?.length) shape.push(`${spec.params.stimulation.length} stimulated`);
    if (spec.params.lesions?.length) shape.push(`${spec.params.lesions.length} lesioned`);
    if (spec.treatment) shape.push(spec.treatment.name.split(' (')[0]!.toLowerCase());
    const details = document.createElement('details');
    details.className = 'sp-detail';
    const sum = document.createElement('summary');
    sum.textContent = `the exact settings — ${shape.join(' · ')}`;
    const rows = document.createElement('dl');
    rows.className = 'keyed';
    for (const [k, v] of specRows(spec)) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      rows.append(dt, dd);
    }
    const why = document.createElement('p');
    why.className = 'sp-why';
    why.textContent = spec.rationale;
    details.append(sum, rows, why);
    el.append(details);

    // a proposal that has been replaced must not still be runnable: only the
    // newest card can start a run, and the old ones say why they cannot
    for (const old of liveCards) {
      if (old.dataset.ran === 'true') continue;
      const btn = old.querySelector<HTMLButtonElement>('.btn.primary');
      if (btn) { btn.disabled = true; btn.textContent = 'superseded'; }
      old.dataset.superseded = 'true';
    }
    liveCards.add(el);
    $('describe-status').textContent = 'proposed — check it, then confirm';
    return el;
  }

  /** the approved settings, integrated by the same path a preset run takes */
  async function runSpec(spec: StateSpec, card: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    setStatus('busy', 'running the model');
    await new Promise((r) => setTimeout(r, 10));
    try {
      const t = spec.treatment ? treatmentById(spec.treatment.id) : undefined;
      const dose = spec.treatment?.dose ?? 1;
      const params = t ? applyTreatment(spec.params, t.id, dose) : spec.params;
      const r = await makeBrainRun(params, spec.title);
      remember(r);
      recordBenchState(r.id, spec.title, t?.name, dose);
      setRun(r);
      $('effect-panel').hidden = true;
      card.dataset.ran = 'true';
      const label = card.querySelector('.sp-head .label');
      if (label) label.textContent = `ran as ${r.id} · this is what is on screen`;
      btn.textContent = 'ran';
      $('describe-status').textContent = 'running — the brain shows it now';
      setStatus('ready', live ? 'connected' : 'in the browser');
    } catch (err) {
      btn.disabled = false;
      setStatus('error', `run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function describeSend(): Promise<void> {
    const q = describeIn.value.trim();
    if (!q) { describeIn.focus(); return; }
    if (!live) { $('describe-status').textContent = 'no relay: run npm run serve to design a state in words'; return; }
    if (busy) return;
    $('describe-status').textContent = 'Cajal is designing it…';
    describeIn.value = '';
    describeIn.placeholder = 'What should change? "make the seizure focal", "half the dose", "add a thalamic lesion"';
    const before = lastSpec;
    await ask(q, { compose: true, surface: BENCH });
    if (lastSpec === before) $('describe-status').textContent = 'no proposal came back — try describing the state itself';
  }
  $('describe-go').addEventListener('click', () => void describeSend());
  // Enter sends, shift-Enter is a newline — the same keys as the drawer's
  // composer, because two chats on one page that answer differently to the
  // same key is worse than either choice
  describeIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    e.preventDefault();
    void describeSend();
  });
  {
    // The bench opens on the PRESET side. The equations are what always
    // works — no relay, no key, no model — and describing a state is the
    // layer over them, so the default is the part of the studio that can
    // never be unavailable. With no relay it is not a default but a floor:
    // describe mode cannot compose anything, so a stored preference for it
    // is ignored rather than honoured into a dead textarea.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('cajal.benchMode');
    } catch (_) { /* fine */ }
    setBenchMode(live && saved === 'describe' ? 'describe' : 'preset');
    if (!live) $('describe-status').textContent = 'no relay: describe mode needs npm run serve';
  }

  async function compareRun(): Promise<void> {
    const { params, label, t, dose } = treated();
    if (!t) return;
    const preset = presetById(presetSel.value);
    setStatus('busy', 'running untreated and treated');
    const release = pressing(compareBtn, 'running both…');
    await new Promise((r) => setTimeout(r, 10));
    try {
      const a = await makeBrainRun(benchParams(), `Bench · ${preset?.title ?? 'custom'} · untreated`);
      const b = await makeBrainRun(params, `Bench · ${preset?.title ?? 'custom'}${label}`);
      remember(a);
      remember(b);
      recordBenchState(a.id, preset?.title, undefined, 0);
      recordBenchState(b.id, preset?.title, t.name, dose);
      showEffect(a, b, t, dose, preset?.title ?? 'custom');
      setRun(b);
      shownSignature = benchSignature();
      markPending();
      setStatus('ready', live ? 'connected' : 'in the browser');
    } catch (err) {
      setStatus('error', `compare failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      release();
    }
  }

  function showEffect(a: BrainRun, b: BrainRun, t: Treatment, dose: number, condition: string): void {
    $('effect-panel').hidden = false;
    const ga = a.summary.global;
    const gb = b.summary.global;
    $('effect-caption').textContent = `${t.name} at ${Math.round(dose * 100)}% on ${condition.toLowerCase()}. ${t.expect}`;
    const body = $<HTMLTableElement>('effect-table').tBodies[0]!;
    body.replaceChildren();
    const arrow = (d: number, eps: number) => (Math.abs(d) < eps ? 'no change' : d > 0 ? `↑ ${d > 0 ? '+' : ''}${d.toFixed(2)}` : `↓ ${d.toFixed(2)}`);
    const rows: Array<[string, string, string, string]> = [
      ['mean activity', ga.mean.toFixed(2), gb.mean.toFixed(2), arrow(gb.mean - ga.mean, 0.01)],
      ['amplitude', ga.amplitude.toFixed(3), gb.amplitude.toFixed(3), arrow(gb.amplitude - ga.amplitude, 0.005)],
      ['synchrony', ga.synchrony.toFixed(2), gb.synchrony.toFixed(2), arrow(gb.synchrony - ga.synchrony, 0.02)],
      ['dominant rhythm', rhythmLabel(ga.peakHz, ga.dominantBand, ga.amplitude), rhythmLabel(gb.peakHz, gb.dominantBand, gb.amplitude), ga.amplitude < FLAT_AMPLITUDE && gb.amplitude < FLAT_AMPLITUDE ? 'no change' : gb.amplitude < FLAT_AMPLITUDE ? 'rhythm lost' : ga.amplitude < FLAT_AMPLITUDE ? 'rhythm appears' : Math.abs(gb.peakHz - ga.peakHz) < 0.5 ? 'no change' : gb.peakHz > ga.peakHz ? 'faster' : 'slower'],
    ];
    for (const band of ['delta', 'alpha', 'beta', 'gamma']) {
      const x = ga.bands[band] ?? 0;
      const y = gb.bands[band] ?? 0;
      rows.push([`${band} share`, `${Math.round(x * 100)}%`, `${Math.round(y * 100)}%`, Math.abs(y - x) < 0.03 ? 'no change' : `${y > x ? '↑' : '↓'} ${Math.round((y - x) * 100)} pts`]);
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      for (const text of r) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      body.append(tr);
    }
    const diffs = a.summary.regions.map((ra, i) => ({ id: ra.id, d: (b.summary.regions[i]?.mean ?? 0) - ra.mean }));
    const up = [...diffs].sort((p, q) => q.d - p.d).filter((x) => x.d > 0.01).slice(0, 3);
    const down = [...diffs].sort((p, q) => p.d - q.d).filter((x) => x.d < -0.01).slice(0, 3);
    $('effect-regions').textContent = `Regions that changed most: ${up.length ? `up — ${up.map((x) => `${x.id} +${x.d.toFixed(2)}`).join(', ')}` : 'none up'}; ${down.length ? `down — ${down.map((x) => `${x.id} ${x.d.toFixed(2)}`).join(', ')}` : 'none down'}. Use the buttons above to flip the brain between the two runs.`;
    const ua = $('ab-untreated');
    const ub = $('ab-treated');
    ua.onclick = () => { setRun(a); ua.setAttribute('aria-pressed', 'true'); ub.setAttribute('aria-pressed', 'false'); };
    ub.onclick = () => { setRun(b); ub.setAttribute('aria-pressed', 'true'); ua.setAttribute('aria-pressed', 'false'); };
    ub.setAttribute('aria-pressed', 'true');
    ua.setAttribute('aria-pressed', 'false');
  }

  $('bench-brain').addEventListener('click', () => void benchRun('brain'));
  compareBtn.addEventListener('click', () => void compareRun());
  $('bench-micro').addEventListener('click', () => void benchRun('micro'));

  /* ── the desk ──────────────────────────────────────────────────────────── */

  function addMessage(kind: 'user' | 'agent' | 'error', text: string, surface?: { list: HTMLElement; empty: string; scroller: HTMLElement }): HTMLElement {
    const into = surface ?? { list: benchMessages, empty: 'bench-messages-empty', scroller: benchScroller };
    document.getElementById(into.empty)?.remove();
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    if (kind === 'agent') div.append(renderMarkdown(text, (id) => void showRun(id)));
    else {
      for (const para of text.split(/\n{2,}/)) {
        const p = document.createElement('p');
        p.textContent = para.trim();
        if (p.textContent) div.append(p);
      }
    }
    const was = follows(into.scroller);
    into.list.append(div);
    stickToEnd(into.scroller, was);
    return div;
  }

  /** a run's stored payload, from the page's cache or the service */
  async function runPayload(id: string): Promise<Record<string, any> | null> {
    const cached = localRuns.get(id) as unknown as Record<string, any> | undefined;
    if (cached) return cached;
    if (!live) return null;
    try {
      const res = await fetch(`${relay}/runs/${id}`);
      if (!res.ok) return null;
      return (await res.json()) as Record<string, any>;
    } catch (_) {
      return null;
    }
  }

  /** the headline numbers a run produced, whatever kind it is */
  function gotFromRun(r: Record<string, any>): Array<[string, string]> {
    const kind = String(r.kind ?? '');
    if (kind === 'whole-brain' && r.summary?.global) {
      const g = r.summary.global;
      return [
        ['mean activity', Number(g.mean).toFixed(2)],
        ['synchrony', Number(g.synchrony).toFixed(2)],
        ['amplitude', Number(g.amplitude).toFixed(3)],
        ['rhythm', rhythmLabel(Number(g.peakHz), String(g.dominantBand), Number(g.amplitude))],
      ];
    }
    if (kind === 'microcircuit' && r.summary) {
      return [
        ['excitatory rate', `${Number(r.summary.rateE).toFixed(1)} Hz`],
        ['synchrony', Number(r.summary.synchrony).toFixed(1)],
        ['rhythm', `${Number(r.summary.peakHz).toFixed(1)} Hz ${r.summary.dominantBand}`],
      ];
    }
    if (kind === 'neuron') {
      return [
        ['resting potential', `${Number(r.rest_mv).toFixed(1)} mV`],
        ['Goldman potential', `${Number(r.ghk).toFixed(1)} mV`],
        ['spikes', String((r.spikes as unknown[] | undefined)?.length ?? 0)],
      ];
    }
    if (kind === 'sweep' && r.sweep) {
      const t = r.sweep.transition;
      return [
        ['points', String(r.sweep.points?.length ?? 0)],
        ['turns at', t ? Number(t.at).toFixed(2) : 'no turn'],
        ['sharpness', t ? `${Number(t.sharpness).toFixed(1)}×` : '—'],
        ['monotone', r.sweep.monotone ? 'yes' : 'no'],
      ];
    }
    return [];
  }

  async function currentViewing(): Promise<{ runId: string; kind: string; title: string; mode: string; ms: number | null } | null> {
    if (activeTab === 'neuron') {
      // the neuron tab computes in the browser; store what is on screen so Cajal can read it
      try {
        const res = await fetch(`${relay}/bench`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'neuron', params: neuronTab.getParams(), title: 'Single neuron · as on screen' }) });
        if (!res.ok) return null;
        const r = (await res.json()) as { id: string; title: string };
        runIndex.set(r.id, { id: r.id, kind: 'neuron', title: r.title });
        return { runId: r.id, kind: 'neuron', title: r.title, mode: 'neuron', ms: null };
      } catch {
        return null;
      }
    }
    if (activeTab === 'bench' && lastBenchmarkId) return { runId: lastBenchmarkId, kind: 'benchmark', title: 'the benchmark on screen', mode: 'benchmark', ms: null };
    return run && !run.id.startsWith('local-') ? { runId: run.id, kind: run.kind, title: run.title, mode, ms: frames ? Math.round(frame * frames.dt) : null } : null;
  }

  /**
   * ONE conversation, in the condition engine. It used to be two — a drawer
   * over the page for questions and the bench for designing a state — and two
   * chats about the same brain, one of them covering the controls of the
   * other, was a choice the reader had to make before they could ask anything.
   * The surface is still a parameter because the shape of a turn is, but there
   * is only one of them now.
   */
  interface Surface { list: HTMLElement; empty: string; send: HTMLButtonElement; scroller: HTMLElement }
  const BENCH: Surface = { list: benchMessages, empty: 'bench-messages-empty', send: $<HTMLButtonElement>('describe-go'), scroller: benchScroller };

  async function ask(q: string, opts: { compose?: boolean; surface?: Surface } = {}): Promise<void> {
    if (!live || busy || !q.trim()) return;
    const compose = opts.compose === true;
    const surface = opts.surface ?? BENCH;
    busy = true;
    surface.send.disabled = true;
    setStatus('busy', 'asking Cajal');
    addMessage('user', q, surface);
    document.getElementById(surface.empty)?.remove();
    const agentDiv = document.createElement('div');
    agentDiv.className = 'msg agent';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const thinking = document.createElement('p');
    thinking.className = 'thinking';
    thinking.textContent = 'thinking…';
    agentDiv.append(meta, thinking);
    const wasAtEnd = follows(surface.scroller);
    surface.list.append(agentDiv);
    stickToEnd(surface.scroller, wasAtEnd);
    const traceEntries: TraceEntry[] = [];
    const simIds: string[] = [];
    const cards: HTMLElement[] = [];
    const traceHost = document.createElement('div');
    const tag = (text: string, cls = '') => {
      const s = document.createElement('span');
      s.className = `tag ${cls}`.trim();
      s.textContent = text;
      meta.append(s);
      return s;
    };
    try {
      // what the person is looking at, so "explain what I am looking at" has a referent on every tab
      const viewing = await currentViewing();
      const res = await fetch(`${relay}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, contextId, viewing, benchmark: lastBenchmarkId, compose }) });
      if (!res.ok || !res.body) throw new Error(`relay ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let gotText = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as PageEvent;
          const following = follows(surface.scroller);
          if (ev.type === 'route') { thinking.textContent = ev.reason || `route: ${ev.route}`; tag(ev.route); traceEntries.push({ kind: 'route', route: ev.route, reason: ev.reason }); }
          else if (ev.type === 'tool') { thinking.textContent = `running ${ev.name}…`; tag(ev.name); traceEntries.push({ kind: 'tool', name: ev.name }); }
          else if (ev.type === 'sim') {
            simIds.push(ev.runId);
            runIndex.set(ev.runId, { id: ev.runId, kind: ev.kind, title: ev.title });
            const t = tag(`${ev.kind} ${ev.runId}`, 'sim');
            t.addEventListener('click', () => void showRun(ev.runId));
            void showRun(ev.runId);
          } else if (ev.type === 'spec') {
            // built now (so the tag can point at it) but appended after the
            // answer: the sentence explains the proposal, the card IS it
            const card = specCardEl(ev.spec);
            cards.push(card);
            setBenchMode('describe');
            const t = tag(`proposed ${ev.spec.id}`, 'sim');
            t.addEventListener('click', () => { switchTab('sim'); card.scrollIntoView({ block: 'center' }); });
          } else if (ev.type === 'text') {
            gotText = true;
            thinking.remove();
            agentDiv.append(renderMarkdown(ev.text, (id) => void showRun(id)));
          } else if (ev.type === 'error') {
            thinking.remove();
            agentDiv.classList.add('error');
            const p = document.createElement('p');
            p.textContent = ev.message;
            agentDiv.append(p);
          } else if (ev.type === 'done') {
            tag(`${(ev.ms / 1000).toFixed(1)} s`);
            traceEntries.push({ kind: 'time', ms: ev.ms });
          }
          stickToEnd(surface.scroller, following);
        }
      }
      if (!gotText && thinking.isConnected) thinking.textContent = 'no answer';
      const wasFollowing = follows(surface.scroller);
      for (const card of cards) agentDiv.append(card);
      stickToEnd(surface.scroller, wasFollowing);
      // the evidence for the badges: what the model chose, beside what the
      // equations returned. Built after the answer so each run can be read back.
      for (const id of simIds) {
        const r = await runPayload(id);
        if (!r) continue;
        traceEntries.push({
          kind: 'run', runId: id, runKind: String(r.kind ?? 'run'), title: String(r.title ?? id),
          chose: choseFromParams(r.params as Record<string, unknown> | undefined),
          got: gotFromRun(r),
        });
      }
      const beforeTrace = follows(surface.scroller);
      agentDiv.append(traceHost);
      renderTrace(traceHost, traceEntries, (id) => void showRun(id));
      stickToEnd(surface.scroller, beforeTrace);
      setStatus('ready', 'connected');
    } catch (err) {
      thinking.remove();
      agentDiv.classList.add('error');
      const p = document.createElement('p');
      p.textContent = err instanceof Error ? err.message : String(err);
      agentDiv.append(p);
      for (const card of cards) if (!card.isConnected) agentDiv.append(card);
      setStatus('error', 'relay unreachable');
    } finally {
      busy = false;
      surface.send.disabled = !live;
    }
  }

  /* ── the LaBraM loop, watched live ─────────────────────────────────────── */

  const loopLog = $('loop-log');
  const loopVerdict = $('loop-verdict');
  const loopBtn = $<HTMLButtonElement>('loop-run');
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  /** a reading and how sure it was: the same bar in the table and on a strip */
  const confBar = (conf: number, ok: boolean): HTMLSpanElement => {
    const wrap = document.createElement('span');
    wrap.className = `conf${ok ? '' : ' wrong'}`;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(conf * 100)}%`;
    bar.append(fill);
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = `${pct(conf)} ${ok ? '✓' : '✗'}`;
    wrap.append(bar, v);
    return wrap;
  };
  /* Four rows that say where the test is. The log below them is the
     transcript; this is the story: what each stage does, and how far it got.
     A reader who cannot name the stage they are watching cannot read the
     result when it lands. */
  const stageRows = () => [...$('loop-stages').querySelectorAll<HTMLLIElement>('li')];
  type StageState = 'idle' | 'running' | 'done' | 'error';
  function setStage(i: number, state: StageState, detail: string): void {
    const li = stageRows()[i];
    if (!li) return;
    li.dataset.state = state;
    (li.querySelector('.s') as HTMLElement).textContent = detail;
  }
  /** the idle line of each stage, matching Studio.astro's markup: a stage
   *  that has not run says what it is waiting FOR, not merely that it is not
   *  running — the four rows are the method before they are a progress bar */
  const STAGE_IDLE = [
    'waiting to generate condition parameters',
    'awaiting the parameter lock',
    'awaiting simulated traces',
    'awaiting latent embeddings',
  ];
  function resetStages(): void {
    for (let i = 0; i < 4; i++) setStage(i, 'idle', STAGE_IDLE[i]!);
  }

  const logLine = (text: string, now = false) => {
    for (const li of loopLog.querySelectorAll('li.now')) li.classList.remove('now');
    const li = document.createElement('li');
    li.textContent = text;
    if (now) li.classList.add('now');
    loopLog.append(li);
  };

  /* ── the EEG strips ──────────────────────────────────────────────────────
     The benchmark's subject is the recording, not the simulation that made
     it — and until now the recording was the one thing you could not look
     at: each state flashed through the brain stage in a second and left a
     row of numbers behind. Every state now keeps a strip here — the trace
     LaBraM read, its band split, and the two readings of it when they land —
     for as long as the page is open. */

  const eegList = $<HTMLOListElement>('loop-eegs');
  const eegEmpty = $('loop-eegs-empty');
  const eegAllCh = $<HTMLInputElement>('eeg-all-channels');
  const eegSharedScale = $<HTMLInputElement>('eeg-shared-scale');
  const BAND_INITIALS = ['δ', 'θ', 'α', 'β', 'γ'];

  interface Strip {
    li: HTMLLIElement;
    canvas: HTMLCanvasElement;
    nums: HTMLElement;
    bands: HTMLElement;
    verdict: HTMLElement;
    foot: HTMLElement;
    wf: EegWaveform | null;
  }
  const strips = new Map<number, Strip>();

  const node = (tag: string, cls?: string, text?: string): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /** Each state to its own scale, so the pattern is legible; on request, every
   *  state on ONE scale, so amplitude reads as amplitude and a seizure does not
   *  look like waking in a bigger box. The µV is printed either way. */
  function drawStrips(): void {
    const want = eegAllCh.checked ? 19 : 6;
    eegList.classList.toggle('all-channels', eegAllCh.checked);
    const shared = eegSharedScale.checked ? [...strips.values()].reduce((m, st) => (st.wf ? Math.max(m, peakUv(st.wf, want)) : m), 0) : 0;
    for (const st of strips.values()) {
      drawEegTrace(st.canvas, st.wf, { channels: want, scaleUv: shared, sharedNote: shared && st.wf ? 'one scale for every state' : undefined });
    }
  }
  eegAllCh.addEventListener('change', drawStrips);
  eegSharedScale.addEventListener('change', drawStrips);
  // the chat drawer takes 500px out of the column without a window resize, and
  // a strip only redraws on an event: watch the list itself
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => drawStrips()).observe(eegList);
  else window.addEventListener('resize', drawStrips);

  function clearStrips(): void {
    strips.clear();
    eegList.replaceChildren();
    eegEmpty.hidden = false;
  }

  function makeStrip(index: number, name: string, preset: string, expected: string): Strip {
    const li = document.createElement('li');
    li.className = 'eeg-strip';
    const head = node('div', 'strip-head');
    head.append(node('span', 'n', String(index + 1)), node('b', 'name', name), node('span', 'label', preset));
    const nums = node('span', 'nums', 'waiting for the simulation…');
    head.append(nums);
    const expect = node('p', 'caption expected', `the definer expected: ${expected}`);
    const body = node('div', 'strip-body');
    const canvas = document.createElement('canvas');
    canvas.className = 'eeg-canvas';
    canvas.setAttribute('aria-label', `the scalp EEG of ${name}`);
    const bands = node('div', 'bands mini');
    for (const b of BAND_INITIALS) {
      const band = node('div', 'band');
      band.append(node('span', 'v', '–'), node('div', 'bar'), node('span', 'n', b));
      (band.querySelector('.bar') as HTMLElement).style.height = '2px';
      bands.append(band);
    }
    body.append(canvas, bands);
    const verdict = node('div', 'strip-verdict');
    verdict.hidden = true;
    const foot = node('div', 'strip-foot');
    li.append(head, expect, body, verdict, foot);
    eegList.append(li);
    eegEmpty.hidden = true;
    const st: Strip = { li, canvas, nums, bands, verdict, foot, wf: null };
    strips.set(index, st);
    return st;
  }

  function setMiniBands(el: HTMLElement, bands: Record<string, number> | null): void {
    const cells = el.querySelectorAll<HTMLElement>('.band');
    BAND_NAMES.forEach((b, i) => {
      const cell = cells[i];
      if (!cell) return;
      const v = bands?.[b] ?? 0;
      (cell.querySelector('.bar') as HTMLElement).style.height = bands ? `${Math.max(2, Math.round(v * 100))}%` : '2px';
      (cell.querySelector('.v') as HTMLElement).textContent = bands ? `${Math.round(v * 100)}` : '–';
    });
  }

  /** the trace and the band split come from the stored EEG run: the page draws
   *  what the pipeline analysed, it never re-derives a signal */
  async function loadStripEeg(index: number, eegRunId: string): Promise<void> {
    const st = strips.get(index);
    if (!st || !live || !eegRunId) return;
    try {
      const res = await fetch(`${relay}/runs/${eegRunId}`);
      if (!res.ok) return;
      const r = (await res.json()) as { result?: { waveform?: EegWaveform; features?: { global?: Record<string, number> } } };
      st.wf = r.result?.waveform ?? null;
      setMiniBands(st.bands, r.result?.features?.global ?? null);
      if (st.wf?.note) st.canvas.title = st.wf.note;
      drawStrips();
    } catch (_) { /* the strip keeps its numbers; the trace says it has none */ }
  }

  function stripFoot(st: Strip, simRunId: string, eegRunId: string): void {
    st.foot.replaceChildren();
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.textContent = 'see the simulation';
    btn.title = 'open this state on the Simulation tab';
    btn.addEventListener('click', () => {
      switchTab('sim');
      void showRun(simRunId);
    });
    st.foot.append(btn, node('span', 'dim', `${simRunId} → ${eegRunId}`));
  }

  function handleLoopEvent(e: LoopEvent): void {
    if (e.type === 'loop_start') {
      logLine(`model ${e.model} · ${e.states} states · LaBraM ${e.labramConfigured ? 'configured' : 'NOT configured (the loop will fail)'}`);
      setStage(0, 'running', `${e.model} is designing ${e.states} states`);
      if (!e.labramConfigured) setStage(2, 'error', 'LaBraM is not configured on this machine — the test will fail');
    } else if (e.type === 'stage') {
      logLine(e.stage === 'done' ? `verdict: ${e.note}` : `${e.stage} — ${e.note}`, e.stage !== 'done');
      if (e.stage === 'evaluate') setStage(3, 'running', 'the blind judge is reading each analysis');
    }
    else if (e.type === 'scenarios') {
      // stage 1's data, shown first and in full: what the reasoning model designed
      const box = $('loop-defined');
      box.hidden = false;
      // the states themselves appear as strips on the right, each with the EEG
      // its author predicted, from this moment on — before anything has run
      $('loop-defined-note').textContent = `${e.model} was asked for ${e.scenarios.length} distinct brain states, each as a preset with optional knob changes and the scalp EEG it expects. It returned ${e.scenarios.map((x) => x.name).join(', ')}, and every strip on the right is built from that answer.`;
      let raw = e.raw;
      try {
        raw = JSON.stringify(JSON.parse(e.raw.match(/\[[\s\S]*\]/)?.[0] ?? e.raw), null, 2);
      } catch { /* show as returned */ }
      $('loop-defined-raw').textContent = raw;
      $('loop-log-box').hidden = false;
      setStage(0, 'done', `${e.scenarios.length} states defined: ${e.scenarios.map((x) => x.name).join(', ')}`);
      setStage(1, 'running', `0 of ${e.scenarios.length} simulated and projected onto the scalp`);
      setStage(2, 'running', `0 of ${e.scenarios.length} read`);
      clearStrips();
      // the strip exists before the recording does, so the column shows what is
      // coming rather than appearing four states later
      e.scenarios.forEach((sc, i) => makeStrip(i, sc.name, `preset ${sc.preset}`, sc.expected_eeg));
      drawStrips();
    } else if (e.type === 'trial') {
      const t = e.trial;
      const st = strips.get(e.index) ?? makeStrip(e.index, t.name, t.preset ? `preset ${t.preset}` : '', '');
      const mo = t.morphology;
      st.nums.textContent = `${t.dominantBand}${mo ? ` · ${mo.rms_uv!.toFixed(0)} µV rms · synchrony ${mo.channel_synchrony!.toFixed(2)} · burst ${mo.burst_index!.toFixed(1)}` : ''} · LaBraM ${t.labram ? `${t.windows} epochs` : 'did not run'}`;
      st.li.dataset.labram = String(t.labram);
      stripFoot(st, t.runId, t.eegRunId);
      void loadStripEeg(e.index, t.eegRunId);
      const n = e.index + 1;
      const of = strips.size || n;
      setStage(1, n >= of ? 'done' : 'running', `${n} of ${of} simulated and projected onto 19 scalp electrodes`);
      setStage(2, n >= of ? 'done' : 'running', t.labram
        ? `${n} of ${of} decomposed · LaBraM returned a latent embedding for each of ${t.windows} epochs`
        : `${n} of ${of} decomposed · LaBraM DID NOT RUN on ${t.name}`);
      logLine(`${t.name}: simulated as ${t.runId}, EEG analysed as ${t.eegRunId}, LaBraM ${t.labram ? `encoded ${t.windows} epochs` : 'DID NOT RUN'}`, true);
    } else if (e.type === 'verdict') {
      const v = e.verdict;
      const st = strips.get(e.index);
      if (st) {
        st.verdict.hidden = false;
        st.verdict.replaceChildren();
        const one = (who: string, pick: string, conf: number, ok: boolean) => {
          const row = node('span', 'read');
          row.append(node('span', 'who', who), node('span', 'pick', pick), confBar(conf, ok));
          return row;
        };
        st.verdict.append(
          one('LaBraM', v.labramPick, v.labramConfidence, v.labramCorrect),
          one('blind judge', v.pick, v.judgeConfidence, v.correct),
        );
        if (v.reason) st.verdict.append(node('span', 'why', `the judge: ${v.reason}`));
      }
      setStage(3, 'running', `${e.index + 1} of ${strips.size || e.index + 1} discriminated and scored`);
      logLine(`${v.truth}: LaBraM ${v.labramPick} (${pct(v.labramConfidence)}), judge ${v.pick} (${pct(v.judgeConfidence)})`, true);
    } else if (e.type === 'result') {
      const r = e.result;
      lastBenchmarkId = (r as { runId?: string }).runId ?? lastBenchmarkId;
      $('loop-scoreboard').hidden = false;
      loopVerdict.dataset.pass = String(r.pass);
      loopVerdict.replaceChildren();
      const big = document.createElement('span');
      big.className = 'big';
      big.textContent = r.pass ? 'PASS' : 'FAIL';
      const b = document.createElement('b');
      b.textContent = `overall confidence ${pct(r.overallConfidence)}`;
      loopVerdict.append(big, b);
      $('loop-score-sub').textContent = `${r.model ?? ''}${r.model ? ' · ' : ''}${strips.size} states · ${(r.ms / 1000).toFixed(0)} s`;
      lines('loop-score-lines', [
        ['LaBraM', `${pct(r.labramAccuracy)} of states · ${pct(r.separability.accuracy)} of ${r.separability.windows} epochs (chance ${pct(r.separability.chance)})`],
        ['blind judge', `${pct(r.judgeAccuracy)} of states named from the analysis alone`],
        ...(lastBenchmarkId ? [['stored as', lastBenchmarkId] as [string, string]] : []),
      ]);
      $('loop-score-note').textContent = 'PASS needs all three: LaBraM read every recording, its latent clusters separate the conditions better than chance, and the blind judge named at least 3 of the 4. Separation is compared against chance directly — no significance test is run. The states below are the evidence.';
      liveBenchmarkId = (r as { runId?: string }).runId ?? null;
      setStage(3, 'done', `${r.pass ? 'PASS' : 'FAIL'} · LaBraM named ${pct(r.labramAccuracy)} of the states, the blind judge ${pct(r.judgeAccuracy)}`);
      $('loop-status').textContent = r.pass ? 'passed — the result is at the top right' : 'failed — the result is at the top right';
      investigations.onBenchmarkResult({ labramAccuracy: r.labramAccuracy, judgeAccuracy: r.judgeAccuracy, pass: r.pass, overallConfidence: r.overallConfidence, states: strips.size || 4 });
    } else if (e.type === 'loop_error') {
      logLine(`error: ${e.message}`);
      const running = stageRows().findIndex((li) => li.dataset.state === 'running');
      setStage(running < 0 ? 0 : running, 'error', e.message);
      $('loop-status').textContent = 'error';
    }
  }

  /** the benchmark this session just produced. The relay announces a finished
   *  benchmark as a run, and replaying what is already on screen would refetch
   *  every recording and label the live result "History". */
  let liveBenchmarkId: string | null = null;

  /** draw a stored benchmark from History as if it were running */
  function replayBenchmark(res: unknown, id: string): void {
    const r = res as { model: string; scenarios: Array<{ name: string; preset: string; knobs: Record<string, number>; expected_eeg: string }>; trials: unknown[]; verdicts: unknown[] };
    if (!r?.scenarios) return;
    if (id === liveBenchmarkId) return;
    liveBenchmarkId = null;
    loopLog.replaceChildren();
    $('loop-defined').hidden = true;
    $('loop-scoreboard').hidden = true;
    clearStrips();
    resetStages();
    lastBenchmarkId = id;
    handleLoopEvent({ type: 'loop_start', model: r.model, states: r.scenarios.length, labramConfigured: true });
    handleLoopEvent({ type: 'scenarios', scenarios: r.scenarios, raw: JSON.stringify(r.scenarios, null, 2), model: r.model });
    r.trials.forEach((trial, index) => handleLoopEvent({ type: 'trial', index, trial } as LoopEvent));
    r.verdicts.forEach((verdict, index) => handleLoopEvent({ type: 'verdict', index, verdict } as LoopEvent));
    handleLoopEvent({ type: 'result', result: { ...(res as object), runId: id } } as LoopEvent);
    $('loop-status').textContent = `shown from History (${id})`;
  }

  async function runLoop(): Promise<void> {
    if (!live || busy) return;
    busy = true;
    loopBtn.disabled = true;
    $<HTMLButtonElement>('describe-go').disabled = true;
    loopLog.replaceChildren();
    $('loop-defined').hidden = true;
    $('loop-log-box').hidden = true;
    $('loop-scoreboard').hidden = true;
    clearStrips();
    resetStages();
    const model = $<HTMLSelectElement>('loop-model').value;
    $('loop-status').textContent = 'running — each state\'s EEG appears on the right';
    setStatus('busy', 'running the LaBraM loop');
    try {
      const res = await fetch(`${relay}/loop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, states: 4 }) });
      if (!res.ok || !res.body) throw new Error(`relay ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as PageEvent;
          if (ev.type === 'sim') {
            runIndex.set(ev.runId, { id: ev.runId, kind: ev.kind, title: ev.title });
            void showRun(ev.runId);
            continue;
          }
          if (ev.type !== 'loop') continue;
          handleLoopEvent(ev.event);
        }
      }
      setStatus('ready', 'connected');
    } catch (err) {
      logLine(`error: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('error', 'loop failed');
    } finally {
      busy = false;
      loopBtn.disabled = !live;
      $<HTMLButtonElement>('describe-go').disabled = !live;
    }
  }
  loopBtn.addEventListener('click', () => void runLoop());
  if (!live) loopBtn.disabled = true;

  /* ── tabs ──────────────────────────────────────────────────────────────── */

  const TABS: Tab[] = ['about', 'sim', 'bench', 'neuron', 'inv', 'glossary'];
  const stage = $('stage');

  /* the Investigate tab drives the page through this, and nothing else */
  const investigationHost: InvestigationHost = {
    live,
    showBrainRun(wbRun: WholeBrainRun, s: WholeBrainSummary, title: string): void {
      // one id, reused: a sweep's 11 runs are a moving picture, not 11 entries in History
      const r: BrainRun = {
        id: 'local-sweep', kind: 'whole-brain', title,
        params: wbRun.params as BrainRun['params'], dt_ms: wbRun.dt_ms, frames: wbRun.frames, n: N,
        activity: wbRun.activity, meanField: s.meanField, synchronyTrace: s.synchronyTrace,
        summary: { global: s.global, lobes: s.lobes, regions: s.regions, hemispheres: s.hemispheres, latencies: s.latencies, entrainment: s.entrainment, notes: s.notes },
      };
      cacheRun(r);
      setRun(r);
    },
    moveStage(slotId: string | null): void {
      const slot = slotId ? document.getElementById(slotId) : $('sim-stage-slot');
      if (slot && stage.parentElement !== slot) slot.prepend(stage);
    },
    ask(q: string): void {
      // there is one conversation and it lives in the condition engine
      switchTab('sim');
      setBenchMode('describe');
      void ask(q);
    },
    switchTab(t: string): void {
      switchTab(t as Tab);
    },
    async registerSweep(scale: 'brain' | 'neuron', spec: Record<string, unknown>, title: string): Promise<string | null> {
      // the page computed this sweep point by point so the curve could draw as
      // it went; the service recomputes it from the same spec and the same
      // seed so the run Cajal reads is one the service made itself
      if (!live) return null;
      try {
        const res = await fetch(`${relay}/sweep`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scale, spec, title }) });
        if (!res.ok) return null;
        const r = (await res.json()) as { id: string; kind: string; title: string };
        runIndex.set(r.id, { id: r.id, kind: r.kind, title: r.title });
        return r.id;
      } catch (_) {
        return null;
      }
    },
    runBenchmark(): void {
      void runLoop();
    },
  };
  const investigations: Investigations = startInvestigations(investigationHost);

  function switchTab(t: Tab): void {
    // This site is the Simulation tab alone: there is no other tab to go to,
    // so a goto lands on the explainer — the About statement (never a
    // measurement) is its Scope and limits. The full studio goes to /#tab.
    if (standalone && t !== 'sim') { window.location.href = t === 'about' ? '/how-it-works#limits' : '/how-it-works'; return; }
    activeTab = t;
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      const on = b.dataset.tab === t;
      b.setAttribute('aria-selected', String(on));
      // roving tabindex: the strip is one tab stop, arrows move inside it
      b.tabIndex = on ? 0 : -1;
      // the tab strip scrolls sideways on a phone: the selected tab is kept in view
      if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    for (const p of root.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== t;
    // the brain and its readout live in whichever tab shows them (moving a canvas
    // keeps its WebGL context). The EEG benchmark no longer borrows it: its
    // subject is the recording, and a stage showing one state per second was
    // the thing that could not be read.
    if (t === 'sim' && stage.parentElement !== $('sim-stage-slot')) $('sim-stage-slot').prepend(stage);
    if (t === 'sim') sizeWorkspace();
    // a canvas drawn while its panel was hidden has no size and stays blank:
    // the brain redraws itself every frame, the readout only on an event
    if (t === 'sim' || t === 'inv') drawInstruments();
    if (t === 'bench') drawStrips();
    if (t === 'neuron') neuronTab.redraw();
    if (t === 'inv') investigations.show();
    if (t === 'about') aboutFigures.draw();
    try {
      localStorage.setItem('cajal.tab', t);
    } catch (_) { /* fine */ }
    if (!standalone && window.location.hash !== `#${t}`) window.history.replaceState(null, '', `#${t}`);
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.addEventListener('click', () => switchTab(b.dataset.tab as Tab));
  /* /simulation is the Simulation tab on its own (data-standalone): the other
     tabs are not hidden panels there but pages of the studio at `/`, so a
     goto or a hash that names one is a link, not a switch; and the hash is
     left alone, because on that page it names a section of the explainer. */
  const standalone = root.dataset.standalone === 'true';
  // the strip is wider than a phone: say there is more of it to the right
  {
    const strip = root.querySelector<HTMLElement>('.tabs');
    // the WAI-ARIA tabs pattern: left and right arrows move between tabs and
    // select as they go, Home and End jump to the ends
    strip?.addEventListener('keydown', (e) => {
      const tabs = [...strip.querySelectorAll<HTMLButtonElement>('[data-tab]')];
      const i = tabs.findIndex((b) => b === document.activeElement);
      if (i < 0) return;
      const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
        : e.key === 'Home' ? 0
        : e.key === 'End' ? tabs.length - 1
        : -1;
      if (to < 0) return;
      e.preventDefault();
      switchTab(tabs[to]!.dataset.tab as Tab);
      tabs[to]!.focus();
    });
    if (strip) {
      const mark = () => { strip.dataset.more = String(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2); };
      strip.addEventListener('scroll', mark, { passive: true });
      window.addEventListener('resize', mark);
      mark();
      // the strip is measured again once the webfont is in: Inter is wider
      // than the fallback it swaps over, and the first measurement is stale
      document.fonts?.ready.then(mark).catch(() => {});
    }
  }
  // the About tab's five entries are the way in: each one opens the tab it names
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-goto]')) {
    const t = b.dataset.goto as Tab;
    if (TABS.includes(t)) b.addEventListener('click', () => switchTab(t));
  }
  // the About tab is documentation with anchors: `#about-model` and its kind
  // open that tab and scroll to the section, before the hash is folded back
  const tabOfHash = (h: string): Tab | null => (TABS.includes(h as Tab) ? (h as Tab) : h.startsWith('about-') ? 'about' : null);
  const scrollToAnchor = (h: string): void => {
    if (!h.startsWith('about-')) return;
    document.getElementById(h)?.scrollIntoView({ block: 'start' });
  };
  window.addEventListener('hashchange', () => {
    const h = window.location.hash.slice(1);
    const t = tabOfHash(h);
    if (!t) return;
    // the browser has already scrolled to the anchor when this fires; the
    // tab switch must not fold the hash before that has happened
    const wasHidden = root.querySelector<HTMLElement>('[data-panel="about"]')?.hidden;
    switchTab(t);
    if (wasHidden) scrollToAnchor(h);
  });
  {
    const rawHash = window.location.hash.slice(1);
    const fromHash = (tabOfHash(rawHash) ?? '') as Tab;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('cajal.tab');
    } catch (_) { /* fine */ }
    // a first visit opens on the Simulation tab: the brain is the studio,
    // and it is running within two seconds; the About tab is one click away
    switchTab(standalone ? 'sim' : TABS.includes(fromHash) ? fromHash : TABS.includes(saved as Tab) ? (saved as Tab) : 'sim');
    if (!standalone) scrollToAnchor(rawHash);
  }

  /* ── zoom: a little, on every view ─────────────────────────────────────── */

  const clampZ = (z: number) => Math.max(0.8, Math.min(1.7, z));
  const zoomBy = (f: number) => {
    if (mode === 'slice') for (const p of PLANES) sliceZoom[p] = clampZ(sliceZoom[p] * f);
    else view.zoom = clampZ((view.zoom ?? 1) * f);
  };
  $('zoom-in').addEventListener('click', () => zoomBy(1.15));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.15));
  // pinch on a trackpad arrives as ctrl+wheel; a plain wheel still scrolls the page
  brain.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    view.zoom = clampZ((view.zoom ?? 1) * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  brain.addEventListener('dblclick', () => { view.zoom = 1; });
  for (const plane of PLANES) {
    sliceCanvas[plane].addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      sliceZoom[plane] = clampZ(sliceZoom[plane] * Math.exp(-e.deltaY * 0.01));
    }, { passive: false });
    sliceCanvas[plane].addEventListener('dblclick', () => { sliceZoom[plane] = 1; });
  }

  /* ── boot ──────────────────────────────────────────────────────────────── */

  if (!live) {
    // the absence is marked on the control that needs the relay, not in the
    // header: hover the tab and it says why, open it and the note says what
    // to run. Nothing else on the page is missing anything.
    $('offline').hidden = false;
    $<HTMLButtonElement>('describe-go').disabled = true;
    $('describe-go').title = OFFLINE_HINT;
    describeIn.disabled = true;
    describeIn.placeholder = 'Describing a state needs the local relay — use pick a preset';
    const aiTab = root.querySelector<HTMLButtonElement>('[data-bench-mode="describe"]');
    if (aiTab) {
      aiTab.dataset.offline = 'true';
      aiTab.title = OFFLINE_HINT;
    }
    // the benchmark needs the relay too: its button locks with the reason on
    // it, instead of a click that fails after the fact
    loopBtn.disabled = true;
    loopBtn.title = 'The benchmark needs the local relay: run npm run models, npm run serve and npm run a2a, then rebuild with CAJAL_RELAY set.';
    $('loop-status').textContent = 'offline — the benchmark needs the local relay';
  } else {
    fetch(`${relay}/healthz`).then(async (r) => {
      const h = (await r.json()) as { keys: { apiKey: boolean }; models?: { error?: string } };
      const modelsUp = !!h.models && !('error' in h.models);
      // the fully-connected case says nothing and shows nothing; the two
      // partly-up cases are news and keep the pill
      if (!h.keys.apiKey) setStatus('live', 'relay up · no API key for the agent');
      else if (!modelsUp) setStatus('live', 'agent · tools connected · model service off');
      else setStatus('ready', 'agent · tools · models connected');
      const list = (await (await fetch(`${relay}/runs`)).json()) as Array<{ id: string; kind: string; title: string }>;
      for (const r of list.reverse()) runIndex.set(r.id, r);
    }).catch(() => setStatus('error', 'relay unreachable — run npm run serve'));
  }

  // Something on the brain from the first second: the awake preset, run on
  // the worker. The loop starts FIRST, so the mesh is on screen and the page
  // is scrollable while the 2 s of model time integrates, instead of the tab
  // being frozen for the length of it.
  requestAnimationFrame(tick);
  void simulateBrain({ duration_ms: 2000 }).then(({ run: wb, summary: s }) => {
    const first: BrainRun = {
      id: 'local-awake', kind: 'whole-brain', title: 'Awake, resting · run when the page opened', params: wb.params as BrainRun['params'], dt_ms: wb.dt_ms, frames: wb.frames, n: N,
      activity: wb.activity, meanField: s.meanField, synchronyTrace: s.synchronyTrace,
      summary: { global: s.global, lobes: s.lobes, regions: s.regions, hemispheres: s.hemispheres, latencies: s.latencies, entrainment: s.entrainment, notes: s.notes },
    };
    cacheRun(first);
    runIndex.set(first.id, { id: first.id, kind: first.kind, title: first.title });
    setRun(first);
  });
  void PRESETS;
}
