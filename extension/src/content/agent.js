/**
 * TVAgent — agent runtime.
 *
 * The tool-use loop in the content script: it owns the conversation, asks the
 * background worker for model turns and dispatches tool calls to the page
 * driver. Every write to `messages` is tagged with the run it belongs to, so
 * a loop that was cancelled at an await cannot keep writing.
 */
window.TVAgentRuntime = (() => {
  'use strict';

  const MAX_ITERATIONS = 24;

  function systemPrompt(caps) {
    return `You are TVAgent, an assistant embedded in TradingView. You operate the user's chart directly through tools.

Current chart: ${caps.symbol || 'unknown'} on timeframe ${caps.resolution || 'unknown'}.
${caps.loggedIn ? '' : 'The user is NOT logged in to TradingView. Drawing tools will fail — tell them to log in if they ask for drawings.\n'}${caps.pine ? '' : 'The Pine Editor API is unavailable in this session — Pine tools are not offered.\n'}
How to work:
- Act on the chart rather than describing what the user could do. If they ask for EMAs, add them.
- Read before you write. get_chart_context tells you what is already there; get_series_data gives you the bars to compute levels from.
- Verify your own work from the values tools return. Do not claim a change landed if the tool said otherwise.
- Drawing needs real coordinates. Pull prices and times from get_series_data — never invent a timestamp.
- Timeframes are TradingView resolution strings: "60" is 1H, "240" is 4H, "D" is daily.
- For Pine: open_pine_editor (new script) → set_pine_code → add_pine_to_chart, then get_strategy_report for a strategy. If a script fails to compile, fix it and try again.

How to answer:
- Lead with the outcome. First sentence says what happened or what you found.
- Keep it brief and readable. No headers or bullet walls for a simple answer; complete sentences over arrow chains and abbreviations.
- Deliver what was asked at the scope intended. Make routine judgment calls yourself; ask only when different readings mean materially different work. Don't add indicators, drawings, or analysis nobody requested.
- You cannot place real orders and have no broker access. Say so plainly if asked.`;
  }

  class Agent {
    constructor(opts) {
      this.capabilities = opts.capabilities;
      this.handlers = opts.handlers || {};
      this.messages = [];
      this.running = false;
      this.cancelled = false;
      this.port = null;
      this.abortTurn = null;
    }

    get busy() { return this.running; }

    cancel() {
      if (!this.running) return;
      this.cancelled = true;
      if (this.port) { try { this.port.disconnect(); } catch (_) {} this.port = null; }
      // Disconnecting our own end never fires onDisconnect, so settle the
      // in-flight turn by hand or #loop() would await it forever.
      this.abortTurn?.(new Error('cancelled'));
      this.abortTurn = null;
      this.running = false;
      this.#closeDanglingToolCalls();
      this.handlers.onDone?.({ cancelled: true });
    }

    /**
     * Cancelling mid-execution can leave an assistant turn whose tool_use blocks
     * have no matching tool_result. The API rejects that on the next request, so
     * answer the orphans before the conversation continues.
     */
    #closeDanglingToolCalls() {
      const last = this.messages[this.messages.length - 1];
      if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;

      const calls = last.content.filter((b) => b.type === 'tool_use');
      if (calls.length === 0) return;

      // Tools that finished before the stop keep their real result; the rest
      // are answered as interrupted.
      const done = new Map((this.partialResults || []).map((r) => [r.tool_use_id, r]));
      this.messages.push({
        role: 'user',
        content: calls.map((call) => done.get(call.id) || {
          type: 'tool_result',
          tool_use_id: call.id,
          content: 'The user stopped the run before this tool executed.',
          is_error: true,
        }),
      });
      this.partialResults = null;
    }

    reset() {
      this.messages = [];
    }

    async send(userText) {
      if (this.running) return;
      this.messages.push({ role: 'user', content: userText });
      await this.#loop();
    }

    async #loop() {
      this.running = true;
      this.cancelled = false;

      try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          if (this.cancelled) return;

          const response = await this.#turn();
          if (this.cancelled) return;

          this.messages.push({ role: 'assistant', content: response.content });

          const toolUses = response.content.filter((b) => b.type === 'tool_use');
          if (toolUses.length === 0) {
            this.handlers.onDone?.({ stopReason: response.stop_reason });
            return;
          }

          const results = [];
          this.partialResults = results;
          for (const call of toolUses) {
            if (this.cancelled) return;
            results.push(await this.#runTool(call));
          }
          this.partialResults = null;
          this.messages.push({ role: 'user', content: results });
        }

        this.handlers.onError?.(
          new Error(`Stopped after ${MAX_ITERATIONS} steps without finishing. Try a narrower request.`)
        );
      } catch (err) {
        if (!this.cancelled) this.handlers.onError?.(err);
      } finally {
        this.running = false;
        this.port = null;
      }
    }

    /** One model turn, streamed from the background worker. */
    #turn() {
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'tvagent-llm' });
        this.port = port;
        this.abortTurn = reject;

        const settle = (fn) => {
          try { port.disconnect(); } catch (_) {}
          this.port = null;
          this.abortTurn = null;
          fn();
        };

        port.onMessage.addListener((msg) => {
          switch (msg.type) {
            case 'text':
              this.handlers.onText?.(msg.delta);
              break;
            case 'thinking':
              this.handlers.onThinking?.(msg.delta);
              break;
            case 'block_start':
              this.handlers.onBlockStart?.(msg.blockType);
              break;
            case 'done':
              settle(() => resolve(msg.message));
              break;
            case 'error':
              settle(() => reject(new Error(msg.error)));
              break;
          }
        });

        // Fires only if the worker goes away on its own — disconnecting our
        // own end does not trigger this listener.
        port.onDisconnect.addListener(() => {
          if (this.port !== port) return;
          settle(() => reject(new Error('Connection to the extension worker was lost.')));
        });

        port.postMessage({
          type: 'run',
          system: systemPrompt(this.capabilities),
          messages: this.messages,
          tools: window.TVAgentTools.forApi(this.capabilities),
        });
      });
    }

    async #runTool(call) {
      const level = window.TVAgentTools.levelOf(call.name);
      this.handlers.onToolStart?.({ id: call.id, name: call.name, input: call.input, level });

      // Level 2+ needs an explicit yes unless the user turned that off.
      if (level >= 2 && !this.handlers.autoApprove?.()) {
        const approved = await this.handlers.onConfirm?.({ name: call.name, input: call.input });
        if (!approved) {
          const denial = 'The user declined this action. Do not retry it; ask what they want instead.';
          this.handlers.onToolResult?.({ id: call.id, name: call.name, ok: false, result: denial });
          return { type: 'tool_result', tool_use_id: call.id, content: denial, is_error: true };
        }
      }

      try {
        const result = await window.TVAgentBridge.call(call.name, call.input);
        this.handlers.onToolResult?.({ id: call.id, name: call.name, ok: true, result });
        return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) };
      } catch (err) {
        const message = err?.message || String(err);
        this.handlers.onToolResult?.({ id: call.id, name: call.name, ok: false, result: message });
        return { type: 'tool_result', tool_use_id: call.id, content: `Error: ${message}`, is_error: true };
      }
    }
  }

  return { Agent };
})();
