/**
 * src/lib/trace.ts — what the AI actually did.
 *
 * The studio labels its panels "math" or "AI", but a label is a claim. This
 * is the evidence: for every answer, the route the model picked and why,
 * each tool it called, and for each run it made, the SETTINGS IT CHOSE laid
 * beside the NUMBERS THE EQUATIONS RETURNED.
 *
 * That pairing is the whole point. The language model decided to simulate a
 * seizure with inhibition at 0.9; it did not decide that the result would be
 * a synchrony of 0.96. A student who reads one trace understands the
 * division of labour better than one who reads a paragraph about it.
 *
 * Every string reaches the DOM through textContent or createElement.
 */

export type TraceEntry =
  | { kind: 'route'; route: string; reason: string }
  | { kind: 'tool'; name: string }
  | { kind: 'run'; runId: string; runKind: string; title: string; chose: Array<[string, string]>; got: Array<[string, string]> }
  | { kind: 'time'; ms: number };

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** a compact "chosen → computed" pair list */
function pairs(rows: Array<[string, string]>, cls: string): HTMLElement {
  const dl = el('dl', `trace-pairs ${cls}`);
  for (const [k, v] of rows) {
    dl.append(el('dt', undefined, k), el('dd', undefined, v));
  }
  return dl;
}

/**
 * Render the trace into `host`, replacing whatever was there. `onRun` opens a
 * run when its id is clicked.
 */
export function renderTrace(host: HTMLElement, entries: TraceEntry[], onRun: (id: string) => void): void {
  host.replaceChildren();
  if (!entries.length) return;
  const details = el('details', 'trace') as HTMLDetailsElement;
  const summary = el('summary');
  const tools = entries.filter((e) => e.kind === 'tool').length;
  const madeRuns = entries.filter((e) => e.kind === 'run').length;
  summary.append(
    el('span', 'badge ai', 'AI'),
    document.createTextNode(
      ` what Cajal did: ${tools} tool call${tools === 1 ? '' : 's'}${madeRuns ? `, ${madeRuns} run${madeRuns === 1 ? '' : 's'}` : ''}`,
    ),
  );
  details.append(summary);

  const ol = el('ol', 'trace-steps');
  for (const e of entries) {
    const li = el('li');
    if (e.kind === 'route') {
      li.append(el('b', undefined, 'chose a route'), document.createTextNode(`: ${e.route}${e.reason ? ` — ${e.reason}` : ''}`));
      li.append(el('span', 'who ai', 'the model decided this'));
    } else if (e.kind === 'tool') {
      li.append(el('b', undefined, 'called a tool'), document.createTextNode(`: ${e.name}`));
      li.append(el('span', 'who ai', 'the model decided this'));
    } else if (e.kind === 'time') {
      li.append(document.createTextNode(`finished in ${(e.ms / 1000).toFixed(1)} s`));
    } else {
      li.append(el('b', undefined, e.title || e.runKind));
      const ref = el('button', 'run-ref', e.runId) as HTMLButtonElement;
      ref.type = 'button';
      ref.addEventListener('click', () => onRun(e.runId));
      li.append(document.createTextNode(' '), ref);
      const grid = el('div', 'trace-grid');
      const left = el('div');
      left.append(el('span', 'who ai', 'settings the model chose'));
      left.append(e.chose.length ? pairs(e.chose, 'chose') : el('p', 'trace-none', 'the defaults'));
      const right = el('div');
      right.append(el('span', 'who math', 'numbers the equations returned'));
      right.append(e.got.length ? pairs(e.got, 'got') : el('p', 'trace-none', '—'));
      grid.append(left, right);
      li.append(grid);
    }
    ol.append(li);
  }
  details.append(ol);
  details.append(
    el(
      'p',
      'trace-foot',
      'The model picks what to run and how to describe it. It never produces the numbers: those come from the equations, and would be identical if you set the same knobs by hand.',
    ),
  );
  host.append(details);
}

/** the interesting settings of a whole-brain run, as text pairs */
export function choseFromParams(params: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!params) return [];
  const out: Array<[string, string]> = [];
  const KNOBS = ['excitability', 'inhibition', 'coupling', 'noise', 'adaptation', 'arousal'];
  for (const k of KNOBS) {
    const v = params[k];
    if (typeof v === 'number' && Math.abs(v - 1) > 1e-6) out.push([k, v.toFixed(2)]);
  }
  if (typeof params.duration_ms === 'number') out.push(['duration', `${params.duration_ms} ms`]);
  const stim = params.stimulation as Array<{ nodes?: number[]; frequency_hz?: number }> | undefined;
  if (stim?.length) out.push(['stimulation', `${stim.length} site${stim.length === 1 ? '' : 's'}${stim[0]?.frequency_hz ? ` at ${stim[0].frequency_hz} Hz` : ''}`]);
  const les = params.lesions as Array<{ nodes?: number[] }> | undefined;
  if (les?.length) out.push(['lesions', `${les.length}`]);
  const mods = params.modulators as Record<string, number> | undefined;
  if (mods) for (const [k, v] of Object.entries(mods)) if (typeof v === 'number' && Math.abs(v - 1) > 1e-6) out.push([k, v.toFixed(2)]);
  return out.slice(0, 8);
}
