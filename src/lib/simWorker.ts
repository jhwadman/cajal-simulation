/**
 * src/lib/simWorker.ts — the engine, off the main thread.
 *
 * This file adds NO model. It imports `service/engine/` and calls it, which
 * is the whole point: the engine is one truth drawn twice (the agent's tool
 * and the page's bench), and a worker is a third PLACE to run it, never a
 * third version of it. Every run here is seeded, so a run made in the worker
 * and the same run made on the main thread — or in the service — are the
 * same numbers.
 *
 * Why it exists: `simulateWholeBrain` is ~190 ms of arithmetic for 2 s of
 * brain time and ~710 ms for 10 s (85 regions, 1,190 edges, a step every
 * 0.5 ms). On the main thread that is a frozen tab — no rendering, no
 * scrolling, no input — and an Investigate sweep is up to 24 of them in a
 * row. Here it is a message.
 *
 * The protocol is request/response over ids. A sweep streams: the worker
 * keeps simulating while the page draws the point it already has, which is
 * the second reason for the move.
 */

import {
  simulateWholeBrain,
  summarizeWholeBrain,
  sweepBrainSteps,
  type WholeBrainParams,
  type BrainSweepSpec,
} from '../../service/engine/index.ts';

export type SimRequest =
  | { id: number; kind: 'brain'; params: WholeBrainParams }
  | { id: number; kind: 'sweep'; spec: BrainSweepSpec };

export type SimResponse =
  | { id: number; kind: 'brain'; run: unknown; summary: unknown }
  | { id: number; kind: 'sweep-step'; step: unknown }
  | { id: number; kind: 'sweep-done'; sweep: unknown }
  | { id: number; kind: 'error'; message: string };

/** the buffers worth moving rather than copying: the per-frame arrays */
function transfers(...arrays: unknown[]): Transferable[] {
  const out: Transferable[] = [];
  for (const a of arrays) if (ArrayBuffer.isView(a as ArrayBufferView)) out.push((a as ArrayBufferView).buffer as ArrayBuffer);
  return out;
}

const post = (msg: SimResponse, transfer: Transferable[] = []) => {
  (self as unknown as Worker).postMessage(msg, transfer);
};

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const req = e.data;
  try {
    if (req.kind === 'brain') {
      const run = simulateWholeBrain(req.params);
      const summary = summarizeWholeBrain(run);
      post(
        { id: req.id, kind: 'brain', run, summary },
        transfers(run.activity, summary.meanField, summary.synchronyTrace),
      );
      return;
    }
    if (req.kind === 'sweep') {
      // the engine's own generator, one loop shared with the service —
      // driven here rather than re-written
      const it = sweepBrainSteps(req.spec);
      let r = it.next();
      while (!r.done) {
        const step = r.value;
        post(
          { id: req.id, kind: 'sweep-step', step },
          transfers(step.run.activity, step.summary.meanField, step.summary.synchronyTrace),
        );
        r = it.next();
      }
      post({ id: req.id, kind: 'sweep-done', sweep: r.value });
      return;
    }
    post({ id: (req as { id: number }).id, kind: 'error', message: `unknown request: ${(req as { kind: string }).kind}` });
  } catch (err) {
    post({ id: (req as { id: number }).id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
