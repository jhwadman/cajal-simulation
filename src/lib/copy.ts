/**
 * src/lib/copy.ts — the studio's explanatory prose.
 *
 * AUTHORED, THEN CHECKED. Almost every string below was written by the scribe
 * agent (agents/scribe.yaml, gemini-3.8-flash) from a context pack, so that
 * the cover, the Simulation bench and the EEG benchmark speak in ONE voice —
 * the approachable academic mentor. The exceptions are SIM and BENCH, both
 * rewritten by hand (knowledge/06-decisions.md, 2026-09-13), as are three of
 * the four investigations — `tipping`, `potassium` and `dose` (2026-09-18).
 * Re-authoring:
 *
 *   npm run scribe -- agents/briefs/cover.md
 *   npm run scribe -- agents/briefs/simulation.md
 *   npm run scribe -- agents/briefs/bench.md
 *   npm run scribe -- agents/briefs/investigate.md
 *   npm run scribe -- agents/briefs/explainer.md      (EXPLAINER, the /simulation page)
 *
 * THE DIVISION OF LABOUR: the scribe owns the voice, this repo owns the
 * facts. The scribe writes only from the context pack in its brief, and every
 * claim it returned was checked against the code before it landed here. The
 * default route for changing what the copy SAYS is still to change the brief
 * and re-author.
 *
 * A HAND-WRITTEN BLOCK IS ALLOWED, on one condition: the matching brief is
 * rewritten in the same commit so that the next re-author returns the same
 * substance rather than reverting it, and every claim is checked against the
 * code exactly as the scribe's would be. SIM, BENCH and the `tipping`,
 * `potassium` and `dose` investigations stand on that route today; each names
 * its brief and its check in its own comment. COVER.lead and COVER.tabs were
 * trimmed by hand on the same route (2026-09-19, the copy sweep), and the
 * three term lists — the cover's ten, the benchmark's seven, Investigate's
 * math/AI pair — were REMOVED rather than shortened, because the Glossary
 * tab and the cover's own math/AI pair already said them. The briefs no
 * longer ask for them.
 *
 * Plain strings, no markup: the page renders each one as a text node, so the
 * render path stays clean (knowledge/01).
 */

export const COVER = {
  title: "A working studio for brain dynamics.",
  lead: "This studio simulates large-scale brain activity on your machine by integrating the equations while you wait. You can set a brain state, give it a drug, and follow the dynamics from one ion channel up to the whole cortex.",
  /* Shortened by hand (2026-09-19): each section is two or three sentences
   * and its figure carries the rest; agents/briefs/cover.md asks for this
   * length now. The section titles are technical noun phrases, hand-written
   * for the documentation layout of the About tab, and the brief asks for
   * that shape too — as do simulation.md, investigate.md and bench.md for
   * their tab titles. */
  sections: [
    {
      title: "Neural-mass dynamics: Wilson–Cowan populations over 85 regions",
      body: "The engine follows how active each population of cells is, not every neuron. Each of 85 regions pairs an excitatory group with an inhibitory one, and the regions drive each other across conduction delays: a Wilson\u2013Cowan neural-mass model, which is the right altitude for rhythms and seizures.",
    },
    {
      title: "Three scales: membrane, microcircuit, whole brain",
      body: "Three models, one question at three sizes. The single neuron computes voltage from ion gradients and channel gates; the microcircuit runs Izhikevich cells spike by spike; the whole-brain model couples 85 regions across the synthetic connectome.",
    },
    {
      title: "State space: six parameters, twelve conditions, fifteen treatments",
      body: "Six knobs set a state, and twelve tuned conditions set all six at once. A treatment is a set of multipliers on the equations, chosen to match what the drug does at its receptor: the direction and rough size of an effect, not pharmacokinetics.",
    },
    {
      title: "Runs: identifiers and determinism",
      body: "Every run keeps a short id and the same settings give the same numbers every time. The local service holds your forty most recent runs for the session, so any of them can be reopened or handed to the assistant by id.",
    },
  ],
  /* The tab list and the lead were trimmed by hand (2026-09-19) and
   * agents/briefs/cover.md now asks for this length; the cover's own
   * ten-term glossary was removed, not shortened \u2014 the Glossary tab defines
   * the same words. */
  tabs: [
    {
      name: "Simulation",
      body: "The control bench and the 85-region brain: set a state, give it a drug, run it, and compare treated against untreated.",
    },
    {
      name: "EEG benchmark",
      body: "A blind test of whether LaBraM, trained on real human EEG, can tell four simulated states apart from their scalp projections.",
    },
    {
      name: "Single neuron",
      body: "One patch of membrane: set the ion gradients, read the resting potential, inject current and watch it spike.",
    },
    {
      name: "Investigate",
      body: "Four guided experiments, each locked until you commit a prediction.",
    },
    {
      name: "Glossary",
      body: "Every word the studio uses, defined, and the line between what is mathematics and what is AI.",
    },
  ],
  math: "Deterministic differential equations govern the whole-brain network, the spiking microcircuit, the single neuron, and the simulated scalp projections. These mathematical formulations contain no artificial intelligence, meaning identical initial values and noise seeds yield identical trajectories every time. You observe direct numerical integrations rather than stochastic estimations or trained approximations.",
  ai: "Artificial intelligence enters only when interpreting data or organizing experiments. Cajal uses specialized tools to orchestrate runs and explain traces, while pre-trained models such as LaBraM read recordings and describe what is in them. Machine learning never computes the biophysical state equations, leaving the generation of physiological dynamics entirely to classical mathematics.",
  honesty: "Every trajectory on this page reflects a synthetic connectome and an idealized mathematical model rather than a clinical measurement from an individual patient. Tipping points and seizure thresholds are intrinsic properties of these equations, so the studio describes simulated network phenomena without offering medical diagnoses.",
} as const;

