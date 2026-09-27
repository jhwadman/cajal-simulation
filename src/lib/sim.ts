/**
 * src/lib/sim.ts — how the page asks for a simulation.
 *
 * One seam in front of `simWorker.ts`. Everything the page runs in the
 * browser goes through here, so there is exactly one place that knows
 * whether the arithmetic is happening on a worker thread or this one.
 *
 * The fallback is not a second engine: when a worker cannot be constructed
 * (an old browser, a file:// page, a locked-down context) the SAME engine
 * functions are called inline and the tab freezes the way it used to. The
 * numbers are identical either way — every run is seeded — so nothing a
 * reader sees depends on which path ran. That is invariant 1: the engine is
 * one truth, and this file chooses a thread, never a model.
 */

import {
  simulateWholeBrain,
  summarizeWholeBrain,
  sweepBrainSteps,
  type WholeBrainParams,
  type WholeBrainRun,
  type WholeBrainSummary,
  type BrainSweep,
  type BrainSweepSpec,
  type SweepStep,
} from '../../service/engine/index.ts';
import type { SimRequest, SimResponse } from './simWorker.ts';

export interface BrainResult { run: WholeBrainRun; summary: WholeBrainSummary }

/** a request before the seam stamps its id — distributive, so the union survives Omit */
type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never;

let worker: Worker | null | undefined; // undefined = not tried yet, null = unavailable
let nextId = 1;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    // `new URL(..., import.meta.url)` is how the bundler is told to emit the
    // worker as its own chunk from OUR origin. Invariant 10 — zero external
    // requests — holds: this is a same-origin file, not a CDN.
    worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('error', (e) => console.warn('simulation worker failed, falling back to the main thread:', e.message));
  } catch (err) {
    console.warn('no simulation worker; the model will run on the main thread:', err);
    worker = null;
  }
  return worker;
}

/** one request, one reply */
function ask<T>(req: Unsent<SimRequest>, take: (r: SimResponse, done: (v: T) => void, fail: (e: Error) => void) => void): Promise<T> {
  const w = getWorker()!;
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const done = (v: T) => { w.removeEventListener('message', onMsg); resolve(v); };
    const fail = (e: Error) => { w.removeEventListener('message', onMsg); reject(e); };
    const onMsg = (e: MessageEvent<SimResponse>) => {
      if (e.data.id !== id) return;
      if (e.data.kind === 'error') { fail(new Error(e.data.message)); return; }
      take(e.data, done, fail);
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ ...req, id } as SimRequest);
  });
}

/** integrate one whole-brain state */
export async function simulateBrain(params: WholeBrainParams): Promise<BrainResult> {
  if (!getWorker()) {
    const run = simulateWholeBrain(params);
    return { run, summary: summarizeWholeBrain(run) };
  }
  return ask<BrainResult>({ kind: 'brain', params }, (r, done) => {
    if (r.kind === 'brain') done({ run: r.run as WholeBrainRun, summary: r.summary as WholeBrainSummary });
  });
}

/**
 * One parameter varied across a range, streamed.
 *
 * `onStep` is awaited, so the page can draw a point and hand the browser a
 * frame before the next one is shown — but the worker does NOT wait for it.
 * Points arrive while the previous one is being drawn, which is why a sweep
 * on a worker finishes sooner than the sum of its parts.
 */
export async function sweepBrain(spec: BrainSweepSpec, onStep: (s: SweepStep) => void | Promise<void>): Promise<BrainSweep> {
  if (!getWorker()) {
    const it = sweepBrainSteps(spec);
    let r = it.next();
    while (!r.done) {
      await onStep(r.value);
      r = it.next();
    }
    return r.value;
  }
  const queue: SweepStep[] = [];
  let drain: Promise<void> = Promise.resolve();
  return ask<BrainSweep>({ kind: 'sweep', spec }, (r, done, fail) => {
    if (r.kind === 'sweep-step') {
      queue.push(r.step as SweepStep);
      // serialise the callbacks: the steps must be drawn in order, and each
      // gets its frame, however fast they arrive
      drain = drain.then(() => onStep(queue.shift()!));
      return;
    }
    if (r.kind === 'sweep-done') {
      const sweep = r.sweep as BrainSweep;
      // the sweep is finished when the last point has been DRAWN, not when
      // the last point was computed — but a throw while drawing must fail it
      // rather than leave the caller waiting on a promise nothing will settle
      void drain.then(() => done(sweep), (err) => fail(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
