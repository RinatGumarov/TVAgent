/**
 * TVAgent — the Anthropic model catalog.
 *
 * One list, loaded by the panel (which offers it), by the settings screen
 * (which paints it) and by the background worker (which shapes the request
 * around it). It used to be written out separately in each of those places,
 * which is how a model could be offered in settings that the worker could not
 * actually call.
 *
 * `reasoning` is the part that has to live next to the ids: the models do not
 * take the same reasoning controls, and sending the wrong pair is a flat 400
 * rather than a degraded answer.
 */
(() => {
  'use strict';

  const ANTHROPIC = [
    {
      id: 'claude-opus-5',
      // Settings' segmented control.
      label: 'Opus 5',
      // The composer chip, which has room for the brand.
      chip: 'Claude Opus',
      thinking: 'adaptive',
      effort: true,
    },
    {
      id: 'claude-sonnet-5',
      label: 'Sonnet 5',
      chip: 'Claude Sonnet',
      thinking: 'adaptive',
      effort: true,
    },
    {
      // Adaptive thinking and output_config.effort are Claude 5 controls. Haiku
      // 4.5 takes neither: it wants an explicit thinking budget, and rejects
      // the whole request rather than ignoring the fields it does not know.
      id: 'claude-haiku-4-5',
      label: 'Haiku 4.5',
      chip: 'Claude Haiku',
      thinking: 'budget',
      effort: false,
    },
  ];

  const DEFAULT_MODEL = 'claude-opus-5';
  const byId = new Map(ANTHROPIC.map((m) => [m.id, m]));

  /** Leaves room for the answer itself; the API also requires budget < max_tokens. */
  const budgetFor = (maxTokens) => Math.max(1024, Math.min(8000, Math.floor(maxTokens / 2)));

  globalThis.TVAgentModels = {
    ANTHROPIC,
    DEFAULT_MODEL,

    isAnthropic: (id) => byId.has(id),
    get: (id) => byId.get(id) || null,

    /** The name for the composer chip; an unknown id is written as it was typed. */
    chip: (id) => (byId.get(id) || {}).chip || id || '',

    /**
     * The reasoning fields this model accepts, ready to spread into the request
     * body. An unrecognised id gets neither — a model we know nothing about is
     * likelier to reject an unknown field than to want one.
     */
    reasoning(id, { effort, maxTokens }) {
      const model = byId.get(id);
      if (!model) return {};

      const body = {};
      if (model.thinking === 'adaptive') {
        // Ask for the summary so the panel can show reasoning instead of a
        // silent pause.
        body.thinking = { type: 'adaptive', display: 'summarized' };
      } else if (model.thinking === 'budget') {
        body.thinking = { type: 'enabled', budget_tokens: budgetFor(maxTokens) };
      }
      if (model.effort && effort) body.output_config = { effort };
      return body;
    },
  };
})();
