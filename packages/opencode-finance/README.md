# opencode-finance

Finance workflow plugin for OpenCode.

## Enable in OpenCode

Add the plugin package in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-finance"]
}
```

OpenCode installs npm plugins automatically on startup.

## Auth providers

```bash
opencode auth login --provider alphavantage
opencode auth login --provider finnhub
opencode auth login --provider financial-modeling-prep
opencode auth login --provider polygon
opencode auth login --provider quartr
opencode auth login --provider sec-edgar
opencode auth login --provider quiver-quant
```

If your OpenCode config uses `enabled_providers`, this plugin auto-includes its finance auth provider IDs at runtime so they remain visible in `opencode auth login`.

`disabled_providers` still takes precedence. If you disable a finance provider there, it will stay hidden from the picker.

## Commands and tools

The plugin adds finance commands (`/quote`, `/metrics`, `/filings`, `/watch`, `/portfolio`, `/report-portfolio`, `/report-insiders`, `/market`, `/report`, `/onboard`) and tools (`financial_search`, `portfolio`, `portfolio_report`, `report_insiders`, `report_pdf`).

## Migration helper

For finance-fork users moving to OpenCode + plugin:

```bash
bun run --cwd packages/opencode-finance migrate
```
