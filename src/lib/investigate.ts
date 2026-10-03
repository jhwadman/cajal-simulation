/**
 * src/lib/investigate.ts — the Investigate tab: four short experiments.
 *
 * WHY THIS EXISTS. The rest of the studio shows STATES: set the knobs, look
 * at the brain. But a state is a point, and science is about the curve
 * between points. These four investigations each vary ONE thing across a
 * range and ask what shape comes out — which is how you find a tipping
 * point, a threshold dose, or a treatment that stops helping.
 *
 * THE SHAPE OF EACH ONE is the same on purpose, so the load stays low and
 * the pattern becomes the lesson:
 *
 *   question → PREDICT → watch it run → compare → ask Cajal about YOUR data
 *
 * The prediction is not decoration. Committing to an answer before the data
 * arrives is the difference between an experiment and a demonstration, and
 * it is what makes a surprising result land. The guess is drawn on the chart
 * as a line before a single point exists.
 *
 * WHO DOES WHAT is shown, not claimed: every investigation carries a ledger
 * saying which parts were equations and which were a language model. In
 * three of the four, the AI does nothing at all until you ask it to explain
 * the curve you just produced. In the fourth, an AI model is the instrument
 * under test.
 *
 * Every string reaches the DOM through textContent or createElement.
 */

import { drawSweepChart } from './sweepChart.ts';
import { INVESTIGATE } from './copy.ts';
import type { SweepSeries } from './sweepChart.ts';
import { sweepNeuron, presetById } from '../../service/engine/index.ts';
import { sweepBrain } from './sim.ts';
import type { BrainSweep, BrainSweepPoint, NeuronSweep, WholeBrainRun, WholeBrainSummary } from '../../service/engine/index.ts';

/* ── what the tab needs from the page ────────────────────────────────────── */

export interface InvestigationHost {
  live: boolean;
  /** draw a finished simulation on the shared brain */
  showBrainRun(run: WholeBrainRun, summary: WholeBrainSummary, title: string): void;
  /** move the shared brain into this slot, or release it */
  moveStage(slotId: string | null): void;
  /** open the chat and ask */
  ask(question: string): void;
  switchTab(tab: string): void;
  /** register a finished sweep with the service so Cajal can inspect it */
  registerSweep(scale: 'brain' | 'neuron', spec: Record<string, unknown>, title: string): Promise<string | null>;
  /** start the EEG benchmark (investigation four) */
  runBenchmark(): void;
}

export interface Investigations {
  /** called when the tab is opened */
  show(): void;
  /** the benchmark finished: investigation four is waiting for this */
  onBenchmarkResult(r: { labramAccuracy: number; judgeAccuracy: number; pass: boolean; overallConfidence: number; states: number }): void;
}

/* ── small DOM helpers ───────────────────────────────────────────────────── */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
/**
 * How long to let a frame be late before concluding that this page is not
 * painting at all. Generous: a stage drawing a whole brain can be slow and
 * still be worth waiting for.
 */
const FRAME_BACKSTOP_MS = 400;
/** a new regime is worth looking at, so it is held rather than flashed */
const REGIME_DWELL_MS = 260;

/**
 * A sweep's sense of whether anyone is actually watching it draw.
 *
 * WHY THIS IS NOT `requestAnimationFrame`. A frame is not a timer: it arrives
 * only if the page is painting. Chrome stops rAF outright for a hidden page —
 * measured here as zero callbacks in eight seconds — and stretches it to the
 * cost of the slowest frame while the brain stage animates the previous run.
 * Awaiting one per point made a sweep's wall clock a property of the
 * compositor rather than of the work: of an 87.7 s nine-point dose sweep,
 * 85.9 s was spent waiting for frames and 1.7 s inside the model.
 *
 * So the sweep asks the page instead of assuming. While frames come back it
 * waits for them, and the chart gains a point per frame exactly as before.
 * The first frame that never arrives settles the question for the rest of the
 * sweep: nobody is watching, so stop paying to be watched. A reader who looks
 * away gets a finished curve when they look back, instead of a sweep that
 * stopped when the painting stopped.
 *
 * A timer cannot carry this on its own — a background tab clamps `setTimeout`
 * to one second, so a per-point deadline would cost as much as the frame it
 * was meant to replace. It is used once, to find out, and then not again.
 */
function paintPacer() {
  let painting = true;

  /** yield without waiting for anything: the page is not going to paint */
  const task = (): Promise<boolean> =>
    // not a timer, so a background tab does not clamp it to a second; the
    // relay and the controls still get their turn between points
    new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r(false);
      ch.port2.postMessage(0);
    });

  /** hand the browser one chance to paint; true if it took it */
  async function handOver(): Promise<boolean> {
    if (!painting || document.visibilityState === 'hidden') return task();
    const painted = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelAnimationFrame(raf);
        resolve(ok);
      };
      const raf = requestAnimationFrame(() => done(true));
      const timer = setTimeout(() => done(false), FRAME_BACKSTOP_MS);
    });
    if (!painted) painting = false;
    return painted;
  }

  /**
   * Hold for `ms` so a change on the brain can register as a change — but
   * count only time the page actually spent painting. The moment frames stop
   * coming there is nothing to look at, and the hold ends.
   */
  async function dwell(ms: number): Promise<void> {
    const until = performance.now() + ms;
    while (performance.now() < until) if (!(await handOver())) return;
  }

  return { handOver, dwell };
}
const COL = { primary: '#35d6ff', secondary: '#ff6a3d', warm: '#ffb45c' };

/** which regime a point is in: the brain is redrawn when this changes */
const regimeOf = (p: BrainSweepPoint): string =>
  p.mean > 0.9 ? 'saturated' : p.synchrony > 0.6 && p.amplitude > 0.12 ? 'seizure-like' : p.mean < 0.03 ? 'silent' : 'ordinary';

/* ── the four ────────────────────────────────────────────────────────────── */

type Choice = { id: string; label: string };

/** a question with one right answer, asked before the run or after it */
interface Ask {
  prompt: string;
  options: Choice[];
  correct: string;
}

interface Spec {
  id: string;
  short: string;
  usesBrain: boolean;
  /** a number the student picks on a slider, or one of three statements */
  predict:
    | { kind: 'value'; min: number; max: number; step: number; start: number; prompt: string; fmt: (v: number) => string }
    | { kind: 'choice'; prompt: string; options: Choice[]; correct: string };
  /**
   * An optional FIRST half of the prediction, asked above the slider: what
   * SHAPE is this going to be? A number alone ("it tips at 0.88") can be
   * close to right for the wrong reason, and the shape is the thing the
   * investigation is actually about. Both halves must be committed before
   * the run button unlocks.
   */
  shape?: Ask;
  /**
   * Asked AFTER the run and before anything is revealed: what do you SEE?
   * Nothing — not the verdict, not the mechanism, not the ask-Cajal button —
   * is shown until this is answered, so the reader reads their own chart
   * instead of being told what it says. See knowledge/08.
   */
  observe?: Ask & { headline: string };
  runLabel: string;
  /** the step-two heading, when 'run the simulation' would undercount */
  runStep?: string;
  /**
   * What the experiment IS, as rows beside the steps: what varies, what is
   * held still, what is measured, what one point costs. A reader arriving at
   * step one used to be asked to predict a curve whose axes they had not been
   * told; these rows, and the empty axes drawn under them, are the
   * orientation. Facts about the instrument, checked against the spec that
   * `go()` runs, and kept here beside the ledger for the same reason.
   */
  setup: Array<[string, string]>;
  /** under the step-two label: what pressing the button does, and how long it takes */
  runNote: string;
  /** step three before there is anything to compare */
  emptyNote?: string;
  ledger: Array<[string, string, 'ai' | 'math' | 'you']>;
}

const EMPTY_NOTE = 'Nothing to compare yet. Once the points are in you will be asked what you see on the chart, and only then is anything named or explained.';

