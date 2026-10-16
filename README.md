# Whole Brain Simulation

An offline desktop teaching app for exploring an 85-region Wilson–Cowan
whole-brain model on a synthetic connectome. Pick a brain state, adjust its
controls, and inspect the visualization and numerical readout. The app
bundles its runtime, brain assets, fonts, and explanation pages.

## Build and run

Use Node 22.16+ or Node 24 LTS. From this directory:

```bash
npm ci
npm run desktop
npm test
npm run test:desktop
npm run test:app
npm run package
```

Setup downloads dependencies; the installed app runs offline. The packaging
command creates a DMG/ZIP on Mac, an NSIS installer on Windows, or an AppImage
on Linux under `release/`. Installed-app users do not need Node or a terminal.
See [desktop/README.md](desktop/README.md) for the native build workflow,
installed-app verification, and signing requirements for public releases.

The engine is pure TypeScript with no runtime dependencies. Desktop packaging
uses Electron and preserves the existing worker and deterministic tests.

## Where things are

| path | what |
|---|---|
| `service/engine/` | the engine: `wholeBrain.ts` (the model and `derive()`, the knob → parameter map), `connectome.ts`, `atlas.ts`, `analysis.ts` (what a run means in text), `presets.ts`, `medications.ts`, `sweep.ts`, `microcircuit.ts`, `neuron.ts` |
| `service/tests/` | the regime tests |
| `src/pages/` | `index.astro`, the simulation; `how-it-works.astro`, the explainer |
| `src/components/Studio.astro` | the markup, shared with the full studio and rendered here with `standalone` |
| `src/lib/` | `client.ts` (the bench and the views), `sim.ts` / `simWorker.ts` (the engine on a worker), `gl.ts` and `render.ts` (the brain), `slice.ts` (the sections), `colormap.ts` (the one activation scale), `copy.ts` (the prose) |
| `public/brain/` | the baked mesh and volume; `public/fonts/` the three self-hosted faces with their licences |

The full studio adds an assistant that runs the model through a tool set,
pre-trained models that read EEG, fMRI, single-cell and imaging data, an EEG
benchmark, a single neuron and four guided investigations. It lives in
[jhwadman/cajal](https://github.com/jhwadman/cajal); this repository packages the simulation as a standalone desktop app.

cajal is a simulation studio, not a clinical instrument. A run shows the kind
of dynamics a cortex has under a condition, on a synthetic connectome, never
a measurement of anyone's brain.
