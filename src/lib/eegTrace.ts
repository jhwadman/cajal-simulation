/**
 * src/lib/eegTrace.ts — the recording itself, drawn.
 *
 * Every other EEG readout on this page is a statistic: a band split, an
 * amplitude, a synchrony. The trace is the thing those statistics are ABOUT,
 * and in the benchmark it is also the evidence — what LaBraM and the blind
 * judge were given. So it is drawn the way a clinical viewer draws it:
 * channels stacked front to back, one second per gridline, and the microvolt
 * scale stated on every strip. Each recording is drawn to its own scale by
 * default, because a pattern you cannot see is worth nothing; the caller can
 * impose ONE scale across states, and then a seizure's 200 µV and a waking
 * 15 µV are visibly different rather than both filling the box.
 *
 * The data is `result.waveform` from the EEG pipeline (models/cajal_models/
 * eeg.py): the preprocessed signal LaBraM read, decimated for drawing. This
 * module never computes a signal — it only draws the one that was analysed.
 *
 * Colours are the tokens from src/styles/global.css (see the contract there):
 * ink for the trace, dim for the chrome. Change one, change them all.
 */

export interface EegWaveform {
  channels: string[];
  sfreq: number;
  seconds: number;
  /** channels × samples, in microvolts */
  uv: number[][];
  note?: string;
}

const INK = 'rgba(232,236,241,0.88)';
const DIM = 'rgba(154,164,178,0.85)';
const DIMMER = 'rgba(97,107,122,0.9)';
const GRID = 'rgba(232,236,241,0.06)';
const MONO = '"iA Writer Mono", ui-monospace, Menlo, monospace';

/** the channels drawn when not all of them fit: evenly spaced, so the
 *  selection still runs front to back across the montage */
export function pickChannels(total: number, want: number): number[] {
  if (total <= want) return Array.from({ length: total }, (_, i) => i);
  return Array.from({ length: want }, (_, k) => Math.round((k * (total - 1)) / (want - 1)));
}

/** How big this recording is, in µV: the 99th percentile of |signal| over the
 *  drawn channels, not the maximum — one artefactual spike would otherwise
 *  shrink the rhythm everything else is made of. The caller uses it to put
 *  every state on one scale. */
export function peakUv(wf: EegWaveform, want: number): number {
  const mags: number[] = [];
  for (const c of pickChannels(wf.uv.length, want)) for (const v of wf.uv[c]!) mags.push(Math.abs(v));
  if (!mags.length) return 0;
  mags.sort((a, b) => a - b);
  return mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.99))]!;
}

function prep(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export interface EegTraceOptions {
  /** how many channels to stack (default 6) */
  channels?: number;
  /** µV at the top of a row; null or 0 scales this recording to itself */
  scaleUv?: number | null;
  /** drawn under the trace when the scale came from elsewhere */
  sharedNote?: string;
}

/**
 * Draw the recording. Returns the µV half-height actually used, so a caller
 * holding several strips can adopt the largest and redraw them all.
 */
export function drawEegTrace(canvas: HTMLCanvasElement, wf: EegWaveform | null, opts: EegTraceOptions = {}): number {
  const p = prep(canvas);
  if (!p) return 0;
  const { ctx, w, h } = p;
  ctx.font = `10px ${MONO}`;
  if (!wf || !wf.uv.length) {
    ctx.fillStyle = DIMMER;
    ctx.fillText('no trace stored for this recording', 8, h / 2);
    return 0;
  }
  const want = opts.channels ?? 6;
  const rows = pickChannels(wf.uv.length, want);
  const gutter = 30;
  const axis = 13;      // the seconds along the bottom
  const top = 12;       // the microvolt scale along the top: no trace under it
  const plotW = w - gutter - 6;
  const plotH = h - axis - top;
  const rowH = plotH / rows.length;
  const scale = Math.max(opts.scaleUv || 0, peakUv(wf, want), 1);
  const secs = wf.seconds || wf.uv[0]!.length / wf.sfreq;

  // one gridline per second, the way a chart recorder ruled the paper
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = DIMMER;
  for (let s = 0; s <= Math.floor(secs); s++) {
    const x = gutter + (plotW * s) / secs;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotH);
    ctx.stroke();
    if (s % 2 === 0 && s < secs) ctx.fillText(`${s}s`, x + 2, h - 3);
  }

  rows.forEach((c, k) => {
    const mid = top + rowH * (k + 0.5);
    const amp = rowH * 0.44;
    const data = wf.uv[c]!;
    ctx.strokeStyle = 'rgba(232,236,241,0.05)';
    ctx.beginPath();
    ctx.moveTo(gutter, mid);
    ctx.lineTo(gutter + plotW, mid);
    ctx.stroke();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = gutter + (plotW * i) / (data.length - 1);
      const y = mid - Math.max(-1.6, Math.min(1.6, data[i]! / scale)) * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (rowH >= 11) {
      ctx.fillStyle = DIM;
      ctx.fillText(wf.channels[c] ?? `ch${c}`, 2, mid + 3);
    }
  });

  // the scale, stated: without it a trace is a shape, not a measurement. It
  // sits at the top, where the second labels along the bottom cannot reach it.
  const label = `±${Math.round(scale)} µV${opts.sharedNote ? ` · ${opts.sharedNote}` : ''}`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = DIMMER;
  ctx.fillText(label, w - tw - 4, 9);
  return scale;
}
