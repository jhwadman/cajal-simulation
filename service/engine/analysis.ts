/**
 * engine/analysis.ts — what a run MEANS, as numbers and then as text.
 *
 * The agent never sees frames; it sees the summary printed here: global and
 * per-lobe activity, the dominant rhythm and the band split, a synchrony
 * index, hemispheric balance, the most and least active regions, and — for
 * stimulation runs — how fast the response travelled. The page draws the
 * frames and shows the same numbers, so what the agent says and what the
 * reader sees are one run described twice.
 */

import { REGIONS, N, LOBES } from './atlas.ts';
import type { Lobe } from './atlas.ts';
import type { WholeBrainRun } from './wholeBrain.ts';
import type { MicrocircuitRun } from './microcircuit.ts';

export const BANDS: Array<[string, number, number]> = [
  ['delta', 1, 4],
  ['theta', 4, 8],
  ['alpha', 8, 13],
  ['beta', 13, 30],
  ['gamma', 30, 80],
];

/* ── spectra ─────────────────────────────────────────────────────────────── */

/** in-place radix-2 FFT; re/im length must be a power of two */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface Spectrum {
  /** Hz per bin */
  df: number;
  /** power per bin, bins 0..n/2 */
  power: Float64Array;
}

/** Power spectrum of a signal sampled at `fs` Hz, from its last power-of-two window, Hann-tapered, mean removed. */
export function spectrum(signal: ArrayLike<number>, fs: number): Spectrum {
  let n = 1;
  while (n * 2 <= signal.length && n < 2048) n *= 2;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const start = signal.length - n;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[start + i]!;
  mean /= n;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (signal[start + i]! - mean) * w;
  }
  fft(re, im);
  const power = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return { df: fs / n, power };
}

export interface BandSplit {
  /** fraction of power 1–80 Hz in each band, by band name */
  fractions: Record<string, number>;
  /** the band with the most power */
  dominantBand: string;
  /** peak frequency in 1–80 Hz */
  peakHz: number;
  /** total power 1–80 Hz (amplitude proxy) */
  total: number;
}

export function bandSplit(sp: Spectrum): BandSplit {
  const fractions: Record<string, number> = {};
  let total = 0;
  let peakHz = 0;
  let peakP = -1;
  for (let k = 0; k < sp.power.length; k++) {
    const f = k * sp.df;
    if (f < 1 || f > 80) continue;
    total += sp.power[k]!;
    if (sp.power[k]! > peakP) {
      peakP = sp.power[k]!;
      peakHz = f;
    }
  }
  let dominantBand = 'delta';
  let best = -1;
  for (const [name, lo, hi] of BANDS) {
    let p = 0;
    for (let k = 0; k < sp.power.length; k++) {
      const f = k * sp.df;
      if (f >= lo && f < hi) p += sp.power[k]!;
    }
    const frac = total > 0 ? p / total : 0;
    fractions[name] = frac;
    if (frac > best) {
      best = frac;
      dominantBand = name;
    }
  }
  return { fractions, dominantBand, peakHz, total };
}

/**
 * Below this mean-field amplitude a run has no rhythm worth naming: the peak
 * bin is noise and the widest band wins the share by being widest.
 */
export const FLAT_AMPLITUDE = 0.005;

/**
 * How to say what rhythm a run had. Two honest statistics — the strongest
 * single frequency and the band holding the most power — read as a
 * contradiction when there is no rhythm at all ("8.8 Hz beta" on a collapsed
 * cortex), so under FLAT_AMPLITUDE we say that instead.
 */
export function rhythmLabel(peakHz: number, dominantBand: string, amplitude: number): string {
  return amplitude < FLAT_AMPLITUDE ? 'no rhythm · activity collapsed' : `${peakHz.toFixed(1)} Hz ${dominantBand}`;
}

/* ── whole-brain summary ─────────────────────────────────────────────────── */

export interface RegionStat {
  id: string;
  label: string;
  lobe: Lobe;
  mean: number;
  std: number;
  peakHz: number;
}

