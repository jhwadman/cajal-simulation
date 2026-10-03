# cajal-simulation

The simulation from [cajal](https://github.com/jhwadman/cajal), a brain
simulation studio, as a site of its own: one page, no services, no keys.

An 85-region Wilson–Cowan whole-brain model on a synthetic distance-rule
connectome with conduction delays and adaptation, run **in your browser** on a
worker thread and drawn on a real brain (the FreeSurfer fsaverage6 pial
surface, the MNI152 brain mask). Pick a named state — awake, deep sleep, REM,
seizure, anaesthesia, a lesion, a stimulation — or a treatment, press *run
the brain*, and watch the cortex light up by region while the mean field, the
synchrony and the band split are read out beside it. `/how-it-works` says how
a run is generated, equation by equation, and where AI was used to build it.

The page makes no request once it has loaded. Everything it shows is
computed by `service/engine/`, pure TypeScript with no dependencies, which is
the same engine the full studio's agent runs through its tools: a run is the
same numbers wherever it is made.

## Run it

```bash
npm install
npm run dev      # http://127.0.0.1:4360
npm test         # the engine's regime tests: every preset behaves as it claims
npm run build    # static files under dist/
```

Node 22 or newer.

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
[jhwadman/cajal](https://github.com/jhwadman/cajal); this repository is a
copy of the pages and the engine, kept in step by hand.

cajal is a simulation studio, not a clinical instrument. A run shows the kind
of dynamics a cortex has under a condition, on a synthetic connectome, never
a measurement of anyone's brain.
