/**
 * src/lib/colormap.ts — the activation colour scale, in ONE place.
 *
 * WHY THIS FILE EXISTS. The excitation colour used to be written out four
 * times: as GLSL constants in gl.ts, as numbers in render.ts, again in
 * slice.ts, and a fourth time as a CSS gradient for the legend. Four copies
 * of one decision is four chances to drift, and a legend that disagrees with
 * the cortex is worse than no legend. Everything that paints activity now
 * reads this module, and the shader is handed the same table as a uniform
 * rather than repeating it.
 *
 * THE SCALE. Turbo (Mikhailov, Google, 2019): a rainbow that is ordered the
 * way the eye orders brightness, so equal steps of colour are equal steps of
 * activity. Jet — the rainbow of older EEG and fMRI figures — is not, and
 * invents edges in the data at its cyan and yellow bands. The table below is
 * 33 samples of Turbo, taken from matplotlib's copy of the reference values.
 *
 * TWO DELIBERATE DEPARTURES from plain Turbo, both so the map says something
 * true about a brain:
 *
 *   1. The top is clipped at TOP. Turbo ends at a very dark red (#7a0403),
 *      which on dark tissue under directional light reads as LESS active
 *      than the orange below it — exactly backwards. Clipping ends the scale
 *      on a strong red that stays the brightest, hottest thing on screen.
 *
 *   2. Colour is an overlay on anatomy, not a replacement for it. Below
 *      threshold the cortex keeps its tissue grey so the gyri and sulci still
 *      read, and the scale fades in over MIX_FROM..MIX_FULL. A resting brain
 *      looks like a brain; an active one lights up. This is the convention
 *      every fMRI figure uses, and the reason the model's resting mean
 *      (~0.13, so excite ~0.09) must not paint the whole organ blue.
 *
 * The legend in the page is generated from cssGradient() for the same reason.
 */

/** Turbo, 33 samples, 0..255. Do not hand-edit: see the header. */
export const TURBO: ReadonlyArray<readonly [number, number, number]> = [
  [48, 18, 59], [57, 42, 115], [64, 64, 162], [68, 86, 199],
  [70, 107, 227], [70, 128, 246], [66, 148, 255], [55, 168, 250],
  [40, 188, 235], [28, 205, 216], [24, 221, 194], [31, 233, 175],
  [50, 242, 152], [78, 249, 125], [109, 254, 98], [139, 255, 75],
  [164, 252, 60], [185, 246, 53], [205, 236, 52], [223, 223, 55],
  [238, 207, 58], [248, 190, 57], [253, 172, 52], [254, 150, 43],
  [251, 126, 33], [244, 102, 23], [235, 80, 14], [223, 63, 8],
  [208, 47, 5], [190, 33, 2], [169, 22, 1], [146, 11, 1],
  [122, 4, 3],
];

/** how far up Turbo the scale runs; past this it darkens instead of heating */
export const TOP = 0.88;

/* ── activity → position on the scale ───────────────────────────────────── */

/**
 * Regional firing rate → 0..1 along the scale. Below FLOOR nothing is
 * painted; SPAN sets what counts as saturated. Shared so the cortex, the
 * sections and the 2D overlay all agree on what "fully excited" means.
 */
export const EXCITE_FLOOR = 0.06;
export const EXCITE_SPAN = 0.75;
export const excite = (a: number): number =>
  Math.max(0, Math.min(1, (a - EXCITE_FLOOR) / EXCITE_SPAN));

/**
 * Where colour starts to show over anatomy, and where it fully covers.
 * Tuned against the model, not by eye: the waking cortex sits near activity
 * 0.13, which is excite ~0.09, and must stay grey enough to read as anatomy
 * (~5% colour here). Past a quarter of the range the scale takes over
 * completely, so a moderately active region is unmistakably ITS colour rather
 * than a pastel of grey and its colour.
 */
export const MIX_FROM = 0.04;
export const MIX_FULL = 0.40;

/** how much of the scale shows through the tissue grey, 0..1 (smoothstep) */
export function overlayMix(e: number): number {
  const u = Math.max(0, Math.min(1, (e - MIX_FROM) / (MIX_FULL - MIX_FROM)));
  return u * u * (3 - 2 * u);
}