export interface LobeStat {
  lobe: Lobe;
  mean: number;
  peakHz: number;
  dominantBand: string;
}

export interface ResponseLatency {
  id: string;
  label: string;
  /** ms after stimulation onset at which the region's activity first rose 5 SD above its baseline and held for 20 ms */
  latency_ms: number;
  /** peak activity in the stimulation window */
  peak: number;
}

export interface WholeBrainSummary {
  kind: 'whole-brain';
  duration_ms: number;
  regions: RegionStat[];
  lobes: LobeStat[];
  global: {
    mean: number;
    /** var(mean field) / mean(var_i): 0 independent, 1 lockstep */
    synchrony: number;
    peakHz: number;
    dominantBand: string;
    bands: Record<string, number>;
    /** RMS amplitude of the mean field, a seizure-size proxy */
    amplitude: number;
  };
  hemispheres: { left: number; right: number; homotopicCorrelation: number };
  /** mean pairwise correlation over connected pairs */
  meanFC: number;
  /** the global mean field, per frame, for the page's trace */
  meanField: Float32Array;
  /** the synchrony over a sliding window, per frame, for the page's trace */
  synchronyTrace: Float32Array;
  latencies: ResponseLatency[];
  /** for periodic stimulation: regions whose power at the drive frequency rose most, stimulated nodes excluded */
  entrainment: Array<{ id: string; label: string; hz: number; gain: number }>;
  notes: string[];
}

