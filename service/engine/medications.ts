/**
 * engine/medications.ts — drugs and lab compounds as changes to the model.
 *
 * Each entry says what the compound does at the receptor or channel in one
 * sentence, then how that is expressed in this model: multipliers on the
 * derived Wilson–Cowan parameters (applied after the state's own knobs and
 * overrides, so a drug acts ON a state), optional neuromodulator changes, and
 * optionally a regional emphasis. `dose` runs 0–1, where 1 is a typical
 * clinical (or, for lab compounds, experimental) effect size.
 *
 * These are qualitative mappings, not pharmacokinetic models: they show the
 * direction a compound pushes a network and roughly how far, which is what the
 * studio is for. Every entry's `model` line says exactly what it changes.
 */

import type { WholeBrainParams, DerivedParams } from './wholeBrain.ts';

type Scale = Partial<Record<keyof DerivedParams, number>>;

export interface Treatment {
  id: string;
  name: string;
  group: 'clinical' | 'lab';
  class: string;
  /** what it does biologically, one sentence */
  mechanism: string;
  /** what it does in this model, one sentence */
  model: string;
  /** what to expect, one sentence */
  expect: string;
  /** multipliers at full dose (1 = no change) */
  scale: Scale;
  modulators?: Partial<Record<'dopamine' | 'acetylcholine' | 'noradrenaline' | 'serotonin' | 'adenosine', number>>;
  regional?: Array<{ region: string; factor: number }>;
}