/* ── the Simulation tab ──────────────────────────────────────────────────
 * Hand-written, like BENCH, with agents/briefs/simulation.md rewritten to
 * match (knowledge/06-decisions.md). Checked against presets.ts (12 tuned
 * conditions), medications.ts (15 compounds, 12 clinical + 3 lab) and
 * atlas.ts (68 cortical + 17 subcortical). ----------------------------- */
export const SIM = {
  title: "Whole-brain simulation: coupled Wilson–Cowan equations with conduction delays",
  lead: "We model large-scale brain dynamics by coupling 85 anatomical regions across a synthetic structural connectome with axonal conduction delays. Within each parcel, an excitatory population interacting with an inhibitory one governs local rhythmicity. Pressing run integrates these coupled Wilson–Cowan differential equations forward in time, and the cortical surface animates as the solver advances, translating regional population firing rates into an evolving spatial pattern.",
  describe: "Say the state you want, in clinical or plain language, and press design the simulation. Cajal proposes the settings as a card; nothing runs until you press confirm and run.",
  steps: [
    {
      name: "Set the state",
      body: "Pick one of the twelve tuned conditions, or describe one in words and confirm the card Cajal proposes. Either way the same equations run across all 85 regions.",
    },
    {
      name: "Give it a drug",
      body: "Add one of the fifteen compounds and press compare with untreated. The bench runs the same condition without the drug and tables what changed.",
    },
    {
      name: "Go down a scale",
      body: "Press run cell by cell to drop the same state into a spiking microcircuit and see every spike.",
    },
  ],
} as const;

/* ── the EEG benchmark tab ───────────────────────────────────────────────
 * The one block on this page that was NOT authored by the scribe: it was
 * written by hand, and agents/briefs/bench.md was rewritten to match so a
 * re-author does not revert it. Every claim below was checked against
 * service/loop/labram.ts and models/cajal_models/eeg.py — see
 * knowledge/06-decisions.md. ------------------------------------------- */
