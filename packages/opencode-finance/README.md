# opencode-finance

Finance workflow plugin for OpenCode.

## Quick install

```bash
curl -fsSL https://opencode.finance/install.sh | bash
```

The installer:
- Installs OpenCode if missing.
- Adds `opencode-finance` to your OpenCode config plugin list.
- Prompts for finance credentials and writes them directly to OpenCode auth storage.
- Installs or updates the `finance-comprehensive-report` skill at `~/.opencode/skills/finance-comprehensive-report/SKILL.md`.

## Manual plugin enable (advanced)

If you need manual setup, add the plugin package in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-finance"]
}
```

OpenCode installs npm plugins automatically on startup.

Finance credential setup is handled by `https://opencode.finance/install.sh`.

If your OpenCode config uses `enabled_providers`, this plugin auto-includes its finance auth provider IDs at runtime so they remain visible in `opencode auth login`.

`disabled_providers` still takes precedence. If you disable a finance provider there, it will stay hidden from the picker.

## Commands and tools


The plugin adds finance commands (`/quote`, `/metrics`, `/filings`, `/watch`, `/portfolio`, `/report-portfolio`, `/report-insiders`, `/financial-government-trading`, `/financial-darkpool-anomaly`, `/report-pdf`, `/market`, `/report`, `/onboard`) and tools (`financial_search`, `portfolio`, `portfolio_report`, `report_insiders`, `report_government_trading`, `report_pdf`).

`/report` is the comprehensive report workflow powered by the `finance-comprehensive-report` skill and profile-based `report_pdf` export (`subcommand: report`) after markdown artifacts.

`/report-pdf` requires an explicit profile mode: `report`, `government-trading`, or `darkpool-anomaly`.

## Migration helper

For finance-fork users moving to OpenCode + plugin:

```bash
bun run --cwd packages/opencode-finance migrate
```
