/**
 * TVAgent — the conversation surface.
 *
 * Owns the message list and the run trace. A run's tool calls collapse into one
 * "3 actions" row rather than three stacked boxes: on an ordinary day nobody
 * opens them, and three boxes per turn buries the answer.
 */
window.TVAgentChat = (() => {
  'use strict';

  /** Top-level rows kept on screen. The model's own history is not affected. */
  const MAX_ROWS = 300;

  /** Per tool call, in the trace. get_series_data alone returns ~300 bars. */
  const MAX_BLOB_CHARS = 2000;

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  /**
   * The whole of the markup the panel renders: fenced blocks, which streamer()
   * turns into <pre><code>, and inline code, which is this. Nothing else — a
   * model answer is prose, and a full markdown renderer here would be a much
   * larger surface for something to go wrong on.
   */
  const inlineCode = (text) => esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>');

  /**
   * Nobody reads a 40KB JSON blob in a collapsed trace row, and the panel pays
   * for every character of it on every scroll.
   */
  const clip = (text) =>
    text.length > MAX_BLOB_CHARS
      ? `${text.slice(0, MAX_BLOB_CHARS)}\n… ${text.length - MAX_BLOB_CHARS} more characters`
      : text;

  const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

  function create(listEl) {
    let assistantEl = null;
    let assistant = null; // the streaming renderer writing into assistantEl
    let thinkingEl = null;
    let runEl = null; // the collapsed activity row for the current run
    const tools = new Map();
    // Confirmation cards still waiting on the user. A run can end underneath
    // one — Stop, or New chat — and the promise it handed the agent has to be
    // settled, or the tool call awaiting it is parked for the life of the page.
    const openConfirms = new Set();

    const scroll = () => (listEl.scrollTop = listEl.scrollHeight);

    /**
     * A conversation that runs all afternoon otherwise grows a DOM node per
     * message forever, and the panel gets slower with every one of them.
     */
    function trimRows() {
      if (listEl.children.length <= MAX_ROWS) return;
      while (listEl.children.length > MAX_ROWS) listEl.removeChild(listEl.firstChild);
      const first = listEl.firstChild;
      if (first && first.className && first.className.indexOf('tva-trimmed') !== -1) return;
      // Say it once, rather than letting the top of the conversation vanish
      // with no explanation.
      const note = document.createElement('div');
      note.className = 'tva-msg notice tva-trimmed';
      note.textContent = 'Earlier messages are no longer shown here.';
      listEl.insertBefore(note, first);
    }

    function add(className, html) {
      const el = document.createElement('div');
      el.className = className;
      if (html != null) el.innerHTML = html;
      listEl.appendChild(el);
      trimRows();
      scroll();
      return el;
    }

    /**
     * Streams model text into one message element.
     *
     * Every delta used to re-render the whole message through innerHTML, which
     * is O(n²) over a turn and, on a long answer at streaming speed, the most
     * expensive thing the panel does. Text arrives in order, so only the
     * segment currently being written can still change: the ones before it are
     * closed nodes that are never touched again.
     */
    function streamer(el) {
      let tail = ''; // the segment being written
      let held = ''; // a partial fence, waiting for the rest of it
      let fenced = false;
      let node = null;

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
        if (fenced) node.firstChild.textContent = tail.replace(/^[a-zA-Z0-9_-]*\n/, '');
        else node.innerHTML = inlineCode(tail);
      }

      /** Text with no fence left in it, into the segment being written. */
      function write(chunk) {
        if (!chunk) return;
        tail += chunk;
        paint();
      }

      /**
       * Splits at every complete fence, then holds back a trailing run of one
       * or two backticks in case the next delta completes one.
       *
       * The order is the whole of it. Holding back first took two backticks off
       * the end of a fence that had arrived whole — "```" is a single token, so
       * it routinely arrives as its own delta — and left the third behind as
       * text. The fence was then split across `tail` and the next chunk, and
       * nothing ever looked across that seam again: the block never opened and
       * the answer rendered with its backticks showing.
       */
      function consume(chunk, last) {
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
        push(delta) {
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
      const done = runEl.querySelectorAll('.tva-call').length;
      const label = runEl.querySelector('.tva-run-label');
      label.textContent = done === 1 ? '1 action' : `${done} actions`;
    }

    /** Answers every card still on screen, so nothing is left awaiting one. */
    function settleConfirms() {
      const open = Array.from(openConfirms);
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

      notice: (text) => add('tva-msg notice', esc(text)),
      error: (text) => add('tva-msg error', esc(text)),
      user: (text) => add('tva-msg user', esc(text)),

      /** Called when a run starts, so the next tool call opens a fresh row. */
      startRun() {
        assistantEl = thinkingEl = runEl = null;
        assistant = null;
      },

      endRun() {
        settleConfirms();
        assistant?.flush();
        if (runEl) {
          runEl.querySelector('.tva-run-mark').classList.add('done');
          countActions();
        }
        assistantEl = thinkingEl = runEl = null;
        assistant = null;
      },

      onBlockStart(blockType) {
        if (blockType === 'text') {
          assistant?.flush();
          assistantEl = null;
          assistant = null;
        }
        if (blockType === 'thinking') thinkingEl = null;
      },

      onThinking(delta) {
        if (!thinkingEl) {
          const body = run().querySelector('.tva-run-body');
          thinkingEl = document.createElement('div');
          thinkingEl.className = 'tva-think';
          body.appendChild(thinkingEl);
        }
        thinkingEl.textContent += delta;
        scroll();
      },

      onText(delta) {
        if (!assistantEl) {
          assistantEl = add('tva-msg assistant', '');
          assistant = streamer(assistantEl);
        }
        assistant.push(delta);
        scroll();
      },

      onToolStart({ id, name, input }) {
        assistant?.flush();
        assistantEl = null;
        assistant = null;
        const body = run().querySelector('.tva-run-body');
        const call = document.createElement('div');
        call.className = 'tva-call';
        call.innerHTML =
          `<div class="tva-call-head"><span class="tva-call-name">${esc(name)}</span>` +
          '<span class="tva-call-status pending">running…</span></div>' +
          `<pre class="tva-call-body">${esc(clip(asText(input) || ''))}</pre>`;
        body.appendChild(call);
        tools.set(id, call);
        countActions();
        scroll();
      },

      onToolResult({ id, ok, result }) {
        const call = tools.get(id);
        if (!call) return;
        tools.delete(id);
        const status = call.querySelector('.tva-call-status');
        status.className = 'tva-call-status ' + (ok ? 'ok' : 'err');
        status.textContent = ok ? 'done' : 'failed';
        call.querySelector('.tva-call-body').textContent += '\n\n→ ' + clip(asText(result) || '');
        // A failure is the one thing worth unfolding without being asked.
        if (!ok && runEl) runEl.open = true;
        scroll();
      },

      onConfirm({ name, input }) {
        assistant?.flush();
        assistantEl = null;
        assistant = null;
        return new Promise((resolve) => {
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

          const finish = (allowed, word) => {
            openConfirms.delete(finish);
            el.querySelector('.tva-confirm-actions')?.remove();
            el.insertAdjacentHTML(
              'beforeend',
              `<div class="tva-confirm-outcome">${word || (allowed ? 'Allowed' : 'Denied')}</div>`
            );
            resolve(allowed);
          };
          openConfirms.add(finish);
          el.querySelector('[data-yes]').addEventListener('click', () => finish(true));
          el.querySelector('[data-no]').addEventListener('click', () => finish(false));
        });
      },
    };
  }

  return { create, esc };
})();