export const TREATMENTS: readonly Treatment[] = [
  {
    id: 'benzodiazepine', name: 'Benzodiazepine (lorazepam, diazepam)', group: 'clinical', class: 'GABA-A positive modulator',
    mechanism: 'Makes GABA-A receptors open more readily, strengthening fast inhibition everywhere.',
    model: 'inhibition onto excitatory cells ×1.8, drive ×0.9.',
    expect: 'Terminates a seizure; in a waking brain, lowers activity (real EEG also shows a beta increase, which this model does not reproduce).',
    scale: { c2: 1.8, P: 0.9 },
  },
  {
    id: 'propofol', name: 'Propofol', group: 'clinical', class: 'GABA-A agonist, general anaesthetic',
    mechanism: 'Strongly potentiates GABA-A inhibition and suppresses arousal systems; used to induce general anaesthesia.',
    model: 'inhibition ×1.9, drive ×0.6, adaptation ×2.2, thalamus and brainstem drive ×0.5.',
    expect: 'Pushes a waking brain towards anaesthesia: activity collapses, what remains is slow and synchronous.',
    scale: { c2: 1.9, P: 0.6, k_adapt: 2.2 },
    regional: [{ region: 'thalamus', factor: 0.5 }, { region: 'brainstem', factor: 0.5 }],
  },
  {
    id: 'ketamine', name: 'Ketamine', group: 'clinical', class: 'NMDA receptor antagonist',
    mechanism: 'Blocks NMDA receptors, preferentially on inhibitory interneurons, which releases excitatory cells from their brake.',
    model: 'excitation onto inhibitory cells ×0.92, inhibitory time constant ×0.7, noise ×1.6, coupling between regions ×0.65.',
    expect: 'Desynchronises the cortex and raises fast (gamma-range) activity: the dissociative state.',
    scale: { c3: 0.92, ti: 0.7, sigma: 1.6, G: 0.65 },
  },
  {
    id: 'levetiracetam', name: 'Levetiracetam', group: 'clinical', class: 'anti-seizure (SV2A)',
    mechanism: 'Binds the synaptic vesicle protein SV2A and reduces excitatory transmitter release during bursts.',
    model: 'recurrent excitation ×0.9, coupling between regions ×0.7.',
    expect: 'Weakens seizure spread between regions: discharges shrink and fall out of lockstep; little change to a healthy waking brain.',
    scale: { c1: 0.9, G: 0.7 },
  },
  {
    id: 'sodium-blocker', name: 'Carbamazepine / phenytoin', group: 'clinical', class: 'sodium-channel blocker, anti-seizure',
    mechanism: 'Stabilises the inactivated state of voltage-gated sodium channels, so neurons cannot fire rapidly.',
    model: 'gain of excitatory cells ×0.75, recurrent excitation ×0.9.',
    expect: 'Raises the threshold for runaway firing; slows and dampens a seizure.',
    scale: { ae: 0.75, c1: 0.9 },
  },
  {
    id: 'caffeine', name: 'Caffeine', group: 'clinical', class: 'adenosine receptor antagonist',
    mechanism: 'Blocks adenosine receptors, removing the sleep-pressure signal that builds up while awake.',
    model: 'adaptation ×0.3, recurrent excitation ×0.78 (the cholinergic desynchronisation that arousal brings, as the model’s acetylcholine knob does), drive ×1.2.',
    expect: 'Breaks up slow-wave sleep into a waking rhythm; a waking brain changes little.',
    scale: { k_adapt: 0.3, c1: 0.78, P: 1.2 },
    modulators: { adenosine: 0.5 },
  },
  {
    id: 'methylphenidate', name: 'Methylphenidate / amphetamine', group: 'clinical', class: 'dopamine and noradrenaline reuptake inhibitor',
    mechanism: 'Raises dopamine and noradrenaline at synapses, sharpening signal over noise in prefrontal and striatal circuits.',
    model: 'gain ×1.15, noise ×0.8, drive ×1.1; prefrontal and striatal drive ×1.2.',
    expect: 'A more focused pattern: frontal and striatal regions up, faster and less noisy activity.',
    scale: { ae: 1.15, sigma: 0.8, P: 1.1 },
    modulators: { dopamine: 1.6, noradrenaline: 1.5 },
    regional: [{ region: 'rostralmiddlefrontal', factor: 1.2 }, { region: 'caudate', factor: 1.2 }, { region: 'putamen', factor: 1.15 }],
  },
  {
    id: 'donepezil', name: 'Donepezil', group: 'clinical', class: 'acetylcholinesterase inhibitor',
    mechanism: 'Slows the breakdown of acetylcholine, raising cholinergic tone; used in Alzheimer’s disease.',
    model: 'adaptation ×0.7, recurrent excitation ×0.95.',
    expect: 'Less slow activity and a more desynchronised, attentive pattern.',
    scale: { k_adapt: 0.7, c1: 0.95 },
    modulators: { acetylcholine: 1.6 },
  },
  {
    id: 'haloperidol', name: 'Haloperidol', group: 'clinical', class: 'dopamine D2 antagonist (antipsychotic)',
    mechanism: 'Blocks D2 dopamine receptors, most strongly in the striatum.',
    model: 'gain ×0.85; striatal drive ×0.7.',
    expect: 'Damps a dopamine surge and quietens the striatum.',
    scale: { ae: 0.85 },
    modulators: { dopamine: 0.5 },
    regional: [{ region: 'accumbens', factor: 0.7 }, { region: 'caudate', factor: 0.75 }, { region: 'putamen', factor: 0.75 }],
  },
  {
    id: 'ssri', name: 'SSRI (sertraline, fluoxetine)', group: 'clinical', class: 'serotonin reuptake inhibitor',
    mechanism: 'Raises synaptic serotonin; its clinical effect builds over weeks through receptor adaptation.',
    model: 'noise ×0.9, coupling ×0.95 (a small acute effect).',
    expect: 'Little acute change: the model shows a slight steadying, not the weeks-long clinical effect.',
    scale: { sigma: 0.9, G: 0.95 },
    modulators: { serotonin: 1.3 },
  },
  {
    id: 'alcohol', name: 'Alcohol (ethanol)', group: 'clinical', class: 'GABA-A potentiator, NMDA inhibitor',
    mechanism: 'Enhances GABA-A inhibition and blocks NMDA excitation.',
    model: 'inhibition ×1.35, recurrent excitation ×0.85, drive ×0.9.',
    expect: 'Lower activity and more slow power: sedation.',
    scale: { c2: 1.35, c1: 0.85, P: 0.9 },
  },
  {
    id: 'psilocybin', name: 'Psilocybin', group: 'clinical', class: 'serotonin 5-HT2A agonist',
    mechanism: 'Activates 5-HT2A receptors, densest in visual and association cortex.',
    model: 'coupling ×0.7, noise ×1.5; visual cortex drive ×1.3.',
    expect: 'The hierarchy flattens: regions decouple, visual cortex is flooded, activity becomes more varied.',
    scale: { G: 0.7, sigma: 1.5 },
    modulators: { serotonin: 2 },
    regional: [{ region: 'occipital', factor: 1.3 }],
  },
  {
    id: 'bicuculline', name: 'Bicuculline / picrotoxin', group: 'lab', class: 'GABA-A antagonist (convulsant)',
    mechanism: 'Blocks GABA-A receptors; used in the lab to induce seizures.',
    model: 'inhibition onto excitatory cells ×0.5; the model’s slow adaptation ×3 and faster, which it needs to turn runaway firing into repeated discharges rather than a saturated plateau.',
    expect: 'Removes the brake: a waking brain tips into hypersynchronous discharges.',
    scale: { c2: 0.5, k_adapt: 3, tau_adapt: 0.15 },
  },
  {
    id: 'muscimol', name: 'Muscimol', group: 'lab', class: 'GABA-A agonist',
    mechanism: 'Activates GABA-A receptors directly; used in the lab to silence tissue reversibly.',
    model: 'inhibition ×2.4, drive ×0.7.',
    expect: 'Strong suppression: activity collapses toward silence.',
    scale: { c2: 2.4, P: 0.7 },
  },
  {
    id: '4-ap', name: '4-aminopyridine', group: 'lab', class: 'potassium-channel blocker (convulsant)',
    mechanism: 'Blocks voltage-gated potassium channels, prolonging action potentials and boosting transmitter release.',
    model: 'gain of excitatory cells ×1.2, recurrent excitation ×1.1.',
    expect: 'Hyperexcitability: from a waking state, the network tips into slow hypersynchronous discharges.',
    scale: { ae: 1.2, c1: 1.1 },
  },
];

