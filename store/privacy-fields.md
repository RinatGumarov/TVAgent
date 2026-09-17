# Chrome Web Store privacy fields

## Permission justifications

### storage

Stores the selected provider, model, provider base URL, reasoning effort, API
key, consent flag, confirmation preference and panel width locally. Conversation
history is not persisted.

### TradingView content-script match: https://_.tradingview.com/chart/_

Loads the product only on TradingView chart pages and lets the fixed local tool
handlers read or update the chart requested by the user. No separate TradingView
host permission is granted to the background worker.

### https://api.anthropic.com/*

Sends a model request directly to Anthropic when the user selects Anthropic and
provides an API key. The key is attached only in the background service worker.

### Optional: http://localhost/* and http://127.0.0.1/*

Lets a user explicitly connect to a local OpenAI-compatible provider such as
Ollama or LM Studio. Chrome grants only the loopback host the user selects.

### Optional declaration: https://_/_

Chrome requires a wildcard optional declaration to request an origin discovered
from user input. TVAgent validates HTTPS and requests only the exact configured
provider host at runtime; it never requests all HTTPS hosts. Obsolete custom
provider grants are removed when the configured host changes.

## Remote code

Select: **No, I am not using remote code.**

All executable JavaScript and CSS ships inside the extension ZIP. The extension
does not download or evaluate JavaScript, CSS or WebAssembly and has no
`eval`, dynamic script loader or arbitrary JavaScript tool.

Model responses are data. A response may select from a fixed allowlist of named
tools whose schemas, permission levels, validation and complete implementations
are included in the submitted source. Unknown and inherited names are refused;
no response can add a tool or change its implementation.

## Data categories

- Authentication information: model-provider API keys stored locally and sent
  only to the selected provider.
- Website content: chart context, recent OHLCV bars, indicators, drawings,
  strategy values and requested Pine source.
- User-generated content / personal communications: prompts and the in-memory
  conversation sent to the selected provider.

Do not select personally identifiable information, health information, location,
browsing history, financial/payment information or analytics: TVAgent does not
handle those categories. Market chart values are website content, not a user's
personal payment or brokerage information.

## Certifications

Certify that data is used only to provide the disclosed single purpose, is not
sold or used for advertising or lending, and is transferred only to the model
provider selected by the user. Use this privacy policy URL:

`https://github.com/RinatGumarov/TVAgent/blob/main/PRIVACY.md`
