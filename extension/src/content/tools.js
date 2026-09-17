/**
 * TVAgent — the tools the model sees.
 *
 * Each maps onto a driver method. Permission levels: 0 read, 1 chart change,
 * 2 persistent change (confirmation unless auto-approve is on), 3 financial
 * (not implemented). `needs` names the capability a tool depends on.
 */
window.TVAgentTools = (() => {
  'use strict';

  const TOOLS = [
    // ---- context ---------------------------------------------------------
    {
      level: 0,
      name: 'get_chart_context',
      description:
        'Read the current state of the chart: symbol, timeframe, visible range, last bar, ' +
        'every indicator with its inputs, and every drawing. Call this first when you need ' +
        'to know what the user is looking at.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      level: 0,
      needs: 'series',
      name: 'get_series_data',
      description:
        'Get recent OHLCV bars for the current symbol and timeframe. Only the bars ' +
        'TradingView has loaded (~300) are available. Use this to compute levels, find ' +
        'swing highs/lows, or locate crossovers before drawing. The response carries a ' +
        '"range" object with the exact high and low of the returned window and the ' +
        'timestamp of each — take those values verbatim when you need the extreme of a ' +
        'range; do not rescan the bars and do not round. The bars themselves are for ' +
        'everything else: crossovers, patterns, per-bar arithmetic.',
      input_schema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            description: 'How many of the most recent bars to return (default 100).',
          },
        },
        additionalProperties: false,
      },
    },

    // ---- chart -----------------------------------------------------------
    {
      level: 1,
      name: 'set_symbol',
      description:
        'Change the chart symbol. Use a fully qualified ticker with the exchange prefix, ' +
        'e.g. "BINANCE:BTCUSDT", "NASDAQ:AAPL", "FX:EURUSD".',
      input_schema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'set_timeframe',
      description:
        'Change the chart timeframe. TradingView resolution strings: minutes as a bare ' +
        'number ("1", "5", "60", "240"), "D" daily, "W" weekly, "M" monthly. 4H is "240".',
      input_schema: {
        type: 'object',
        properties: { timeframe: { type: 'string' } },
        required: ['timeframe'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'set_visible_range',
      description: 'Set the visible time range of the chart. Times are unix seconds.',
      input_schema: {
        type: 'object',
        properties: { from: { type: 'number' }, to: { type: 'number' } },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },

    // ---- indicators ------------------------------------------------------
    {
      level: 0,
      name: 'search_indicators',
      description:
        'Search the built-in indicator catalog by name. add_indicator needs the exact ' +
        'display name, so search first whenever you are unsure what an indicator is called.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      level: 0,
      name: 'list_indicators',
      description: 'List indicators currently on the chart, with their ids and input values.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      level: 1,
      name: 'add_indicator',
      description:
        'Add a built-in indicator to the chart. Use the exact display name from ' +
        'search_indicators (e.g. "Moving Average Exponential", "Relative Strength Index"). ' +
        'Common abbreviations like "EMA" or "RSI" are also accepted. Inputs are the ' +
        'indicator\'s own parameters, e.g. {"length": 50}.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          inputs: { type: 'object', description: 'Indicator parameters, e.g. {"length": 200}.' },
          overlay: {
            type: 'boolean',
            description: 'Force onto the price pane instead of a separate pane.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'update_indicator',
      description: 'Change the inputs of an indicator already on the chart, by id.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' }, inputs: { type: 'object' } },
        required: ['id', 'inputs'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'remove_indicator',
      description: 'Remove an indicator from the chart by id.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },

    // ---- drawings --------------------------------------------------------
    {
      level: 0,
      name: 'list_drawings',
      description: 'List drawings currently on the chart, with their ids and types.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      level: 1,
      name: 'create_horizontal_line',
      description: 'Draw a horizontal line at a price level — support, resistance, a target.',
      input_schema: {
        type: 'object',
        properties: {
          price: { type: 'number' },
          text: { type: 'string', description: 'Optional label.' },
        },
        required: ['price'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'create_vertical_line',
      description:
        'Draw a vertical line at a point in time (unix seconds) — mark an event or a ' +
        'crossover. The time snaps to the nearest loaded bar.',
      input_schema: {
        type: 'object',
        properties: { time: { type: 'number' } },
        required: ['time'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'create_trend_line',
      description:
        'Draw a trend line between two points. Each point is {time (unix seconds), price}. ' +
        'Times snap to the nearest loaded bar.',
      input_schema: {
        type: 'object',
        properties: {
          from: {
            type: 'object',
            properties: { time: { type: 'number' }, price: { type: 'number' } },
            required: ['time', 'price'],
          },
          to: {
            type: 'object',
            properties: { time: { type: 'number' }, price: { type: 'number' } },
            required: ['time', 'price'],
          },
          text: { type: 'string' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'create_text',
      description: 'Place a text label on the chart at a time/price point.',
      input_schema: {
        type: 'object',
        properties: {
          time: { type: 'number' },
          price: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['time', 'price', 'text'],
        additionalProperties: false,
      },
    },
    {
      level: 1,
      name: 'remove_drawing',
      description: 'Remove a drawing from the chart by id.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },

    // ---- pine ------------------------------------------------------------
    {
      level: 1,
      needs: 'pine',
      name: 'open_pine_editor',
      description:
        'Open the Pine Editor. Pass newScript: true (the default) to start a blank script ' +
        'so you do not overwrite whatever the user already has open.',
      input_schema: {
        type: 'object',
        properties: { newScript: { type: 'boolean' } },
        additionalProperties: false,
      },
    },
    {
      level: 2,
      needs: 'pine',
      name: 'set_pine_code',
      description:
        'Replace the Pine Editor contents with your script. Write Pine v6 ("//@version=6"). ' +
        'Open the editor with a new script first.',
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
        additionalProperties: false,
      },
    },
    {
      level: 2,
      needs: 'pine',
      name: 'add_pine_to_chart',
      description:
        'Compile the current Pine Editor script and add it to the chart. Returns the new ' +
        'study id, or ok:false if it failed to compile. For a strategy, follow with ' +
        'get_strategy_report.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },

    // ---- strategy --------------------------------------------------------
    {
      level: 0,
      needs: 'strategy',
      name: 'get_strategy_report',
      description:
        'Read backtest results for a strategy on the chart: net profit, profit factor, ' +
        'max drawdown, win rate, Sharpe, Sortino, trade count. Omit id to use the first ' +
        'strategy found.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: false,
      },
    },
  ];

  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  /** The API wants only the wire fields — `level` and `needs` are ours. */
  function forApi(capabilities) {
    return TOOLS.filter((t) => isAvailable(t, capabilities)).map(
      ({ name, description, input_schema }) => ({ name, description, input_schema }),
    );
  }

  function isAvailable(tool, caps) {
    if (!tool) return false;
    if (!caps || !tool.needs) return true;
    return !!caps[tool.needs];
  }

  /** The tool by that name, or null. Null means "no such tool", not "level 3". */
  const get = (name) => byName.get(name) || null;

  return { TOOLS, forApi, isAvailable, get };
})();
