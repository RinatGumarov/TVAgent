/**
 * TVAgent — the Anthropic model catalog, shared by the settings screen and the
 * worker. `reasoning` says which thinking controls each model accepts; the
 * wrong pair is a 400.
 */

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
    // Haiku 4.5 wants an explicit thinking budget and rejects the Claude 5
    // controls.
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

export { ANTHROPIC, DEFAULT_MODEL };

export const isAnthropic = (id) => byId.has(id);
export const get = (id) => byId.get(id) || null;

/** The name for the composer chip; an unknown id is written as it was typed. */
export const chip = (id) => (byId.get(id) || {}).chip || id || '';

/**
 * The reasoning fields this model accepts, ready to spread into the request
 * body. An unrecognised id gets neither — a model we know nothing about is
 * likelier to reject an unknown field than to want one.
 */
export function reasoning(id, { effort, maxTokens }) {
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
}