function corr(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

export function summarizeWholeBrain(run: WholeBrainRun): WholeBrainSummary {
  const { frames, activity } = run;
  const fs = 1000 / run.dt_ms;
  // the engine already warms up before recording; skip a little more for statistics
  const skip = Math.min(frames - 1, Math.round(100 / run.dt_ms));
  const T = frames - skip;

  const series: Float64Array[] = [];
  for (let i = 0; i < N; i++) {
    const s = new Float64Array(T);
    for (let f = 0; f < T; f++) s[f] = activity[(f + skip) * N + i]!;
    series.push(s);
  }

  const meanField = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let m = 0;
    for (let i = 0; i < N; i++) m += activity[f * N + i]!;
    meanField[f] = m / N;
  }

  const regions: RegionStat[] = REGIONS.map((r, i) => {
    const s = series[i]!;
    let m = 0;
    for (let f = 0; f < T; f++) m += s[f]!;
    m /= T;
    let v = 0;
    for (let f = 0; f < T; f++) v += (s[f]! - m) ** 2;
    v /= T;
    const sp = bandSplit(spectrum(s, fs));
    return { id: r.id, label: r.label, lobe: r.lobe, mean: m, std: Math.sqrt(v), peakHz: sp.peakHz };
  });

  // global mean field statistics
  const mf = new Float64Array(T);
  for (let f = 0; f < T; f++) mf[f] = meanField[f + skip]!;
  let gm = 0;
  for (let f = 0; f < T; f++) gm += mf[f]!;
  gm /= T;
  let gv = 0;
  for (let f = 0; f < T; f++) gv += (mf[f]! - gm) ** 2;
  gv /= T;
  let meanVar = 0;
  for (const r of regions) meanVar += r.std * r.std;
  meanVar /= N;
  const synchrony = meanVar > 0 ? Math.min(1, gv / meanVar) : 0;
  const gsp = bandSplit(spectrum(mf, fs));

  // sliding synchrony for the page: 400 ms window
  const win = Math.round(400 / run.dt_ms);
  const synchronyTrace = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - win);
    const b = f + 1;
    const len = b - a;
    if (len < 8) continue;
    let mfm = 0;
    const mfw = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      mfw[k] = meanField[a + k]!;
      mfm += mfw[k]!;
    }
    mfm /= len;
    let mfv = 0;
    for (let k = 0; k < len; k++) mfv += (mfw[k]! - mfm) ** 2;
    mfv /= len;
    let vsum = 0;
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = 0; k < len; k++) m += activity[(a + k) * N + i]!;
      m /= len;
      let v = 0;
      for (let k = 0; k < len; k++) v += (activity[(a + k) * N + i]! - m) ** 2;
      vsum += v / len;
    }
    const mv = vsum / N;
    synchronyTrace[f] = mv > 1e-9 ? Math.min(1, mfv / mv) : 0;
  }

  // lobes
  const lobes: LobeStat[] = LOBES.map((lobe) => {
    const idx = REGIONS.map((r, i) => (r.lobe === lobe ? i : -1)).filter((i) => i >= 0);
    const s = new Float64Array(T);
    for (let f = 0; f < T; f++) {
      let m = 0;
      for (const i of idx) m += series[i]![f]!;
      s[f] = m / idx.length;
    }
    let m = 0;
    for (let f = 0; f < T; f++) m += s[f]!;
    const sp = bandSplit(spectrum(s, fs));
    return { lobe, mean: m / T, peakHz: sp.peakHz, dominantBand: sp.dominantBand };
  });

  // hemispheres
  let left = 0;
  let right = 0;
  let nl = 0;
  let nr = 0;
  let homo = 0;
  let nh = 0;
  REGIONS.forEach((r, i) => {
    if (r.hemi === 'L') {
      left += regions[i]!.mean;
      nl++;
      const j = REGIONS.findIndex((q) => q.hemi === 'R' && q.name === r.name);
      if (j >= 0) {
        homo += corr(series[i]!, series[j]!);
        nh++;
      }
    } else if (r.hemi === 'R') {
      right += regions[i]!.mean;
      nr++;
    }
  });

  // functional connectivity over a sample of pairs (all pairs is fine at N=85)
  let fc = 0;
  let nfc = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    fc += corr(series[i]!, series[j]!);
    nfc++;
  }

  // response latencies for stimulation runs
  const latencies: ResponseLatency[] = [];
  for (const s of run.params.stimulation) {
    const onsetF = Math.round(s.onset_ms / run.dt_ms);
    if (onsetF < 20 || onsetF >= frames - 5) continue;
    const baseA = Math.max(0, onsetF - Math.round(300 / run.dt_ms));
    for (let i = 0; i < N; i++) {
      let m = 0;
      let cnt = 0;
      for (let f = baseA; f < onsetF; f++) {
        m += activity[f * N + i]!;
        cnt++;
      }
      m /= cnt;
      let v = 0;
      for (let f = baseA; f < onsetF; f++) v += (activity[f * N + i]! - m) ** 2;
      const sd = Math.sqrt(v / cnt) + 0.01;
      const endF = Math.min(frames, onsetF + Math.round(Math.min(s.duration_ms, 600) / run.dt_ms));
      // a response is a rise of 4 SD (and at least 0.03) above the pre-onset
      // baseline that HOLDS for three consecutive frames — a single noisy
      // frame crossing the line is not a response and used to report 0 ms
      const thresh = m + Math.max(5 * sd, 0.05);
      const HOLD = 5; // frames (20 ms) the rise must persist
      let lat = -1;
      let peak = 0;
      let streak = 0;
      for (let f = onsetF + 1; f < endF; f++) {
        const a = activity[f * N + i]!;
        if (a > peak) peak = a;
        streak = a > thresh ? streak + 1 : 0;
        if (lat < 0 && streak >= HOLD) lat = (f - (HOLD - 1) - onsetF) * run.dt_ms;
      }
      if (lat >= 0 && !s.nodes.includes(i)) {
        latencies.push({ id: REGIONS[i]!.id, label: REGIONS[i]!.label, latency_ms: lat, peak });
      }
    }
  }
  latencies.sort((a, b) => a.latency_ms - b.latency_ms);

  // entrainment: a periodic drive shows up as power at its own frequency in
  // the regions it reaches, which survives the intrinsic alpha that hides a
  // single-trial evoked response. Gain = stimulation-window power at f0 ± 1 Hz
  // over the same-length window before onset; reported when it clears 8× and
  // three times the network median (spectral leakage lifts everything a little).
  const entrainment: WholeBrainSummary['entrainment'] = [];
  for (const s of run.params.stimulation) {
    if (s.frequency_hz < 1) continue;
    const onsetF = Math.round(s.onset_ms / run.dt_ms);
    const endF = Math.min(frames, onsetF + Math.round(s.duration_ms / run.dt_ms));
    // equal windows before and during, as long as both fit
    const len = Math.min(endF - onsetF, onsetF);
    if (len < 64) continue;
    const powerAt = (sig: Float64Array): number => {
      const sp = spectrum(sig, fs);
      let p = 0;
      for (let k = 0; k < sp.power.length; k++) if (Math.abs(k * sp.df - s.frequency_hz) <= 1) p += sp.power[k]!;
      return p;
    };
    const gains: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) {
      const before = new Float64Array(len);
      const during = new Float64Array(len);
      for (let f = 0; f < len; f++) {
        before[f] = activity[(onsetF - len + f) * N + i]!;
        during[f] = activity[(onsetF + f) * N + i]!;
      }
      gains.push([i, powerAt(during) / (powerAt(before) + 1e-9)]);
    }
    const sorted = gains.map((g) => g[1]).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 1;
    for (const [i, g] of gains.sort((a, b) => b[1] - a[1])) {
      if (s.nodes.includes(i)) continue;
      if (g < 8 || g < 3 * median) break;
      entrainment.push({ id: REGIONS[i]!.id, label: REGIONS[i]!.label, hz: s.frequency_hz, gain: Math.round(g * 10) / 10 });
      if (entrainment.length >= 10) break;
    }
  }

  const summary: WholeBrainSummary = {
    kind: 'whole-brain',
    duration_ms: run.params.duration_ms,
    regions,
    lobes,
    global: {
      mean: gm,
      synchrony,
      peakHz: gsp.peakHz,
      dominantBand: gsp.dominantBand,
      bands: gsp.fractions,
      amplitude: Math.sqrt(gv),
    },
    hemispheres: { left: left / nl, right: right / nr, homotopicCorrelation: nh ? homo / nh : 0 },
    meanFC: nfc ? fc / nfc : 0,
    meanField,
    synchronyTrace,
    latencies: latencies.slice(0, 12),
    entrainment,
    notes: [],
  };
  summary.notes = readNotes(summary, run);
  return summary;
}

