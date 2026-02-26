export type FinanceSlashCommand = {
  name: string
  description: string
  template: string
  hints: string[]
  aliases?: string[]
}

export const FINANCE_SLASH_COMMANDS: FinanceSlashCommand[] = [
  {
    name: "quote",
    description: "Get a quick quote for one ticker",
    hints: ["$1"],
    template:
      'Get the latest quote for "$1". Return price, currency, previous close, absolute change, and change percent with source/timestamp.\n\nUse financial_search with query "$1 quote" and intent "quote".',
  },
  {
    name: "metrics",
    description: "Get fundamental metrics for one ticker",
    hints: ["$1"],
    template:
      'Fetch latest key metrics for "$1" (revenue, net income, margins, debt/equity, return on equity, free cash flow). Return source and timestamp from the tool result.\n\nUse financial_search with query "$1 fundamentals" and intent "fundamentals".',
  },
  {
    name: "filings",
    description: "Fetch recent SEC filings for ticker (optional form)",
    hints: ["$1", "$2"],
    template:
      'Summarize recent SEC filings for "$1". If a form code is provided in $2, restrict to that form only.\n\nUse financial_search with query "$1 filing $2" and intent "filings".',
  },
  {
    name: "watch",
    description: "Create a watch-style snapshot for a ticker",
    hints: ["$1"],
    template:
      'Create a watch-style snapshot for "$1" using the latest quote and fundamentals. Keep it concise and factual; do not provide advice.\n\nUse financial_search with query "$1 watch" and intent "quote" first, then intent "fundamentals" as needed.',
  },
  {
    name: "portfolio",
    description: "Manage stored holdings (ticker, price bought, date bought)",
    hints: ["$ARGUMENTS"],
    template:
      'Manage stored portfolio holdings using the `portfolio` tool.\n\nArgument behavior:\n- `/portfolio` -> list holdings\n- `/portfolio <ticker> <price_bought> <YYYY-MM-DD>` -> add/update one holding\n- `/portfolio remove <ticker>` -> remove one holding\n- `/portfolio clear` -> clear all holdings\n\nExecution rules:\n1) If no first argument exists, call `portfolio` with `{ action: "list" }`.\n2) If first argument is `remove`, call `portfolio` with `{ action: "remove", ticker: "$2" }`.\n3) If first argument is `clear`, call `portfolio` with `{ action: "clear" }`.\n4) Otherwise call `portfolio` with `{ action: "upsert", ticker: "$1", price_bought: <number from "$2">, date_bought: "$3" }`.\n5) After any write action (`upsert`, `remove`, `clear`), call `portfolio` with `{ action: "list" }` and present holdings in a compact table with `ticker`, `price_bought`, `date_bought`.\n6) If required arguments are missing or invalid, explain exact usage and do not invent values.',
  },
  {
    name: "report-portfolio",
    description: "Generate portfolio-level insights from stored holdings",
    hints: [],
    aliases: ["portfolio-report"],
    template:
      'Generate portfolio-level insights for all stored holdings.\n\nFirst call `portfolio_report` with `{ coverage: "comprehensive" }`.\n\nThen provide:\n1) concise executive summary\n2) holdings table with `ticker`, `date_bought`, `price_bought`, `current_price`, `per_share_pnl`, `return_percent`, `day_change_percent`, `ytd_return_percent`, `held_days`\n3) key insights: winner/loser split, best/worst holdings, average return, and notable risk flags (drawdown, large daily movers, missing quote data)\n4) data quality note with retrieval timestamp and unknown fields called out explicitly\n\nIf no holdings exist, instruct the user to add holdings with `/portfolio <ticker> <price_bought> <YYYY-MM-DD>`.\n\nDo not provide investment advice.',
  },
  {
    name: "report-insiders",
    description: "Generate Quiver plan-aware insider/government-trading insights",
    hints: ["$1"],
    aliases: ["insiders-report"],
    template:
      'Generate a tier-aware insider report using Quiver Quant.\n\nExecution rules:\n1) If "$1" exists, call `report_insiders` with `{ ticker: "$1", limit: 50 }`.\n2) If "$1" is missing, call `report_insiders` with `{ limit: 50 }` for portfolio mode.\n3) Then provide a concise in-chat executive summary with:\n   - mode (`ticker` or `portfolio`)\n   - Quiver plan used (`Public`, `Hobbyist`, `Trader`, or `Enterprise`)\n   - coverage/degradation notes including `not_attempted_due_to_tier`\n   - last 7-day insider/government activity highlights\n   - global government-trading summary (congress/senate/house)\n4) Point directly to artifact files from the tool output:\n   - `insiders-report.md`\n   - `insiders-data.json`\n\nIf tool output reports missing Quiver setup, show:\n`curl -fsSL https://opencode.finance/install.sh | bash`\n\nDo not provide investment advice.',
  },
  {
    name: "financial-government-trading",
    description: "Generate strict government-trading delta artifacts from Quiver Tier 1 feeds",
    hints: ["$1"],
    aliases: ["government-trading", "report-government-trading"],
    template:
      'Generate a strict government-trading report using Quiver Quant required datasets.\n\nExecution rules:\n1) If "$1" exists, call `report_government_trading` with `{ ticker: "$1", limit: 50 }`.\n2) If "$1" is missing, call `report_government_trading` with `{ limit: 50 }` for global mode (no portfolio holdings required).\n3) Then provide a concise in-chat summary with:\n   - mode and scope\n   - generated_at, run_id, and baseline_run_id\n   - delta counts (`new_events`, `updated_events`, `unchanged_events`, `no_longer_present_events`)\n   - persistence trend highlights\n   - source attribution timestamps for required datasets\n4) Point directly to artifact files from the tool output:\n   - `report.md`\n   - `dashboard.md`\n   - `assumptions.json`\n   - `normalized-events.json`\n   - `delta-events.json`\n   - `data.json`\n5) After summary, ask exactly one user question with the `question` tool:\n   - header: `PDF Export`\n   - question: `Generate a polished PDF report now?`\n   - options:\n     1) `Yes (Recommended)` - Generate a polished PDF in the same output directory.\n     2) `No` - Skip PDF generation.\n   - custom: `false`\n6) If user selects `Yes (Recommended)`, call `report_pdf` with:\n   - `subcommand`: `government-trading`\n   - `outputRoot`: `<artifacts.output_root>`\n   - `filename`: `government-trading-<run_id>.pdf`\n\nIf tool output reports missing Quiver setup, show:\n`curl -fsSL https://opencode.finance/install.sh | bash`\n\nIf `question` is unavailable in this client context, skip PDF export and complete normally.\n\nDo not provide investment advice.',
  },
  {
    name: "market",
    description: "Summarize current market overview",
    hints: ["$ARGUMENTS"],
    template:
      "Provide a high-level market summary using available finance sources. If the user passes a specific region or index, tailor the summary. Keep uncertainty explicit when data is missing.",
  },
  {
    name: "financial-darkpool-anomaly",
    description: "Detect statistically significant off-exchange (darkpool) anomalies",
    hints: ["$1"],
    aliases: ["darkpool-anomaly"],
    template:
      'Generate darkpool anomaly analysis with strict statistical criteria.\n\nExecution rules:\n1) If "$1" exists, call `report_darkpool_anomaly` with `{ ticker: "$1" }`.\n2) If "$1" is missing, call `portfolio` with `{ action: "list" }`.\n3) If holdings exist, call `report_darkpool_anomaly` in portfolio mode with `{}`.\n4) If holdings are empty, stop and ask for a ticker using `/financial-darkpool-anomaly <ticker>`.\n5) Then provide a concise in-chat summary with:\n   - mode (`ticker` or `portfolio`)\n   - Quiver plan used\n   - anomaly counts by transition (`new`, `persisted`, `severity_change`, `resolved`)\n   - top anomalies with severity, direction, and z-score\n6) Point directly to artifact files from tool output:\n   - `report.md`\n   - `dashboard.md`\n   - `assumptions.json`\n   - `evidence.json`\n   - `evidence.md`\n\nAfter markdown artifacts are written, ask exactly one user question with the `question` tool:\n- header: `PDF Export`\n- question: `Generate a polished PDF report now?`\n- options:\n  1) `Yes (Recommended)` - Generate a polished PDF in the report directory.\n  2) `No` - Skip PDF generation.\n- custom: `false`\n\nIf user selects `Yes (Recommended)`, call `report_pdf` with:\n- `subcommand`: `darkpool-anomaly`\n- `outputRoot`: darkpool artifact `output_root` from `report_darkpool_anomaly`\n- `filename`: `<ticker-or-portfolio>-<YYYY-MM-DD>-darkpool-anomaly.pdf`\n\nIf `question` is unavailable in this client context, skip PDF export and complete analysis normally.\n\nDo not provide investment advice.',
  },
  {
    name: "report-pdf",
    description: "Export finance artifacts to PDF using a profile-specific quality gate",
    hints: ["$1", "$2", "$3"],
    aliases: ["pdf-report"],
    template:
      'Export an existing artifact directory to PDF.\n\nUsage:\n- `/report-pdf report <output_root> [filename]`\n- `/report-pdf government-trading <output_root> [filename]`\n\nExecution rules:\n1) Require `$1` to be exactly `report` or `government-trading` or `darkpool-anomaly`; if invalid, stop and show usage.\n2) Require `$2` as output directory path.\n3) Call `report_pdf` with:\n   - `subcommand`: `$1`\n   - `outputRoot`: `$2`\n   - `filename`: `$3` when provided\n4) Return the generated PDF path and profile used.\n\nDo not invent paths.',
  },
  {
    name: "report",
    description: "Generate a comprehensive public-company financial report",
    hints: ["$1", "$2"],
    template:
      'Build a very comprehensive public-company financial report for "$1".\n\nFirst call the skill tool with name "finance-comprehensive-report".\n\nThen produce:\n1) a concise in-chat executive summary including `directional_conviction_score` (0-100), score band (`bearish`, `neutral`, `bullish`), and top drivers\n2) markdown artifacts in `reports/$1/<YYYY-MM-DD>/`:\n   - `report.md`\n   - `dashboard.md`\n   - `assumptions.json`\n   - `adjustment-log.md`\n\nInside `report.md`, include dedicated sections for technical analysis, fundamental analysis, risk assessment, portfolio fit, market intelligence, scenario valuation, and monitoring triggers.\n\nInside `assumptions.json`, include `scenario_assumptions`, `score_inputs`, `factor_weights`, and `uncertainty_flags`.\n\nUse `financial_search` with `coverage: \"comprehensive\"` for numeric financial claims. Use Exa (`websearch`) only for qualitative news/catalyst context, never for numeric financial metrics.\n\nFor every factual claim, include the actual publisher/domain source label and URL plus retrieval timestamp. Never use generic source labels like `websearch`, `exa`, `search`, or `internet`.\n\nIn `dashboard.md`, include separate KPI rows for Stock price, Previous close, Daily change, Daily change percent, 52W high/low or 52W range, YTD return, Market cap, Analyst consensus, Revenue, Net income, Free cash flow, and Debt-to-equity.\n\nFor insider analysis, call `financial_search` with intent `insider` and `coverage: \"comprehensive\"`, and use returned `ownershipChange` when available.\n\nKeep KPI source labels and source URLs coherent (for example, Yahoo chart label must use Yahoo chart URL).\n\nIn `report.md`, include metadata lines: `Sector: <value>`, `Headquarters: <value>`, `Website: <value>`, and `Icon URL: <value>`.\n\nUse period-aware fundamental labels based on `metricPeriods` (`TTM`, `FY`, `Q`); do not force `(TTM)` when the period differs.\n\nWhen portfolio holdings/benchmark/mandate are missing, render portfolio fit as `Not evaluated: missing portfolio holdings, benchmark, and mandate`.\n\nNever emit the token `N/A` in report artifacts. Use observed values or explicit `unknown`/reason text.\n\nAfter all markdown artifacts are written, ask exactly one user question with the `question` tool:\n- header: `PDF Export`\n- question: `Generate a polished PDF report now?`\n- options:\n  1) `Yes (Recommended)` - Generate a polished PDF in the report directory.\n  2) `No` - Skip PDF generation.\n- custom: `false`\n\nIf user selects `Yes (Recommended)`, call `report_pdf` with:\n- `subcommand`: `report`\n- `outputRoot`: `reports/$1/<YYYY-MM-DD>/`\n- `filename`: `$1-<YYYY-MM-DD>.pdf`\n\nIf `question` is unavailable in this client context, skip PDF export and complete the report normally.\n\nPDF requirements:\n- first page: ticker summary\n- remaining pages: report information from `report.md`, `dashboard.md`, and `assumptions.json` (exclude `adjustment-log.md`)\n- footer on every page must display `opencode.finance` and link to `https://opencode.finance`\n\nInclude source and timestamp for factual claims, label missing values as "unknown", and keep observed data separate from model assumptions and inference. Do not provide investment advice.',
  },
]
