# Chrome Web Store listing

## Name

TVAgent — AI Chart Assistant

## Summary

AI chart assistant that reads and updates TradingView charts through a fixed set of local tools.

## Category

Productivity

## Language

English

## Single purpose

TVAgent adds a user-controlled AI assistant to an open TradingView chart so the
user can inspect chart context and make chart changes through a fixed, reviewable
set of chart tools.

## Detailed description

TVAgent places an AI assistant directly inside TradingView. Ask it to explain the
current chart, inspect recent bars, add or update indicators and drawings, write
Pine code, or read a strategy report.

Main features:

- Reads the current symbol, timeframe, visible range and recent OHLCV bars.
- Adds and updates indicators and chart drawings through named chart tools.
- Supports a confirmation step before persistent Pine edits.
- Works with Anthropic or a user-configured OpenAI-compatible model provider.
- Keeps settings and API keys in local extension storage and sends a key only
  to the selected provider for request authentication.
- Has no TVAgent backend, account, analytics, advertising or broker access.
- Cannot place, modify or cancel trades.

Before the first model request, TVAgent identifies the chart and conversation
data sent to the selected model provider and requires affirmative consent. A
hosted custom provider must use HTTPS and receives only the exact host permission
the user grants.

TVAgent is an independent project. It is not affiliated with, endorsed by or
sponsored by TradingView, Inc. TradingView is a trademark of its owner and is
used only to identify compatibility.
