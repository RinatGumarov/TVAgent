# Privacy Policy — TVAgent

**Last updated:** 2026-08-18

TVAgent is a browser extension that adds an AI chat panel to TradingView charts.
It has no backend. There is no TVAgent server, no account, and no analytics.

## What TVAgent stores

Everything is stored with `chrome.storage.local`, on your machine only. Nothing
is synced to a Google account or transmitted to the developer.

| Stored | Why |
|---|---|
| Your LLM API key | To authenticate your requests to the model provider you chose |
| Provider, model name, base URL, reasoning effort, max tokens | Your model settings |
| `autoApprove` flag | Whether Level 2 actions ask for confirmation |
| Panel width | To restore the panel at the size you left it |

Conversations are not written to disk. They live in the panel for the current
tab and are gone when you close or reload it.

## What leaves your browser, and where it goes

TVAgent talks to exactly two kinds of destination, both of which you choose:

**1. The model provider you configure.** When you send a message, the extension
sends your message, the conversation so far, the tool definitions, and the chart
context the agent read (symbol, timeframe, visible range, indicators on the
chart, recent OHLCV bars, drawings, strategy report values, Pine source you asked
it to work on) to that provider's API:

- **Anthropic** (`https://api.anthropic.com`) — governed by
  [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy).
- **Any OpenAI-compatible endpoint you enter yourself**, including local ones such
  as Ollama or LM Studio on `localhost`. With a local endpoint, nothing leaves
  your machine at all. With a hosted one, that provider's own privacy policy
  applies.

**2. TradingView**, only in the sense that the extension runs inside the
`tradingview.com` chart page you already have open and calls the page's own APIs.
It sends TradingView nothing extra and does not transmit your API key, your
prompts, or your conversation to TradingView.

The API key is held in the extension's background service worker and attached to
provider requests there. It is never exposed to the TradingView page, and never
sent anywhere except the provider endpoint you configured.

## What TVAgent does not do

- No analytics, telemetry, crash reporting, or usage tracking of any kind.
- No advertising, and no sale or sharing of data with anyone.
- No collection of personal identifiers, browsing history, or activity on any
  site other than the TradingView chart page it runs on.
- No access to your TradingView credentials or broker accounts. TVAgent cannot
  place, modify, or cancel orders — there is no code path to one.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | Save your settings and API key locally |
| `https://*.tradingview.com/*` | Run the panel and read/drive the chart, which is the entire product |
| `https://api.anthropic.com/*` | Send your requests to Anthropic when Anthropic is the selected provider |
| `http://localhost/*`, `http://127.0.0.1/*` | Reach a local model server such as Ollama or LM Studio, if you point the extension at one |

## Deleting your data

Removing the extension from `chrome://extensions` deletes everything it stored.
To clear only the API key, open the panel's ⚙ settings and empty the key field.

## Changes

Material changes to this policy will be published in this file in the
[TVAgent repository](https://github.com/RinatGumarov/TVAgent), with the date
above updated.

## Contact

Open an issue at <https://github.com/RinatGumarov/TVAgent/issues>.