export const BENCH = {
  title: "EEG benchmark: closed-loop discrimination with LaBraM",
  lead: "Can a network trained strictly on clinical human EEG recognise a brain state generated purely from differential equations? We synthesise four distinct neurological states with the whole-brain model, project the activity onto virtual scalp electrodes, and feed the output to LaBraM, an EEG foundation model trained on roughly 2,500 hours of real human recordings. Because LaBraM has never encountered this studio's synthetic engine, it cannot fall back on a memorised artifact — whatever it separates, it separates on the structure of the signal itself. This is a closed-loop falsification test: if the simulated biology is mathematically hollow, the evaluation fails, and the page says so.",
  stages: [
    {
      name: "Define",
      body: "An external language model designs four distinct neurological conditions out of the studio's tuned biophysical presets. Adjustments are bounded to half a step from baseline, which prevents the over-saturated dynamics where every state degrades into uninformative slow waves. The selected states and their expected electrophysiological signatures are locked into the table on the left before anything is executed, eliminating retrospective bias.",
    },
    {
      name: "Simulate and project",
      body: "The neural engine integrates each configuration across the 85-region whole-brain connectome for eight simulated seconds. A distance-weighted forward kernel then projects regional cortical currents onto 19 standard 10-20 scalp channels, incorporating a calibrated microvolt gain, pink 1/f background noise and a 1 µV trace of line-frequency hum; only cortical regions contribute. Set beside a boundary-element structural head model this projection is abstract, but it faithfully preserves the three properties the test turns on — spatial synchrony, broadband power and amplitude dynamics.",
    },
    {
      name: "Decompose and encode",
      body: "Raw traces are bandpass-filtered between 0.1 and 75 Hz, notch-filtered for line noise, downsampled to 200 Hz and partitioned into four-second epochs. We deliberately avoid average referencing: subtracting the spatial mean artificially erases the global phase synchrony that is characteristic of generalised seizures and slow-wave sleep — the very thing those states are made of. Each epoch is then processed through two parallel paths. LaBraM compresses the multi-channel time series into latent embeddings, mapping the signal's geometry using representations learned from human clinical records, while a deterministic classical pipeline extracts canonical band power, cross-channel synchrony, a burst index and spectral flatness.",
    },
    {
      name: "Discriminate and score",
      body: "Two independent raters evaluate the data blind. A fresh instance of the external language model reviews the tabular spectral metrics with every identifying line stripped out, names the underlying physiological condition and reports its own confidence score. Separately — and reported by nothing — we measure the geometric distance between each epoch's embedding and its true condition's centroid. The run is marked successful only if three things hold: LaBraM read every recording, its latent clusters separate the conditions better than chance, and the blind judge correctly identifies at least 3 of the 4 conditions.",
    },
  ],
  /* The seven-term list this block carried was removed on 2026-09-19: the
   * Glossary tab defines LaBraM, latent embedding, epoch, forward model,
   * blind judge and confidence, and the cover repeated every one of them. */
  reading: "One strip per state: the trace LaBraM read, with its microvolt scale, the band powers beside it, and both readings — LaBraM's nearest-centroid pick with its geometric confidence, and the blind judge's pick with its own self-reported certainty. Each strip is drawn to its own scale so the rhythm stays legible; tick one scale for all states to compare amplitude. See the simulation opens the run a strip came from.",
} as const;

/* ── the Investigate tab ─────────────────────────────────────────────────
 * Four experiments. `why` is read before the reader predicts; `mechanism`
 * and `limits` are the explanation shown once the model has answered.
 * Written by the scribe from agents/briefs/investigate.md, then checked
 * against the engine: every number here is one the sweeps actually produce.
 * `transfer` is the scribe's; the other three are hand-written and each says
 * so, with the sweep its numbers came from, in its own comment.
 * ------------------------------------------------------------------- */