/** Rule-based one-liners so the agent has a first reading to check against the numbers. */
function readNotes(s: WholeBrainSummary, run: WholeBrainRun): string[] {
  const notes: string[] = [];
  const g = s.global;
  if (g.synchrony > 0.6 && g.amplitude > 0.15 && g.peakHz < 8 && g.mean > 0.2) {
    notes.push('hypersynchronous, large-amplitude slow discharges with a HIGH mean across the whole network: the signature of a generalised seizure-like state');
  } else if (g.synchrony > 0.6 && g.peakHz < 4 && g.mean <= 0.2) {
    notes.push('slow, synchronous up/down-state alternation on a LOW mean: slow-wave (deep sleep / anaesthesia-like) dynamics');
  } else if (g.synchrony < 0.2 && g.mean > 0.15) {
    notes.push('desynchronised, low-amplitude activity with regions running independently: the awake, engaged cortex');
  } else if (g.dominantBand === 'alpha' && g.synchrony >= 0.2 && g.synchrony <= 0.6) {
    notes.push('moderately synchronous alpha: a resting, eyes-closed-like state');
  }
  if (g.mean < 0.05) notes.push('activity has largely collapsed: the network is close to silent');
  if (g.mean > 0.6) notes.push('activity is saturated in most regions: excitation has overwhelmed inhibition');
  const asym = s.hemispheres.left - s.hemispheres.right;
  if (Math.abs(asym) > 0.06) {
    notes.push(`hemispheric asymmetry: the ${asym > 0 ? 'left' : 'right'} hemisphere is more active by ${Math.abs(asym).toFixed(2)}`);
  }
  if (run.params.lesions.length) {
    const damaged = run.params.lesions.flatMap((l) => l.nodes.map((i) => REGIONS[i]!.id));
    const neighbours = s.regions.filter((r) => !damaged.includes(r.id) && r.mean < g.mean * 0.5).map((r) => r.id);
    if (neighbours.length) notes.push(`diaschisis: ${neighbours.length} intact region(s) running at under half the global mean after the lesion — ${neighbours.slice(0, 6).join(', ')}`);
  }
  if (run.params.stimulation.length && s.latencies.length) {
    const first = s.latencies[0]!;
    notes.push(`stimulation response reached ${first.label} first, ${first.latency_ms} ms after onset`);
  }
  if (s.entrainment.length) {
    const e = s.entrainment[0]!;
    notes.push(`the ${e.hz} Hz drive entrained ${s.entrainment.length} other region(s), strongest ${e.label} (×${e.gain} power at ${e.hz} Hz)`);
  } else if (run.params.stimulation.some((st) => st.frequency_hz >= 1)) {
    notes.push('the periodic drive did not entrain any region beyond its target at this coupling');
  }
  if (run.params.unresolved.length) notes.push(`UNRESOLVED region references (ignored): ${run.params.unresolved.join(', ')}`);
  return notes;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const f2 = (x: number) => x.toFixed(2);

/** The text the agent reads. */
export function printWholeBrain(runId: string, run: WholeBrainRun, s: WholeBrainSummary): string {
  const p = run.params;
  const lines: string[] = [];
  lines.push(`RUN_ID: ${runId}`);
  lines.push(`WHOLE-BRAIN SIMULATION · ${p.duration_ms} ms · ${N} regions (synthetic distance-rule connectome, conduction delays) · seed ${p.seed}`);
  const m = p.modulators;
  lines.push(`KNOBS: excitability ${f2(p.excitability)} · inhibition ${f2(p.inhibition)} · coupling ${f2(p.coupling)} · noise ${f2(p.noise)} · adaptation ${f2(p.adaptation)} · arousal ${f2(p.arousal)}`);
  lines.push(`MODULATORS: dopamine ${f2(m.dopamine)} · acetylcholine ${f2(m.acetylcholine)} · noradrenaline ${f2(m.noradrenaline)} · serotonin ${f2(m.serotonin)} · adenosine ${f2(m.adenosine)}  (1.00 = baseline)`);
  if (p.stimulation.length) {
    for (const st of p.stimulation) {
      const nodes = st.nodes.map((i) => REGIONS[i]!.id);
      lines.push(`STIMULATION: ${st.region} → [${nodes.slice(0, 8).join(', ')}${nodes.length > 8 ? `, +${nodes.length - 8}` : ''}] · amplitude ${f2(st.amplitude)} · ${st.frequency_hz > 0 ? `${st.frequency_hz} Hz ${st.waveform}` : 'constant'} · from ${st.onset_ms} ms for ${st.duration_ms} ms`);
    }
  }
  if (p.regional_drive.length) {
    lines.push(`REGIONAL SIGNATURE: ${p.regional_drive.map((d) => `${d.region} ×${d.factor}`).join(', ')}`);
  }
  if (p.lesions.length) {
    for (const l of p.lesions) {
      const nodes = l.nodes.map((i) => REGIONS[i]!.id);
      lines.push(`LESION: ${l.region} → [${nodes.slice(0, 8).join(', ')}${nodes.length > 8 ? `, +${nodes.length - 8}` : ''}] · severity ${f2(l.severity)}`);
    }
  }
  const g = s.global;
  lines.push('');
  lines.push(`GLOBAL: mean activity ${f2(g.mean)} (0–1 scale; baseline awake ≈ 0.15–0.30) · mean-field amplitude ${f2(g.amplitude)} · synchrony ${f2(g.synchrony)} (0 = regions independent, 1 = lockstep) · dominant rhythm ${rhythmLabel(g.peakHz, g.dominantBand, g.amplitude)}`);
  lines.push(`BAND POWER of the mean field: ${BANDS.map(([b]) => `${b} ${pct(g.bands[b] ?? 0)}`).join(' · ')}`);
  lines.push(`HEMISPHERES: left ${f2(s.hemispheres.left)} · right ${f2(s.hemispheres.right)} · homotopic correlation ${f2(s.hemispheres.homotopicCorrelation)} · mean functional connectivity ${f2(s.meanFC)}`);
  lines.push('BY LOBE (mean activity · dominant rhythm):');
  for (const l of s.lobes) lines.push(`  ${l.lobe.padEnd(11)} ${f2(l.mean)} · ${l.peakHz.toFixed(1)} Hz ${l.dominantBand}`);
  const sorted = [...s.regions].sort((a, b) => b.mean - a.mean);
  lines.push(`MOST ACTIVE: ${sorted.slice(0, 8).map((r) => `${r.id} ${f2(r.mean)}`).join(', ')}`);
  lines.push(`LEAST ACTIVE: ${sorted.slice(-6).reverse().map((r) => `${r.id} ${f2(r.mean)}`).join(', ')}`);
  if (s.entrainment.length) {
    lines.push(`ENTRAINMENT at ${s.entrainment[0]!.hz} Hz (power gain during vs before, stimulated regions excluded): ${s.entrainment.map((e) => `${e.id} ×${e.gain}`).join(', ')}`);
  }
  if (s.latencies.length) {
    lines.push(`RESPONSE LATENCY after stimulation onset (first regions to rise 3 SD above their baseline): ${s.latencies.slice(0, 8).map((l) => `${l.id} +${l.latency_ms} ms`).join(', ')}`);
  }
  if (s.notes.length) {
    lines.push('');
    lines.push('READING (rule-based, check against the numbers):');
    for (const n of s.notes) lines.push(`  - ${n}`);
  }
  lines.push('');
  lines.push('This is a mechanistic neural-mass model on a synthetic connectome: it shows the KIND of dynamics a cortex has under these conditions, not a measurement of any brain. Say so when a reader could mistake it for one.');
  return lines.join('\n');
}

/* ── microcircuit summary ────────────────────────────────────────────────── */

export interface MicrocircuitSummary {
  kind: 'microcircuit';
  duration_ms: number;
  neurons: number;
  excitatory: number;
  rateE: number;
  rateI: number;
  /** Fano factor of the 5 ms population count: ~1 asynchronous, ≫1 synchronous bursting */
  synchrony: number;
  peakHz: number;
  dominantBand: string;
  bands: Record<string, number>;
  /** mean coefficient of variation of inter-spike intervals (≈1 Poisson-like, <0.5 regular) */
  isiCv: number;
  silentFraction: number;
  notes: string[];
}

export function summarizeMicrocircuit(run: MicrocircuitRun): MicrocircuitSummary {
  const { params, spikeTimes, spikeIds, rate, counts } = run;
  const Ne = params.excitatory;
  const Nn = params.neurons;
  const secs = params.duration_ms / 1000;
  let ce = 0;
  let ci = 0;
  for (let i = 0; i < Nn; i++) {
    if (i < Ne) ce += counts[i]!;
    else ci += counts[i]!;
  }
  const rateE = ce / Ne / secs;
  const rateI = ci / (Nn - Ne) / secs;

  // Fano factor of 5 ms bins after a 100 ms transient
  const binW = 5;
  const bins: number[] = [];
  for (let t = 100; t + binW <= rate.length; t += binW) {
    let c = 0;
    for (let k = 0; k < binW; k++) c += rate[t + k]!;
    bins.push(c);
  }
  let bm = 0;
  for (const b of bins) bm += b;
  bm /= Math.max(1, bins.length);
  let bv = 0;
  for (const b of bins) bv += (b - bm) ** 2;
  bv /= Math.max(1, bins.length);
  const synchrony = bm > 0 ? bv / bm : 0;

  const sp = bandSplit(spectrum(rate, 1000));

  // ISI CV over neurons with ≥ 5 spikes
  const lastSpike = new Float64Array(Nn).fill(-1);
  const isiSum = new Float64Array(Nn);
  const isiSq = new Float64Array(Nn);
  const isiN = new Int32Array(Nn);
  for (let k = 0; k < spikeTimes.length; k++) {
    const i = spikeIds[k]!;
    const t = spikeTimes[k]!;
    if (lastSpike[i]! >= 0) {
      const d = t - lastSpike[i]!;
      isiSum[i]! += d;
      isiSq[i]! += d * d;
      isiN[i]!++;
    }
    lastSpike[i] = t;
  }
  let cvSum = 0;
  let cvN = 0;
  let silent = 0;
  for (let i = 0; i < Nn; i++) {
    if (counts[i]! === 0) silent++;
    if (isiN[i]! >= 5) {
      const m = isiSum[i]! / isiN[i]!;
      const v = isiSq[i]! / isiN[i]! - m * m;
      cvSum += Math.sqrt(Math.max(0, v)) / m;
      cvN++;
    }
  }
  const s: MicrocircuitSummary = {
    kind: 'microcircuit',
    duration_ms: params.duration_ms,
    neurons: Nn,
    excitatory: Ne,
    rateE,
    rateI,
    synchrony,
    peakHz: sp.peakHz,
    dominantBand: sp.dominantBand,
    bands: sp.fractions,
    isiCv: cvN ? cvSum / cvN : 0,
    silentFraction: silent / Nn,
    notes: [],
  };
  if (s.synchrony > 8 && s.rateE > 20) s.notes.push('synchronous high-rate bursting of the whole population: seizure-like, the network has lost the balance of excitation and inhibition');
  else if (s.synchrony > 3) s.notes.push('population bursts riding on irregular firing: a synchronous-irregular regime');
  else if (s.synchrony < 1.6 && s.isiCv > 0.7) s.notes.push('asynchronous irregular firing, the regime of the awake cortex');
  if (s.rateE < 1) s.notes.push('excitatory cells are almost silent: the drive is too weak or inhibition too strong');
  if (s.dominantBand === 'gamma' && s.bands.gamma! > 0.35) s.notes.push('a gamma-band population rhythm carried by the fast-spiking interneurons');
  return s;
}

export function printMicrocircuit(runId: string, run: MicrocircuitRun, s: MicrocircuitSummary): string {
  const p = run.params;
  const lines: string[] = [];
  lines.push(`RUN_ID: ${runId}`);
  lines.push(`MICROCIRCUIT SIMULATION · ${p.duration_ms} ms · ${p.neurons} Izhikevich neurons (${p.excitatory} regular-spiking excitatory, ${p.neurons - p.excitatory} fast-spiking inhibitory) · ${Math.round(p.connectivity * 100)}% random connectivity · seed ${p.seed}`);
  lines.push(`KNOBS: excitability ${f2(p.excitability)} · inhibition ${f2(p.inhibition)} · noise ${f2(p.noise)} · drive ${f2(p.drive)}`);
  lines.push('');
  lines.push(`FIRING: excitatory ${s.rateE.toFixed(1)} Hz · inhibitory ${s.rateI.toFixed(1)} Hz · ${pct(s.silentFraction)} of cells silent · ISI CV ${f2(s.isiCv)} (≈1 irregular, <0.5 clock-like)`);
  lines.push(`POPULATION: synchrony (Fano factor of 5 ms counts) ${s.synchrony.toFixed(1)} (≈1 asynchronous, >5 bursting) · dominant rhythm ${s.peakHz.toFixed(1)} Hz (${s.dominantBand})`);
  lines.push(`BAND POWER of the population rate: ${BANDS.map(([b]) => `${b} ${pct(s.bands[b] ?? 0)}`).join(' · ')}`);
  if (s.notes.length) {
    lines.push('');
    lines.push('READING (rule-based, check against the numbers):');
    for (const n of s.notes) lines.push(`  - ${n}`);
  }
  lines.push('');
  lines.push('A random pulse-coupled network of model neurons: it reproduces the regimes a cortical circuit can be in, not the wiring of any real one.');
  return lines.join('\n');
}
