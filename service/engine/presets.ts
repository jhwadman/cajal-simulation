/**
 * engine/presets.ts — named brain states as knob settings.
 *
 * These are the page's one-click scenarios and the agent's starting points.
 * Each is a claim about which direction the knobs move for that state, in the
 * language of the model — not a clinical definition. The agent is free to
 * start from one and turn knobs from there.
 */

import type { WholeBrainParams } from './wholeBrain.ts';
import type { MicrocircuitParams } from './microcircuit.ts';

/** the bench's menu groups: a flat list of twelve is a list to read, four
 *  groups of two to four are a list to scan */
export type PresetGroup = 'wake' | 'sleep' | 'pathology' | 'stimulation' | 'pharmacology';
export const PRESET_GROUPS: ReadonlyArray<[PresetGroup, string]> = [
  ['wake', 'wake'],
  ['sleep', 'sleep'],
  ['pathology', 'pathology'],
  ['stimulation', 'stimulation'],
  ['pharmacology', 'pharmacology'],
];

export interface Preset {
  id: string;
  title: string;
  /** which menu group the bench lists it under */
  group: PresetGroup;
  blurb: string;
  brain?: WholeBrainParams;
  micro?: MicrocircuitParams;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'awake',
    title: 'Awake, resting',
    group: 'wake',
    blurb: 'Eyes closed, mind wandering: posterior alpha and the default-mode network (precuneus, posterior and medial prefrontal cortex) carrying the most activity.',
    brain: {
      duration_ms: 3000,
      // arousal a touch under baseline keeps the scalp EEG alpha-dominant rather than on the alpha/beta line
      arousal: 0.85,
      regional_drive: [
        { region: 'precuneus', factor: 1.25 }, { region: 'posteriorcingulate', factor: 1.25 }, { region: 'isthmuscingulate', factor: 1.15 },
        { region: 'medialorbitofrontal', factor: 1.2 }, { region: 'rostralanteriorcingulate', factor: 1.15 }, { region: 'inferiorparietal', factor: 1.15 },
        { region: 'occipital', factor: 1.15 }, { region: 'precentral', factor: 0.85 }, { region: 'postcentral', factor: 0.85 },
      ],
    },
    micro: { duration_ms: 1000 },
  },
  {
    id: 'focus',
    title: 'Focused attention',
    group: 'wake',
    blurb: 'Acetylcholine and noradrenaline up: the frontoparietal control network (dorsolateral prefrontal, superior parietal, anterior cingulate, insula) engaged and the default-mode network quietened.',
    brain: {
      duration_ms: 3000, modulators: { acetylcholine: 1.8, noradrenaline: 1.5 }, arousal: 1.3, adaptation: 0.5, coupling: 0.8,
      regional_drive: [
        { region: 'rostralmiddlefrontal', factor: 1.4 }, { region: 'caudalmiddlefrontal', factor: 1.35 }, { region: 'superiorparietal', factor: 1.35 },
        { region: 'supramarginal', factor: 1.2 }, { region: 'caudalanteriorcingulate', factor: 1.3 }, { region: 'insula', factor: 1.2 }, { region: 'thalamus', factor: 1.15 },
        { region: 'precuneus', factor: 0.7 }, { region: 'posteriorcingulate', factor: 0.7 }, { region: 'medialorbitofrontal', factor: 0.75 }, { region: 'isthmuscingulate', factor: 0.75 },
      ],
    },
    micro: { duration_ms: 1000, noise: 1.2 },
  },
  {
    id: 'deep-sleep',
    title: 'Deep sleep (N3)',
    group: 'sleep',
    blurb: 'Adenosine and adaptation up, arousal down: slow waves that begin frontally and travel back, with the thalamus and brainstem quiet.',
    brain: {
      duration_ms: 4000, adaptation: 3.4, arousal: 0.5, excitability: 1.25, modulators: { adenosine: 1.8, acetylcholine: 0.3 }, noise: 0.7,
      regional_drive: [
        { region: 'superiorfrontal', factor: 1.2 }, { region: 'rostralmiddlefrontal', factor: 1.15 }, { region: 'medialorbitofrontal', factor: 1.15 }, { region: 'caudalanteriorcingulate', factor: 1.1 },
        { region: 'thalamus', factor: 0.6 }, { region: 'brainstem', factor: 0.6 }, { region: 'occipital', factor: 0.9 },
      ],
      // the up/down-state alternation needs strong recurrent excitation held down by adaptation
      overrides: { c1: 20, k_adapt: 9, P: 1.0, tau_adapt: 400 },
    },
    micro: { duration_ms: 1000, drive: -1.5, noise: 0.8 },
  },
  {
    id: 'rem',
    title: 'REM sleep',
    group: 'sleep',
    blurb: 'Acetylcholine high while noradrenaline and serotonin fall away: a desynchronised, low-voltage cortex with the limbic system (amygdala, hippocampus, parahippocampal cortex), the visual association areas and the pontine brainstem engaged, while dorsolateral prefrontal cortex, precuneus and primary visual cortex fall below the rest.',
    brain: {
      // the reciprocal-interaction picture of REM: REM-on cholinergic pontine neurons fire at
      // waking rates while the REM-off aminergic nuclei (locus coeruleus, dorsal raphe) go quiet,
      // so the cortex is activated but without the adaptation that makes N3's slow waves
      duration_ms: 3000, arousal: 0.95, adaptation: 0.4, coupling: 0.9,
      modulators: { acetylcholine: 1.9, noradrenaline: 0.2, serotonin: 0.2 },
      // the PET/fMRI signature of REM (Maquet 1996, Braun 1997/1998, Nofzinger 1997): limbic and
      // paralimbic activation, extrastriate visual cortex up with STRIATE cortex down, pontine
      // tegmentum and thalamus up, dorsolateral prefrontal and posterior midline cortex down
      regional_drive: [
        { region: 'amygdala', factor: 1.4 }, { region: 'hippocampus', factor: 1.35 },
        { region: 'parahippocampal', factor: 1.3 }, { region: 'entorhinal', factor: 1.25 },
        { region: 'lateraloccipital', factor: 1.3 }, { region: 'fusiform', factor: 1.3 }, { region: 'inferiortemporal', factor: 1.25 },
        { region: 'pericalcarine', factor: 0.85 },
        { region: 'rostralanteriorcingulate', factor: 1.25 }, { region: 'medialorbitofrontal', factor: 1.2 },
        { region: 'brainstem', factor: 1.3 }, { region: 'thalamus', factor: 1.25 },
        { region: 'rostralmiddlefrontal', factor: 0.8 }, { region: 'caudalmiddlefrontal', factor: 0.85 }, { region: 'superiorfrontal', factor: 0.9 },
        { region: 'precuneus', factor: 0.85 }, { region: 'posteriorcingulate', factor: 0.85 }, { region: 'inferiorparietal', factor: 0.85 },
      ],
    },
    micro: { duration_ms: 1000, noise: 1.1 },
  },
  {
    id: 'anaesthesia',
    title: 'General anaesthesia',
    group: 'pharmacology',
    blurb: 'Inhibition up, arousal near zero: the thalamus and brainstem switched off, activity collapsing with what remains frontal, slow and synchronous.',
    brain: {
      duration_ms: 4000, inhibition: 1.3, arousal: 0.3, adaptation: 3.5, coupling: 1.1, noise: 0.5,
      regional_drive: [
        { region: 'thalamus', factor: 0.4 }, { region: 'brainstem', factor: 0.4 }, { region: 'superiorfrontal', factor: 1.15 }, { region: 'occipital', factor: 0.8 }, { region: 'parietal', factor: 0.85 },
      ],
      // burst-suppression territory: bistable cortex, little drive, long adaptation
      overrides: { c1: 19, k_adapt: 9, P: 0.95, tau_adapt: 500 },
    },
    micro: { duration_ms: 1000, inhibition: 2, drive: -2.5 },
  },
  {
    id: 'seizure',
    title: 'Generalised seizure',
    group: 'pathology',
    blurb: 'Inhibition fails, excitability climbs: hypersynchronous large-amplitude slow discharges everywhere.',
    brain: {
      duration_ms: 3000, excitability: 1.05, inhibition: 0.55, coupling: 1.15, adaptation: 3, noise: 0.5,
      // a fast adaptation is what turns the runaway up-state into repeated discharges;
      // 45 ms gives ~3 Hz, the classic spike-and-wave rate
      overrides: { tau_adapt: 45 },
    },
    micro: { duration_ms: 1000, excitability: 1.6, inhibition: 0.2 },
  },
  {
    id: 'focal-seizure',
    title: 'Focal seizure, left temporal',
    group: 'pathology',
    blurb: 'A driven left hippocampus and temporal lobe recruit their neighbours; watch whether it generalises.',
    brain: {
      duration_ms: 4000,
      inhibition: 0.85,
      coupling: 1.2,
      adaptation: 1.5,
      stimulation: [
        { region: 'L_hippocampus', amplitude: 3, frequency_hz: 4, onset_ms: 600, duration_ms: 3000 },
        { region: 'L_temporal', amplitude: 1.2, frequency_hz: 4, onset_ms: 900, duration_ms: 2700 },
      ],
    },
  },
  {
    id: 'stroke',
    title: 'Left MCA stroke',
    group: 'pathology',
    blurb: 'Silence the left middle-cerebral-artery territory and see the diaschisis in what stays connected.',
    brain: {
      duration_ms: 3000,
      lesions: [
        { region: 'L_precentral', severity: 1 },
        { region: 'L_postcentral', severity: 1 },
        { region: 'L_supramarginal', severity: 1 },
        { region: 'L_parsopercularis', severity: 1 },
        { region: 'L_superiortemporal', severity: 1 },
        { region: 'L_insula', severity: 0.8 },
        { region: 'L_putamen', severity: 0.7 },
      ],
    },
  },
  {
    id: 'tms-motor',
    title: 'TMS over left motor cortex',
    group: 'stimulation',
    blurb: 'A 20 Hz train over M1: the response travels to S1, the contralateral M1 and down to the thalamus.',
    brain: {
      duration_ms: 2500,
      stimulation: [{ region: 'L_precentral', amplitude: 4, frequency_hz: 20, onset_ms: 800, duration_ms: 1000 }],
      coupling: 1.3,
    },
  },
  {
    id: 'visual',
    title: 'Flickering visual input',
    group: 'stimulation',
    blurb: 'A 10 Hz flicker into V1 drives the occipital lobe and entrains its neighbours.',
    brain: {
      duration_ms: 3000,
      stimulation: [{ region: 'pericalcarine', amplitude: 2.5, frequency_hz: 10, onset_ms: 500, duration_ms: 2000 }],
    },
  },
  {
    id: 'psychedelic',
    title: 'Psychedelic state',
    group: 'pharmacology',
    blurb: 'Serotonin 2A drive up: visual cortex and the thalamus flooded, the default-mode network dissolved, entropy up and regions wandering.',
    brain: {
      duration_ms: 3000, modulators: { serotonin: 2.2 }, noise: 1.6, coupling: 0.7, excitability: 1.05, adaptation: 0.8,
      regional_drive: [
        { region: 'occipital', factor: 1.4 }, { region: 'fusiform', factor: 1.3 }, { region: 'thalamus', factor: 1.3 }, { region: 'insula', factor: 1.15 },
        { region: 'precuneus', factor: 0.7 }, { region: 'posteriorcingulate', factor: 0.7 }, { region: 'medialorbitofrontal', factor: 0.75 },
      ],
    },
    micro: { duration_ms: 1000, noise: 1.8 },
  },
  {
    id: 'dopamine',
    title: 'Dopamine surge',
    group: 'pharmacology',
    blurb: 'Reward: the striatum (accumbens, caudate, putamen), medial prefrontal and anterior cingulate cortex lit, with sharper and less noisy signalling.',
    brain: {
      duration_ms: 3000,
      modulators: { dopamine: 2 },
      regional_drive: [
        { region: 'accumbens', factor: 1.5 }, { region: 'caudate', factor: 1.35 }, { region: 'putamen', factor: 1.3 },
        { region: 'medialorbitofrontal', factor: 1.35 }, { region: 'rostralanteriorcingulate', factor: 1.3 }, { region: 'lateralorbitofrontal', factor: 1.2 }, { region: 'insula', factor: 1.1 },
      ],
      stimulation: [
        { region: 'accumbens', amplitude: 2, onset_ms: 800, duration_ms: 1500 },
        { region: 'medialorbitofrontal', amplitude: 1, onset_ms: 900, duration_ms: 1400 },
      ],
    },
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function describePresets(): string {
  return PRESETS.map((p) => `- ${p.id}: ${p.title}. ${p.blurb}`).join('\n');
}