const SPECS: Spec[] = [
  {
    id: 'tipping',
    short: 'How much inhibition can a brain lose?',
    usesBrain: true,
    shape: {
      prompt: 'First the shape, before any number. As that brake comes off a step at a time, how does a cortex go from awake to seizing?',
      options: [
        { id: 'ramp', label: 'steadily: every step of lost inhibition makes things a little worse' },
        { id: 'cliff', label: 'not at all, then all at once: the brake holds, and then the quiet state is gone' },
        { id: 'instant', label: 'immediately: a cortex below its normal inhibition is already seizing' },
      ],
      correct: 'cliff',
    },
    predict: {
      kind: 'value',
      min: 0.7,
      max: 1.2,
      step: 0.05,
      start: 0.85,
      prompt: 'Now the number. Wherever you think it changes, put the marker there — it is drawn on the empty axis before the first point exists.',
      fmt: (v) => v.toFixed(2),
    },
    observe: {
      headline: 'Eleven points, and the axis is full. Read it before anything is named.',
      prompt:
        'Follow the synchrony line from the right, where inhibition is normal, towards the left, where almost none is left. It jumps once, on its own. Then, at the far left below 0.80, what does it do?',
      options: [
        { id: 'higher', label: 'climbs higher still: less brake, worse seizure' },
        { id: 'holds', label: 'holds at the top' },
        { id: 'falls', label: 'falls back down' },
      ],
      correct: 'falls',
    },
    runLabel: 'run 11 simulations',
    runNote: 'Eleven complete simulations, one at each strength of inhibition, drawn on the chart as they finish: the least inhibition on the left, the most on the right. About ten seconds. The brain view is redrawn whenever the cortex changes regime.',
    setup: [
      ['varies', 'inhibition, eleven values from 0.70 to 1.20 in steps of 0.05; the waking brain sits at 1.00'],
      ['held still', 'everything else about the awake state, and the random seed, so only inhibition differs between two points'],
      ['measured', 'synchrony: how much of the cortex fires in lockstep, 0 (every region on its own rhythm) to 1 (all 85 as one); mean activity drawn fainter behind it'],
      ['one point', 'one complete simulation of 85 coupled regions, 1.2 s of brain time, about a second on your machine'],
      ['the chart', 'inhibition along the bottom, synchrony up the side; your prediction is drawn on it before the first point, and where the model turns is marked after the last'],
    ],
    ledger: [
      ['the two predictions', 'yours — the shape and the number — both committed before the calculation ran', 'you'],
      ['the eleven points', 'eleven complete simulations of 85 coupled regions; no AI touches these numbers', 'math'],
      ['the transition and its sharpness', 'measured, not judged: the biggest single step, divided by the step an even ramp would have taken', 'math'],
      ['the reading', 'yours, taken off the finished chart before anything was named', 'you'],
      ['the explanation', 'Cajal, reading only the numbers this run produced, and only if you ask', 'ai'],
    ],
  },
  {
    id: 'potassium',
    short: 'When excitement leads to silence',
    usesBrain: false,
    predict: {
      kind: 'choice',
      prompt:
        'A neuron sits in about 5 mM of potassium. Every spike pushes a little more of it out into the narrow space around the cell, and hard firing can outrun the glia and capillaries that clear it. Raising it from 2 to 30 mM moves the cell closer to its firing threshold — so what does the firing rate do?',
      options: [
        { id: 'up', label: 'climbs the whole way: nearer threshold at every step, until the channels cannot go faster' },
        { id: 'down', label: 'falls the whole way: the gradient the cell runs on is being flattened' },
        { id: 'both', label: 'climbs at first, then stops dead: too depolarised to fire at all' },
      ],
      correct: 'both',
    },
    observe: {
      headline: 'Fifteen points, and the axis is full. Read it before anything is named.',
      prompt: 'The climb from 75 Hz to 100 Hz takes seven points. Look at what the line does immediately after that peak, at 14 mM.',
      options: [
        { id: 'ease', label: 'it eases back down, point by point' },
        { id: 'stop', label: 'it stops dead: 100 Hz, then nothing' },
        { id: 'hold', label: 'it holds at 100 Hz for the rest of the sweep' },
      ],
      correct: 'stop',
    },
    runLabel: 'run 15 simulations',
    runNote: 'Fifteen runs of one neuron, one at each concentration. A single cell is far cheaper than 85 regions, so all fifteen are computed at once and then revealed one at a time, so the shape can be watched arriving.',
    setup: [
      ['varies', 'potassium outside one neuron, fifteen values from 2 to 30 mM in steps of 2; a resting brain sits near 5 mM'],
      ['held still', 'every other concentration and permeability, the temperature, and the current step driving the cell'],
      ['measured', 'firing rate in Hz, spikes per second; the resting voltage drawn fainter behind it'],
      ['one point', 'one Hodgkin–Huxley run at that concentration, its resting potential from the Goldman–Hodgkin–Katz equation, integrated in 0.01 ms steps'],
      ['the chart', 'potassium along the bottom, firing rate up the side; the concentration at which the cell falls silent is marked after the last point'],
    ],
    ledger: [
      ['the hypothesis', 'yours, committed before the calculation ran', 'you'],
      ['the equilibrium potentials', 'the Goldman–Hodgkin–Katz equation, solved at every concentration', 'math'],
      ['the spikes and currents', 'the Hodgkin–Huxley equations, integrated in steps of 0.01 ms', 'math'],
      ['the reading', 'yours, taken off the finished chart before anything was named', 'you'],
      ['the explanation', 'Cajal, working strictly from the parameters this run generated', 'ai'],
    ],
  },
  {
    id: 'dose',
    short: 'Dimmer switch or circuit breaker?',
    usesBrain: true,
    predict: {
      kind: 'choice',
      prompt:
        'You will give a benzodiazepine, which strengthens inhibition, to a generalised seizure; and caffeine, which blocks adenosine, to a brain in deep sleep. One of the two barely moves the brain dose after dose and then flips it into another state altogether. Which one is the circuit breaker?',
      options: [
        { id: 'benzodiazepine', label: 'the benzodiazepine: the seizure holds, then breaks all at once' },
        { id: 'caffeine', label: 'caffeine: deep sleep holds, then the brain snaps awake' },
        { id: 'neither', label: 'neither: both ease their state along, dose by dose' },
      ],
      correct: 'caffeine',
    },
    observe: {
      headline: 'Both curves are drawn. Read them before anything is named.',
      prompt:
        'One of them has been stepping steadily downwards since the very first dose. The other sits almost flat across the left half of the axis and then falls nearly the whole way down between two neighbouring doses, around a dose of 0.75. Which one is the cliff?',
      options: [
        { id: 'benzodiazepine', label: 'the benzodiazepine is the cliff' },
        { id: 'caffeine', label: 'caffeine is the cliff' },
      ],
      correct: 'caffeine',
    },
    runLabel: 'run this dose sweep',
    runStep: 'step 2 · run both sweeps',
    runNote: 'Two sweeps, run one at a time from the menu: nine doses of the benzodiazepine on a seizing brain, then nine of caffeine on a sleeping one, or the other way round. About ten seconds each. Both curves land on the same axes.',
    emptyNote: 'Nothing to compare yet. After the first sweep there is one number; after both, you will be asked which curve is the cliff before anything is named.',
    setup: [
      ['varies', 'the dose, nine values from none (0) to one and a half times the clinical reference (1.5); 1.0 is a typical clinical effect, not milligrams'],
      ['two sweeps', 'a benzodiazepine on a generalised seizure, and caffeine on deep sleep, each on its own brain; both curves land on one pair of axes'],
      ['held still', 'the state being treated and the random seed, so along a curve only the dose differs'],
      ['measured', 'synchrony, 0 to 1; a seizure and deep sleep both sit high and waking sits low, so both curves should come down. The question is how.'],
      ['one point', 'one complete simulation of 85 regions for 1.2 s, about a second; nine per drug'],
    ],
    ledger: [
      ['the hypothesis', 'yours, committed before either curve existed', 'you'],
      ['the two drug models', "multipliers on the model's parameters, set by hand from what each drug does at its receptor", 'math'],
      ['nine doses per drug', 'nine complete simulations of 85 coupled regions each; no AI touches these numbers', 'math'],
      ['the sharpness score', 'measured, not judged: the biggest single step, divided by the step an even ramp would have taken', 'math'],
      ['the explanation', 'Cajal, reading the two curves you produced, and only if you ask', 'ai'],
    ],
  },
  {
    id: 'transfer',
    short: 'Would a real-brain AI recognise ours?',
    usesBrain: false,
    predict: {
      kind: 'choice',
      prompt: 'Four simulated states, turned into scalp EEG. How many will it place correctly?',
      options: [
        { id: 'all', label: 'all four: the structure transfers' },
        { id: 'some', label: 'two or three: partly' },
        { id: 'none', label: 'none: a simulation will not fool it' },
      ],
      correct: 'all',
    },
    runLabel: 'run the closed-loop benchmark',
    runNote: 'Opens the EEG benchmark tab and runs the loop there, through the local model service. About ten seconds. This tab keeps your prediction and shows the verdict when the result comes back.',
    setup: [
      ['the instrument', 'LaBraM, a neural network trained on about 2,500 hours of real human EEG; it has never been shown a simulation'],
      ['the input', 'four simulated states from the same 85-region model, projected onto 19 scalp electrodes as EEG'],
      ['measured', 'how many of the four LaBraM tells apart from the EEG alone, and how many a blind second model names from the automated reading'],
      ['needs', 'the local relay and model service; without them the button stays locked and this tab says so'],
    ],
    ledger: [
      ['the hypothesis', 'yours', 'you'],
      ['the four states', 'designed by a language model, which is the only part of the test it touches', 'ai'],
      ['the simulations', 'the same 85-region model as everywhere else in the studio', 'math'],
      ['the scalp EEG', 'a distance-kernel forward projection onto 19 electrodes: arithmetic', 'math'],
      ['reading the EEG', 'LaBraM, a neural network trained on real human recordings', 'ai'],
      ['naming the state', 'a second language model, shown only the automated analysis and never the answer', 'ai'],
      ['the score', 'arithmetic', 'math'],
    ],
  },
];

