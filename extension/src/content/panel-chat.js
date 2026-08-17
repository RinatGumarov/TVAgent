/**
 * TVAgent — the conversation surface.
 *
 * Owns the message list and the run trace. A run's tool calls collapse into
 * one "N actions" row.
 */
window.TVAgentChat = (() => {
  'use strict';

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  /** Deliberately minimal: fenced blocks and inline code, nothing else. */
  function renderText(text) {
    return String(text)
      .split(/```/)
      .map((part, i) => {
        if (i % 2 === 1) {
          return `<pre><code>${esc(part.replace(/^[a-zA-Z0-9_-]*\n/, ''))}</code></pre>`;
        }
        return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>');
      })
      .join('');
  }

  function create(listEl) {
    let assistantEl = null;
    let thinkingEl = null;
    let runEl = null; // the collapsed activity row for the current run
    const tools = new Map();

    const scroll = () => (listEl.scrollTop = listEl.scrollHeight);

    function add(className, html) {
      const el = document.createElement('div');
      el.className = className;
      if (html != null) el.innerHTML = html;
      listEl.appendChild(el);
      scroll();
      return el;
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
      scroll();
      return details;
    }

    function countActions() {
      const done = runEl.querySelectorAll('.tva-call').length;
      const label = runEl.querySelector('.tva-run-label');
      label.textContent = done === 1 ? '1 action' : `${done} actions`;
    }

    return {
      clear() {
        listEl.innerHTML = '';
        assistantEl = thinkingEl = runEl = null;
        tools.clear();
      },

      notice: (text) => add('tva-msg notice', esc(text)),
      error: (text) => add('tva-msg error', esc(text)),
      user: (text) => add('tva-msg user', esc(text)),

      /** Called when a run starts, so the next tool call opens a fresh row. */
      startRun() {
        assistantEl = thinkingEl = runEl = null;
      },

      endRun() {
        if (runEl) {
          runEl.querySelector('.tva-run-mark').classList.add('done');
          countActions();
        }
        assistantEl = thinkingEl = runEl = null;
      },

      onBlockStart(blockType) {
        if (blockType === 'text') assistantEl = null;
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
          assistantEl.dataset.raw = '';
        }
        assistantEl.dataset.raw += delta;
        assistantEl.innerHTML = renderText(assistantEl.dataset.raw);
        scroll();
      },

      onToolStart({ id, name, input }) {
        assistantEl = null;
        const body = run().querySelector('.tva-run-body');
        const call = document.createElement('div');
        call.className = 'tva-call';
        call.innerHTML =
          `<div class="tva-call-head"><span class="tva-call-name">${esc(name)}</span>` +
          '<span class="tva-call-status pending">running…</span></div>' +
          `<pre class="tva-call-body">${esc(JSON.stringify(input, null, 2))}</pre>`;
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
        const rendered = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        call.querySelector('.tva-call-body').textContent += '\n\n→ ' + rendered;
        // A failure is the one thing worth unfolding without being asked.
        if (!ok && runEl) runEl.open = true;
        scroll();
      },

      onConfirm({ name, input }) {
        assistantEl = null;
        return new Promise((resolve) => {
          const el = document.createElement('div');
          el.className = 'tva-confirm';
          el.innerHTML =
            `<div class="tva-confirm-head">Allow <b>${esc(name)}</b>?</div>` +
            `<pre class="tva-call-body">${esc(JSON.stringify(input, null, 2).slice(0, 600))}</pre>` +
            '<div class="tva-confirm-actions">' +
            '<button class="tva-btn primary" data-yes>Allow</button>' +
            '<button class="tva-btn" data-no>Deny</button></div>';
          listEl.appendChild(el);
          scroll();

          const finish = (allowed) => {
            el.querySelector('.tva-confirm-actions').remove();
            el.insertAdjacentHTML(
              'beforeend',
              `<div class="tva-confirm-outcome">${allowed ? 'Allowed' : 'Denied'}</div>`
            );
            resolve(allowed);
          };
          el.querySelector('[data-yes]').addEventListener('click', () => finish(true));
          el.querySelector('[data-no]').addEventListener('click', () => finish(false));
        });
      },
    };
  }

  return { create, esc, renderText };
})();
