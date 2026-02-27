# OpenCode Finance

This repository contains:

- `packages/opencode-finance`: OpenCode finance plugin package.
- `packages/web`: standalone marketing page deployed on Vercel.

## Setup

Run the one-shot installer:

```bash
curl -fsSL https://opencode.finance/install.sh | bash
```

It will:

- Install OpenCode if missing.
- Ensure `opencode-finance` is present in your OpenCode config `plugin` list.
- Prompt for finance credentials and write them to `~/.local/share/opencode/auth.json`.
- Install or update `finance-comprehensive-report` at `~/.opencode/skills/finance-comprehensive-report/SKILL.md`.

When `enabled_providers` is set in OpenCode config, `opencode-finance` auto-includes its finance auth provider IDs at runtime so they appear in `opencode auth login`. Explicit `disabled_providers` entries still hide them.

## Manual plugin enable (advanced)

If you need manual setup, add the plugin package in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-finance"]
}
```

OpenCode installs npm plugins automatically on startup.

```bash
bun run --cwd packages/opencode-finance migrate
```

It migrates auth credentials, portfolio holdings, and the `finance-comprehensive-report` skill.

## Development

```bash
bun install
bun run typecheck
bun run build
```

## Commands, tools, and providers

### Slash commands

| Slash command                                                          | Aliases                                             | What it does                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/quote <ticker>`                                                      | -                                                   | Fetches a quick quote snapshot (price, previous close, daily change/percent, source/timestamp).              |
| `/metrics <ticker>`                                                    | -                                                   | Fetches key fundamentals (revenue, income, margins, debt/equity, ROE, free cash flow).                       |
| `/filings <ticker> [form]`                                             | -                                                   | Summarizes recent SEC filings, optionally filtered by form type.                                             |
| `/watch <ticker>`                                                      | -                                                   | Produces a concise watch-style snapshot using quote and fundamentals.                                        |
| `/portfolio [args]`                                                    | -                                                   | Lists, upserts, removes, or clears stored holdings.                                                          |
| `/report-portfolio`                                                    | `/portfolio-report`                                 | Generates portfolio-level performance insights from stored holdings.                                         |
| `/report-insiders [ticker]`                                            | `/insiders-report`                                  | Generates a Quiver plan-aware insider/government-trading report (ticker or portfolio mode).                  |
| `/financial-government-trading [ticker]`                               | `/government-trading`, `/report-government-trading` | Generates strict government-trading delta artifacts from required Quiver datasets.                           |
| `/financial-political-backtest [ticker\|portfolio] [windows] [anchor]` | `/political-backtest`                               | Runs a strict political-trading event-study backtest in ticker or portfolio mode.                            |
| `/financial-darkpool-anomaly [ticker]`                                 | `/darkpool-anomaly`                                 | Detects statistically significant darkpool anomalies (ticker or portfolio mode).                             |
| `/market [scope]`                                                      | -                                                   | Produces a high-level market summary (optionally scoped to a region/index).                                  |
| `/report <ticker> [focus]`                                             | -                                                   | Runs the comprehensive company report workflow (`finance-comprehensive-report`) and writes report artifacts. |
| `/report-pdf <profile> <output_root> [filename]`                       | `/pdf-report`                                       | Exports an existing artifact directory to PDF with profile-specific quality gates.                           |
| `/onboard`                                                             | -                                                   | Runs finance setup checks (required/optional providers and report skill readiness).                          |

### Tools

| Tool                           | What it does                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `financial_search`             | Finance data retrieval for quotes, fundamentals, filings, insider activity, and news with source/timestamp metadata.                       |
| `portfolio`                    | Manages stored holdings (`list`, `upsert`, `remove`, `clear`).                                                                             |
| `portfolio_report`             | Builds portfolio-level analytics from stored holdings plus fresh market data.                                                              |
| `report_insiders`              | Generates tier-gated Quiver insider/government-trading artifacts (`insiders-report.md`, `insiders-data.json`).                             |
| `report_government_trading`    | Generates strict government-trading delta artifacts with normalization, baseline comparison, and persistence trends.                       |
| `report_darkpool_anomaly`      | Generates strict statistical darkpool anomaly artifacts (`report.md`, `dashboard.md`, `assumptions.json`, `evidence.json`, `evidence.md`). |
| `financial_political_backtest` | Runs event-study backtests around political-trading events and writes deterministic artifacts.                                             |
| `report_pdf`                   | Generates polished PDFs from workflow artifacts using profile-specific section plans and quality gates.                                    |

### `report_pdf` profiles

| Profile              | Expected artifact set                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `report`             | `report.md`, `dashboard.md`, `assumptions.json`                                                             |
| `government-trading` | `report.md`, `dashboard.md`, `assumptions.json`, `normalized-events.json`, `delta-events.json`, `data.json` |
| `darkpool-anomaly`   | `report.md`, `dashboard.md`, `assumptions.json`, `evidence.md`, `evidence.json`                             |
| `political-backtest` | `report.md`, `dashboard.md`, `assumptions.json`, `aggregate-results.json`, `comparison.json`                |

### Auth providers

| Provider ID               | Name                    | Credential type | Typical use                         |
| ------------------------- | ----------------------- | --------------- | ----------------------------------- |
| `yfinance`                | Yahoo Finance           | none            | Public finance data                 |
| `alphavantage`            | Alpha Vantage           | API key         | Quotes, fundamentals, news          |
| `finnhub`                 | Finnhub                 | API key         | Quotes, fundamentals, insider/news  |
| `financial-modeling-prep` | Financial Modeling Prep | API key         | Quotes, fundamentals, news          |
| `polygon`                 | Polygon                 | API key         | Market/reference/news data          |
| `quartr`                  | Quartr                  | API key         | Reports, events, news               |
| `quiver-quant`            | Quiver Quant            | API key         | Insider/government trading datasets |
| `sec-edgar`               | SEC EDGAR               | identity header | Official SEC filings                |
