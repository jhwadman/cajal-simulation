/**
 * engine/neuron.ts — one neuron, from ion gradients to spikes.
 *
 * Two equations, one chain:
 *
 *   1. NERNST and GOLDMAN–HODGKIN–KATZ (GHK). Each ion's concentration
 *      gradient sets its own equilibrium (Nernst) potential; the resting
 *      membrane potential is the GHK weighted mixture of those gradients,
 *      weighted by how permeable the membrane is to each ion:
 *
 *        Vm = (RT/F) · ln( (P_K[K]o + P_Na[Na]o + P_Cl[Cl]i) / (P_K[K]i + P_Na[Na]i + P_Cl[Cl]o) )
 *
 *   2. HODGKIN–HUXLEY (HH). A spiking membrane: voltage-gated sodium and
 *      potassium conductances plus a leak, driven by a current step. Its
 *      reversal potentials come from the SAME concentrations (Nernst), its
 *      leak reversal is the GHK potential of the resting permeabilities, and
 *      its leak conductance grows when the membrane is made more permeable —
 *      so changing a concentration or opening chloride channels in part 1
 *      changes how this neuron fires.
 *
 * The rate equations are Hodgkin and Huxley's (modern sign convention),
 * scaled with a Q10 of 3 so that 37 °C runs at their reference speed. This is
 * a textbook membrane, not a particular cell type. Pure TypeScript, shared by
 * the page and the agent's tool.
 */

export interface Ions {
  K_in: number;
  K_out: number;
  Na_in: number;
  Na_out: number;
  Cl_in: number;
  Cl_out: number;
}
export interface Permeability {
  K: number;
  Na: number;
  Cl: number;
}

/** a typical mammalian neuron, mM */
export const DEFAULT_IONS: Ions = { K_in: 140, K_out: 5, Na_in: 12, Na_out: 145, Cl_in: 7, Cl_out: 110 };
/** resting relative permeabilities, P_K = 1 */
export const DEFAULT_PERM: Permeability = { K: 1, Na: 0.04, Cl: 0.45 };

const R = 8.314462618;
const F = 96485.33212;

/** RT/F in millivolts at a temperature in °C */
export function thermalVoltage(tempC: number): number {
  return ((R * (tempC + 273.15)) / F) * 1000;
}

/** Nernst potential in mV for an ion of valence z */
export function nernst(z: number, out: number, inn: number, tempC = 37): number {
  return (thermalVoltage(tempC) / z) * Math.log(out / inn);
}

/** the GHK voltage equation in mV */
export function ghk(perm: Permeability, ions: Ions, tempC = 37): number {
  const num = perm.K * ions.K_out + perm.Na * ions.Na_out + perm.Cl * ions.Cl_in;
  const den = perm.K * ions.K_in + perm.Na * ions.Na_in + perm.Cl * ions.Cl_out;
  return thermalVoltage(tempC) * Math.log(num / den);
}

/* ── conditions and drugs ────────────────────────────────────────────────── */

export interface NeuronCondition {
  id: string;
  title: string;
  blurb: string;
  ions?: Partial<Ions>;
  perm?: Partial<Permeability>;
  temperature_c?: number;
}

export const NEURON_CONDITIONS: readonly NeuronCondition[] = [
  { id: 'resting', title: 'Resting neuron', blurb: 'Typical mammalian gradients; the membrane mostly permeable to potassium, so it rests near E_K.' },
  { id: 'ap-peak', title: 'Peak of an action potential', blurb: 'Sodium channels open: P_Na rises about 500-fold (to 20× P_K), and Vm swings toward E_Na.', perm: { Na: 20 } },
  { id: 'hyperkalemia', title: 'Hyperkalaemia (K⁺ out 9 mM)', blurb: 'High blood potassium shrinks the potassium gradient: the cell depolarises and becomes easier to fire.', ions: { K_out: 9 } },
  { id: 'raised-k', title: 'Raised extracellular K⁺ (12 mM)', blurb: 'As during intense activity or a seizure: the cell sits so close to threshold that it fires on its own.', ions: { K_out: 12 } },
  { id: 'extreme-k', title: 'Extreme extracellular K⁺ (25 mM)', blurb: 'As in spreading depolarisation: depolarised so far that sodium channels stay inactivated, so the neuron cannot fire at all (depolarisation block).', ions: { K_out: 25 } },
  { id: 'hypokalemia', title: 'Hypokalaemia (K⁺ out 2.5 mM)', blurb: 'Low potassium steepens the gradient: the cell hyperpolarises and is harder to excite.', ions: { K_out: 2.5 } },
  { id: 'hyponatremia', title: 'Hyponatraemia (Na⁺ out 120 mM)', blurb: 'Less sodium outside lowers E_Na: smaller action potentials.', ions: { Na_out: 120 } },
  { id: 'gaba-open', title: 'GABA-A channels open', blurb: 'Chloride permeability up tenfold: Vm is pulled toward E_Cl and the extra conductance shunts excitatory input.', perm: { Cl: 4.5 } },
  { id: 'ouabain', title: 'Pump blocked (ouabain, minutes)', blurb: 'With the Na⁺/K⁺ pump stopped, gradients run down: potassium leaks out, sodium leaks in, the cell depolarises.', ions: { K_in: 110, Na_in: 40, K_out: 7 } },
  { id: 'cold', title: 'Cooled to 20 °C', blurb: 'Colder membranes: slightly smaller RT/F and much slower channel gating, so spikes broaden.', temperature_c: 20 },
  { id: 'fever', title: 'Fever (40 °C)', blurb: 'Faster gating and narrower spikes.', temperature_c: 40 },
];