/* ── the scale itself ───────────────────────────────────────────────────── */

/** Turbo sampled at t (0..1), linearly between the 33 stops */
export function turbo(t: number): [number, number, number] {
  const s = Math.max(0, Math.min(1, t)) * (TURBO.length - 1);
  const i = Math.min(TURBO.length - 2, Math.floor(s));
  const f = s - i;
  const a = TURBO[i]!;
  const b = TURBO[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** excitation (0..1) → its colour on the scale, with the top clipped */
export function activation(e: number): [number, number, number] {
  return turbo(Math.max(0, Math.min(1, e)) * TOP);
}

/** the scale as a CSS gradient, so the legend cannot disagree with the brain */
export function cssGradient(deg = 90): string {
  const n = 16;
  const stops: string[] = [];
  for (let i = 0; i <= n; i++) {
    const c = activation(i / n);
    stops.push(`rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0}) ${((i / n) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${deg}deg, ${stops.join(', ')})`;
}

/** the table flattened to 0..1 floats, for upload as a GLSL uniform array */
export function turboUniform(): Float32Array {
  const out = new Float32Array(TURBO.length * 3);
  for (let i = 0; i < TURBO.length; i++) {
    out[i * 3] = TURBO[i]![0] / 255;
    out[i * 3 + 1] = TURBO[i]![1] / 255;
    out[i * 3 + 2] = TURBO[i]![2] / 255;
  }
  return out;
}

/* ── the diverging scale: a CHANGE, not a level ──────────────────────────── */

/**
 * The second scale in this module, and the only other one allowed.
 *
 * Comparing two runs asks a different question from reading one: not "how
 * active is this region" but "which way did it move". A sequential scale
 * cannot answer that — zero has no place on it — so a difference gets a
 * diverging scale with no change in the middle.
 *
 * ITS COLOURS ARE TAKEN FROM THE SCALE ABOVE, not invented beside it: the
 * warm end is where activation() ends, the cool end is Turbo's blue, and the
 * middle is the same tissue grey the cortex is drawn in when nothing is
 * happening. So an unchanged region in a difference map looks exactly like a
 * quiet region in an activity map — which is what it is.
 */
export const DIFF_WARM: readonly [number, number, number] = turbo(TOP);
export const DIFF_COOL: readonly [number, number, number] = turbo(0.12);
/** the matter grey the cortex is lit in, so "no change" reads as plain tissue */
export const DIFF_NEUTRAL: readonly [number, number, number] = [196, 190, 181];

/**
 * A signed difference → 0..1 on the diverging scale, 0.5 being no change.
 * `span` is the difference that reaches either end; it is chosen per
 * comparison and PRINTED beside the picture, because a difference map whose
 * scale is not stated is a picture that can be made to say anything.
 */
export const diffPos = (d: number, span: number): number =>
  0.5 + 0.5 * Math.max(-1, Math.min(1, d / (span || 1)));

/** how far from "no change" a position is, 0..1 — the strength of the paint */
export const diffStrength = (t: number): number => Math.min(1, Math.abs(t - 0.5) * 2);

/** position on the diverging scale (0.5 = no change) → its colour */
export function divergence(t: number): [number, number, number] {
  const k = diffStrength(t);
  const end = t >= 0.5 ? DIFF_WARM : DIFF_COOL;
  return [
    DIFF_NEUTRAL[0] + (end[0] - DIFF_NEUTRAL[0]) * k,
    DIFF_NEUTRAL[1] + (end[1] - DIFF_NEUTRAL[1]) * k,
    DIFF_NEUTRAL[2] + (end[2] - DIFF_NEUTRAL[2]) * k,
  ];
}

/** the diverging scale as a CSS gradient, so its legend cannot disagree either */
export function cssGradientDiff(deg = 90): string {
  const n = 16;
  const stops: string[] = [];
  for (let i = 0; i <= n; i++) {
    const c = divergence(i / n);
    stops.push(`rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0}) ${((i / n) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${deg}deg, ${stops.join(', ')})`;
}
