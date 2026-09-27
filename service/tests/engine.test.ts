/**
 * service/tests/engine.test.ts — the model behaves the way its presets claim.
 *
 * These are regime tests, not numerical fits: a preset that promises slow
 * waves must produce a slow synchronous rhythm on a low mean, the seizure
 * preset a high one, the awake preset neither. They pin the tuning so a
 * change to derive() that silently turns "awake" into "seizure" fails here
 * rather than on the page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGIONS, N, resolveRegion, connectome, simulateWholeBrain, summarizeWholeBrain,
  simulateMicrocircuit, summarizeMicrocircuit, presetById, PRESETS, applyTreatment, TREATMENTS,
  simulateNeuron, nernst, ghk, DEFAULT_IONS, DEFAULT_PERM, sweepBrain, sweepNeuron,
} from '../engine/index.ts';

test('atlas: 85 regions, mirrored, ids unique', () => {
  assert.equal(N, 85);
  assert.equal(new Set(REGIONS.map((r) => r.id)).size, 85);
  const left = REGIONS.filter((r) => r.hemi === 'L');
  for (const l of left) {
    const r = REGIONS.find((q) => q.hemi === 'R' && q.name === l.name);
    assert.ok(r, `no mirror for ${l.id}`);
    assert.equal(r.x, -l.x);
  }
});

test('atlas: region references resolve', () => {
  assert.deepEqual(resolveRegion('L_precentral').map((i) => REGIONS[i]!.id), ['L_precentral']);
  assert.equal(resolveRegion('hippocampus').length, 2);
  assert.equal(resolveRegion('left temporal').length, 9);
  assert.equal(resolveRegion('V1').length, 2);
  assert.equal(resolveRegion('cortex').length, 68);
  assert.equal(resolveRegion('nonsense-region').length, 0);
});

test('connectome: rows normalised, symmetric edge list, delays positive', () => {
  const c = connectome();
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = 0; j < N; j++) s += c.weights[i * N + j]!;
    assert.ok(Math.abs(s - 1) < 1e-9, `row ${i} sums to ${s}`);
  }
  assert.ok(c.edges.length > 200);
  assert.ok(c.delays[1]! > 0);
});

test('whole-brain: the awake preset is desynchronised alpha/beta', () => {
  const s = summarizeWholeBrain(simulateWholeBrain(presetById('awake')!.brain!));
  assert.ok(s.global.mean > 0.05 && s.global.mean < 0.35, `mean ${s.global.mean}`);
  assert.ok(s.global.synchrony < 0.3, `sync ${s.global.synchrony}`);
  assert.ok(s.global.peakHz >= 7 && s.global.peakHz <= 20, `peak ${s.global.peakHz}`);
});

test('whole-brain: seizure is hypersynchronous, large and high-mean', () => {
  const s = summarizeWholeBrain(simulateWholeBrain(presetById('seizure')!.brain!));
  assert.ok(s.global.synchrony > 0.6, `sync ${s.global.synchrony}`);
  assert.ok(s.global.amplitude > 0.15, `amp ${s.global.amplitude}`);
  assert.ok(s.global.mean > 0.2, `mean ${s.global.mean}`);
  assert.ok(s.notes.some((n) => n.includes('seizure')), s.notes.join(' | '));
});

test('whole-brain: deep sleep is slow, synchronous and low-mean', () => {
  const s = summarizeWholeBrain(simulateWholeBrain(presetById('deep-sleep')!.brain!));
  assert.ok(s.global.synchrony > 0.6, `sync ${s.global.synchrony}`);
  assert.ok(s.global.peakHz < 4, `peak ${s.global.peakHz}`);
  assert.ok(s.global.mean <= 0.2, `mean ${s.global.mean}`);
  assert.ok(s.notes.some((n) => n.includes('slow-wave')), s.notes.join(' | '));
});

test('whole-brain: REM is desynchronised and lower-voltage than wake, limbic-led, with striate under extrastriate', () => {
  const s = summarizeWholeBrain(simulateWholeBrain(presetById('rem')!.brain!));
  const awake = summarizeWholeBrain(simulateWholeBrain(presetById('awake')!.brain!));
  // wake-like activation: the mean sits in the awake band and nothing synchronises
  assert.ok(s.global.mean > 0.05 && s.global.mean < 0.35, `mean ${s.global.mean}`);
  assert.ok(s.global.synchrony < 0.3, `sync ${s.global.synchrony}`);
  // but lower-voltage than resting wake: REM has the smallest EEG of any stage
  assert.ok(s.global.amplitude < awake.global.amplitude, `amp ${s.global.amplitude} vs awake ${awake.global.amplitude}`);
  // the limbic signature: amygdala and hippocampal formation lead the ranking
  const top = [...s.regions].sort((a, b) => b.mean - a.mean).slice(0, 8).map((r) => r.id);
  const limbic = top.filter((id) => /amygdala|hippocampus|parahippocampal|entorhinal/.test(id)).length;
  assert.ok(limbic >= 3, `limbic regions in the top 8: ${limbic} (${top.join(', ')})`);
  // the dissociated visual pattern: extrastriate up, striate down (Braun 1998)
  const mean = (id: string) => s.regions.find((r) => r.id === id)!.mean;
  for (const h of ['L', 'R']) {
    assert.ok(mean(`${h}_pericalcarine`) < mean(`${h}_lateraloccipital`), `${h} striate ${mean(`${h}_pericalcarine`)} vs extrastriate ${mean(`${h}_lateraloccipital`)}`);
  }
  // dorsolateral prefrontal cortex is deactivated, not silenced
  for (const h of ['L', 'R']) {
    assert.ok(mean(`${h}_rostralmiddlefrontal`) < s.global.mean, `${h} DLPFC ${mean(`${h}_rostralmiddlefrontal`)} vs global ${s.global.mean}`);
    assert.ok(mean(`${h}_rostralmiddlefrontal`) > 0.01, `${h} DLPFC silenced at ${mean(`${h}_rostralmiddlefrontal`)}`);
  }
});

test('whole-brain: a lesion silences its regions and the run is reproducible', () => {
  const p = presetById('stroke')!.brain!;
  const a = simulateWholeBrain(p);
  const b = simulateWholeBrain(p);
  assert.deepEqual(Array.from(a.activity.slice(0, 200)), Array.from(b.activity.slice(0, 200)));
  const s = summarizeWholeBrain(a);
  const pre = s.regions.find((r) => r.id === 'L_precentral')!;
  const mirror = s.regions.find((r) => r.id === 'R_precentral')!;
  assert.equal(pre.mean, 0);
  assert.ok(mirror.mean > 0);
  // the two partly damaged regions are casualties, not the busiest regions in the run
  const awake = summarizeWholeBrain(simulateWholeBrain(presetById('awake')!.brain!));
  for (const id of ['L_insula', 'L_putamen']) {
    const hurt = s.regions.find((r) => r.id === id)!;
    const intact = awake.regions.find((r) => r.id === id)!;
    assert.ok(hurt.mean < intact.mean * 0.5, `${id} ${hurt.mean} vs intact ${intact.mean}`);
    assert.ok(hurt.mean > 0, `${id} is damaged, not destroyed`);
  }
  const busiest = [...s.regions].sort((x, y) => y.mean - x.mean)[0]!;
  assert.ok(!['L_insula', 'L_putamen'].includes(busiest.id), `busiest region is ${busiest.id}`);
});

test('whole-brain: partial lesions fall monotonically to silence', () => {
  // severity is the fraction of a region destroyed, so activity must fall as it
  // rises and reach exactly zero at 1 — never rise on the way there. The sweep
  // behind this pin, mean activity at severity 0, 0.25, 0.5, 0.75, 1 against the
  // awake preset: L_insula 0.109, 0.089, 0.033, 0.011, 0.000; R_thalamus 0.120,
  // 0.100, 0.053, 0.013, 0.000.
  const awake = presetById('awake')!.brain!;
  for (const region of ['L_insula', 'R_thalamus']) {
    const means = [0, 0.25, 0.5, 0.75, 1].map((severity) => {
      const run = simulateWholeBrain({ ...awake, lesions: severity > 0 ? [{ region, severity }] : [] });
      return summarizeWholeBrain(run).regions.find((r) => r.id === region)!.mean;
    });
    for (let k = 1; k < means.length; k++) {
      assert.ok(means[k]! < means[k - 1]!, `${region}: ${means.map((m) => m.toFixed(4)).join(' → ')}`);
    }
    assert.equal(means.at(-1), 0, `${region} at severity 1`);
    assert.ok(means[2]! < means[0]! * 0.6, `${region} at half severity: ${means[2]} of ${means[0]}`);
  }
});

test('inhibition sweep: a margin that holds, a cliff, then saturation with no rhythm', () => {
  // Investigation one, and the three things its prose claims in order: the
  // cortex is untouched until it is not, the change arrives inside one step,
  // and pushing further does NOT make a worse seizure. Sweeping inhibition
  // 0.7 → 1.2 in 11 steps at seed 1, synchrony: 0.661, 0.666, 0.931, 0.918,
  // 0.928, 0.025, 0.012, 0.021, 0.026, 0.022, 0.029 from 0.70 upward;
  // transition at 0.925 with sharpness 9.83; at 0.75 mean is 0.987 and the
  // oscillation amplitude 0.001.
  const sweep = sweepBrain({ base: presetById('awake')!.brain!, variable: 'inhibition', from: 0.7, to: 1.2, steps: 11, duration_ms: 1200, measure: 'synchrony', seed: 1 });
  const at = (v: number) => sweep.points.find((p) => Math.abs(p.value - v) < 1e-6)!;
  const trace = () => sweep.points.map((p) => `${p.value.toFixed(2)}:${p.synchrony.toFixed(2)}`).join(' ');

  // the margin: five per cent of the brake gone and nothing has happened
  assert.ok(at(1.0).synchrony < 0.1 && at(0.95).synchrony < 0.1, `no margin left: ${trace()}`);
  // the cliff: the very next step is a seizure
  assert.ok(at(0.9).synchrony > 0.8, `no transition: ${trace()}`);
  assert.ok((sweep.transition?.sharpness ?? 1) > 5, `sharpness ${(sweep.transition?.sharpness ?? 1).toFixed(2)} reads as a ramp`);
  assert.equal(sweep.monotone, false);

  // the surprise: below 0.80 the seizure stops being a rhythm at all
  assert.ok(at(0.75).mean > 0.95, `mean at 0.75: ${at(0.75).mean.toFixed(3)}`);
  assert.ok(at(0.75).amplitude < 0.05, `amplitude at 0.75: ${at(0.75).amplitude.toFixed(3)}`);
  assert.ok(at(0.75).synchrony < at(0.8).synchrony, `synchrony does not fall back: ${trace()}`);
});

test('potassium sweep: firing rises, then stops dead in depolarisation block', () => {
  // Investigation two. Sweeping K_out 2 → 30 mM in 15 steps: rate 75, 75, 75,
  // 75, 87.5, 87.5, 100 and then 0 at every remaining point; resting voltage
  // -78.2 → -33.2 mV; GHK -76.3 → -42.4 mV; spike peaks 63.0 … 56.5 at 10 mM
  // and 14.8 at 16 mM, the last concentration that spikes at all.
  const sweep = sweepNeuron({ field: 'K_out', from: 2, to: 30, steps: 15, measure: 'rate_hz' });
  const at = (v: number) => sweep.points.find((p) => Math.abs(p.value - v) < 1e-6)!;
  const rates = () => sweep.points.map((p) => `${p.value}:${p.rate_hz}`).join(' ');

  // it gets FASTER first: the naive prediction is right for seven points
  assert.ok(at(14).rate_hz > at(2).rate_hz, `no rise: ${rates()}`);
  assert.equal(sweep.points.reduce((a, b) => (b.rate_hz > a.rate_hz ? b : a)).value, 14, rates());
  // and then it does not decline, it stops — and stays stopped
  assert.ok(sweep.points.filter((p) => p.value >= 16).every((p) => p.rate_hz === 0), `not silent above 16 mM: ${rates()}`);
  assert.equal(sweep.monotone, false);

  // silent because it is too DEPOLARISED, which is the whole point
  assert.ok(at(30).rest_mv > at(2).rest_mv + 30, `resting voltage ${at(2).rest_mv.toFixed(1)} → ${at(30).rest_mv.toFixed(1)} mV`);
  assert.ok(at(30).ghk > at(2).ghk, 'the potassium equilibrium potential must rise across the sweep');

  // the fingerprint: spikes shrink before they stop
  const spiking = sweep.points.filter((p) => p.peak_mv !== null);
  assert.ok(at(2).peak_mv! > at(10).peak_mv!, `spikes do not shrink: ${spiking.map((p) => `${p.value}:${p.peak_mv!.toFixed(1)}`).join(' ')}`);
  assert.ok(spiking.at(-1)!.peak_mv! < at(10).peak_mv! * 0.6, `the last spike is not stunted: ${spiking.at(-1)!.peak_mv!.toFixed(1)} mV`);
});

test('dose-response: the benzodiazepine is gradual where caffeine is a threshold', () => {
  // Investigation three on the page is this comparison, and its prose names
  // both shapes. The finding is the DIFFERENCE between them, so both halves
  // are pinned: a benzodiazepine walked up against a generalised seizure must
  // come down in followable steps, and caffeine walked up against deep sleep
  // must hold and then fall off a cliff. Sweeping dose 0 → 1.5 in 9 steps at
  // seed 1, synchrony: benzodiazepine 0.96, 0.88, 0.76, 0.54, 0.40, 0.16,
  // 0.18, 0.06, 0.01 (sharpness 2.05); caffeine 0.78, 0.93, 0.89, 0.92, 0.12,
  // 0.03, 0.01, 0.01, 0.01 (sharpness 6.93, turning at 0.66).
  const shape = (treatment: string, preset: string) =>
    sweepBrain({ base: presetById(preset)!.brain!, variable: 'dose', treatment, from: 0, to: 1.5, steps: 9, duration_ms: 1200, measure: 'synchrony', seed: 1 });

  const benzo = shape('benzodiazepine', 'seizure');
  const caffeine = shape('caffeine', 'deep-sleep');
  const sharp = (x: typeof benzo) => x.transition?.sharpness ?? 1;
  assert.ok(sharp(benzo) < 3, `benzodiazepine sharpness ${sharp(benzo).toFixed(2)} is not a gradual shape`);
  assert.ok(sharp(caffeine) > 4, `caffeine sharpness ${sharp(caffeine).toFixed(2)} is not a threshold`);
  assert.ok(sharp(caffeine) > sharp(benzo) * 2, `${sharp(caffeine).toFixed(2)} vs ${sharp(benzo).toFixed(2)}: the two shapes are no longer distinguishable`);

  // both must actually WORK, or "gradual" would only mean "did nothing"
  assert.ok(benzo.points[0]!.synchrony > 0.8 && benzo.points.at(-1)!.synchrony < 0.1, benzo.points.map((p) => p.synchrony.toFixed(2)).join(' '));
  assert.ok(caffeine.points[0]!.synchrony > 0.6 && caffeine.points.at(-1)!.synchrony < 0.1, caffeine.points.map((p) => p.synchrony.toFixed(2)).join(' '));

  // the page tells the reader deep sleep is untouched across the left half and
  // gone by 0.75: that sentence is a claim about these points
  const at = (x: typeof benzo, dose: number) => x.points.reduce((a, b) => (Math.abs(b.value - dose) < Math.abs(a.value - dose) ? b : a));
  assert.ok(at(caffeine, 0.5).synchrony > 0.8, `caffeine at half a dose: ${at(caffeine, 0.5).synchrony.toFixed(2)}`);
  assert.ok(at(caffeine, 0.75).synchrony < 0.3, `caffeine at 0.75: ${at(caffeine, 0.75).synchrony.toFixed(2)}`);
});

test('whole-brain: a 20 Hz drive entrains regions beyond its target', () => {
  const s = summarizeWholeBrain(simulateWholeBrain(presetById('tms-motor')!.brain!));
  assert.ok(s.entrainment.length >= 3, `entrained ${s.entrainment.length}`);
  assert.ok(s.entrainment.every((e) => e.id !== 'L_precentral'));
  assert.ok(s.entrainment[0]!.gain >= 8);
  assert.ok(s.notes.some((n) => n.includes('entrained')), s.notes.join(' | '));
});

test('whole-brain: unresolved regions are reported, not guessed', () => {
  const run = simulateWholeBrain({ duration_ms: 600, stimulation: [{ region: 'the moon' }] });
  assert.deepEqual(run.params.unresolved, ['the moon']);
});

test('microcircuit: awake is asynchronous, seizure bursts', () => {
  const awake = summarizeMicrocircuit(simulateMicrocircuit(presetById('awake')!.micro!));
  const seiz = summarizeMicrocircuit(simulateMicrocircuit(presetById('seizure')!.micro!));
  assert.ok(awake.rateE > 1 && awake.rateE < 30, `awake E ${awake.rateE}`);
  assert.ok(awake.synchrony < 3, `awake sync ${awake.synchrony}`);
  assert.ok(seiz.synchrony > awake.synchrony * 3, `seizure sync ${seiz.synchrony} vs ${awake.synchrony}`);
});

test('every preset runs', () => {
  for (const p of PRESETS) {
    if (p.brain) assert.ok(simulateWholeBrain({ ...p.brain, duration_ms: 800 }).frames > 0, p.id);
    if (p.micro) assert.ok(simulateMicrocircuit({ ...p.micro, duration_ms: 300 }).rate.length > 0, p.id);
  }
});

test('treatments: a benzodiazepine ends a seizure; propofol collapses a waking brain; bicuculline makes one discharge', () => {
  const seizure = summarizeWholeBrain(simulateWholeBrain(presetById('seizure')!.brain!)).global;
  const benzo = summarizeWholeBrain(simulateWholeBrain(applyTreatment(presetById('seizure')!.brain!, 'benzodiazepine', 1))).global;
  assert.ok(benzo.synchrony < seizure.synchrony / 2, `benzo sync ${benzo.synchrony} vs ${seizure.synchrony}`);
  const awake = summarizeWholeBrain(simulateWholeBrain(presetById('awake')!.brain!)).global;
  const prop = summarizeWholeBrain(simulateWholeBrain(applyTreatment(presetById('awake')!.brain!, 'propofol', 1))).global;
  assert.ok(prop.mean < awake.mean / 2, `propofol mean ${prop.mean}`);
  const bic = summarizeWholeBrain(simulateWholeBrain(applyTreatment(presetById('awake')!.brain!, 'bicuculline', 1))).global;
  assert.ok(bic.synchrony > 0.5 && bic.mean < 0.9, `bicuculline sync ${bic.synchrony} mean ${bic.mean}`);
  for (const t of TREATMENTS) assert.ok(simulateWholeBrain({ ...applyTreatment(presetById('awake')!.brain!, t.id, 0.5), duration_ms: 600 }).frames > 0, t.id);
});

test('neuron: Nernst and GHK match the textbook; TTX abolishes spikes; extreme K+ blocks them', () => {
  assert.ok(Math.abs(nernst(1, 5, 140) + 89.1) < 0.5);
  assert.ok(Math.abs(nernst(1, 145, 12) - 66.6) < 0.5);
  assert.ok(Math.abs(ghk(DEFAULT_PERM, DEFAULT_IONS) + 69.8) < 0.5);
  assert.ok(simulateNeuron({}).spikes.length >= 3, 'default fires repetitively');
  assert.equal(simulateNeuron({ drug: 'ttx' }).spikes.length, 0);
  assert.equal(simulateNeuron({ ions: { K_out: 25 } }).spikes.length, 0);
  assert.ok(simulateNeuron({ ions: { K_out: 12 } }).notes.some((n) => n.includes('spontaneous')));
});

