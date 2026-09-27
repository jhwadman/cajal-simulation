/**
 * src/lib/neuronTab.ts — the Single neuron tab: the Goldman–Hodgkin–Katz
 * equation and a Hodgkin–Huxley membrane, recomputed in this browser on every
 * control change (both run in well under a frame). Pure maths from
 * service/engine/neuron.ts; no AI anywhere in this tab.
 *
 * Every string reaches the DOM through textContent or createElement.
 */

import {
  simulateNeuron, thermalVoltage, NEURON_CONDITIONS, NEURON_DRUGS, DEFAULT_IONS, DEFAULT_PERM,
} from '../../service/engine/neuron.ts';
import type { Ions, Permeability, NeuronParams, NeuronRun } from '../../service/engine/neuron.ts';

export interface NeuronTab {
  getParams(): NeuronParams;
  setParams(p: NeuronParams): void;
  redraw(): void;
}

const ION_KEYS: Array<keyof Ions> = ['K_in', 'K_out', 'Na_in', 'Na_out', 'Cl_in', 'Cl_out'];
const PERM_KEYS: Array<keyof Permeability> = ['K', 'Na', 'Cl'];

const COL = { K: '#35d6ff', Na: '#ff6a3d', Cl: '#ffb45c', vm: '#ffffff', rest: '#9aa4b2' };

