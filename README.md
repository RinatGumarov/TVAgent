# TVAgent

An AI assistant inside TradingView. TVAgent is a Chrome extension that adds a
chat panel to the chart page and lets a model read the chart and change it
through TradingView's own in-page API: indicators, drawings, Pine scripts,
strategy reports. No screen scraping and no DOM clicking.

Ask it "add EMA 50 and 200", "mark the high and low of the visible range", or
"build an EMA crossover strategy and backtest it".

https://github.com/user-attachments/assets/42a4e5aa-85fa-452f-8fca-803de6da0f30

https://github.com/user-attachments/assets/9491f5f3-06b2-468f-926b-8328c94c4d8f

https://github.com/user-attachments/assets/db9fab5a-131c-4611-ad89-bb2830a09658

Recorded on a live chart with a local model (`gemma4:26b-a4b-it-qat`); the
waits for the model are shortened.

## Install

TVAgent is not on the Chrome Web Store yet, so it is loaded unpacked.

From a [release](https://github.com/RinatGumarov/TVAgent/releases): unzip it,
open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
and select the unzipped folder.

From source, build it first:

```bash
npm ci && npm run build
```

Then **Load unpacked** and select `build/extension/`.

Chrome 111 or newer is required. Building needs Node 22.18 or newer.

## Use

1. Open a chart at <https://www.tradingview.com/chart/>. Log in first:
   anonymous sessions cannot create most drawings, and the panel will say so.
2. Open the panel. On a logged-in chart it is a tab marked **AI** in the
   right-hand widget bar. Without a widget bar, the extension's toolbar button
   opens it as an overlay.
3. Read the data disclosure the panel opens with and agree to it.
4. Choose a provider:
   - **Anthropic**: pick a model, then press **Manage key** and save an
     [API key](https://console.anthropic.com/settings/keys) on the extension's
     options page. Keys are never typed on the TradingView page.
   - **OpenAI-compatible**: enter the base URL and a model name. Local servers
     such as Ollama or LM Studio work over HTTP on `localhost`. Hosted
     providers must use HTTPS, and Chrome asks you to allow that exact host
     before anything is sent to it. A key, if the provider needs one, goes on
     the same options page.
5. Type a request, or click one of the suggestions.

Every tool call the model makes is a row in the chat; click one to see its
input and what came back. Reading the
chart and changing indicators or drawings happen without asking. Writing Pine
code and adding it to the chart ask for confirmation first; the "Run Pine
edits without asking" switch in settings turns that off.

TVAgent cannot place orders and has no access to your broker. Backtest results
are not predictions.

### Settings

| Setting                       |                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Provider                      | Anthropic, or any OpenAI-compatible endpoint                                                  |
| API key                       | Entered on the extension's options page, kept in local storage, sent only to its provider     |
| Model                         | Claude Opus 5, Sonnet 5 or Haiku 4.5; for other providers, the list is loaded from the server |
| Effort                        | Reasoning effort. For other providers: Auto, Off (fastest), Low, Medium, High                 |
| Run Pine edits without asking | Skips the confirmation for the Pine tools                                                     |

### What the model can do

| Group      | Tools                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Read       | `get_chart_context`, `get_series_data`, `list_indicators`, `search_indicators`, `list_drawings`, `get_strategy_report` |
| Chart      | `set_symbol`, `set_timeframe`, `set_visible_range`                                                                     |
| Indicators | `add_indicator`, `update_indicator`, `remove_indicator`                                                                |
| Drawings   | `create_horizontal_line`, `create_vertical_line`, `create_trend_line`, `create_text`, `remove_drawing`                 |
| Pine       | `open_pine_editor`, `set_pine_code`, `add_pine_to_chart`                                                               |

The model sees these tools and nothing else about TradingView. A name that is
not on the list is refused. Tools that the page cannot support, such as the
Pine tools in a session without the Pine editor, are not offered.

## How it works

```
┌─ Panel (content script, isolated world) ──────────────┐
│  chat UI · agent loop · tool dispatch · permissions   │
└────────┬──────────────────────────┬───────────────────┘
         │ chrome.runtime Port      │ authenticated postMessage
         ▼                          ▼
┌─ Background worker ────┐  ┌─ Driver (page world) ─────┐
│ attaches the API key   │  │ window.TradingViewApi     │
│ streams the response   │  └───────────────────────────┘
└────────────────────────┘
```

- **Driver** (`src/injected/driver.ts`) is the only code that
  touches `window.TradingViewApi`. It exposes a fixed set of methods.
- **Panel** (`src/content/`) is the chat UI, the agent loop, the
  tool schemas and the permission levels. It reaches the driver over
  `postMessage`, which every script on the page can see, so the two ends agree
  a secret at `document_start` and stamp every message with an HMAC.
- **Background worker** (`src/background/service-worker.ts`)
  attaches the API key and streams the model's response. The key never
  reaches the page.

## Limits

- TradingView's in-page API is internal and unversioned. It can change without
  notice, and the driver is the one file that would need to follow.
- Only the bars TradingView has loaded, about 300, are available to the model.
- Horizontal, vertical and trend lines and text labels are the drawings
  exposed. Other drawing tools are not.

## Development

```bash
npm ci
npm run build        # build/extension/, loadable unpacked
npm run build:watch
npm test
npm run typecheck
npm run lint
npm run package      # dist/tvagent-<version>.zip
```

```
src/entries/     one file per bundle; side effects only
src/injected/    the page-world driver
src/content/     the panel, the agent loop, the bridge
src/shared/      the wire protocol, the model catalog, the URL policy
src/background/  the worker that holds the key
src/types/       TradingView's undocumented API, declared
static/          manifest.json, icons, panel.css — copied as they are
```

esbuild builds four bundles. `src/shared/wire.ts` is imported by both the
driver and the bridge, so each world gets its own copy of it and the two
cannot drift.

The tests run on Node's own test runner with no framework. They bundle the
real modules and run them under a fake DOM and a fake `chrome.*`, so what they
exercise is what ships.

To log every driver call to the page console, set
`localStorage['tv-agent-debug'] = '1'` on the chart page and reload.

## Privacy

TVAgent has no backend, no analytics and no account. Settings and your API key
stay in the extension's local storage; prompts and chart data go only to the
model provider you configure. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE). TVAgent is an independent project and is not affiliated with
or endorsed by TradingView, Inc.
