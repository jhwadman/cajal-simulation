/**
 * src/lib/markdown.ts — the subset of Markdown an answer uses, rendered as
 * DOM nodes. No innerHTML anywhere: every piece of text becomes a text node,
 * so model output can never become markup.
 *
 * Supported: paragraphs, headings (rendered as bold lead lines), bullet and
 * numbered lists, **bold**, *italic*, `code`, fenced code blocks, and run
 * ids (wb-…, mc-…, eeg-…, bench-…) as clickable chips when a handler is
 * given. Anything else is plain text.
 */

/* Every prefix `PREFIX` in service/runs.ts issues, and no more: a prefix the
   agent may quote that is missing here renders as plain text and the reader
   cannot click through to the run it names, while one listed here that
   `showRun()` cannot open gives them a chip that goes nowhere. Both halves are
   the rule in knowledge/03-agent-and-tools.md. */
const RUN_ID = /\b(wb|mc|eeg|fmri|sc|img|nr|sw|bench)-[0-9a-f]{6}\b/g;

export function renderMarkdown(text: string, onRun?: (id: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  const flushPara = (buf: string[]) => {
    if (!buf.length) return;
    const p = document.createElement('p');
    inline(p, buf.join(' '), onRun);
    frag.append(p);
    buf.length = 0;
  };
  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara(para);
      i++;
      continue;
    }
    if (trimmed.startsWith('```')) {
      flushPara(para);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i]!), i++;
      i++;
      const pre = document.createElement('pre');
      pre.textContent = code.join('\n');
      frag.append(pre);
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara(para);
      const p = document.createElement('p');
      const b = document.createElement('strong');
      inline(b, heading[1]!, onRun);
      p.append(b);
      frag.append(p);
      i++;
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara(para);
      const list = document.createElement(numbered ? 'ol' : 'ul');
      while (i < lines.length) {
        const t = lines[i]!.trim();
        const b = t.match(/^[-*•]\s+(.*)$/);
        const n = t.match(/^(\d+)[.)]\s+(.*)$/);
        if (!(numbered ? n : b)) break;
        const li = document.createElement('li');
        inline(li, (numbered ? n![2] : b![1])!, onRun);
        list.append(li);
        i++;
        // a wrapped continuation line belongs to the item
        while (i < lines.length && lines[i]!.trim() && !/^([-*•]|\d+[.)])\s/.test(lines[i]!.trim())) {
          li.append(document.createTextNode(' '));
          inline(li, lines[i]!.trim(), onRun);
          i++;
        }
      }
      frag.append(list);
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flushPara(para);
  return frag;
}

/** inline marks: **bold**, *italic*, `code`, run ids */
function inline(parent: HTMLElement, text: string, onRun?: (id: string) => void): void {
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const emitText = (s: string) => {
    if (!s) return;
    if (!onRun) {
      parent.append(document.createTextNode(s));
      return;
    }
    let l = 0;
    let r: RegExpExecArray | null;
    RUN_ID.lastIndex = 0;
    while ((r = RUN_ID.exec(s))) {
      parent.append(document.createTextNode(s.slice(l, r.index)));
      const chip = document.createElement('button');
      chip.className = 'run-ref';
      chip.textContent = r[0];
      chip.title = 'show this run';
      const id = r[0];
      chip.addEventListener('click', () => onRun(id));
      parent.append(chip);
      l = r.index + r[0].length;
    }
    parent.append(document.createTextNode(s.slice(l)));
  };
  while ((m = re.exec(text))) {
    emitText(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = tok.slice(2, -2);
      parent.append(b);
    } else if (tok.startsWith('`')) {
      const c = document.createElement('code');
      c.textContent = tok.slice(1, -1);
      parent.append(c);
    } else {
      const em = document.createElement('em');
      em.textContent = tok.slice(1, -1);
      parent.append(em);
    }
    last = m.index + tok.length;
  }
  emitText(text.slice(last));
}
