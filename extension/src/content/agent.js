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
      this.port = null;
      this.abortTurn = null;
      this.partialResults = null;
    }

    /**
     * Which run is allowed to write. Bumped by anything that ends a run, so a
     * loop parked on an await can tell that it is no longer the one.
     */
    #run = 0;

    #stale(run) {
      return run !== this.#run;
    }

    cancel() {
      if (!this.running) return;
      // First, and synchronously: whatever the abandoned loop is parked on
      // resumes after this returns, and this is what tells it to stop.
      this.#run++;
      if (this.port) { try { this.port.disconnect(); } catch (_) { /* already disconnected */ } this.port = null; }
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

    /**
     * New chat. A run in flight ends first, or its next write would land at
     * the head of the empty history.
     */
    reset() {
      this.cancel();
      this.messages = [];
      this.partialResults = null;
    }

    async send(userText) {
      if (this.running) return;
      const run = ++this.#run;
      this.running = true;
      this.messages.push({ role: 'user', content: userText });
      await this.#loop(run);
    }

    async #loop(run) {
      try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          if (this.#stale(run)) return;

          const response = await this.#turn();
          if (this.#stale(run)) return;

          const content = response.content || [];
          const toolUses = content.filter((b) => b.type === 'tool_use');

          // The API rejects an assistant turn with empty content, so the run
          // ends here instead of recording one.
          if (content.length === 0) {
            this.handlers.onDone?.({ stopReason: response.stop_reason });
            return;
          }

          this.messages.push({ role: 'assistant', content });

          if (toolUses.length === 0) {
            this.handlers.onDone?.({ stopReason: response.stop_reason });
            return;
          }

          const results = [];
          this.partialResults = results;
          for (const call of toolUses) {
            if (this.#stale(run)) return;
            results.push(await this.#runTool(call, run));
          }
          // cancel() has already answered the batch through
          // #closeDanglingToolCalls.
          if (this.#stale(run)) return;
          this.partialResults = null;
          this.messages.push({ role: 'user', content: results });
        }

        this.handlers.onError?.(
          new Error(`Stopped after ${MAX_ITERATIONS} steps without finishing. Try a narrower request.`)
        );
      } catch (err) {
        if (!this.#stale(run)) this.handlers.onError?.(err);
      } finally {
        // Only for the current run: a cancel()+send() pair may already have
        // started a new loop.
        if (!this.#stale(run)) {
          this.running = false;
          this.port = null;
        }
      }
    }

    /** One model turn, streamed from the background worker. */
    #turn() {
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'tvagent-llm' });
        this.port = port;
        this.abortTurn = reject;

        const settle = (fn) => {
          try { port.disconnect(); } catch (_) { /* already disconnected */ }
          if (this.port === port) {
            this.port = null;
            this.abortTurn = null;
          }
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

    /** An answer for a tool that will not run, in the shape the API expects. */
    #refuse(call, message) {
      this.handlers.onToolResult?.({ id: call.id, name: call.name, ok: false, result: message });
      return { type: 'tool_result', tool_use_id: call.id, content: message, is_error: true };
    }

    async #runTool(call, run) {
      const tools = window.TVAgentTools;
      const tool = tools.get(call.name);
      const level = tool ? tool.level : 3;
      this.handlers.onToolStart?.({ id: call.id, name: call.name, input: call.input, level });

      // A name that is not in the tool list is not a tool, whatever its level
      // would have been.
      if (!tool) {
        return this.#refuse(call, `There is no tool called "${call.name}". Use one of the tools you were given.`);
      }
      if (!tools.isAvailable(tool, this.capabilities)) {
        return this.#refuse(call, `The tool "${call.name}" is not available on this chart right now.`);
      }
      // Level 3 is financial and deliberately unimplemented. No confirmation
      // dialog, and no auto-approve switch, can turn one on.
      if (level >= 3) {
        return this.#refuse(call, `The tool "${call.name}" is not implemented.`);
      }

      // Level 2 needs an explicit yes unless the user turned that off.
      if (level === 2 && !this.handlers.autoApprove?.()) {
        const approved = await this.handlers.onConfirm?.({ name: call.name, input: call.input });
        // Stop can land while the card is still on screen.
        if (this.#stale(run)) {
          return this.#refuse(call, 'The user stopped the run before this tool executed.');
        }
        if (!approved) {
          return this.#refuse(call, 'The user declined this action. Do not retry it; ask what they want instead.');
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
