/**
 * TVAgent — the conversation surface.
 *
 * Owns the message list and the run trace. A run's tool calls collapse into
 * one "N actions" row.
 */

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

/**
 * The only markup the panel renders: fenced blocks (streamer) and inline
 * code. A model answer is prose; a full markdown renderer would be a far
 * larger surface.
 */
const inlineCode = (text: string) => esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>');

/** Nobody reads a 40KB blob in a collapsed trace row. */
const clip = (text: string) =>
  text.length > MAX_BLOB_CHARS
    ? `${text.slice(0, MAX_BLOB_CHARS)}\n… ${text.length - MAX_BLOB_CHARS} more characters`
    : text;

const asText = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/** Appends deltas to one element, splitting fenced blocks out as they arrive. */
interface Streamer {
  push(delta: unknown): void;
  flush(): void;
}

/** Resolves one confirmation card, whoever answers it. */
type ConfirmFinish = (allowed: boolean, word?: string) => void;

function create(listEl: HTMLElement) {
  let assistantEl: HTMLElement | null = null;
  let assistant: Streamer | null = null; // the renderer writing into assistantEl
  let thinkingEl: HTMLElement | null = null;
  let runEl: HTMLDetailsElement | null = null; // the collapsed activity row
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
   * Streams model text into one message element. Only the segment being
   * written can still change; the ones before it are closed nodes.
   */
  function streamer(el: HTMLElement): Streamer {
    let tail = ''; // the segment being written
    let held = ''; // a partial fence, waiting for the rest of it
    let fenced = false;
    let node: HTMLElement | null = null;

    function open() {
      node = document.createElement(fenced ? 'pre' : 'span');
      if (fenced) node.appendChild(document.createElement('code'));
      el.appendChild(node);
    }

    function paint() {
      if (!node) {
        if (!tail && !fenced) return;
        open();
      }
      if (fenced) node!.firstChild!.textContent = tail.replace(/^[a-zA-Z0-9_-]*\n/, '');
      else node!.innerHTML = inlineCode(tail);
    }

    /** Text with no fence left in it, into the segment being written. */
    function write(chunk: string) {
      if (!chunk) return;
      tail += chunk;
      paint();
    }

    /**
     * Splits at every complete fence, then holds back a trailing run of
     * one or two backticks in case the next delta completes one. Fences
     * first: "```" often arrives as its own delta.
     */
    function consume(chunk: string, last: boolean) {
      let rest = chunk;
      let cut;
      while ((cut = rest.indexOf('```')) !== -1) {
        write(rest.slice(0, cut));
        rest = rest.slice(cut + 3);
        fenced = !fenced;
        tail = '';
        node = null;
        paint();
      }
      if (!last) {
        const partial = /`{1,2}$/.exec(rest);
        if (partial) {
          held = partial[0];
          rest = rest.slice(0, rest.length - held.length);
        }
      }
      write(rest);
    }

    return {
      push(delta: unknown) {
        const rest = held + String(delta);
        held = '';
        consume(rest, false);
      },
      /** Whatever is still held back is literal after all. */
      flush() {
        if (!held) return;
        const rest = held;
        held = '';
        consume(rest, true);
      },
    };
  }

  /** One row per run, holding every tool call and every thinking block. */
  function run() {
    if (runEl) return runEl;
    const details = document.createElement('details');
    details.className = 'tva-run';
    details.innerHTML =
      '<summary><span class="tva-run-mark"></span>' +
      '<span class="tva-run-label">working…</span></summary>' +
      '<div class="tva-run-body"></div>';
    listEl.appendChild(details);
    runEl = details;
    trimRows();
    scroll();
    return details;
  }

  function countActions() {
    const row = run();
    const done = row.querySelectorAll('.tva-call').length;
    const label = row.querySelector('.tva-run-label');
    if (label) label.textContent = done === 1 ? '1 action' : `${done} actions`;
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
      assistant?.flush();
      listEl.innerHTML = '';
      assistantEl = thinkingEl = runEl = null;
      assistant = null;
      tools.clear();
    },

    notice: (text: unknown) => add('tva-msg notice', esc(text)),
    error: (text: unknown) => add('tva-msg error', esc(text)),
    user: (text: unknown) => add('tva-msg user', esc(text)),

    /** Called when a run starts, so the next tool call opens a fresh row. */
    startRun() {
      assistantEl = thinkingEl = runEl = null;
      assistant = null;
    },

    endRun() {
      settleConfirms();
      assistant?.flush();
      if (runEl) {
        runEl.querySelector('.tva-run-mark')?.classList.add('done');
        countActions();
      }
      assistantEl = thinkingEl = runEl = null;
      assistant = null;
    },

    onBlockStart(blockType: string) {
      if (blockType === 'text') {
        assistant?.flush();
        assistantEl = null;
        assistant = null;
      }
      if (blockType === 'thinking') thinkingEl = null;
    },

    onThinking(delta: string) {
      if (!thinkingEl) {
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'tva-think';
        run().querySelector('.tva-run-body')?.appendChild(thinkingEl);
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
      assistant?.flush();
      assistantEl = null;
      assistant = null;
      const call = document.createElement('div');
      call.className = 'tva-call';
      call.innerHTML =
        `<div class="tva-call-head"><span class="tva-call-name">${esc(name)}</span>` +
        '<span class="tva-call-status pending">running…</span></div>' +
        `<pre class="tva-call-body">${esc(clip(asText(input) || ''))}</pre>`;
      run().querySelector('.tva-run-body')?.appendChild(call);
      tools.set(id, call);
      countActions();
      scroll();
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
      if (!ok && runEl) runEl.open = true;
      scroll();
    },

    onConfirm({ name, input }: { name: string; input: unknown }) {
      assistant?.flush();
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