export function treatmentById(id: string): Treatment | undefined {
  return TREATMENTS.find((t) => t.id === id);
}

/** interpolate a multiplier from 1 (dose 0) to its full value (dose 1) geometrically */
const at = (full: number, dose: number) => Math.pow(full, dose);

/** apply a treatment to a state's parameters; returns new params, the original untouched */
export function applyTreatment(params: WholeBrainParams, id: string, dose = 1): WholeBrainParams {
  const t = treatmentById(id);
  if (!t) return params;
  const d = Math.max(0, Math.min(1.5, dose));
  const scale: Partial<DerivedParams> = { ...(params.scale ?? {}) };
  for (const [k, f] of Object.entries(t.scale) as Array<[keyof DerivedParams, number]>) {
    scale[k] = (scale[k] ?? 1) * at(f, d);
  }
  const modulators = { ...(params.modulators ?? {}) } as Record<string, number>;
  for (const [k, v] of Object.entries(t.modulators ?? {})) {
    const base = modulators[k] ?? 1;
    modulators[k] = base * at(v / 1, d);
  }
  const regional_drive = [...(params.regional_drive ?? []), ...(t.regional ?? []).map((r) => ({ region: r.region, factor: at(r.factor, d) }))];
  return { ...params, scale, modulators, regional_drive };
}

export function describeTreatments(): string {
  return TREATMENTS.map((t) => `- ${t.id} (${t.group}): ${t.name}, ${t.class}. ${t.mechanism} In the model: ${t.model} Expect: ${t.expect}`).join('\n');
}