export function startNeuronTab(): NeuronTab {
  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el as T;
  };
  const membraneCanvas = $<HTMLCanvasElement>('membrane-canvas');
  const ghkCanvas = $<HTMLCanvasElement>('ghk-canvas');
  const hhCanvas = $<HTMLCanvasElement>('hh-canvas');
  const gateCanvas = $<HTMLCanvasElement>('gate-canvas');
  const condSel = $<HTMLSelectElement>('nc-condition');
  const drugSel = $<HTMLSelectElement>('nc-drug');

  let ions: Ions = { ...DEFAULT_IONS };
  let perm: Permeability = { ...DEFAULT_PERM };
  let temperature = 37;
  let drug = 'none';
  let current = 15;
  let pulse = 80;
  let last: NeuronRun | null = null;

  const fmtPerm = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3));

  function writeControls(): void {
    for (const k of ION_KEYS) {
      const input = $<HTMLInputElement>(`nc-${k}`);
      input.value = String(ions[k]);
      $(`nc-out-${k}`).textContent = `${ions[k]} mM`;
    }
    for (const k of PERM_KEYS) {
      const input = $<HTMLInputElement>(`nc-P${k}`);
      input.value = String(Math.log10(Math.max(0.001, perm[k])));
      $(`nc-out-P${k}`).textContent = fmtPerm(perm[k]);
    }
    $<HTMLInputElement>('nc-temp').value = String(temperature);
    $('nc-out-temp').textContent = `${temperature} °C`;
    $<HTMLInputElement>('nc-current').value = String(current);
    $('nc-out-current').textContent = `${current} µA/cm²`;
    $<HTMLInputElement>('nc-pulse').value = String(pulse);
    $('nc-out-pulse').textContent = `${pulse} ms`;
    drugSel.value = drug;
    $('nc-drug-blurb').textContent = NEURON_DRUGS.find((d) => d.id === drug)?.blurb ?? '';
  }

  function readControl(el: HTMLInputElement): void {
    const ion = el.dataset.ion as keyof Ions | undefined;
    const pk = el.dataset.perm as keyof Permeability | undefined;
    if (ion) ions = { ...ions, [ion]: Number(el.value) };
    else if (pk) perm = { ...perm, [pk]: Math.round(Math.pow(10, Number(el.value)) * 1000) / 1000 };
    else if (el.id === 'nc-temp') temperature = Number(el.value);
    else if (el.id === 'nc-current') current = Number(el.value);
    else if (el.id === 'nc-pulse') pulse = Number(el.value);
    condSel.value = 'custom';
    $('nc-condition-blurb').textContent = 'Custom: your own concentrations, permeabilities and temperature.';
  }

  function applyCondition(id: string): void {
    const c = NEURON_CONDITIONS.find((x) => x.id === id);
    if (!c) return;
    ions = { ...DEFAULT_IONS, ...(c.ions ?? {}) };
    perm = { ...DEFAULT_PERM, ...(c.perm ?? {}) };
    // the permeability of the peak-of-spike preset is a ratio to P_K
    if (c.perm?.Na && c.perm.Na > 1) perm = { ...perm, Na: c.perm.Na };
    temperature = c.temperature_c ?? 37;
    $('nc-condition-blurb').textContent = c.blurb;
  }

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      compute();
    });
  };

  function params(): NeuronParams {
    return { ions: { ...ions }, perm: { ...perm }, temperature_c: temperature, drug, current_ua: current, onset_ms: 10, pulse_ms: pulse, duration_ms: Math.max(100, pulse + 30) };
  }

  function compute(): void {
    writeControls();
    last = simulateNeuron(params());
    draw();
  }

  function draw(): void {
    if (!last) return;
    drawMembrane(last);
    drawGhk(last);
    drawEquation(last);
    drawIonTable(last);
    drawTrace(last);
    drawGates(last);
    drawSummary(last);
  }

  /* ── canvas helpers ────────────────────────────────────────────────────── */

  function prep(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const ctx = c.getContext('2d');
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!ctx || w === 0) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px ui-monospace, Menlo, monospace';
    return { ctx, w, h };
  }

  /**
   * A patch of membrane, drawn from the same numbers the equation uses.
   *
   * WHY. The GHK axis below says WHERE the voltage lands; it does not show
   * why. This does: one column per ion, dots stacked by concentration on each
   * side, so the column heights ARE the gradient; a pore through the bilayer
   * as wide as that ion's permeability; and an arrow whose weight is the
   * current that actually flows (permeability × driving force). Potassium's
   * arrow is the heavy one at rest even though sodium is pulled far harder,
   * which is the whole point of the Goldman equation.
   *
   * The dot scatter is seeded from the ion and the index, never random, so
   * dragging a slider moves only what the number moved.
   */
  function drawMembrane(r: NeuronRun): void {
    const p = prep(membraneCanvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const ions = r.params.ions;
    const perm = r.params.perm;
    const vm = r.rest_mv;

    const padX = 12;
    const midY = h * 0.52;
    const memH = 24;
    const memTop = midY - memH / 2;
    const memBot = midY + memH / 2;
    const outTop = 33;                 // the corner labels own the row above
    const outBot = memTop - 16;
    const inTop = memBot + 16;
    const inBot = h - 29;
    const vGutter = 88;                // the voltage chip's reserved strip

    /* the two compartments */
    const bgOut = ctx.createLinearGradient(0, outTop - 10, 0, memTop);
    bgOut.addColorStop(0, 'rgba(53,214,255,0.05)');
    bgOut.addColorStop(1, 'rgba(53,214,255,0.015)');
    ctx.fillStyle = bgOut;
    ctx.fillRect(0, 0, w, memTop);
    ctx.fillStyle = 'rgba(255,180,92,0.035)';
    ctx.fillRect(0, memBot, w, h - memBot);

    ctx.fillStyle = 'rgba(154,164,178,0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('OUTSIDE', padX, 4);
    ctx.textBaseline = 'bottom';
    ctx.fillText('INSIDE', padX, h - 3);

    const cols: Array<{ key: 'K' | 'Na' | 'Cl'; sym: string; out: number; inn: number; E: number; P: number; z: number }> = [
      { key: 'K', sym: 'K⁺', out: ions.K_out, inn: ions.K_in, E: r.E.K, P: perm.K, z: 1 },
      { key: 'Na', sym: 'Na⁺', out: ions.Na_out, inn: ions.Na_in, E: r.E.Na, P: perm.Na, z: 1 },
      { key: 'Cl', sym: 'Cl⁻', out: ions.Cl_out, inn: ions.Cl_in, E: r.E.Cl, P: perm.Cl, z: -1 },
    ];
    const colW = (w - padX * 2 - vGutter) / cols.length;
    // everything relative is measured against the biggest of the three, so the
    // picture answers "which ion is doing this?" rather than "how many pA?"
    const pMax = Math.max(...cols.map((c) => c.P), 1e-6);
    const fluxOf = (c: typeof cols[number]) => Math.abs(vm - c.E) * c.P;
    const fMax = Math.max(...cols.map(fluxOf), 1e-6);

    // a fixed scatter: the same slider value always draws the same picture
    const jitter = (seed: number): number => {
      const x = Math.sin(seed * 127.1) * 43758.5453;
      return x - Math.floor(x);
    };
    // one dot per 6 mM: fine enough that hyperkalaemia (K⁺ out 5 → 9 mM) is a
    // visible change, coarse enough that a 28:1 gradient still reads at a glance
    const DOT_MM = 6;
    const MAX_DOTS = 24;

    /* the lipid bilayer: two leaflets of heads, broken where a channel sits.
       The gap IS the pore, so a shut channel reads as an unbroken membrane. */
    const pores = cols.map((c, i) => ({
      cx: padX + colW * (i + 0.5),
      pw: 3 + 21 * Math.sqrt(Math.min(1, c.P / pMax)),
      colour: COL[c.key],
    }));
    ctx.fillStyle = 'rgba(232,236,241,0.055)';
    ctx.fillRect(0, memTop, w, memH);
    const headR = 3.1;
    const step = 7.4;
    for (let x = step / 2; x < w; x += step) {
      if (pores.some((q) => Math.abs(x - q.cx) < q.pw / 2 + headR)) continue;
      ctx.fillStyle = 'rgba(232,236,241,0.30)';
      for (const y of [memTop + headR + 1, memBot - headR - 1]) {
        ctx.beginPath();
        ctx.arc(x, y, headR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(232,236,241,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, memTop + headR * 2 + 1);
      ctx.lineTo(x, memBot - headR * 2 - 1);
      ctx.stroke();
    }

    const drawDots = (cx: number, top: number, bot: number, conc: number, colour: string, seed0: number, fromTop: boolean): void => {
      const n = Math.max(conc > 0.5 ? 1 : 0, Math.min(MAX_DOTS, Math.round(conc / DOT_MM)));
      // the cluster has to fit its column at any panel width
      const perRow = 7;
      const dx = Math.min(13, (colW - 10) / perRow);
      const dy = dx;
      const rDot = Math.min(4.2, dx * 0.33);
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / perRow);
        const inRow = i % perRow;
        const rowN = Math.min(perRow, n - row * perRow);
        const x = cx + (inRow - (rowN - 1) / 2) * dx + (jitter(seed0 + i) - 0.5) * dx * 0.25;
        // stack away from the membrane, so both compartments read as "against" it
        const y = fromTop ? bot - 6 - row * dy : top + 6 + row * dy;
        if (y < top || y > bot) continue;
        ctx.fillStyle = colour;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, rDot, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };

    cols.forEach((c, i) => {
      const cx = padX + colW * (i + 0.5);
      const colour = COL[c.key];
      drawDots(cx, outTop, outBot, c.out, colour, i * 100 + 1, true);
      drawDots(cx, inTop, inBot, c.inn, colour, i * 100 + 50, false);

      /* the channel: a pore through both leaflets, as wide as permeability */
      const pw = pores[i]!.pw;
      ctx.fillStyle = 'rgba(6,8,12,0.92)';
      ctx.fillRect(cx - pw / 2, memTop, pw, memH);
      // the channel walls, in the ion's own colour
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - pw / 2, memTop - 2); ctx.lineTo(cx - pw / 2, memBot + 2);
      ctx.moveTo(cx + pw / 2, memTop - 2); ctx.lineTo(cx + pw / 2, memBot + 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* the net drive, and how much current it actually moves */
      const drive = vm - c.E;                       // mV; sign is the cation convention
      const outward = c.z > 0 ? drive > 0 : drive < 0;
      const weight = fluxOf(c) / fMax;
      if (Math.abs(drive) > 0.5 && c.P > 0.002 && weight > 0.02) {
        const aTop = memTop - 22;
        const aBot = memBot + 22;
        ctx.strokeStyle = colour;
        ctx.globalAlpha = 0.25 + 0.75 * weight;
        ctx.lineWidth = 1 + 5 * weight;
        ctx.beginPath();
        ctx.moveTo(cx, outward ? aBot : aTop);
        ctx.lineTo(cx, outward ? aTop : aBot);
        ctx.stroke();
        const ty = outward ? aTop : aBot;
        const dir = outward ? 1 : -1;
        const head = 4 + 3 * weight;
        ctx.beginPath();
        ctx.moveTo(cx, ty);
        ctx.lineTo(cx - head, ty + head * 1.8 * dir);
        ctx.lineTo(cx + head, ty + head * 1.8 * dir);
        ctx.closePath();
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      /* the numbers this column is drawn from */
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = colour;
      ctx.fillText(`${c.sym} ${c.out}`, cx, outTop - 14);
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${c.sym} ${c.inn}`, cx, inBot + 14);
    });

    /* the charge the gradients leave across the bilayer */
    const nCharge = Math.min(11, Math.max(2, Math.round(Math.abs(vm) / 8)));
    const neg = vm < 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    for (let i = 0; i < nCharge; i++) {
      const x = padX + 10 + ((w - padX * 2 - vGutter - 20) * i) / Math.max(1, nCharge - 1);
      ctx.fillStyle = neg ? 'rgba(53,214,255,0.75)' : 'rgba(255,106,61,0.75)';
      ctx.fillText(neg ? '−' : '+', x, memBot + 7);
      ctx.fillStyle = neg ? 'rgba(255,106,61,0.75)' : 'rgba(53,214,255,0.75)';
      ctx.fillText(neg ? '+' : '−', x, memTop - 7);
    }
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const vLabel = `Vm ${vm.toFixed(1)} mV`;
    const vw = ctx.measureText(vLabel).width;
    ctx.fillStyle = 'rgba(6,8,12,0.9)';
    ctx.fillRect(w - padX - vw - 7, midY - 9, vw + 10, 18);
    ctx.strokeStyle = 'rgba(232,236,241,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(w - padX - vw - 7, midY - 9, vw + 10, 18);
    ctx.fillStyle = COL.vm;
    ctx.fillText(vLabel, w - padX, midY);
  }

  /** the voltage axis: every equilibrium potential and the resting potential, labelled without collisions */
  function drawGhk(r: NeuronRun): void {
    const p = prep(ghkCanvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const lo = -110;
    const hi = 80;
    const pad = 22;
    const x = (v: number) => pad + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (w - 2 * pad);
    const axisY = h / 2 + 4;
    ctx.strokeStyle = 'rgba(232,236,241,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, axisY);
    ctx.lineTo(w - pad, axisY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(154,164,178,0.9)';
    for (let v = -100; v <= 80; v += 20) {
      ctx.beginPath();
      ctx.moveTo(x(v), axisY - 3);
      ctx.lineTo(x(v), axisY + 3);
      ctx.stroke();
      const t = `${v}`;
      ctx.fillText(t, x(v) - ctx.measureText(t).width / 2, axisY + 15);
    }
    ctx.fillText('mV', w - pad - 12, axisY - 8);
    // markers, each with a fixed label row so neighbours near -70 never overlap:
    // top rows for Vm and the cations, bottom rows for chloride and the spiking model's rest
    const marks: Array<{ v: number; label: string; color: string; row: number; thick?: boolean; dash?: boolean }> = [
      { v: r.ghk, label: `Vm (GHK) ${r.ghk.toFixed(1)}`, color: COL.vm, row: 0, thick: true },
      { v: r.E.K, label: `E_K ${r.E.K.toFixed(1)}`, color: COL.K, row: 1 },
      { v: r.E.Na, label: `E_Na ${r.E.Na.toFixed(1)}`, color: COL.Na, row: 1 },
      { v: r.E.Cl, label: `E_Cl ${r.E.Cl.toFixed(1)}`, color: COL.Cl, row: 2 },
      { v: r.rest_mv, label: `spiking model at rest ${r.rest_mv.toFixed(1)}`, color: COL.rest, row: 3, dash: true },
    ];
    const rowY = [14, 30, h - 24, h - 8];
    for (const m of marks) {
      const mx = x(m.v);
      const ly = rowY[m.row]!;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.thick ? 2.5 : 1.5;
      ctx.setLineDash(m.dash ? [3, 3] : []);
      ctx.beginPath();
      // the leader runs from the label row to the axis and stops there
      ctx.moveTo(mx, m.row < 2 ? ly + 4 : ly - 12);
      ctx.lineTo(mx, axisY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(mx, axisY, m.thick ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      const tw = ctx.measureText(m.label).width;
      const lx = Math.max(2, Math.min(w - tw - 2, mx - tw / 2));
      ctx.fillText(m.label, lx, ly);
    }
  }

  function drawEquation(r: NeuronRun): void {
    const p = r.params;
    const rtf = thermalVoltage(p.temperature_c);
    const num = p.perm.K * p.ions.K_out + p.perm.Na * p.ions.Na_out + p.perm.Cl * p.ions.Cl_in;
    const den = p.perm.K * p.ions.K_in + p.perm.Na * p.ions.Na_in + p.perm.Cl * p.ions.Cl_out;
    const f = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
    $('ghk-eq').textContent = [
      'Vm = (RT/F) · ln( (P_K[K]o + P_Na[Na]o + P_Cl[Cl]i) / (P_K[K]i + P_Na[Na]i + P_Cl[Cl]o) )',
      `   = ${rtf.toFixed(2)} mV · ln( (${fmtPerm(p.perm.K)}·${p.ions.K_out} + ${fmtPerm(p.perm.Na)}·${p.ions.Na_out} + ${fmtPerm(p.perm.Cl)}·${p.ions.Cl_in}) / (${fmtPerm(p.perm.K)}·${p.ions.K_in} + ${fmtPerm(p.perm.Na)}·${p.ions.Na_in} + ${fmtPerm(p.perm.Cl)}·${p.ions.Cl_out}) )`,
      `   = ${rtf.toFixed(2)} mV · ln( ${f(num)} / ${f(den)} )  =  ${r.ghk.toFixed(1)} mV`,
    ].join('\n');
  }

  function drawIonTable(r: NeuronRun): void {
    const body = $<HTMLTableElement>('ion-table').tBodies[0]!;
    body.replaceChildren();
    const p = r.params;
    const rows: Array<[string, number, number, number, number, string]> = [
      ['K⁺', p.ions.K_in, p.ions.K_out, r.E.K, p.perm.K, COL.K],
      ['Na⁺', p.ions.Na_in, p.ions.Na_out, r.E.Na, p.perm.Na, COL.Na],
      ['Cl⁻', p.ions.Cl_in, p.ions.Cl_out, r.E.Cl, p.perm.Cl, COL.Cl],
    ];
    for (const [ion, inn, out, e, pp, col] of rows) {
      const tr = document.createElement('tr');
      const cells = [ion, `${inn} mM`, `${out} mM`, `${e.toFixed(1)} mV`, fmtPerm(pp)];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i === 0) td.style.color = col;
        tr.append(td);
      });
      body.append(tr);
    }
  }

  function drawTrace(r: NeuronRun): void {
    const p = prep(hhCanvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const lo = -110;
    const hi = 75;
    const padL = 36;
    const padR = 64;
    const y = (v: number) => 6 + ((hi - Math.max(lo, Math.min(hi, v))) / (hi - lo)) * (h - 22);
    const n = r.V.length;
    const x = (i: number) => padL + (i / (n - 1)) * (w - padL - padR);
    // the stimulus window
    let a = -1;
    let b = -1;
    for (let i = 0; i < n; i++) if (r.I[i]! !== 0) { if (a < 0) a = i; b = i; }
    if (a >= 0) {
      ctx.fillStyle = 'rgba(255,106,61,0.08)';
      ctx.fillRect(x(a), 0, x(b) - x(a), h - 16);
      ctx.fillStyle = 'rgba(255,106,61,0.9)';
      ctx.fillRect(x(a), h - 14, x(b) - x(a), 3);
      ctx.fillText(`${r.params.current_ua} µA/cm² step`, x(a), h - 2);
    }
    // grid and reference potentials
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = 'rgba(154,164,178,0.9)';
    for (const v of [-100, -50, 0, 50]) {
      ctx.beginPath();
      ctx.moveTo(padL, y(v));
      ctx.lineTo(w - padR, y(v));
      ctx.stroke();
      ctx.fillText(`${v}`, 4, y(v) + 4);
    }
    const refs: Array<[number, string, string]> = [[r.E.Na, 'E_Na', COL.Na], [r.E.K, 'E_K', COL.K], [r.ghk, 'Vm GHK', COL.vm]];
    let lastLabelY = -99;
    for (const [v, label, color] of refs.sort((p1, p2) => p2[0] - p1[0])) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y(v));
      ctx.lineTo(w - padR, y(v));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      const ly = Math.max(y(v) + 4, lastLabelY + 12);
      ctx.fillText(label, w - padR + 6, ly);
      lastLabelY = ly;
    }
    // the membrane potential
    ctx.strokeStyle = '#e8ecf1';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0) ctx.moveTo(x(i), y(r.V[i]!));
      else ctx.lineTo(x(i), y(r.V[i]!));
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(154,164,178,0.9)';
    ctx.fillText('mV', 4, 12);
    const total = (n - 1) * r.dt_ms;
    ctx.fillText(`${total.toFixed(0)} ms`, w - padR - 40, h - 2);
  }

  function drawGates(r: NeuronRun): void {
    const p = prep(gateCanvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const padL = 36;
    const padR = 64;
    const n = r.m.length;
    const x = (i: number) => padL + (i / (n - 1)) * (w - padL - padR);
    const y = (v: number) => 4 + (1 - v) * (h - 10);
    const series: Array<[Float32Array, string, string]> = [[r.m, COL.Na, 'm  Na⁺ opening'], [r.h, COL.K, 'h  Na⁺ inactivation'], [r.n, COL.Cl, 'n  K⁺ opening']];
    series.forEach(([arr, color, label], k) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) ctx.moveTo(x(i), y(arr[i]!));
        else ctx.lineTo(x(i), y(arr[i]!));
      }
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(label, w - padR + 6, 12 + k * 14);
    });
    ctx.fillStyle = 'rgba(154,164,178,0.9)';
    ctx.fillText('1', 22, 12);
    ctx.fillText('0', 22, h - 4);
  }

  function drawSummary(r: NeuronRun): void {
    const ul = $('hh-summary');
    ul.replaceChildren();
    const rows: Array<[string, string]> = [
      ['resting potential', `${r.rest_mv.toFixed(1)} mV in the spiking model · ${r.ghk.toFixed(1)} mV by the Goldman equation`],
      ['firing', r.spikes.length ? `${r.spikes.length} spikes at ${r.rate_hz.toFixed(0)} Hz during the current step` : 'none: the step never brings the membrane to threshold'],
    ];
    if (r.spikes.length) {
      rows.push(['first action potential', `peak ${r.peak_mv!.toFixed(1)} mV · full width at half maximum ${r.width_ms!.toFixed(2)} ms · threshold ${r.threshold_mv !== null ? `${r.threshold_mv.toFixed(1)} mV` : '—'}`]);
    }
    for (const [k, v] of rows) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = `${k}: `;
      li.append(b, document.createTextNode(v));
      ul.append(li);
    }
    const notes = $('hh-notes');
    notes.replaceChildren();
    notes.hidden = r.notes.length === 0;
    for (const n of r.notes) {
      const li = document.createElement('li');
      li.textContent = n;
      notes.append(li);
    }
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */

  for (const el of document.querySelectorAll<HTMLInputElement>('[data-neuron-control]')) {
    el.addEventListener('input', () => {
      readControl(el);
      schedule();
    });
  }
  condSel.addEventListener('change', () => {
    applyCondition(condSel.value);
    schedule();
  });
  drugSel.addEventListener('change', () => {
    drug = drugSel.value;
    schedule();
  });
  $('nc-reset').addEventListener('click', () => {
    condSel.value = 'resting';
    applyCondition('resting');
    drug = 'none';
    current = 15;
    pulse = 80;
    schedule();
  });
  window.addEventListener('resize', () => draw());
  applyCondition('resting');
  compute();

  return {
    getParams: params,
    setParams(p) {
      ions = { ...DEFAULT_IONS, ...(p.ions ?? {}) };
      perm = { ...DEFAULT_PERM, ...(p.perm ?? {}) };
      temperature = p.temperature_c ?? 37;
      drug = p.drug ?? 'none';
      current = p.current_ua ?? 15;
      pulse = p.pulse_ms ?? 80;
      condSel.value = 'custom';
      $('nc-condition-blurb').textContent = 'Loaded from a run.';
      schedule();
    },
    redraw() {
      requestAnimationFrame(() => draw());
    },
  };
}
