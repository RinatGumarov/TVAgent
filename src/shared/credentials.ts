/**
 * TVAgent — which provider a stored key and model belong to.
 *
 * Storage once kept one shared apiKey/model pair for both providers. This is
 * the move to per-provider slots, shared by the panel (which writes it) and
 * the worker (which has to read an unmigrated profile the same way).
 */

import { isAnthropic } from './models.ts';

/** The raw `chrome.storage.local` contents this reads. */
export interface StoredCredentials {
  provider?: string;
  apiKey?: string;
  model?: string;
  openaiApiKey?: string;
  openaiModel?: string;
}

export interface SplitCredentials {
  apiKey: string;
  model: string;
  openaiApiKey: string;
  openaiModel: string;
  /** True only when the caller should write the result back. */
  changed: boolean;
}

export function split(stored: StoredCredentials | null | undefined): SplitCredentials {
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

  // Under the other provider each half is decided on its own evidence.
  const keyIsAnthropic = key.startsWith('sk-ant-');
  const modelIsAnthropic = isAnthropic(model);
  return {
    apiKey: keyIsAnthropic ? key : '',
    model: modelIsAnthropic ? model : '',
    openaiApiKey: keyIsAnthropic ? '' : key,
    openaiModel: modelIsAnthropic ? '' : model,
    changed: true,
  };
}
