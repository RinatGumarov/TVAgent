/**
 * TVAgent — the API key form on the options page. Keys are typed here, on an
 * extension page, so they never pass through a TradingView document.
 */

const FIELDS = [
  { id: 'key-anthropic', slot: 'apiKey' },
  { id: 'key-openai', slot: 'openaiApiKey' },
];

/** Shows that a key is there without putting it back on screen. */
const mask = (key: string) => (key ? `Saved · ends in ${key.slice(-4)}` : 'Not set');

export async function create(doc: Document) {
  // The worker moves an old shared slot to per-provider ones while answering.
  await chrome.runtime.sendMessage({ type: 'key-status' }).catch(() => null);
  const stored: Record<string, string | undefined> = await chrome.storage.local.get(
    FIELDS.map((f) => f.slot),
  );

  for (const { id, slot } of FIELDS) {
    const input = doc.querySelector<HTMLInputElement>(`#${id}`)!;
    const status = doc.querySelector<HTMLElement>(`#${id}-status`)!;
    const save = doc.querySelector<HTMLElement>(`#${id}-save`)!;
    const remove = doc.querySelector<HTMLElement>(`#${id}-remove`)!;
    status.textContent = mask(stored[slot] || '');

    save.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      await chrome.storage.local.set({ [slot]: key });
      input.value = '';
      status.textContent = mask(key);
    });
    remove.addEventListener('click', async () => {
      await chrome.storage.local.set({ [slot]: '' });
      input.value = '';
      status.textContent = mask('');
    });
  }
}
