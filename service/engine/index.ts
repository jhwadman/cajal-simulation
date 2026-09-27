/**
 * engine/index.ts — the whole model behind one import.
 *
 * Pure TypeScript, no dependencies: the service imports it for the agent's
 * tools and the site bundles it for the browser bench, so a run is the same
 * numbers wherever it is made.
 */

export { REGIONS, N, LOBES, REGION_INDEX, resolveRegion, describeAtlas } from './atlas.ts';
export type { Region, Lobe, Hemisphere } from './atlas.ts';
export { connectome } from './connectome.ts';
export type { Connectome } from './connectome.ts';
export { simulateWholeBrain, resolveParams, derive, SAMPLE_MS } from './wholeBrain.ts';
export type { WholeBrainParams, WholeBrainRun, ResolvedParams, Stimulation, Lesion, Modulators, RegionalDrive, DerivedParams } from './wholeBrain.ts';
export { simulateMicrocircuit, resolveMicroParams } from './microcircuit.ts';
export type { MicrocircuitParams, MicrocircuitRun } from './microcircuit.ts';
export {
  summarizeWholeBrain, printWholeBrain, summarizeMicrocircuit, printMicrocircuit, spectrum, bandSplit, BANDS,
  rhythmLabel,
  FLAT_AMPLITUDE,
} from './analysis.ts';
export type { WholeBrainSummary, MicrocircuitSummary, RegionStat, LobeStat } from './analysis.ts';
export { PRESETS, presetById, describePresets } from './presets.ts';
export { TREATMENTS, treatmentById, applyTreatment, describeTreatments } from './medications.ts';
export type { Treatment } from './medications.ts';
export { nernst, ghk, simulateNeuron, printNeuron, NEURON_CONDITIONS, NEURON_DRUGS, DEFAULT_IONS, DEFAULT_PERM } from './neuron.ts';
export type { Ions, Permeability, NeuronParams, NeuronRun } from './neuron.ts';
export type { Preset } from './presets.ts';
export { sweepBrain, sweepBrainSteps, sweepNeuron, findTransition, printBrainSweep, printNeuronSweep, SWEEP_KNOBS, BRAIN_MEASURES, DEFAULT_RANGE, NEURON_FIELDS, NEURON_MEASURES, NEURON_RANGE } from './sweep.ts';
export type { BrainSweep, BrainSweepPoint, SweepStep, BrainSweepSpec, BrainVariable, BrainMeasure, NeuronSweep, NeuronSweepPoint, NeuronSweepSpec, NeuronField, NeuronMeasure, Transition, SweepKnob } from './sweep.ts';
