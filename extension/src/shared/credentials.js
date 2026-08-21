/**
 * TVAgent — which provider a stored key and model belong to.
 *
 * Storage used to keep one shared `apiKey`/`model` pair for both providers, so
 * switching provider overwrote the other one's values. Each provider now has
 * its own slot, and this is the one-time move from the old shape to the new.
 *
 * The panel and the background worker both have to agree about it — the panel
 * writes the split, the worker reads it and must behave the same way on a
 * profile that has not been through the panel yet. It was written twice, in
 * two dialects, which is exactly the kind of pair that drifts.
 */
(() => {
  'use strict';

  const models = () => globalThis.TVAgentModels;

  /**
   * @param {object} stored raw `chrome.storage.local` contents
   * @returns {{apiKey: string, model: string, openaiApiKey: string,
   *            openaiModel: string, changed: boolean}}
   *   `changed` is true only when the caller should write the result back.
   */
  function split(stored) {
    const s = stored || {};
    const key = s.apiKey || '';
    const model = s.model || '';

    // Anything written since the split is already in the right place.
    if (s.openaiApiKey !== undefined || s.openaiModel !== undefined) {
      return {
        apiKey: key,
        model,
        openaiApiKey: s.openaiApiKey || '',
        openaiModel: s.openaiModel || '',
        changed: false,
      };
    }

    // Under Anthropic the shared pair can only ever have been Anthropic's, so
    // there is nothing to decide and nothing to move.
    if ((s.provider || 'anthropic') !== 'openai') {
      return { apiKey: key, model, openaiApiKey: '', openaiModel: '', changed: false };
    }

    // Under the other provider the pair is ambiguous, and each half is decided
    // on its own evidence: an `sk-ant-` key was never meant to leave
    // api.anthropic.com, and a model id from our own catalog is not something
    // Ollama or OpenRouter will answer to.
    const keyIsAnthropic = key.startsWith('sk-ant-');
    const modelIsAnthropic = models().isAnthropic(model);
    return {
      apiKey: keyIsAnthropic ? key : '',
      model: modelIsAnthropic ? model : '',
      openaiApiKey: keyIsAnthropic ? '' : key,
      openaiModel: modelIsAnthropic ? '' : model,
      changed: true,
    };
  }

  globalThis.TVAgentCredentials = { split };
})();