export interface NeuronDrug {
  id: string;
  title: string;
  blurb: string;
  gNa: number;
  gK: number;
}

export const NEURON_DRUGS: readonly NeuronDrug[] = [
  { id: 'none', title: 'No drug', blurb: '', gNa: 1, gK: 1 },
  { id: 'ttx', title: 'Tetrodotoxin (TTX)', blurb: 'Pufferfish toxin: blocks voltage-gated sodium channels completely, so no action potential can start.', gNa: 0, gK: 1 },
  { id: 'lidocaine', title: 'Lidocaine', blurb: 'Local anaesthetic: blocks about half the sodium channels, raising threshold and slowing firing.', gNa: 0.45, gK: 1 },
  { id: 'tea', title: 'Tetraethylammonium (TEA)', blurb: 'Blocks delayed-rectifier potassium channels: spikes repolarise slowly and broaden.', gNa: 1, gK: 0.15 },
  { id: '4-ap', title: '4-aminopyridine', blurb: 'Potassium-channel blocker: broader spikes and easier repetitive firing.', gNa: 1, gK: 0.55 },
];

/* ── the spiking membrane ────────────────────────────────────────────────── */

export interface NeuronParams {
  ions?: Partial<Ions>;
  perm?: Partial<Permeability>;
  temperature_c?: number;
  drug?: string;
  /** current step, µA/cm² */
  current_ua?: number;
  onset_ms?: number;
  pulse_ms?: number;
  duration_ms?: number;
}

export interface ResolvedNeuronParams {
  ions: Ions;
  perm: Permeability;
  temperature_c: number;
  drug: string;
  current_ua: number;
  onset_ms: number;
  pulse_ms: number;
  duration_ms: number;
}

export interface NeuronRun {
  kind: 'neuron';
  params: ResolvedNeuronParams;
  E: { Na: number; K: number; Cl: number; leak: number };
  ghk: number;
  dt_ms: number;
  V: Float32Array;
  m: Float32Array;
  h: Float32Array;
  n: Float32Array;
  I: Float32Array;
  spikes: number[];
  rest_mv: number;
  peak_mv: number | null;
  width_ms: number | null;
  threshold_mv: number | null;
  rate_hz: number;
  notes: string[];
}

const G_NA = 120;
const G_K = 36;
const G_L = 0.3;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function resolveNeuronParams(p: NeuronParams): ResolvedNeuronParams {
  const ions = { ...DEFAULT_IONS, ...(p.ions ?? {}) };
  for (const k of Object.keys(ions) as Array<keyof Ions>) ions[k] = clamp(Number.isFinite(ions[k]) ? ions[k] : DEFAULT_IONS[k], 0.1, 500);
  const perm = { ...DEFAULT_PERM, ...(p.perm ?? {}) };
  for (const k of Object.keys(perm) as Array<keyof Permeability>) perm[k] = clamp(Number.isFinite(perm[k]) ? perm[k] : DEFAULT_PERM[k], 0, 100);
  if (perm.K + perm.Na + perm.Cl <= 0) perm.K = 1;
  const duration_ms = clamp(p.duration_ms ?? 100, 20, 400);
  const onset_ms = clamp(p.onset_ms ?? 10, 0, duration_ms);
  return {
    ions,
    perm,
    temperature_c: clamp(p.temperature_c ?? 37, 0, 45),
    drug: NEURON_DRUGS.some((d) => d.id === p.drug) ? p.drug! : 'none',
    current_ua: clamp(p.current_ua ?? 15, -20, 100),
    onset_ms,
    pulse_ms: clamp(p.pulse_ms ?? 80, 0, duration_ms - onset_ms),
    duration_ms,
  };
}

