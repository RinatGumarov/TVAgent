# Privacy Policy — TVAgent

**Last updated:** 2026-08-22

TVAgent is a browser extension that adds an AI chat panel to TradingView charts.
It has no backend. There is no TVAgent server, no account, and no analytics.

## What TVAgent stores

Everything is stored with `chrome.storage.local`, on your machine only. Nothing
is synced to a Google account or transmitted to the developer.

| Stored                                              | Why                                                           |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Your LLM API key                                    | To authenticate your requests to the model provider you chose |
| Provider, model name, base URL and reasoning effort | Your model settings                                           |
| `autoApprove` flag                                  | Whether Level 2 actions ask for confirmation                  |
| Data-disclosure consent flag                        | Whether you accepted the current in-product disclosure        |
| Panel width                                         | To restore the panel at the size you left it                  |

Conversations are not written to disk. They live in the panel for the current
tab and are gone when you close or reload it.

Before TVAgent sends a message, its settings screen names the data that will go
to the selected model provider and requires affirmative consent. The extension
will not start a model run until that disclosure is accepted, the provider is
configured, and any optional provider host permission has been granted.

## What leaves your browser, and where it goes

TVAgent talks to exactly two kinds of destination, both of which you choose:

**1. The model provider you configure.** When you send a message, the extension
sends your message, the conversation so far, the tool definitions, and the chart
context the agent read (symbol, timeframe, visible range, indicators on the
chart, recent OHLCV bars, drawings, strategy report values, Pine source you asked
it to work on) to that provider's API:

- **Anthropic** (`https://api.anthropic.com`) — governed by
  [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy).
- **Any OpenAI-compatible endpoint you enter yourself.** HTTP is accepted only
  for Ollama, LM Studio or another process on `localhost` or `127.0.0.1`.
  Hosted endpoints must use HTTPS and require a Chrome permission for that exact
  provider host. With a local endpoint, nothing leaves your machine. With a
  hosted one, that provider's own privacy policy applies.

**2. TradingView**, only in the sense that the extension runs inside the
`tradingview.com` chart page you already have open and calls the page's own APIs.
It sends TradingView nothing extra and does not transmit your API key, your
prompts, or your conversation to TradingView.

The API key stays in extension storage, is displayed only in the isolated
content script's closed-shadow settings field, and is attached to provider
requests by the background service worker. It is never exposed to the
TradingView page, and never sent anywhere except the provider endpoint you
configured.

## What TVAgent does not do

- No analytics, telemetry, crash reporting, or usage tracking of any kind.
- No advertising, and no sale or sharing of data with anyone.
- No collection of personal identifiers, browsing history, or activity on any
  site other than the TradingView chart page it runs on.
- No access to your TradingView credentials or broker accounts. TVAgent cannot
  place, modify, or cancel orders — there is no code path to one.

## Chrome Web Store data categories

For the Chrome Web Store disclosure form, TVAgent handles these categories only
to provide its user-facing chart assistant:

| Category                                         | What it means in TVAgent                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Authentication information                       | The LLM API key you enter and keep in local extension storage                                     |
| Website content                                  | Chart context, recent OHLCV bars, indicators, drawings, strategy values and requested Pine source |
| User-generated content / personal communications | Prompts and the in-memory conversation sent to the provider you select                            |

TVAgent does not sell data, use it for advertising or creditworthiness, or
transfer it for any purpose unrelated to the chart assistant. The use of
information received from Google APIs will adhere to the Chrome Web Store User
Data Policy, including the Limited Use requirements.

## Permissions, and why each is needed

| Permission                                                            | Why                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `storage`                                                             | Save your settings and API key locally                                                                                  |
| TradingView content-script match: `https://*.tradingview.com/chart/*` | Load the product only on chart pages and run the fixed chart tools requested by the user                                |
| `https://api.anthropic.com/*`                                         | Send your requests to Anthropic when Anthropic is the selected provider                                                 |
| `http://localhost/*`, `http://127.0.0.1/*` (optional)                 | Reach a local model server only after you configure and allow it                                                        |
| `https://*/*` (optional declaration)                                  | Let Chrome grant only the exact HTTPS provider host you enter; the extension never requests every HTTPS host at runtime |

The extension runs only on the TradingView chart pages declared in its static
content-script matches. It does not request a separate TradingView host
permission for background network access.

## Deleting your data

Removing the extension from `chrome://extensions` deletes everything it stored.
To clear only the API key, open the panel's ⚙ settings and empty the key field.

## Changes

Material changes to this policy will be published in this file in the
[TVAgent repository](https://github.com/RinatGumarov/TVAgent), with the date
above updated.

## Contact

Open an issue at <https://github.com/RinatGumarov/TVAgent/issues>.