/* ── state kept per investigation ────────────────────────────────────────── */

interface InvState {
  guess?: number;
  choice?: string;
  /** the answer to `spec.shape`, when the investigation asks for one */
  shape?: string;
  ran: boolean;
  runId?: string | null;
  /** the registration still in flight: the ask button waits for it */
  pending?: Promise<string | null>;
  /** investigation three accumulates one sharpness per drug */
  sharpness: Record<string, number>;
  /** investigation three keeps each finished curve so both can be drawn on one pair of axes */
  curves: Record<string, { xs: number[]; sync: Array<number | null>; at: number | null }>;
  /** what the reader READ off the finished chart, before anything was revealed */
  observed?: string;
  /** the finished sweep, so the verdict survives leaving the tab and the observation gate can rebuild it */
  brainSweep?: BrainSweep;
  neuronSweep?: NeuronSweep;
  benchmark?: { labramAccuracy: number; judgeAccuracy: number; pass: boolean; overallConfidence: number; states: number };
}

export function startInvestigations(host: InvestigationHost): Investigations {
  const nav = $('inv-nav');
  const body = $('inv-body');
  const state = new Map<string, InvState>();
  for (const s of SPECS) state.set(s.id, { ran: false, sharpness: {}, curves: {} });
  let currentId = SPECS[0]!.id;
  let running = false;

  /* ── the scaffold every investigation shares ───────────────────────────── */

  interface Built {
    canvas: HTMLCanvasElement;
    status: HTMLElement;
    verdict: HTMLElement;
    actions: HTMLElement;
    runBtn: HTMLButtonElement;
    runStep: HTMLElement;
  }

  function build(spec: Spec, st: InvState, onPredict: () => void, onRun: () => void): Built {
    body.replaceChildren();
    const c = copyFor(spec.id);
    body.append(el('h2', 'inv-q', c.question));
    body.append(el('p', 'inv-why', c.why));

    /* beside the steps: what the experiment is, then who does what. Both
       are facts about the instrument rather than about the result, so both
       are there before anything runs — that is the point of them */
    const about = $('inv-about');
    about.replaceChildren();
    const head = el('div', 'panel-head');
    head.append(el('h2', undefined, 'The experiment'), el('span', 'label', `investigation ${SPECS.indexOf(spec) + 1}`));
    about.append(head);
    const setup = el('dl', 'keyed inv-setup');
    for (const [k, v] of spec.setup) setup.append(el('dt', undefined, k), el('dd', undefined, v));
    about.append(setup);

    /* step one: commit to an answer */
    const pStep = el('div', 'inv-step');
    pStep.append(el('span', 'label', 'step 1 · predict'));
    if (spec.shape) {
      // the shape first, the number second: a slider landing near the right
      // value while the reader expects a straight line is a lucky guess, not
      // a prediction, and the two halves separate those cases
      pStep.append(el('p', 'caption', spec.shape.prompt));
      const row = el('div', 'predict-row');
      for (const opt of spec.shape.options) {
        const b = el('button', 'btn', opt.label) as HTMLButtonElement;
        b.setAttribute('aria-pressed', String(st.shape === opt.id));
        b.addEventListener('click', () => {
          st.shape = opt.id;
          for (const other of row.querySelectorAll('button')) other.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-pressed', 'true');
          onPredict();
        });
        row.append(b);
      }
      pStep.append(row);
    }
    pStep.append(el('p', 'caption', spec.predict.prompt));
    if (spec.predict.kind === 'value') {
      const wrap = el('div', 'guess-wrap');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.predict.min);
      input.max = String(spec.predict.max);
      input.step = String(spec.predict.step);
      input.value = String(st.guess ?? spec.predict.start);
      const out = document.createElement('output');
      const fmt = spec.predict.fmt;
      out.textContent = fmt(Number(input.value));
      const commit = el('button', 'btn') as HTMLButtonElement;
      commit.textContent = st.guess === undefined ? 'lock it in' : 'locked in';
      commit.setAttribute('aria-pressed', String(st.guess !== undefined));
      input.addEventListener('input', () => {
        out.textContent = fmt(Number(input.value));
        commit.textContent = 'lock it in';
        commit.setAttribute('aria-pressed', 'false');
      });
      commit.addEventListener('click', () => {
        st.guess = Number(input.value);
        commit.textContent = 'locked in';
        commit.setAttribute('aria-pressed', 'true');
        onPredict();
      });
      wrap.append(input, out, commit);
      pStep.append(wrap);
    } else {
      const row = el('div', 'predict-row');
      for (const opt of spec.predict.options) {
        const b = el('button', 'btn', opt.label) as HTMLButtonElement;
        b.setAttribute('aria-pressed', String(st.choice === opt.id));
        b.addEventListener('click', () => {
          st.choice = opt.id;
          for (const other of row.querySelectorAll('button')) other.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-pressed', 'true');
          onPredict();
        });
        row.append(b);
      }
      pStep.append(row);
    }
    body.append(pStep);

    /* step two: run it */
    const runStep = el('div', 'inv-step');
    runStep.append(el('span', 'label', spec.runStep ?? 'step 2 · run the simulation'));
    runStep.append(el('p', 'caption', spec.runNote));
    const runBtn = el('button', 'btn primary', spec.runLabel) as HTMLButtonElement;
    const actions = el('div', 'inv-actions');
    actions.append(runBtn);
    runBtn.addEventListener('click', onRun);
    runStep.append(actions);
    const canvas = document.createElement('canvas');
    canvas.className = 'sweep';
    canvas.setAttribute('aria-label', 'the sweep: one simulation per point');
    runStep.append(canvas);
    const status = el('p', 'sweep-status', '');
    runStep.append(status);
    body.append(runStep);

    /* step three: what happened */
    const vStep = el('div', 'inv-step');
    vStep.append(el('span', 'label', 'step 3 · compare and understand'));
    const verdict = el('div');
    vStep.append(verdict);
    body.append(vStep);

    /* who did what, under the setup rows */
    const ledger = el('dl', 'ledger');
    for (const [what, who, kind] of spec.ledger) {
      const dt = el('dt');
      dt.append(el('span', `badge ${kind === 'you' ? 'math' : kind}`, kind === 'you' ? 'you' : kind === 'ai' ? 'AI' : 'math'), document.createTextNode(` ${what}`));
      ledger.append(dt, el('dd', undefined, who));
    }
    const foot = el('div', 'inv-about-foot');
    foot.append(el('span', 'label', 'who does what'));
    foot.append(ledger);
    about.append(foot);

    const committed = spec.predict.kind === 'value' ? st.guess !== undefined : st.choice !== undefined;
    const locked = committed && (!spec.shape || st.shape !== undefined);
    runBtn.disabled = !locked || running;
    if (!locked) runStep.classList.add('locked');
    return { canvas, status, verdict, actions, runBtn, runStep };
  }

  /** the regimes a brain sweep passed through, read off the points */
  function regimeBands(points: BrainSweepPoint[]): Array<{ from: number; to: number; label: string; color: string }> {
    const classify = regimeOf;
    const colour: Record<string, string> = {
      saturated: 'rgba(255,79,216,0.10)',
      'seizure-like': 'rgba(255,106,61,0.13)',
      silent: 'rgba(154,164,178,0.10)',
      ordinary: 'rgba(53,214,255,0.07)',
    };
    const out: Array<{ from: number; to: number; label: string; color: string }> = [];
    for (let i = 0; i < points.length; i++) {
      const k = classify(points[i]!);
      const last = out[out.length - 1];
      if (last && last.label === k) last.to = points[i]!.value;
      else out.push({ from: points[i]!.value, to: points[i]!.value, label: k, color: colour[k]! });
    }
    return out.filter((b) => b.to > b.from);
  }

  /**
   * What just happened, in words, with the timing after it in the machine's
   * voice. The line used to be timings and a seed note and nothing else,
   * which told a reader who had just watched eleven points land what it had
   * cost and not what it was.
   */
  const setStatus = (status: HTMLElement, plain: string, mono?: string): void => {
    status.replaceChildren(document.createTextNode(plain));
    if (mono) status.append(document.createTextNode(' '), el('span', 'mono', mono));
  };
  const emptyVerdict = (spec: Spec): HTMLElement => el('p', 'caption', spec.emptyNote ?? EMPTY_NOTE);

  const numbers = (rows: Array<[string, string]>): HTMLElement => {
    const d = el('div', 'numbers');
    for (const [k, v] of rows) {
      const s = el('span');
      s.append(document.createTextNode(`${k} `), el('b', undefined, v));
      d.append(s);
    }
    return d;
  };

  /**
   * `make` is a function, not a string, because the run id usually arrives a
   * second or two after the curve does. Asking without it sends a question
   * about brains in general; asking with it sends a question about the run
   * this student just produced, which is the entire point.
   */
  /** the scribe's prose for one investigation */
  const copyFor = (id: string) => INVESTIGATE.investigations.find((x) => x.id === id)!;

  /**
   * The explanation, appended once the model has answered. It is written and
   * checked as prose in src/lib/copy.ts rather than assembled here, because
   * it is the part a reader actually reads and it has to survive editing by
   * someone who is not reading TypeScript.
   */
  function explain(box: HTMLElement, id: string): void {
    const c = copyFor(id);
    for (const m of c.mechanism) {
      const para = el('p');
      para.append(el('b', undefined, `${m.title}. `), document.createTextNode(m.body));
      box.append(para);
    }
    const lim = el('p');
    lim.append(el('b', undefined, 'What this does not show. '), document.createTextNode(c.limits));
    box.append(lim);
  }

  /**
   * PREDICT → OBSERVE → EXPLAIN, and the answer is the LAST of the three.
   * Printing the verdict and the whole mechanism the instant a sweep ended
   * turned a discovery into a graded test with the answer written underneath
   * it: a reader who guessed wrong was corrected before they had looked at
   * anything. So between the run and the answer the page asks what the reader
   * SEES in the chart they just made, and holds back the verdict, the
   * mechanism and the ask-Cajal button until they say.
   *
   * Returns true while the gate is still closed, which is the caller's signal
   * to show the box and stop. Every question here is answerable from the
   * chart alone — it is a reading, not a second guess.
   */
  function observationGate(spec: Spec, st: InvState, box: HTMLElement, again: () => void): boolean {
    if (!spec.observe || st.observed !== undefined) return false;
    box.append(el('span', 'headline', spec.observe.headline));
    box.append(el('p', undefined, spec.observe.prompt));
    const row = el('div', 'predict-row');
    for (const opt of spec.observe.options) {
      const b = el('button', 'btn', opt.label) as HTMLButtonElement;
      b.addEventListener('click', () => {
        st.observed = opt.id;
        again();
      });
      row.append(b);
    }
    box.append(row);
    return true;
  }

  /** what the reader read off the chart, as the first line of the reveal */
  function readingLine(spec: Spec, st: InvState, right: string, wrong: string): HTMLElement {
    const hit = st.observed === spec.observe?.correct;
    const p = el('p');
    p.append(el('b', undefined, hit ? 'What you read off the chart. ' : 'Look at the chart once more. '), document.createTextNode(hit ? right : wrong));
    return p;
  }

  const askButton = (label: string, make: () => string | Promise<string>): HTMLButtonElement => {
    const b = el('button', 'btn', label) as HTMLButtonElement;
    b.append(el('span', 'badge ai', 'AI'));
    b.disabled = !host.live;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        host.ask(await make());
      } finally {
        b.disabled = !host.live;
      }
    });
    return b;
  };

  /**
   * A finished brain sweep, drawn from the sweep object rather than from the
   * arrays the live loop fills in as points land. `runBrainSweep` paints the
   * same picture at the end of a run; this is how a reader who left the tab,
   * or who has just answered the observation question, gets it back without
   * integrating 85 regions all over again.
   */
  function drawFinishedBrainSweep(
    canvas: HTMLCanvasElement,
    sweep: BrainSweep,
    o: { xLabel: string; guess?: { x: number; label: string } | null },
  ): void {
    const xs = sweep.points.map((p) => p.value);
    drawSweepChart(canvas, {
      xs,
      series: [
        { label: 'synchrony', values: sweep.points.map((p) => p.synchrony), color: COL.primary },
        { label: 'mean activity', values: sweep.points.map((p) => p.mean), color: COL.secondary, secondary: true },
      ],
      xLabel: o.xLabel,
      yLabel: '0 – 1',
      filled: xs.length,
      yRange: [0, 1],
      guess: o.guess ?? null,
      marker: sweep.transition ? { x: sweep.transition.at, label: `turns at ${sweep.transition.at.toFixed(2)}` } : null,
      bands: regimeBands(sweep.points),
    });
  }

  /* ── investigation one and three: a whole-brain sweep ──────────────────── */

  async function runBrainSweep(
    spec: Record<string, unknown>,
    built: Built,
    opts: { xLabel: string; title: string; guess?: { x: number; label: string } | null },
  ): Promise<BrainSweep> {
    running = true;
    built.runBtn.disabled = true;
    const steps = Number(spec.steps ?? 11);
    const xs: number[] = [];
    const from = Number(spec.from ?? 0);
    const to = Number(spec.to ?? 1);
    for (let i = 0; i < steps; i++) xs.push(from + ((to - from) * i) / (steps - 1));
    const sync: Array<number | null> = new Array(steps).fill(null);
    const mean: Array<number | null> = new Array(steps).fill(null);
    const series: SweepSeries[] = [
      { label: 'synchrony', values: sync, color: COL.primary },
      { label: 'mean activity', values: mean, color: COL.secondary, secondary: true },
    ];
    const draw = (filled: number, marker?: { x: number; label: string } | null, bands?: ReturnType<typeof regimeBands>) =>
      drawSweepChart(built.canvas, { xs, series, xLabel: opts.xLabel, yLabel: '0 – 1', filled, guess: opts.guess ?? null, marker: marker ?? null, yRange: [0, 1], bands });
    draw(0);

    // where the time actually goes, so a slow sweep can be diagnosed rather
    // than guessed at; the breakdown is shown only with ?debug in the URL
    const spent = { compute: 0, chart: 0, brain: 0, frame: 0 };
    // started before the first point, so the wall figure can never read lower
    // than the model time it contains
    const wall0 = performance.now();
    let points: BrainSweepPoint[] = [];
    let lastRegime = '';
    /* The points are simulated on a worker (src/lib/sim.ts) and arrive here
       one at a time. `spent.compute` is no longer this thread's cost — the
       model runs while the chart below is being drawn — so it is measured as
       the wait for the next point, which is what a reader waits for. */
    const pace = paintPacer();
    let waiting = performance.now();
    const sweep = await sweepBrain(spec as never, async (step) => {
      spent.compute += performance.now() - waiting;
      sync[step.index] = step.point.synchrony;
      mean[step.index] = step.point.mean;
      points = [...points, step.point];
      const regime = regimeOf(step.point);
      setStatus(built.status, `Simulation ${step.index + 1} of ${step.total}.`, `${opts.xLabel} ${step.point.value} → synchrony ${step.point.synchrony.toFixed(2)} · ${regime}`);
      let t = performance.now();
      draw(step.index + 1, null, regimeBands(points));
      spent.chart += performance.now() - t;
      // Redrawing the whole brain costs far more than simulating a point, and
      // eleven near-identical brains teach nothing. Redraw when the system
      // actually changes regime, which is the moment worth looking at.
      const changed = regime !== lastRegime;
      if (changed || step.index === step.total - 1) {
        lastRegime = regime;
        t = performance.now();
        host.showBrainRun(step.run, step.summary, `${opts.title} · ${opts.xLabel} = ${step.point.value} · ${regime}`);
        spent.brain += performance.now() - t;
      }
      t = performance.now();
      // a new regime is held so it can be seen; frames only while painting
      if ((await pace.handOver()) && changed) await pace.dwell(REGIME_DWELL_MS);
      spent.frame += performance.now() - t;
      waiting = performance.now();
    });
    draw(steps, sweep.transition ? { x: sweep.transition.at, label: `turns at ${sweep.transition.at.toFixed(2)}` } : null, regimeBands(sweep.points));
    let timing = `${(sweep.computeMs / 1000).toFixed(1)} s in the model, ${((performance.now() - wall0) / 1000).toFixed(1)} s with drawing`;
    if (location.search.includes('debug')) {
      timing += ` · [waiting for points ${(spent.compute / 1000).toFixed(1)}s · chart ${(spent.chart / 1000).toFixed(1)}s · brain ${(spent.brain / 1000).toFixed(1)}s · frames ${(spent.frame / 1000).toFixed(1)}s]`;
    }
    setStatus(
      built.status,
      `Done: ${steps} simulations, one at each value of ${opts.xLabel}, each a complete run of the 85-region model. The same random seed every time, so ${opts.xLabel} is the only thing that differs between two points.`,
      timing,
    );
    running = false;
    return sweep;
  }

  /* ── rendering each investigation ──────────────────────────────────────── */

  function renderTipping(): void {
    const spec = SPECS[0]!;
    const st = state.get(spec.id)!;
    const built = build(spec, st, render, () => void go());
    const guessMark = () => (st.guess === undefined ? null : { x: st.guess, label: `you said ${st.guess.toFixed(2)}` });

    /* the axes are drawn before anything runs, so the reader knows what
       they are predicting on; the prediction joins them as a line before
       there is any data to contradict it — that is the whole point of
       committing to it first */
    if (!st.brainSweep) {
      drawSweepChart(built.canvas, {
        xs: [0.7, 1.2], series: [{ label: 'synchrony', values: [], color: COL.primary }], xLabel: 'inhibition', yLabel: '0 – 1', filled: 0, yRange: [0, 1],
        guess: guessMark(),
      });
    }
    /* a finished sweep survives leaving the tab, and the observation gate
       rebuilds the verdict in place rather than re-running the model */
    if (st.brainSweep) {
      drawFinishedBrainSweep(built.canvas, st.brainSweep, { xLabel: 'inhibition', guess: guessMark() });
      setStatus(built.status, 'Run earlier this session: 11 simulations, one at each strength of inhibition, the same random seed every time.');
    }
    showVerdict();

    function refreshActions(): void {
      built.actions.replaceChildren(built.runBtn);
      if (st.brainSweep && st.observed !== undefined) built.actions.append(askButton('ask Cajal why', makeQuestion));
    }

    async function makeQuestion(): Promise<string> {
      const at = st.brainSweep?.transition?.at ?? 0.93;
      const id = st.runId ?? (await st.pending) ?? null;
      return id
        ? `Inspect the sweep run ${id} I just made on the Investigate tab: inhibition varied from 0.7 to 1.2 on the awake brain with everything else held still. Explain the mechanism behind the transition it found at ${at.toFixed(2)}, and why synchrony falls again at the lowest inhibition instead of rising further.`
        : 'Sweep inhibition from 0.7 to 1.2 on the awake brain and explain the transition you find, and why synchrony falls again at the lowest values instead of rising further.';
    }

    function showVerdict(): void {
      const sweep = st.brainSweep;
      if (!sweep) { built.verdict.replaceChildren(emptyVerdict(spec)); refreshActions(); return; }
      const box = el('div', 'verdict-box');
      if (observationGate(spec, st, box, showVerdict)) {
        built.verdict.replaceChildren(box);
        refreshActions();
        return;
      }

      const t = sweep.transition;
      const at = t?.at ?? 0;
      const sharp = t ? t.sharpness : 1;
      const step = 0.05;
      const near = st.guess !== undefined && Math.abs(st.guess - at) <= step + 0.011;
      box.dataset.hit = String(st.shape === spec.shape?.correct && near);
      box.append(el('span', 'headline', `The quiet state does not degrade. It disappears — at inhibition ${at.toFixed(2)}, with a sharpness of ${sharp.toFixed(1)}×.`));
      box.append(
        numbers([
          ['turns at', at.toFixed(2)],
          ['sharpness', `${sharp.toFixed(1)}×`],
          ['synchrony', `${sweep.range[0].toFixed(2)} → ${sweep.range[1].toFixed(2)}`],
          ['monotone', sweep.monotone ? 'yes' : 'no'],
          ['you said', st.guess === undefined ? '—' : st.guess.toFixed(2)],
        ]),
      );
      box.append(
        readingLine(
          spec, st,
          'Synchrony reaches its highest around inhibition 0.80 and then falls back to about 0.66 below it, while mean activity climbs to 0.99. A population pinned against the ceiling of its own activation curve has no room left to swing, and a rhythm needs room: the seizure does not get worse as the last of the brake goes, it stops being a rhythm at all.',
          'It falls back. Synchrony is at its highest at an inhibition of 0.80 and drops to roughly 0.66 below that, while mean activity climbs to 0.99 — the far left of this chart is not a worse seizure, it is a cortex pinned flat against its own ceiling, with no room left to oscillate.',
        ),
      );
      const shapeSaid = el('p');
      shapeSaid.append(
        el('b', undefined, 'Your prediction, the shape. '),
        document.createTextNode(
          st.shape === 'cliff'
            ? `You said the brake holds and then the quiet state is gone. That is what a sharpness of ${sharp.toFixed(1)} measures: a straight line scores 1, and here nearly the whole change arrived inside a single step of the sweep.`
            : st.shape === 'ramp'
              ? `You said it degrades steadily. A steady decline would score a sharpness of 1; this scored ${sharp.toFixed(1)}. From 1.00 to 0.95 synchrony moved from 0.01 to 0.03 — which is nothing — and the very next step took it to 0.93.`
              : 'You said any cortex below its normal inhibition is already seizing. At 0.95, with five per cent of the brake gone, synchrony is 0.03: an ordinary waking cortex. The margin is real, and having a margin is exactly what makes losing it abrupt.',
        ),
      );
      box.append(shapeSaid);
      const numSaid = el('p');
      numSaid.append(
        el('b', undefined, 'Your prediction, the number. '),
        document.createTextNode(
          st.guess === undefined
            ? `The model turns at ${at.toFixed(2)}.`
            : `You said ${st.guess.toFixed(2)}; the model turns at ${at.toFixed(2)}${near ? ', within one step of the sweep' : ` — the sweep steps by ${step.toFixed(2)}, so that is ${Math.round(Math.abs(st.guess - at) / step)} steps away`}.`,
        ),
      );
      box.append(numSaid);
      explain(box, 'tipping');
      built.verdict.replaceChildren(box);
      refreshActions();
    }

    async function go(): Promise<void> {
      const base = presetById('awake')!.brain!;
      const spc = { base, variable: 'inhibition', from: 0.7, to: 1.2, steps: 11, duration_ms: 1200, measure: 'synchrony', seed: 1 };
      const sweep = await runBrainSweep(spc, built, { xLabel: 'inhibition', title: 'Losing inhibition', guess: guessMark() });
      st.ran = true;
      st.brainSweep = sweep;
      showVerdict();
      built.runBtn.textContent = 'run it again';
      built.runBtn.disabled = false;
      renderNav();
      st.pending = host.registerSweep('brain', spc, 'Investigation · losing inhibition').then((id) => { st.runId = id; return id; });
    }
  }

  function renderPotassium(): void {
    const spec = SPECS[1]!;
    const st = state.get(spec.id)!;
    const built = build(spec, st, render, () => void go());
    const X = 'potassium outside the cell (mM)';

    /** the finished neuron sweep: firing rate, with the resting voltage behind it */
    const seriesFor = (sweep: NeuronSweep): SweepSeries[] => [
      { label: 'firing rate (Hz)', values: sweep.points.map((p) => p.rate_hz), color: COL.primary },
      { label: 'resting mV (scaled)', values: sweep.points.map((p) => (p.rest_mv + 90) * 1.2), color: COL.warm, secondary: true },
    ];
    const silentFrom = (sweep: NeuronSweep) => sweep.points.find((p) => p.rate_hz === 0 && p.value > 8) ?? null;
    const drawFinished = (sweep: NeuronSweep): void => {
      const silent = silentFrom(sweep);
      drawSweepChart(built.canvas, {
        xs: sweep.points.map((p) => p.value), series: seriesFor(sweep), xLabel: X, yLabel: 'firing rate (Hz)',
        filled: sweep.points.length,
        marker: silent ? { x: silent.value, label: `silent from ${silent.value} mM` } : null,
      });
    };

    if (st.neuronSweep) {
      drawFinished(st.neuronSweep);
      setStatus(built.status, 'Run earlier this session: 15 runs of one neuron, one at each concentration.');
    } else {
      // the axes first, so the prediction is made on a chart and not on a black box
      drawSweepChart(built.canvas, { xs: [2, 30], series: [{ label: 'firing rate (Hz)', values: [], color: COL.primary }], xLabel: X, yLabel: 'firing rate (Hz)', filled: 0, yRange: [0, 110] });
    }
    showVerdict();

    function refreshActions(): void {
      built.actions.replaceChildren(built.runBtn);
      if (!st.neuronSweep || st.observed === undefined) return;
      built.actions.append(askButton('ask Cajal why', makeQuestion));
      const b = el('button', 'btn', 'see the same shape in the brain') as HTMLButtonElement;
      b.addEventListener('click', () => { currentId = 'tipping'; render(); });
      built.actions.append(b);
    }

    async function makeQuestion(): Promise<string> {
      const silent = st.neuronSweep ? silentFrom(st.neuronSweep) : null;
      const id = st.runId ?? (await st.pending) ?? null;
      return id
        ? `Inspect the sweep run ${id} I just made on the Investigate tab: external potassium varied from 2 to 30 mM on one neuron. Use the Goldman equation to explain why firing first increases, and explain what makes it stop entirely from ${silent?.value ?? 16} mM.`
        : 'Sweep external potassium from 2 to 30 mM on one neuron and explain, with the Goldman equation and sodium channel inactivation, why firing first rises and then stops entirely.';
    }

    function showVerdict(): void {
      const sweep = st.neuronSweep;
      if (!sweep) { built.verdict.replaceChildren(emptyVerdict(spec)); refreshActions(); return; }
      const box = el('div', 'verdict-box');
      if (observationGate(spec, st, box, showVerdict)) {
        built.verdict.replaceChildren(box);
        refreshActions();
        return;
      }

      const silent = silentFrom(sweep);
      const fastest = sweep.points.reduce((a, b) => (b.rate_hz > a.rate_hz ? b : a));
      const spiking = sweep.points.filter((p) => p.peak_mv !== null);
      const tallest = spiking.reduce((a, b) => (b.peak_mv! > a.peak_mv! ? b : a), spiking[0]!);
      const last = spiking.at(-1)!;
      box.dataset.hit = String(st.choice === 'both');
      box.append(el('span', 'headline', `It speeds up, and then it stops dead: ${fastest.rate_hz.toFixed(0)} Hz at ${fastest.value} mM, nothing from ${silent ? silent.value : '—'} mM.`));
      box.append(
        numbers([
          ['resting voltage', `${sweep.points[0]!.rest_mv.toFixed(0)} → ${sweep.points.at(-1)!.rest_mv.toFixed(0)} mV`],
          ['fastest at', `${fastest.value} mM (${fastest.rate_hz.toFixed(0)} Hz)`],
          ['silent from', silent ? `${silent.value} mM` : '—'],
          ['tallest spike', `+${tallest.peak_mv!.toFixed(0)} mV at ${tallest.value} mM`],
          ['last spike', `+${last.peak_mv!.toFixed(0)} mV at ${last.value} mM`],
        ]),
      );
      box.append(
        readingLine(
          spec, st,
          `It stops dead. The rate climbs 75, 87.5, 100 Hz and the very next point is zero, with every point after it zero too — at ${last.value} mM the cell manages two spikes and then nothing at all.`,
          `Look at ${last.value} mM. The line does not slope downwards from the peak: it lands on zero and stays there for the remaining ${sweep.points.length - sweep.points.indexOf(last) - 1} points. At ${last.value} mM the cell manages two spikes and then nothing.`,
        ),
      );
      const said = el('p');
      said.append(
        el('b', undefined, 'Your prediction. '),
        document.createTextNode(
          st.choice === 'both'
            ? `You said it would climb and then stop, and it does: ${fastest.rate_hz.toFixed(0)} Hz at ${fastest.value} mM, silent from ${silent ? silent.value : '—'}.`
            : st.choice === 'up'
              ? 'You said it would climb the whole way, and for seven points it does — the reasoning is right and it is the same reasoning that ends it. Resting closer to threshold makes the cell fire more readily; held there, the sodium channels that make a spike never reset.'
              : 'You said it would fall the whole way. It does not: the first thing extra potassium does is make the cell easier to excite, and the rate rises from 75 Hz to 100 Hz before anything goes wrong. The failure is not a weakened gradient — it is a membrane held too depolarised to spike.',
        ),
      );
      box.append(said);
      explain(box, 'potassium');
      built.verdict.replaceChildren(box);
      refreshActions();
    }

    async function go(): Promise<void> {
      running = true;
      built.runBtn.disabled = true;
      const spc = { field: 'K_out', from: 2, to: 30, steps: 15, measure: 'rate_hz' };
      const sweep: NeuronSweep = sweepNeuron(spc as never);
      const xs = sweep.points.map((p) => p.value);
      const series = seriesFor(sweep);
      // fast to compute, so reveal it point by point: the shape is the finding
      const pace = paintPacer();
      for (let i = 1; i <= xs.length; i++) {
        drawSweepChart(built.canvas, { xs, series, xLabel: X, yLabel: 'firing rate (Hz)', filled: i });
        setStatus(built.status, `Point ${i} of ${xs.length}.`, `K⁺ ${xs[i - 1]} mM · rest ${sweep.points[i - 1]!.rest_mv.toFixed(0)} mV · ${sweep.points[i - 1]!.rate_hz.toFixed(0)} Hz`);
        await pace.handOver();
      }
      drawFinished(sweep);
      setStatus(
        built.status,
        'Done: 15 runs of one neuron, one at each concentration, everything else about the cell held still. A single cell is far cheaper than 85 regions, so all fifteen were computed before the first point was drawn.',
        `${(sweep.computeMs / 1000).toFixed(2)} s in the model`,
      );
      st.ran = true;
      st.neuronSweep = sweep;
      running = false;
      showVerdict();
      built.runBtn.textContent = 'run it again';
      built.runBtn.disabled = false;
      renderNav();
      st.pending = host.registerSweep('neuron', spc, 'Investigation · potassium and one neuron').then((id) => { st.runId = id; return id; });
    }
  }

  /* ── investigation three: two dose curves, compared ────────────────────── */

  /**
   * The two sweeps this investigation is made of. Each is a real state from
   * the preset list and a real treatment from `medications.ts`; the colour is
   * the one the curve is drawn in, so the legend, the menu and the prose all
   * name the same thing.
   */
  const DOSE_DRUGS = [
    { id: 'benzodiazepine', menu: 'a benzodiazepine on a generalised seizure', name: 'the benzodiazepine', Name: 'The benzodiazepine', preset: 'seizure', title: 'A benzodiazepine for a seizure', legend: 'benzodiazepine · seizure', color: COL.primary },
    { id: 'caffeine', menu: 'caffeine during deep sleep', name: 'caffeine', Name: 'Caffeine', preset: 'deep-sleep', title: 'Caffeine in deep sleep', legend: 'caffeine · deep sleep', color: COL.warm },
  ] as const;

  function renderDose(): void {
    const spec = SPECS[2]!;
    const st = state.get(spec.id)!;
    const built = build(spec, st, render, () => void go(pick.value));
    // one source for which curve is the cliff: the same field the prediction
    // is graded against, so the reveal can never disagree with step one
    const correct = spec.predict.kind === 'choice' ? spec.predict.correct : 'caffeine';
    const ran = (id: string) => st.curves[id] !== undefined;
    const doneCount = () => DOSE_DRUGS.filter((d) => ran(d.id)).length;

    /* which sweep to run: the menu always offers the one still missing */
    const pick = document.createElement('select');
    pick.setAttribute('aria-label', 'which dose sweep to run');
    for (const d of DOSE_DRUGS) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.menu;
      pick.append(o);
    }
    built.actions.replaceChildren(pick, built.runBtn);
    built.runBtn.textContent = 'run this dose sweep';
    const progress = el('p', 'caption', '');
    built.actions.after(progress);

    function refreshMenu(): void {
      for (const d of DOSE_DRUGS) {
        const o = pick.querySelector(`option[value="${d.id}"]`);
        if (o) o.textContent = ran(d.id) ? `${d.menu} — run` : d.menu;
      }
      const missing = DOSE_DRUGS.find((d) => !ran(d.id));
      if (missing) pick.value = missing.id;
      const n = doneCount();
      progress.textContent =
        n === 0
          ? 'Two sweeps make this experiment. Each one gives the drug at nine doses, from none to half again the clinical reference, and every dose is a complete simulation of all 85 regions. Run them in either order.'
          : n === 1
            ? 'One sweep done, one to go. The second curve is drawn on the same axes as the first, so the two shapes can be compared rather than remembered.'
            : 'Both sweeps are on the axes below: synchrony against dose, nine simulations each, the same random seed throughout, so the only difference along a curve is the dose.';
    }
    refreshMenu();

    /** both finished curves on one pair of axes — the comparison IS the experiment */
    function drawCurves(): void {
      const have = DOSE_DRUGS.filter((d) => ran(d.id));
      if (!have.length) return;
      const xs = st.curves[have[0]!.id]!.xs;
      drawSweepChart(built.canvas, {
        xs,
        series: have.map((d) => ({ label: d.legend, values: st.curves[d.id]!.sync, color: d.color })),
        xLabel: 'dose',
        yLabel: 'synchrony',
        filled: xs.length,
        yRange: [0, 1],
      });
    }

    /**
     * Three stages, not one: one curve measured, both curves drawn and read
     * (`observationGate`), then the answer. This is the only investigation
     * whose finding is a COMPARISON, so a verdict after a single sweep would
     * be a number with nothing to be a number against.
     */
    function showVerdict(): void {
      const n = doneCount();
      if (n === 0) { built.verdict.replaceChildren(emptyVerdict(spec)); refreshActions(); return; }
      const box = el('div', 'verdict-box');

      if (n < DOSE_DRUGS.length) {
        const d = DOSE_DRUGS.find((x) => ran(x.id))!;
        const other = DOSE_DRUGS.find((x) => !ran(x.id))!;
        box.append(el('span', 'headline', `${d.Name}: sharpness ${(st.sharpness[d.id] ?? 1).toFixed(1)}×. One number is not a comparison.`));
        box.append(
          numbers([
            [d.id, `${(st.sharpness[d.id] ?? 1).toFixed(1)}×`],
            ['this curve turns at', st.curves[d.id]!.at === null ? '—' : st.curves[d.id]!.at!.toFixed(2)],
            [other.id, 'not run'],
          ]),
        );
        box.append(
          el(
            'p',
            undefined,
            'Sharpness is the biggest single step in the curve divided by the step an even ramp across the same total change would have taken, so a straight line scores 1. What it means here depends entirely on the other curve: run ' +
              `${other.name} and compare the two shapes.`,
          ),
        );
        built.verdict.replaceChildren(box);
        refreshActions();
        return;
      }

      if (observationGate(spec, st, box, showVerdict)) {
        built.verdict.replaceChildren(box);
        refreshActions();
        return;
      }

      /* the reveal: what the curves are, what the reader saw, what they predicted */
      const benzo = st.sharpness.benzodiazepine ?? 1;
      const caff = st.sharpness.caffeine ?? 1;
      box.dataset.hit = String(st.choice === correct);
      box.append(el('span', 'headline', `Caffeine is the circuit breaker: ${caff.toFixed(1)}× against the benzodiazepine's ${benzo.toFixed(1)}×.`));
      box.append(
        numbers([
          ['benzodiazepine', `${benzo.toFixed(1)}×`],
          ['caffeine', `${caff.toFixed(1)}×`],
          ['caffeine turns at', st.curves.caffeine?.at == null ? '—' : st.curves.caffeine.at.toFixed(2)],
          ['you read the cliff as', DOSE_DRUGS.find((d) => d.id === st.observed)?.name ?? '—'],
        ]),
      );

      box.append(
        readingLine(
          spec, st,
          'Caffeine holds deep sleep near a synchrony of 0.9 across the first half of the dose range and then drops to roughly 0.1 in a single step, while the benzodiazepine comes down in followable stages the whole way.',
          'The cliff is caffeine’s: it holds deep sleep near a synchrony of 0.9 across the first half of the dose range and then drops to roughly 0.1 in one step. The benzodiazepine comes down in stages — 0.96, 0.76, 0.54, 0.40 — which is what a dimmer switch looks like on a chart.',
        ),
      );

      const said = el('p');
      said.append(
        el('b', undefined, 'Your prediction. '),
        document.createTextNode(
          st.choice === correct
            ? 'You said caffeine before either curve existed, and the curves agree.'
            : st.choice === 'benzodiazepine'
              ? 'You said the benzodiazepine, which is the reasonable guess: a seizure is the more violent of the two states, so it sounds like the more all-or-nothing one. But the shape belongs to the state being treated. The seizure’s severity varies continuously with how far inhibition has fallen below its critical value, so it can be walked back a step at a time. Deep sleep cannot: it is a cycle that either regenerates itself or stops.'
              : 'You said both would change smoothly. The benzodiazepine does, at a sharpness near 2. Caffeine does not: nearly all of its effect arrives inside one step of the sweep.',
        ),
      );
      box.append(said);

      explain(box, 'dose');
      built.verdict.replaceChildren(box);
      refreshActions();
    }

    /**
     * The ask button appears only once the reveal has happened. Cajal reading
     * the curve aloud beforehand would hand over exactly what the observation
     * step is asking the reader to find for themselves.
     */
    function refreshActions(): void {
      built.actions.replaceChildren(pick, built.runBtn);
      if (doneCount() === DOSE_DRUGS.length && st.observed) built.actions.append(askButton('ask Cajal why', makeQuestion));
    }

    /* what has already been run survives leaving the tab and coming back */
    if (doneCount() > 0) {
      drawCurves();
      setStatus(built.status, `${doneCount() * 9} simulations so far, nine per drug, the same random seed every time, so along a curve the dose is the only thing that differs.`);
    } else {
      // the axes first: dose along the bottom, synchrony up the side, before either curve exists
      drawSweepChart(built.canvas, { xs: [0, 1.5], series: [{ label: 'synchrony', values: [], color: COL.primary }], xLabel: 'dose', yLabel: 'synchrony', filled: 0, yRange: [0, 1] });
    }
    showVerdict();

    async function makeQuestion(): Promise<string> {
      const id = st.runId ?? (await st.pending) ?? null;
      return id
        ? `Inspect the dose sweep run ${id} I just made on the Investigate tab. I ran a benzodiazepine on a generalised seizure and caffeine on deep sleep, from no dose to 1.5, nine doses each. The benzodiazepine scored a sharpness of ${(st.sharpness.benzodiazepine ?? 1).toFixed(1)} and caffeine ${(st.sharpness.caffeine ?? 1).toFixed(1)}, where a straight line scores 1. Explain why one dose-response is gradual and the other is a threshold, and what a clinician would take from the difference.`
        : 'Sweep the dose of a benzodiazepine in a generalised seizure and of caffeine in deep sleep, and explain why one dose-response is gradual and the other is a threshold.';
    }

    async function go(id: string): Promise<void> {
      const d = DOSE_DRUGS.find((x) => x.id === id) ?? DOSE_DRUGS[0]!;
      const base = presetById(d.preset)!.brain!;
      const spc = { base, variable: 'dose', treatment: d.id, from: 0, to: 1.5, steps: 9, duration_ms: 1200, measure: 'synchrony', seed: 1 };
      const sweep = await runBrainSweep(spc, built, { xLabel: 'dose', title: d.title });
      st.sharpness[d.id] = sweep.transition?.sharpness ?? 1;
      st.curves[d.id] = {
        xs: sweep.points.map((p) => p.value),
        sync: sweep.points.map((p) => p.synchrony),
        at: sweep.transition?.at ?? null,
      };
      // one curve is half an experiment, so the nav does not call it done yet
      st.ran = doneCount() === DOSE_DRUGS.length;
      // the second curve joins the first rather than replacing it: the
      // comparison is the finding, and it cannot be made from memory
      if (doneCount() === DOSE_DRUGS.length) drawCurves();
      refreshMenu();
      showVerdict();
      built.runBtn.disabled = false;
      renderNav();
      st.pending = host.registerSweep('brain', spc, `Investigation · ${d.id} dose`).then((rid) => { st.runId = rid; return rid; });
    }
  }

  function renderTransfer(): void {
    const spec = SPECS[3]!;
    const st = state.get(spec.id)!;
    const built = build(spec, st, render, () => {
      host.switchTab('bench');
      host.runBenchmark();
    });
    built.canvas.remove();
    built.status.replaceChildren();
    built.runBtn.textContent = 'run the closed-loop benchmark';
    /* the loop runs through the relay and the model service. With neither,
       the benchmark tab's own button is disabled and `runLoop` returns
       without a word — so this button must not send the reader there to
       press nothing. A missing service is marked on the control that needs
       it (knowledge/01), not discovered by a click that does nothing. */
    if (!host.live) {
      built.runBtn.disabled = true;
      built.runBtn.title = 'needs the local relay and model service, which this build does not have';
      setStatus(built.status, 'This build has no relay, so the benchmark cannot run here. Your prediction is kept; the button unlocks in a build with the local services up.');
    }

    if (st.benchmark) {
      const b = st.benchmark;
      const got = Math.round(b.labramAccuracy * b.states);
      const said = st.choice === 'all' ? b.states : st.choice === 'some' ? 2.5 : 0.5;
      const hit = Math.abs(got - said) <= 1;
      const box = el('div', 'verdict-box');
      box.dataset.hit = String(hit);
      box.append(el('span', 'headline', `LaBraM placed ${got} of ${b.states} correctly.`));
      box.append(
        numbers([
          ['LaBraM', `${Math.round(b.labramAccuracy * 100)}%`],
          ['blind judge', `${Math.round(b.judgeAccuracy * 100)}%`],
          ['confidence', `${Math.round(b.overallConfidence * 100)}%`],
          ['verdict', b.pass ? 'pass' : 'fail'],
        ]),
      );
      explain(box, 'transfer');
      built.verdict.replaceChildren(box);
      built.actions.replaceChildren(
        built.runBtn,
        askButton('ask Cajal what an embedding is', () => 'Inspect the benchmark run I just made. In it, LaBraM turned each EEG recording into an embedding and the states were told apart from those embeddings. Explain in plain language what an embedding is, how the separability was measured, and what it would have meant if LaBraM had scored at chance.'),
      );
    } else {
      built.verdict.replaceChildren(el('p', 'caption', 'No benchmark run yet in this session. Lock in a prediction, then run it.'));
    }
  }

  /* ── nav and dispatch ──────────────────────────────────────────────────── */

  function renderNav(): void {
    nav.replaceChildren();
    SPECS.forEach((s, i) => {
      const st = state.get(s.id)!;
      const b = el('button') as HTMLButtonElement;
      b.setAttribute('aria-selected', String(s.id === currentId));
      b.append(el('span', 'n', `investigation ${i + 1}`));
      b.append(document.createTextNode(s.short));
      const predicted = s.predict.kind === 'value' ? st.guess !== undefined : st.choice !== undefined;
      if (st.ran || st.benchmark) b.append(el('span', 'done', ' ✓ done'));
      else if (predicted) b.append(el('span', 'done', ' · predicted'));
      b.addEventListener('click', () => { currentId = s.id; render(); });
      nav.append(b);
    });
  }

  function render(): void {
    renderNav();
    const spec = SPECS.find((s) => s.id === currentId)!;
    host.moveStage(spec.usesBrain ? 'inv-stage-slot' : null);
    if (currentId === 'tipping') renderTipping();
    else if (currentId === 'potassium') renderPotassium();
    else if (currentId === 'dose') renderDose();
    else renderTransfer();
    body.append(
      el(
        'p',
        'inv-foot',
        'Every curve here is the same 85-region model, or the same single-neuron equations, that the other tabs run. Nothing is precomputed and nothing is drawn from a lookup table: the points appear as fast as your machine can integrate them.',
      ),
    );
  }

  return {
    show(): void {
      render();
    },
    onBenchmarkResult(r): void {
      const st = state.get('transfer')!;
      st.benchmark = r;
      st.ran = true;
      if (currentId === 'transfer') render();
      else renderNav();
    },
  };
}