export interface Mechanism { title: string; def?: never; body: string }
export const INVESTIGATE = {
  title: "Investigations: parameter sweeps and transition sharpness",
  lead: "Every experiment on this tab proceeds through three beats: you frame an expectation, test it against differential equations, and inspect the mechanism that drove the outcome. The run button remains locked until you register a prediction. Committing to a specific outcome before you observe the data changes how you perceive the evidence, marking the boundary between an experiment and a demonstration. Once the integration finishes, your prediction sits directly beside what the equations produced.",
  sweep: "A sweep evaluates a complete simulation across a series of parameter values while holding every other variable and random seed constant. By tracking the largest single jump against what an even response would have produced, we obtain a measure of sharpness. A straight line scores 1, whereas a score above 3 indicates the system tipped sharply across a narrow interval rather than sloping smoothly.",
  /* the math / AI pair this block carried duplicated the cover's own; the
   * per-investigation ledger ("who did what") is where that line is drawn
   * on the tab itself (2026-09-19) */
  investigations: [
    /* HAND-WRITTEN (2026-09-18), on the route the header sets out: the
     * matching section of agents/briefs/investigate.md was rewritten in the
     * same commit. Checked against the engine: sweepBrain over inhibition
     * 1.2 → 0.7 in 11 steps, seed 1, gives synchrony 0.029 at 1.20, 0.012 at
     * 1.00, 0.025 at 0.95, then 0.928 at 0.90, 0.918 at 0.85, 0.931 at 0.80,
     * 0.666 at 0.75 and 0.661 at 0.70; transition at 0.925 (printed 0.93)
     * with sharpness 9.83; mean 0.987 and amplitude 0.001 at 0.75; the
     * seizure's peak is 1.95 Hz, delta. */
    {
      id: "tipping",
      question: "How much inhibition can a brain lose before it seizes?",
      why: "Every region in this model pairs an excitatory population that drives local activity with an inhibitory population that reins it in. Common intuition treats a seizure as a shortage of inhibition, and that quietly implies a proportion: lose a tenth of the brake, get a tenth of the trouble. This sweep tests the implication directly rather than the belief. You will set the strength of inhibition at eleven values from 1.20, above the waking baseline of 1.00, down to 0.70, and watch how much of the cortex falls into lockstep at each one.",
      mechanism: [
        {
          title: "Loss of the quiet state",
          body: "Positive feedback drives the excitatory cells to recruit each other, while negative feedback from the inhibitory cells subtracts from that growth. Under ordinary conditions the two settle at a stable, low-activity operating point where any small surge quells itself by recruiting its own brake. Weakening the brake does not nudge that resting state gradually upward; it shrinks the margin by which negative feedback dominates, and the state itself stays where it is until the margin runs out. At an inhibition of 0.95, with a twentieth of the brake gone, synchrony is 0.03 and the cortex looks entirely ordinary. One step further, at 0.90, it is 0.93. The transition is reported at 0.93, the midpoint of the step it straddles, with a sharpness of 9.8 — nearly the whole change arrived inside a single step of the sweep.",
        },
        {
          title: "Network recruitment across delays",
          body: "If one region lost stability on its own, the resulting surge would stay a contained local event. But structural pathways link all 85 regions through distance-dependent conduction delays. When the unstable area begins its high-amplitude rhythmic discharge it broadcasts those pulses to neighbours sitting at the same lowered threshold, equally ready to oscillate, and the connectome turns an isolated breakdown into a global synchronous discharge at roughly 2 Hz. That rhythm is not imposed from anywhere: it comes from a slow adaptation current that accumulates during active firing and enforces a periodic pause.",
        },
        {
          title: "Collapse into silent saturation",
          body: "Continuing the sweep below 0.80 departs from the clinical narrative entirely: synchrony falls back rather than worsening, from 0.93 to about 0.66. With inhibition almost gone the excitatory populations run into the hard ceiling of their own activation curves, and mean firing pins at 0.99. A population pressed against its ceiling cannot oscillate, because it has no room left to swing upward and no adaptation current strong enough to drag it back down — the amplitude of the rhythm collapses from 0.46 at 0.80 to 0.001 at 0.75, which is to say it stops being a rhythm. The seizure lives in an intermediate window. Past that window the model does not produce a worse seizure; it produces saturation, and the response curve is not monotone.",
        },
      ],
      limits: "The value near 0.93 belongs to this differential system and its synthetic connectome, not to any living patient, and a sweep sampled on a finer grid would move it. The finding is the shape — a margin that holds, then a state that ceases to exist — rather than the number where this particular model crosses it.",
    },
    /* HAND-WRITTEN (2026-09-18), same route and same commit as `tipping`.
     * Checked against the engine: sweepNeuron over K_out 2 → 30 mM in 15
     * steps gives rate 75, 75, 75, 75, 87.5, 87.5, 100, then 0 for every
     * remaining point; GHK -76.3 → -42.4 mV; resting -78.2 → -33.2 mV; spike
     * peaks 63.0, 62.5, 61.6, 59.9, 56.5, 27.7, 36.8, 14.8 and then none;
     * two spikes at 16 mM and zero above it; DEFAULT_PERM makes the membrane
     * exactly 25× more permeable to potassium than to sodium; the transition
     * scores a sharpness of 14. */
    {
      id: "potassium",
      question: "If potassium builds up outside a neuron, does it fire more, or less?",
      why: "Every action potential drives potassium ions out through the membrane, briefly raising their concentration in the narrow spaces outside the cell. Under a heavy workload that accumulation outpaces the rate at which glia and local capillaries clear it away, and because the distribution of potassium sets the baseline voltage of the membrane, a neuron firing hard is steadily altering its own electrical environment. You will sweep the outside concentration from 2 mM, a quiet extracellular space, to 30 mM, which is pathological accumulation, and measure what the firing rate does.",
      mechanism: [
        {
          title: "Depolarisation of the resting membrane",
          body: "The resting voltage of a neuron is a weighted average of the equilibrium potentials of its ions, dominated by whichever passes the membrane most easily. An unexcited membrane here is exactly twenty-five times more permeable to potassium than to sodium, so potassium's gradient dictates where the cell rests, and that gradient depends on the logarithm of the ratio of potassium outside to potassium inside. Raising the outside concentration compresses the ratio, driving the potassium equilibrium potential from minus 76 mV up to minus 42 mV across the sweep and pulling the resting voltage from minus 78 mV to minus 33 mV along with it. A cell resting closer to its threshold needs less to reach it, so the firing rate climbs from 75 Hz to a peak of 100 Hz at 14 mM.",
        },
        {
          title: "Sodium channel inactivation block",
          body: "Voltage-gated sodium channels use two distinct gates. An activation gate opens rapidly when the membrane depolarises, which starts the spike; an inactivation gate swings shut more slowly afterwards and only resets once the voltage returns to a negative resting level. At ordinary resting potentials most inactivation gates sit open and ready. As sustained external potassium holds the membrane depolarised, a growing fraction of them are shut before an action potential can begin, and there is never a negative enough interval to reset them. At 16 mM the cell manages two spikes and then stops; at every concentration above it there are none at all. The cell is not inhibited and it is not hyperpolarised — it is held too far depolarised to fire.",
        },
        {
          title: "Shrinking spikes, before the silence",
          body: "The two effects overlap, and the handover shows in the shape of the spikes rather than in their timing. Long before firing cuts off, the height of each action potential is falling: the tallest in the sweep peaks at plus 63 mV at 2 mM, it is down to plus 57 mV by 10 mM, and the last spikes the cell produces at all, at 16 mM, peak at plus 15 mV. The fall is not perfectly orderly — once the membrane sits this depolarised the resting voltage itself wanders between concentrations, and 12 mM yields a shorter spike than 14 mM does — but its direction is unmistakable. Fewer working sodium channels take part in each cycle, starving the regenerative phase of the spike. A simple on-off switch would deliver full-sized spikes right up to the boundary; a waveform that shrinks first is direct evidence of inactivation gates locking shut one by one.",
        },
        {
          title: "The same shape, one scale down",
          body: "Set this beside the whole-cortex sweep and the same dynamic appears at two very different scales. Stripping inhibition across the brain produced a severe seizure that collapsed into flat saturation once the network hit its limits. Saturating one patch of membrane with potassium accelerates firing until channel inactivation extinguishes it. Both curves are non-monotone, and both end in an abrupt stop rather than a decline — the brain sweep scores a sharpness of 9.8 and this one 14, where a straight line would score 1. Driving an element harder stops raising its output once its internal machinery saturates. That belongs to nonlinear feedback systems in general, not to brains in particular.",
        },
      ],
      limits: "This is a textbook Hodgkin and Huxley membrane rather than the specific channel complement of a particular cell type in a particular species, so the concentration at which firing stops — 16 mM here — belongs to these parameters. Real cells move their own tipping points according to their morphology and their pump capacity. What transfers is the mechanism: depolarisation helps a neuron fire until it prevents it.",
    },
    /* HAND-WRITTEN (2026-09-18), on the route the header sets out: the
     * matching section of agents/briefs/investigate.md was rewritten in the
     * same commit, so a re-author returns this substance rather than
     * reverting it. Rewritten because the old block asked the reader a trick
     * question and answered it in developer shorthand. Checked against the
     * engine: sweepBrain over dose 0 → 1.5 in 9 steps, seed 1, gives the
     * benzodiazepine on `seizure` a sharpness of 2.05 with synchrony
     * 0.96 → 0.88 → 0.76 → 0.54 → 0.40, and caffeine on `deep-sleep` a
     * sharpness of 6.93 turning at 0.66 with synchrony 0.92 → 0.12 between
     * neighbouring doses. */
    {
      id: "dose",
      question: "Does twice the dose do twice as much?",
      why: "A dose-response curve has a shape, and in practice the shape matters more than the size of the effect. Some drugs behave like a dimmer switch: every increment of dose moves the brain a little further, so the dose can be raised against what the patient is actually doing and stopped when it is enough. Others behave like a circuit breaker: dose after dose changes almost nothing, and then one step further flips the whole network into a different state. A circuit breaker is far harder to give safely, and the same molecule can be either one, because the shape belongs to the state being treated as much as to the drug. You will give two familiar compounds across their full dose range and compare the shapes of the two curves rather than their endpoints.",
      mechanism: [
        {
          title: "The benzodiazepine is the dimmer switch",
          body: "In this model a benzodiazepine strengthens the inhibitory current acting on the excitatory populations, which is exactly the parameter whose collapse produced the seizure in the first investigation. The drug pushes back along the same axis the disorder moved along. How severe the seizure is varies continuously with how far inhibition sits below its critical value, so every increment of dose recovers some of that distance and shows it on the way: synchrony steps down from 0.96 through 0.76, 0.54 and 0.40 before it settles near zero. The curve scores a sharpness close to 2, near enough to a straight line that half a dose gives roughly half the effect.",
        },
        {
          title: "Caffeine is the circuit breaker",
          body: "Caffeine blocks adenosine, which in this model weakens the slow adaptation current. Slow-wave sleep is not a point on a slope; it is a self-sustaining cycle. Adaptation builds while a region fires, forces it into a silent phase, then decays until firing resumes. Weakening that adaptation a little changes the depth and the period of the cycle, but the cycle still regenerates itself, so from the outside almost nothing happens: across the first half of the dose range synchrony stays around 0.9. Past a critical weakening, adaptation can no longer end the active phase, the cycle has no way to continue, and the cortex falls into the waking state instead. Synchrony drops from 0.92 to 0.12 between two neighbouring doses and the curve scores about 7. There is no dose here that half-wakes the brain.",
        },
        {
          title: "Sharpness is measured, not eyeballed",
          body: "Sharpness divides the largest single step in the curve by the step an even ramp across the same total change would have taken, so a straight line scores 1 and anything above 3 means the system tipped inside one interval. That makes the two shapes comparable as numbers rather than as impressions. It also shows that the shape belongs to the state as much as to the molecule: the same compound given in a different condition can produce a different curve, because what decides it is whether the process being treated varies continuously or holds itself together until it cannot. Caffeine shows a cliff here because the state it disturbs is an all-or-nothing cycle, not because caffeine is a sharper drug than a benzodiazepine.",
        },
      ],
      limits: "A treatment here is a set of multipliers on the model's parameters, chosen to match what the drug does at its receptor. There is no absorption, no distribution and no receptor occupancy curve, so a dose of 1.0 means a typical clinical effect rather than a quantity in milligrams. The two sharpness scores are properties of this model at this sampling, and a finer grid would move them; the finding is the difference between the two shapes, not either number on its own.",
    },
    {
      id: "transfer",
      question: "Our EEG comes out of equations. Would a model trained on real human brains recognise it?",
      why: "The earlier experiments tested the brain model against its own internal mathematical assumptions. This run tests the synthetic output against an external reference by presenting our synthetic traces to LaBraM, an independent neural network trained on thousands of hours of real human EEG. The network receives raw, unlabelled synthetic voltages from four distinct simulated conditions projected onto nineteen standard scalp locations. We want to see if an external instrument perceives familiar structure in these differential equations.",
      mechanism: [
        {
          title: "Unsupervised alignment with real features",
          body: "LaBraM learned to summarise a recording from roughly 2,500 hours of human EEG, and it has never been shown a simulation. Whatever it learned to keep is whatever recurs in real brains: the spread of frequencies, the way amplitude rises and falls, and how much the channels move together. Across 28 unlabelled four-second windows, the network reliably groups recordings from the same simulated conditions together while separating different regimes, achieving a clean passing score against a 25 percent chance baseline. If the differential equations produced unstructured noise, the resulting vectors would scatter randomly across the embedding space. That clean separation shows our equations reproduce the temporal and cross-channel structure that real recordings carry.",
        },
        {
          title: "Informative failure modes",
          body: "When a secondary language model inspects the blind numerical telemetry, it occasionally mislabels a generalised seizure as deep slow-wave sleep. That failure is biologically logical: both states feature prominent high-amplitude delta activity and dense inter-channel synchrony, confounding simple frequency-band summaries. The conditions separate decisively only when the classifier examines the exact voltage amplitude and the fine structure of the synchrony. When an automated reading misclassifies a state, the breakdown exposes the limits of the features it was provided rather than a failure of the classifier itself.",
        },
      ],
      limits: "Distinguishing four radically distinct neural regimes represents a straightforward categorization task, meaning a passing score does not prove total physiological authenticity. Furthermore, projecting cortical activity to the nineteen scalp electrodes relies on a geometric distance kernel rather than a genuine physical volume conductor model. Separability proves that our synthetic traces share basic statistical structures, not that they match real biological brains in fine spatial detail.",
    },
  ],
};

