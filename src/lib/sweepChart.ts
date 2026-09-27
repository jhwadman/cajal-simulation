/**
 * src/lib/sweepChart.ts — drawing a sweep.
 *
 * One parameter along the bottom, one measure up the side, a point per
 * simulation. The chart is drawn again after every point so the student
 * WATCHES the experiment run rather than being handed a finished figure:
 * the empty axis fills up left to right, which is what makes a sweep feel
 * like an experiment instead of an illustration.
 *
 * Two marks carry the teaching. `guess` is the vertical line where the
 * student predicted the change would happen, drawn before any data exists.
 * `marker` is where the model actually turned, drawn only once the sweep has
 * finished. The gap between them is the lesson.
 *
 * No dependencies, no innerHTML: a canvas and a 2D context.
 */

export interface SweepSeries {
  label: string;
  values: Array<number | null>;
  color: string;
  /** drawn thin and faint: context, not the point */
  secondary?: boolean;
}

export interface SweepChartOpts {
  xs: number[];
  series: SweepSeries[];
  xLabel: string;
  yLabel: string;
  /** how many points have been computed; the rest of the axis stays empty */
  filled: number;
  marker?: { x: number; label: string } | null;
  guess?: { x: number; label: string } | null;
  yRange?: [number, number];
  /** shaded bands along the x axis, drawn under everything (regime labels) */
  bands?: Array<{ from: number; to: number; label: string; color: string }>;
}

const COL = {
  axis: '#1c2330',
  text: '#9aa4b2',
  bright: '#e8ecf1',
  grid: 'rgba(232,236,241,0.06)',
  guess: '#ffb45c',
  marker: '#35d6ff',
};

const PAD = { l: 46, r: 12, t: 14, b: 34 };

export function drawSweepChart(canvas: HTMLCanvasElement, o: SweepChartOpts): void {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (!ctx || cw === 0 || ch === 0) return;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const x0 = PAD.l;
  const x1 = cw - PAD.r;
  const y0 = PAD.t;
  const y1 = ch - PAD.b;
  const xs = o.xs;
  if (xs.length < 2 || x1 <= x0 || y1 <= y0) return;
  const xMin = xs[0]!;
  const xMax = xs[xs.length - 1]!;

  // y range: given, or the span of every value drawn so far, padded
  let lo = o.yRange?.[0] ?? Infinity;
  let hi = o.yRange?.[1] ?? -Infinity;
  if (!o.yRange) {
    for (const s of o.series) {
      for (let i = 0; i < Math.min(o.filled, s.values.length); i++) {
        const v = s.values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
  }

  const px = (v: number) => x0 + ((v - xMin) / (xMax - xMin || 1)) * (x1 - x0);
  const py = (v: number) => y1 - ((v - lo) / (hi - lo || 1)) * (y1 - y0);

  // regime bands under everything
  for (const b of o.bands ?? []) {
    const a = px(Math.max(xMin, Math.min(b.from, b.to)));
    const c = px(Math.min(xMax, Math.max(b.from, b.to)));
    ctx.fillStyle = b.color;
    ctx.fillRect(a, y0, Math.max(0, c - a), y1 - y0);
    if (b.label && c - a > 44) {
      ctx.fillStyle = COL.text;
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, (a + c) / 2, y0 + 11);
    }
  }

  // grid and axes
  ctx.strokeStyle = COL.grid;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillStyle = COL.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = py(v);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2), x0 - 6, y);
  }
  ctx.strokeStyle = COL.axis;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // x ticks: first, middle, last
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of [xMin, (xMin + xMax) / 2, xMax]) {
    ctx.fillStyle = COL.text;
    ctx.fillText(Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2), px(v), y1 + 6);
  }
  ctx.fillStyle = COL.text;
  ctx.fillText(o.xLabel, (x0 + x1) / 2, y1 + 19);
  ctx.save();
  ctx.translate(11, (y0 + y1) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(o.yLabel, 0, 0);
  ctx.restore();

  // the student's prediction, drawn before there is any data to contradict it
  if (o.guess) {
    const gx = px(o.guess.x);
    ctx.strokeStyle = COL.guess;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(gx, y0);
    ctx.lineTo(gx, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COL.guess;
    ctx.textAlign = gx > (x0 + x1) / 2 ? 'right' : 'left';
    ctx.textBaseline = 'top';
    // one line under the regime labels, which sit on the top edge of the bands
    ctx.fillText(o.guess.label, gx + (gx > (x0 + x1) / 2 ? -4 : 4), y0 + 15);
  }

  // the series
  for (const s of o.series) {
    const n = Math.min(o.filled, s.values.length, xs.length);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.secondary ? 1 : 2;
    ctx.globalAlpha = s.secondary ? 0.5 : 1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) { started = false; continue; }
      const X = px(xs[i]!);
      const Y = py(v);
      if (started) ctx.lineTo(X, Y);
      else { ctx.moveTo(X, Y); started = true; }
    }
    ctx.stroke();
    if (!s.secondary) {
      ctx.fillStyle = s.color;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        ctx.beginPath();
        ctx.arc(px(xs[i]!), py(v), 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // where the model actually turned
  if (o.marker) {
    const mx = px(o.marker.x);
    ctx.strokeStyle = COL.marker;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, y0);
    ctx.lineTo(mx, y1);
    ctx.stroke();
    ctx.fillStyle = COL.marker;
    ctx.textAlign = mx > (x0 + x1) / 2 ? 'right' : 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(o.marker.label, mx + (mx > (x0 + x1) / 2 ? -4 : 4), y1 - 3);
  }

  // a legend for the primary series
  const prim = o.series.filter((s) => !s.secondary);
  if (prim.length) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    let ly = y0 + 1;
    for (const s of prim) {
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, x1 - 2, ly);
      ly += 12;
    }
  }

  // still running: say so where the data stops. Not before the first point:
  // an empty axis drawn for orientation is not a run at zero
  if (o.filled > 0 && o.filled < xs.length) {
    ctx.fillStyle = COL.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const X = Math.min(x1 - 40, px(xs[Math.max(0, o.filled - 1)]!) + 8);
    ctx.fillText(`${o.filled}/${xs.length}`, X, y0 + 8);
  }
}