const rates = (V: number) => {
  const an = Math.abs(V + 55) < 1e-6 ? 0.1 : (0.01 * (V + 55)) / (1 - Math.exp(-(V + 55) / 10));
  const bn = 0.125 * Math.exp(-(V + 65) / 80);
  const am = Math.abs(V + 40) < 1e-6 ? 1 : (0.1 * (V + 40)) / (1 - Math.exp(-(V + 40) / 10));
  const bm = 4 * Math.exp(-(V + 65) / 18);
  const ah = 0.07 * Math.exp(-(V + 65) / 20);
  const bh = 1 / (1 + Math.exp(-(V + 35) / 10));
  return { an, bn, am, bm, ah, bh };
};

export function simulateNeuron(input: NeuronParams): NeuronRun {
  const p = resolveNeuronParams(input);
  const T = p.temperature_c;
  const E = {
    Na: nernst(1, p.ions.Na_out, p.ions.Na_in, T),
    K: nernst(1, p.ions.K_out, p.ions.K_in, T),
    Cl: nernst(-1, p.ions.Cl_out, p.ions.Cl_in, T),
    leak: 0,
  };
  const vRest = ghk(p.perm, p.ions, T);
  E.leak = vRest;
  const drug = NEURON_DRUGS.find((d) => d.id === p.drug)!;
  const gNa = G_NA * drug.gNa;
  const gK = G_K * drug.gK;
  // more open channels at rest = more leak conductance (shunting)
  const permSum = p.perm.K + p.perm.Na + p.perm.Cl;
  const gL = G_L * (permSum / (DEFAULT_PERM.K + DEFAULT_PERM.Na + DEFAULT_PERM.Cl));
  const phi = Math.pow(3, (T - 37) / 10);

  const dt = 0.01;
  const every = 5;
  const preroll = Math.round(50 / dt);
  const steps = Math.round(p.duration_ms / dt);
  const nOut = Math.floor(steps / every);
  const Vs = new Float32Array(nOut);
  const ms = new Float32Array(nOut);
  const hs = new Float32Array(nOut);
  const ns = new Float32Array(nOut);
  const Is = new Float32Array(nOut);

  let V = vRest;
  let r = rates(V);
  let m = r.am / (r.am + r.bm);
  let h = r.ah / (r.ah + r.bh);
  let n = r.an / (r.an + r.bn);
  const spikes: number[] = [];
  let above = false;
  let prevV = V;
  let threshold: number | null = null;
  let restSum = 0;
  let restN = 0;
  let peak = -Infinity;

  for (let k = -preroll; k < steps; k++) {
    const t = k * dt;
    const I = t >= p.onset_ms && t < p.onset_ms + p.pulse_ms ? p.current_ua : 0;
    r = rates(V);
    // exponential Euler for the gates: stable at any rate
    const step = (x: number, a: number, b: number) => {
      const tau = 1 / ((a + b) * phi);
      const inf = a / (a + b);
      return inf + (x - inf) * Math.exp(-dt / tau);
    };
    m = step(m, r.am, r.bm);
    h = step(h, r.ah, r.bh);
    n = step(n, r.an, r.bn);
    const INa = gNa * m * m * m * h * (V - E.Na);
    const IK = gK * n * n * n * n * (V - E.K);
    const IL = gL * (V - E.leak);
    V += dt * (I - INa - IK - IL); // C = 1 µF/cm²
    if (!Number.isFinite(V)) V = E.leak;
    if (k < 0) continue;
    if (t < p.onset_ms && t >= p.onset_ms - 5) {
      restSum += V;
      restN++;
    }
    const dVdt = (V - prevV) / dt;
    // threshold: where the membrane's own (ionic) current turns inward and runs away, not where the step starts
    if (threshold === null && !above && dVdt - I > 5 && t >= p.onset_ms) threshold = prevV;
    if (!above && V > 0) {
      above = true;
      spikes.push(t);
    } else if (above && V < -20) above = false;
    if (t >= p.onset_ms) peak = Math.max(peak, V);
    prevV = V;
    if (k % every === 0) {
      const o = k / every;
      if (o < nOut) {
        Vs[o] = V;
        ms[o] = m;
        hs[o] = h;
        ns[o] = n;
        Is[o] = I;
      }
    }
  }

  const rest = restN ? restSum / restN : Vs[0] ?? vRest;
  // width of the first spike at half amplitude
  let width: number | null = null;
  if (spikes.length) {
    const s0 = Math.round(spikes[0]! / (dt * every));
    let pk = s0;
    for (let i = s0; i < Math.min(nOut, s0 + Math.round(5 / (dt * every))); i++) if (Vs[i]! > Vs[pk]!) pk = i;
    const half = (rest + Vs[pk]!) / 2;
    let a = pk;
    while (a > 0 && Vs[a]! > half) a--;
    let b = pk;
    while (b < nOut - 1 && Vs[b]! > half) b++;
    width = (b - a) * dt * every;
  }
  const inPulse = spikes.filter((t) => t >= p.onset_ms && t < p.onset_ms + p.pulse_ms);
  const rate = p.pulse_ms > 0 ? (inPulse.length / p.pulse_ms) * 1000 : 0;

  const notes: string[] = [];
  const spontaneous = spikes.filter((t) => t < p.onset_ms).length;
  if (spontaneous) notes.push('spontaneous firing before any stimulus: the resting membrane sits above threshold');
  if (!spikes.length && p.current_ua > 0) {
    if (drug.gNa === 0) notes.push('no action potentials: TTX has removed the sodium current that starts them');
    else if (rest > -55) notes.push('depolarisation block: the resting potential is so high that sodium channels are inactivated (h stays low), so the neuron cannot fire');
    else notes.push('no action potentials: the stimulus is below threshold for this membrane');
  }
  if (spikes.length === 1 && p.pulse_ms > 30) notes.push('a single spike then silence: the membrane accommodates to the step');
  if (spikes.length > 1) notes.push(`repetitive firing at ${rate.toFixed(0)} Hz during the step`);
  if (width !== null && width > 2.5) notes.push(`broad spikes (${width.toFixed(1)} ms at half amplitude): repolarisation is slow`);
  if (p.perm.Cl > DEFAULT_PERM.Cl * 3) notes.push('chloride conductance up: the extra leak shunts injected current, so more current is needed to fire');

  return {
    kind: 'neuron',
    params: p,
    E,
    ghk: vRest,
    dt_ms: dt * every,
    V: Vs,
    m: ms,
    h: hs,
    n: ns,
    I: Is,
    spikes,
    rest_mv: rest,
    peak_mv: spikes.length ? peak : null,
    width_ms: width,
    threshold_mv: spikes.length ? threshold : null,
    rate_hz: rate,
    notes,
  };
}

