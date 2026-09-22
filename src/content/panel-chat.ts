/**
 * TVAgent — the conversation surface.
 *
 * Owns the message list. Every tool call is its own row, always on screen;
 * its input and result, and the model's reasoning, unfold on a click.
 */

import { blocks, render } from './markdown';

/** Top-level rows kept on screen. The model's own history is not affected. */
const MAX_ROWS = 300;

/** Per tool call, in the trace. get_series_data alone returns ~300 bars. */
const MAX_BLOB_CHARS = 2000;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Nobody reads a 40KB blob in a tool row. */
const clip = (text: string) =>
  text.length > MAX_BLOB_CHARS
    ? `${text.slice(0, MAX_BLOB_CHARS)}\n… ${text.length - MAX_BLOB_CHARS} more characters`
    : text;

const asText = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/** Appends deltas to one element, rendered as markdown as they arrive. */
interface Streamer {
  push(delta: unknown): void;
}

/** Resolves one confirmation card, whoever answers it. */
type ConfirmFinish = (allowed: boolean, word?: string) => void;

function create(listEl: HTMLElement) {
  let assistantEl: HTMLElement | null = null;
  let assistant: Streamer | null = null; // the renderer writing into assistantEl
  let thinkingEl: HTMLElement | null = null;
  const tools = new Map<string, HTMLElement>();
  // Confirmation cards still waiting on the user; a run that ends has to
  // settle them.
  const openConfirms = new Set();

  const scroll = () => (listEl.scrollTop = listEl.scrollHeight);

  /**
   * A conversation that runs all afternoon would otherwise grow a node per
   * message forever.
   */
  function trimRows() {
    if (listEl.children.length <= MAX_ROWS) return;
    while (listEl.children.length > MAX_ROWS) listEl.removeChild(listEl.firstChild!);
    // A text node has no className, which is why this is guarded.
    const first = listEl.firstChild as (ChildNode & { className?: string }) | null;
    if (first && first.className && first.className.indexOf('tva-trimmed') !== -1) return;
    // Say it once, rather than letting the top of the conversation vanish
    // with no explanation.
    const note = document.createElement('div');
    note.className = 'tva-msg notice tva-trimmed';
    note.textContent = 'Earlier messages are no longer shown here.';
    listEl.insertBefore(note, first);
  }

  function add(className: string, html: string) {
    const el = document.createElement('div');
    el.className = className;
    if (html != null) el.innerHTML = html;
    listEl.appendChild(el);
    trimRows();
    scroll();
    return el;
  }

  /**
   * Streams model text into one message element. The whole answer is parsed
   * again on each delta, since a later line can change an earlier one; a
   * block that another has followed is closed, and its node is kept.
   */
  function streamer(el: HTMLElement): Streamer {
    let src = '';
    let shown: { key: string; node: Node }[] = [];

    return {
      push(delta: unknown) {
        src += String(delta);
        const next = blocks(src);
        let keep = 0;
        while (keep < shown.length && keep < next.length - 1 && shown[keep].key === next[keep].key)
          keep++;
        shown.slice(keep).forEach(({ node }) => el.removeChild(node));
        shown = shown.slice(0, keep);
        for (const block of next.slice(keep)) {
          const node = render(block);
          el.appendChild(node);
          shown.push({ key: block.key, node });
        }
      },
    };
  }

  /** A folded row in the list: a summary line over a body. */
  function row(className: string, summary: string, body: HTMLElement) {
    const details = document.createElement('details');
    details.className = className;
    details.innerHTML = `<summary>${summary}</summary>`;
    details.appendChild(body);
    listEl.appendChild(details);
    trimRows();
    scroll();
    return details;
  }

  /** Answers every card still on screen, so nothing is left awaiting one. */
  function settleConfirms() {
    const open = Array.from(openConfirms) as ConfirmFinish[];
    openConfirms.clear();
    open.forEach((finish) => finish(false, 'Stopped'));
  }

  return {
    clear() {
      settleConfirms();
      listEl.innerHTML = '';
      assistantEl = thinkingEl = null;
      assistant = null;
      tools.clear();
    },

    notice: (text: unknown) => add('tva-msg notice', esc(text)),
    error: (text: unknown) => add('tva-msg error', esc(text)),
    user: (text: unknown) => add('tva-msg user', esc(text)),

    startRun() {
      assistantEl = thinkingEl = null;
      assistant = null;
    },

    endRun() {
      settleConfirms();
      assistantEl = thinkingEl = null;
      assistant = null;
    },

    onBlockStart(blockType: string) {
      if (blockType === 'text') {
        assistantEl = null;
        assistant = null;
      }
      if (blockType === 'thinking') thinkingEl = null;
    },

    onThinking(delta: string) {
      if (!thinkingEl) {
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'tva-think-body';
        row('tva-think', 'Reasoning', thinkingEl);
      }
      thinkingEl.textContent += delta;
      scroll();
    },

    onText(delta: string) {
      if (!assistantEl) {
        assistantEl = add('tva-msg assistant', '');
        assistant = streamer(assistantEl);
      }
      assistant?.push(delta);
      scroll();
    },

    onToolStart({ id, name, input }: { id: string; name: string; input: unknown }) {
      assistantEl = null;
      assistant = null;
      thinkingEl = null;
      const body = document.createElement('pre');
      body.className = 'tva-call-body';
      body.textContent = clip(asText(input) || '');
      const call = row(
        'tva-call',
        `<span class="tva-call-name">${esc(name)}</span>` +
          '<span class="tva-call-status pending">running…</span>',
        body,
      );
      tools.set(id, call);
    },

    onToolResult({ id, ok, result }: { id: string; ok: boolean; result: unknown }) {
      const call = tools.get(id);
      if (!call) return;
      tools.delete(id);
      const status = call.querySelector('.tva-call-status');
      if (status) {
        status.className = 'tva-call-status ' + (ok ? 'ok' : 'err');
        status.textContent = ok ? 'done' : 'failed';
      }
      const body = call.querySelector('.tva-call-body');
      if (body) body.textContent += '\n\n→ ' + clip(asText(result) || '');
      // A failure is the one thing worth unfolding without being asked.
      if (!ok) (call as HTMLDetailsElement).open = true;
      scroll();
    },

    onConfirm({ name, input }: { name: string; input: unknown }) {
      assistantEl = null;
      assistant = null;
      return new Promise<boolean>((resolve) => {
        const el = document.createElement('div');
        el.className = 'tva-confirm';
        el.innerHTML =
          `<div class="tva-confirm-head">Allow <b>${esc(name)}</b>?</div>` +
          `<pre class="tva-call-body">${esc(clip(asText(input) || ''))}</pre>` +
          '<div class="tva-confirm-actions">' +
          '<button class="tva-btn primary" data-yes>Allow</button>' +
          '<button class="tva-btn" data-no>Deny</button></div>';
        listEl.appendChild(el);
        trimRows();
        scroll();

        const finish: ConfirmFinish = (allowed, word) => {
          openConfirms.delete(finish);
          el.querySelector('.tva-confirm-actions')?.remove();
          el.insertAdjacentHTML(
            'beforeend',
            `<div class="tva-confirm-outcome">${word || (allowed ? 'Allowed' : 'Denied')}</div>`,
          );
          resolve(allowed);
        };
        openConfirms.add(finish);
        el.querySelector('[data-yes]')?.addEventListener('click', () => finish(true));
        el.querySelector('[data-no]')?.addEventListener('click', () => finish(false));
      });
    },
  };
}

export { create, esc };
