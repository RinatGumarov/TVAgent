/**
 * TVAgent — the data-use screen. It stands in for the chat until the user
 * agrees; the worker checks the same flag before any request.
 */

const PRIVACY_URL = 'https://github.com/RinatGumarov/TVAgent/blob/main/PRIVACY.md';

function create(hostEl: HTMLElement, { onAgree }: { onAgree: () => void }) {
  hostEl.innerHTML = `
      <section class="tva-disclosure" id="tva-disclosure">
        <h2>Before you send chart data</h2>
        <p>When you send a message, TVAgent sends your prompts and conversation,
          chart context, recent OHLCV bars, indicators, drawings, strategy values,
          and any Pine source you ask it to work on to your selected model provider.</p>
        <p>Your API key is sent only to the selected model provider to
          authenticate its API request. The TVAgent developer and TradingView do
          not receive your prompts or model credentials.</p>
        <a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Read the privacy policy</a>
        <button class="tva-btn primary" id="tva-disclosure-agree" type="button">Agree and continue</button>
      </section>
    `;
  hostEl.querySelector('#tva-disclosure-agree')?.addEventListener('click', async () => {
    await chrome.storage.local.set({ dataDisclosureAccepted: true });
    onAgree();
  });
}

export { create, PRIVACY_URL };