/** the text the agent reads */
export function printNeuron(runId: string, r: NeuronRun): string {
  const p = r.params;
  const f1 = (x: number) => x.toFixed(1);
  const lines = [
    `RUN_ID: ${runId}`,
    `SINGLE NEURON · Nernst + Goldman–Hodgkin–Katz + Hodgkin–Huxley · ${p.temperature_c} °C · drug ${p.drug} · step ${p.current_ua} µA/cm² from ${p.onset_ms} ms for ${p.pulse_ms} ms`,
    `CONCENTRATIONS (mM, in/out): K⁺ ${p.ions.K_in}/${p.ions.K_out} · Na⁺ ${p.ions.Na_in}/${p.ions.Na_out} · Cl⁻ ${p.ions.Cl_in}/${p.ions.Cl_out}`,
    `PERMEABILITIES (relative): P_K ${p.perm.K} · P_Na ${p.perm.Na} · P_Cl ${p.perm.Cl}`,
    `NERNST: E_K ${f1(r.E.K)} mV · E_Na ${f1(r.E.Na)} mV · E_Cl ${f1(r.E.Cl)} mV`,
    `GHK resting potential: ${f1(r.ghk)} mV (the leak reversal of the spiking model)`,
    `SPIKING MODEL: rest ${f1(r.rest_mv)} mV · ${r.spikes.length} spike(s)${r.spikes.length ? ` · peak ${f1(r.peak_mv!)} mV · width ${r.width_ms!.toFixed(2)} ms · threshold ${r.threshold_mv !== null ? f1(r.threshold_mv) : '?'} mV · ${r.rate_hz.toFixed(0)} Hz during the step` : ''}`,
  ];
  if (r.notes.length) lines.push('READING:', ...r.notes.map((n) => `  - ${n}`));
  lines.push('A textbook membrane (Hodgkin–Huxley kinetics, Q10 3, referenced to 37 °C), not a particular cell type.');
  return lines.join('\n');
}
