# TVAgent

An AI assistant inside TradingView. TVAgent is a Chrome extension that adds a
chat panel to the chart page and lets a model read the chart and change it
through TradingView's own in-page API: indicators, drawings, Pine scripts,
strategy reports. No screen scraping and no DOM clicking.

Ask it "add EMA 50 and 200", "mark the high and low of the visible range", or
"build an EMA crossover strategy and backtest it".

## Install

TVAgent is not on the Chrome Web Store yet, so it is loaded unpacked:

1. Clone this repository, or unzip a [release](https://github.com/RinatGumarov/TVAgent/releases).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

Chrome 111 or newer is required.

## Use

1. Open a chart at <https://www.tradingview.com/chart/>. Log in first:
   anonymous sessions cannot create most drawings, and the panel will say so.
2. Open the panel. On a logged-in chart it is a tab marked **AI** in the
   right-hand widget bar. Without a widget bar, the extension's toolbar button
   opens it as an overlay.
3. Choose a provider in the settings screen:
   - **Anthropic**: paste an [API key](https://console.anthropic.com/settings/keys)
     and pick a model.
   - **OpenAI-compatible**: enter the base URL and a model name. A local
     server such as Ollama on `localhost` needs no key.
4. Type a request, or click one of the suggestions.

The chat shows every tool call the model makes and what came back. Reading the
chart and changing indicators or drawings happen without asking. Writing Pine
code and adding it to the chart ask for confirmation first; the "Run Pine
edits without asking" switch in settings turns that off.

TVAgent cannot place orders and has no access to your broker. Backtest results
are not predictions.

### Settings

| Setting | |
|---|---|
| Provider | Anthropic, or any OpenAI-compatible endpoint |
| API key | Kept in the extension's local storage and sent only to the selected provider |
| Model | Claude Opus 5, Sonnet 5 or Haiku 4.5; for other providers, the list is loaded from the server |
| Effort | Reasoning effort for Claude models |
| Run Pine edits without asking | Skips the confirmation for the Pine tools |

### What the model can do

| Group | Tools |
|---|---|
| Read | `get_chart_context`, `get_series_data`, `list_indicators`, `search_indicators`, `list_drawings`, `get_strategy_report` |
| Chart | `set_symbol`, `set_timeframe`, `set_visible_range` |
| Indicators | `add_indicator`, `update_indicator`, `remove_indicator` |
| Drawings | `create_horizontal_line`, `create_vertical_line`, `create_trend_line`, `create_text`, `remove_drawing` |
| Pine | `open_pine_editor`, `set_pine_code`, `add_pine_to_chart` |

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
│ holds the API key      │  │ window.TradingViewApi     │
│ streams the response   │  └───────────────────────────┘
└────────────────────────┘
```

- **Driver** (`extension/src/injected/driver.js`) is the only code that
  touches `window.TradingViewApi`. It exposes a fixed set of methods.
- **Panel** (`extension/src/content/`) is the chat UI, the agent loop, the
  tool schemas and the permission levels. It reaches the driver over
  `postMessage`, which every script on the page can see, so the two ends agree
  a secret at `document_start` and stamp every message with an HMAC.
- **Background worker** (`extension/src/background/service-worker.js`)
  holds the API key and streams the model's response. The key never reaches
  the page.

## Limits

- TradingView's in-page API is internal and unversioned. It can change without
  notice, and the driver is the one file that would need to follow.
- Only the bars TradingView has loaded, about 300, are available to the model.
- Horizontal, vertical and trend lines and text labels are the drawings
  exposed. Other drawing tools are not.
- Only local OpenAI-compatible endpoints work out of the box. The manifest
  grants `localhost` and `127.0.0.1`; a hosted provider needs its host added
  to `host_permissions`.

## Development

The tests run on plain Node with no dependencies. They read the extension
sources from disk and evaluate them under a fake DOM and a fake `chrome.*`:

```bash
bash tools/test.sh
```

`extension/src/shared/` is copied into `extension/src/injected/` by
`tools/sync-worlds.sh`, because Chrome cannot load one file into two worlds.
`tools/package.sh` builds the store zip.

To log every driver call to the page console, set
`localStorage['tv-agent-debug'] = '1'` on the chart page and reload.

## Privacy

TVAgent has no backend, no analytics and no account. Settings and your API key
stay in the extension's local storage; prompts and chart data go only to the
model provider you configure. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE). TVAgent is an independent project and is not affiliated with
or endorsed by TradingView, Inc.
