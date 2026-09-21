# Reviewer notes

## Test path

1. Install the submitted ZIP in Chrome 111 or newer.
2. Open `https://www.tradingview.com/chart/`.
3. Open TVAgent from the TradingView widget bar or the extension toolbar action.
4. Read the data disclosure and press Agree and continue.
5. Select Anthropic, press Manage key and save a temporary review API key on
   the options page that opens, or select an
   OpenAI-compatible endpoint and grant its exact host when Chrome prompts.
6. Send `What am I looking at?` to exercise read-only chart context.
7. Send `Add EMA 50` to exercise a fixed chart-changing tool.
8. Open the options page and press Remove to clear the API key after testing.

Anonymous TradingView sessions can exercise chart context but may not expose all
drawing or Pine APIs. A logged-in test account is needed for those host features.
No credentials are committed to this repository; use temporary, revocable
credentials in the Developer Dashboard if the review team requests them.

## Model responses are not remote code

The model returns JSON-shaped text and fixed tool calls. Every callable tool is
declared in `src/content/tools.ts` and implemented in the submitted extension.
The dispatcher checks own properties, rejects unknown names and exposes no
JavaScript execution tool. A response cannot download code, define a tool or
alter a handler.

Persistent Pine changes ask for confirmation by default. The extension has no
order-placement, broker, cookie, credential or arbitrary-navigation capability.

## External services

- TradingView: the page on which the user invokes the product.
- Anthropic: required only when the user selects Anthropic.
- A custom OpenAI-compatible endpoint: used only after the user enters it and
  grants that exact host; hosted endpoints must use HTTPS.
