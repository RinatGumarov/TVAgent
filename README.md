# TVAgent

A Chrome extension that puts a Claude-powered agent inside TradingView. It reads
the chart and drives it through TradingView's own semantic API — no DOM clicking,
no screen scraping.

Ask it "add EMA 50 and 200", "mark the high and low of the visible range", or
"build an EMA crossover strategy and backtest it", and it does the work.

---

## Install

Needs Chrome 111+ — the driver relies on `world: "MAIN"` content scripts.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder in this repo
   (or the folder you unzipped from a [release](https://github.com/RinatGumarov/TVAgent/releases))
4. Open <https://www.tradingview.com/chart/> — the panel appears on the right
5. Click ⚙ in the panel, paste an [Anthropic API key](https://console.anthropic.com/settings/keys),
   or point it at a local model server such as Ollama

**Log in to TradingView.** Anonymous sessions can't create most drawing tools —
the panel warns you if it detects this.

The toolbar button toggles the panel. The left edge drags to resize.

---

## Architecture

```
┌─ Panel (content script, ISOLATED world) ──────────────┐
│  chat UI · agent loop · tool dispatch · permissions   │
└────────┬──────────────────────────┬───────────────────┘
         │ chrome.runtime Port      │ authenticated postMessage
         ▼                          ▼
┌─ Background worker ────┐  ┌─ Driver (MAIN world) ─────┐
│ holds the API key      │  │ TradingViewDriver         │
│ streams from Claude    │  │ over window.TradingViewApi│
└────────────────────────┘  └───────────────────────────┘
```

Four boundaries, each doing one job:

- **The API key never leaves the background worker.** Not the page, not the panel,
  not TradingView. The settings screen's key fields are closed shadow roots, so
  the value is not in the panel's markup either.
- **The model never gets arbitrary JS.** It calls named tools; the driver
  dispatches only from its own handler table, checked with `hasOwnProperty`, and
  the agent refuses any name that is not in the tool list. There is no
  `execute_javascript`.
- **The page bridge is authenticated.** `window.postMessage` is shared with every
  script on tradingview.com, so the two ends agree a secret once at
  `document_start` and stamp every message with an HMAC over its id. A page
  script can neither invoke a driver method nor answer one.
- **A run is owned by one loop.** Stop, New chat and a second send all end the
  run that was in flight, so two loops can never write into one conversation.

| File | Role |
|---|---|
| `extension/src/shared/wire.js` | The bridge protocol and its handshake, loaded into both worlds. |
| `extension/src/shared/models.js` | The Anthropic model catalog, and what each model's request may carry. |
| `extension/src/shared/credentials.js` | Which provider a stored key and model belong to. |
| `extension/src/shared/wait.js` | One poll helper, for everything that waits on the host. |
| `extension/src/injected/driver.js` | MAIN world. The `TradingViewDriver` — every call into `window.TradingViewApi`. |
| `extension/src/content/bridge.js` | postMessage RPC to the driver, with timeouts. |
| `extension/src/content/tools.js` | Tool schemas the model sees, plus permission levels. |
| `extension/src/content/agent.js` | Tool-use loop, confirmations, conversation state. |
| `extension/src/content/panel.js` | Chat UI, execution trace, settings. |
| `extension/src/background/service-worker.js` | Anthropic API proxy, SSE streaming. |

---

## Tools

19 tools. The model sees these and nothing else about TradingView.

| Group | Tools |
|---|---|
| Context | `get_chart_context`, `get_series_data` |
| Chart | `set_symbol`, `set_timeframe`, `set_visible_range` |
| Indicators | `search_indicators`, `list_indicators`, `add_indicator`, `update_indicator`, `remove_indicator` |
| Drawings | `list_drawings`, `create_horizontal_line`, `create_vertical_line`, `create_trend_line`, `create_text`, `remove_drawing` |
| Pine | `open_pine_editor`, `set_pine_code`, `add_pine_to_chart` |
| Strategy | `get_strategy_report` |

### Permissions

Following the plan's §15 model:

| Level | Behavior | Tools |
|---|---|---|
| 0 — read | automatic | context, series, list/search, strategy report |
| 1 — chart change | automatic | symbol, timeframe, indicators, drawings |
| 2 — persistent | **asks first** | `set_pine_code`, `add_pine_to_chart` |
| 3 — financial | **not implemented** | — |

Level 2 confirmations can be switched off in settings for demo runs; that switch
covers level 2 and nothing else. Level 3 does not exist: there is no order
placement, no broker access, no code path to one, and a call at that level is
refused rather than offered as something to allow. A name that is not in the
tool list is not a privileged tool — it is answered as "no such tool" and never
dispatched.

### Capability probe

On load the panel probes the page and disables tools that aren't available —
missing Pine API, no series data, logged-out session. A gap degrades one tool
instead of breaking the extension. The driver pushes a fresh report on every
symbol and timeframe change, so a tool that becomes available later comes back
and the system prompt always names the chart the user is actually looking at.

---

## What's verified

Everything the driver calls was checked against live production TradingView, with
a logged-in `pro_premium_expert` account, on 2026-08-17:

- symbol/timeframe changes, indicator add/update/remove, the 241-entry indicator
  catalog, `setInputValues` shape, OHLCV bar reads
- horizontal/vertical/trend lines, text labels, removal
- the full Pine loop: new script → set code → compile → attach
- strategy report reads: net profit, profit factor, drawdown, Sharpe, Sortino

Not verified end-to-end: the Anthropic API request shape (needs a key) and the
extension running under `chrome://extensions` (needs a browser load). Both are
standard, but they are the two things to try first.

---

## Known limits

- **`exportData` is dead** on the main chart page even for paid accounts, so
  `get_series_data` reads the loaded window — about 300 bars, not full history.
- **`cross_line`, `flag`, `price_label`** need tool-specific parameters and aren't
  exposed. `parallel_channel` needs 3 points.
- **`getStudiesList()` is dead** in production; the catalog comes from
  `studyMetaIntoRepository()` instead.
- **`createStudy` wants the display name**, not the `@tv-basicstudies` id — hence
  `search_indicators`.
- **This API is internal and unversioned.** It can change without notice. The
  driver is the seam that absorbs that.
- **Only local OpenAI-compatible endpoints work out of the box.** The manifest
  grants `localhost` and `127.0.0.1` but no hosted third-party host, so pointing
  the base URL at a remote provider fails until that host is added to
  `host_permissions`.

---

## Debugging

```javascript
localStorage.setItem('tv-agent-debug', '1')
```

Then reload. This logs every driver call and its duration to the page console,
and is also what exposes the manual handle — it is not present otherwise, since
a global that calls straight into the handler table would bypass the bridge's
authentication:

```javascript
await window.__tvAgent.call('get_chart_context')
window.__tvAgent.methods
```

---

## Tests

Everything under `tests/` runs on plain node, with no dependencies to install.
The extension sources are read from disk and evaluated under a fake DOM, a fake
`chrome.*` and a fake window, so the tests run the shipped files rather than a
copy made importable.

```bash
bash tools/test.sh
```

Two of them reach outside: `models-test.mjs` skips its last section unless a
local Ollama is running, and `adapter-test.mjs` and `loop-probe.mjs` exist to be
pointed at a live model by hand.

---

## Not financial advice

TVAgent analyzes charts and writes scripts. It cannot trade, and backtest results
are not predictions.

---

## Privacy

No backend, no analytics, no account. Settings and your API key live in
`chrome.storage.local`; prompts go only to the model provider you configure. Full
detail in [PRIVACY.md](PRIVACY.md).

---

## License

[MIT](LICENSE).

TVAgent is an independent project. It is not affiliated with, endorsed by, or
sponsored by TradingView, Inc. "TradingView" is a trademark of its owner and is
used here only to say what this extension works with.