/* ── the explainer page, /simulation ─────────────────────────────────────
 * Written by the scribe from agents/briefs/explainer.md (2026-09-23, third
 * draft, after the brief gained the section that lists every term the page
 * uses and the reason behind each design choice) and then PATCHED BY HAND
 * with the owner's leave: where a sentence still leaned on a name it had
 * not explained, the mechanism was put in front of it; and four facts were
 * corrected, each now forbidden in the brief — the model tracks regional
 * ACTIVITY, not voltages (wholeBrain.ts); the blind judge reads the
 * classical analysis and never sees LaBraM's numbers (service/loop/
 * labram.ts); the scribe is called at authoring time, never "offline"
 * (service/scribe.ts); and a treatment is applied, nothing "interacts"
 * (medications.ts). The equations and the directory table are hand-written
 * in src/pages/how-it-works.astro; the simulation itself is /simulation.
 * ------------------------------------------------------------------- */
export const EXPLAINER = {
  title: "Whole-brain dynamics simulated in your browser.",
  lead: "This page pairs a live whole-brain simulation with an account of how it works, how it was built, and where AI was used. You can explore brain states, apply a treatment, and trace every number back to the source code. The equations run on your machine, with no cloud service behind them.",
  run: {
    title: "Whole-brain simulation: 85 Wilson–Cowan regions on a synthetic connectome",
    body: "The simulation page shows a model that couples 85 brain areas across roughly twelve hundred synthetic pathways. Each area is described by two numbers that change in time: how active its excitatory cells are, and how active the inhibitory cells that curb them are. Excitation feeds itself and drives inhibition, inhibition pushes excitation back down, and each responds to its input through a curve that rises and then saturates, the way a population of cells does. That pair of equations per region is the Wilson–Cowan model, and we work at this population level because rhythms, synchrony and seizure discharges are things whole populations do, not single spikes. You can set a state from twelve tuned presets, or describe one in words for Cajal to turn into a proposal you inspect and confirm; pressing run integrates the equations forward in time and nothing else. Try the generalised seizure preset, then open the knobs and raise inhibition toward 1 to watch the discharge stop.",
  },
  generate: {
    title: "The computational chain: from parameter knobs to regional readout",
    body: "The simulation steps deterministically from six top-level controls down to the activity of every region, half a millisecond at a time. A small seeded random-number generator supplies every random nudge along the way, so identical settings and the same seed produce the same trace to the last decimal, in your browser or in the local service. That is what makes a run a fact rather than an event: a difference between two runs is a difference in settings, never in luck. You can check it yourself by running any condition twice with the seed held constant.",
    steps: [
      { name: "Derive base parameters", body: "The engine translates the six knobs and five neuromodulators into the coefficients the equations actually use: how strongly a region excites itself, how hard its inhibition pushes back, its resting drive, and its coupling to the rest of the network. A treatment multiplies those values afterwards, and a preset can override individual ones. This mapping is one function, called derive, and it runs before the integration begins." },
      { name: "Couple the network", body: "A signal takes time to travel along an axon, so an area experiences what its neighbours were doing several milliseconds earlier. The synthetic connectome weights these delayed interactions by the distance between region centroids: nearer regions are more strongly connected, with a handful of known long-range pathways added by hand. A damaged region has the activity it can reach scaled down by the fraction of its tissue that survives." },
      { name: "Integrate population rates", body: "Excitatory and inhibitory activity relax toward their saturating response curves across discrete half-millisecond steps. Cells that have been firing for a while tire: an adaptation variable builds up gradually and damps ongoing activity, which is what generates slow waves. The engine discards an initial four-hundred-millisecond warm-up so the model's start-up transient never appears in your run." },
      { name: "Apply seeded noise", body: "Fluctuations enter the equations through a seeded pseudo-random sequence. Because the generator, mulberry32, produces exactly the same sequence from the same starting integer, identical inputs yield identical traces on the browser worker and in the local service alike. You can reproduce any trace anywhere by keeping its seed." },
      { name: "Sample and analyse", body: "The engine samples every region's excitatory activity every four milliseconds to assemble the frames the brain plays back. From those frames the same routines compute the mean field, which is all 85 regions averaged into one number at each moment, its amplitude, how much of the regions' variation is shared, and the split of its power across the frequency bands. The picture on the page and the text Cajal reads come from the very same analysis functions." },
    ],
  },
  scalp: {
    title: "Scalp projection: synthetic forward mapping to nineteen channels",
    body: "An electroencephalogram, or EEG, is a set of small voltages recorded by sensors resting on the scalp, nineteen of them here. To produce those nineteen traces from a run, the model projects each cortical region's activity outward to every sensor, weighted by a decay that falls off with distance, and only the cortex contributes because the deep nuclei do not reach the scalp. It runs in the direction the physics does, from sources to sensors, which is why it is called a forward model, and it omits the skull, the head geometry and the orientation of the sources, keeping only the rhythms, the amplitudes and the synchrony. We rely on this crude projection because it carries exactly what the benchmark tests and nothing that could flatter the simulation.",
  },
  built: {
    title: "Engineering provenance: collaborative development under architectural discipline",
    body: "This feature came together through coordinated work between human judgment and two kinds of artificial intelligence. A coding agent, Claude Code, implemented the software under strict written rules, while Gemini drafted this explanatory prose from structured technical briefs; the person guided the scientific design, evaluated every change, and made every architectural commitment. The rules exist for a reason each: a coding agent that reads them before every change does not drift the architecture, and a model that writes prose will state a plausible thing the code does not do unless every sentence is checked. Development began with the mathematics, then pinned its behaviour with tests, and only then spent its effort on whether a reader can understand and trust what they see. You can read the rules and the tests yourself; the repository guide below says where they are.",
    stages: [
      { name: "Consult the manual", body: "The repository keeps a manual that describes how the system works right now, one document per subsystem, and the coding agent read it before writing code. The manual lists thirteen invariants, rules that must stay true through every change, such as the engine taking no outside dependencies because two programs run it. Reading first is what kept the architecture from drifting as features were added." },
      { name: "Isolate the mathematics", body: "The equations that move the brain, the wiring, and the analysis live in one folder of plain TypeScript with no outside libraries, because two programs run them: the page in your browser and the local service the assistant uses. One copy means the run you watch and the run the assistant describes are the same numbers, and there is no second version to fall out of step." },
      { name: "Pin with tests", body: "A regime is a pattern the model can be in, such as desynchronised waking rhythms or a hypersynchronous seizure, and a regime test runs a preset and asserts the pattern it claims, so a change that moves the pattern fails on purpose. Before any preset value is altered, a sweep runs the model across one parameter with everything else held still, to find where the response turns and how sharply. A tuned number is then a measurement of the model, not a guess." },
      { name: "Verify every claim", body: "Every sentence of technical copy, including this page, was checked against the code before it was committed. A drafted assertion the implementation does not support was deleted, not softened. That audit is what lets the page say how the model works without a hedge on every line." },
    ],
  },
  inside: {
    title: "Active roles: machine learning systems operating within the studio",
    body: "Three learned models work inside the studio, each in one bounded role, and none of them touches the equations. They describe, interpret or draft; every simulated trace, every treatment effect and every spectral number comes from the deterministic mathematics above. The roles are bounded on purpose, so that you can always tell a number the equations produced from a sentence a model wrote.",
    places: [
      { name: "Cajal the assistant", body: "A language model at a desk with fifteen tools. When you ask it a question, it runs the simulation tools and explains the numbers they returned, never inventing one. When you describe a state in words, it drafts the settings as a proposal for you to confirm, and nothing is computed until you do." },
      { name: "LaBraM EEG benchmark", body: "LaBraM is a network trained on about 2,500 hours of real human EEG to produce a compact description of any recording it is shown, without ever being taught to name a state; that kind of network is called a foundation model. In the benchmark it reads the nineteen-channel projections of four simulated states and returns a description of each. A separate, blind instance of the language model reads only the classical analysis of each recording, never LaBraM's numbers, and names the state, which tests whether the simulated rhythms carry a signature a reader of real EEG can recognise." },
      { name: "The scribe", body: "Gemini, called at authoring time with a curated context pack, drafted this explanatory text. It runs during the build of the page and never in your browser, which makes no network request while you read. Its job is to make the ideas clear without inventing a capability the code does not have." },
    ],
  },
  repo: {
    title: "Repository guide: structure and local verification",
    body: "The code is one repository holding the mathematical engine, the browser interface, and the optional local services behind the assistant and the benchmark. The interface, the whole-brain integration and the single-neuron tools run in a standard web browser after one install. Talking to Cajal or running the foundation-model benchmark needs the accompanying local services and an API key.",
    steps: [
      { name: "Open the index", body: "Begin with knowledge/index.md, the manual's front page. It maps the subsystems and lists the thirteen invariants every change must keep." },
      { name: "Inspect the engine", body: "Read service/engine/wholeBrain.ts, the whole-brain integration file. You will see the complete Wilson–Cowan implementation and the knob-to-parameter mapping, with no outside library in sight." },
      { name: "Run the tests", body: "Run npm test from your terminal. The regime tests assert the rhythm, synchrony and activity each preset claims, so you can see what the model is held to." },
      { name: "Launch the bench", body: "Run npm run dev and open port 4360. You can adjust the knobs, change the seed, and watch the model move between states yourself." },
    ],
  },
  honesty: "This simulation demonstrates the kinds of dynamics a cortex can have; it does not record or diagnose any person's brain. The thresholds where the model tips between states are properties of these equations on a synthetic wiring, not constants of biology.",
} as const;
