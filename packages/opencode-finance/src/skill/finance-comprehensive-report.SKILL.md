---
name: finance-comprehensive-report
description: Build a comprehensive, audit-traceable public-company financial report using technical, fundamental, risk, portfolio-fit, and market-intelligence analysis plus scenario valuation and non-advice directional conviction scoring.
managed_by: opencode-finance
workflow_version: 4
---

# Finance Comprehensive Report

## Input Requirements
- `ticker` (required): public company symbol, for example `AAPL`.
- `focus` (optional): emphasis area such as `forensic`, `valuation`, `governance`, or `credit`.
- `report_date` (optional): date override in `YYYY-MM-DD`; default to today.
- `output_root` (optional): base output directory; default `reports/<ticker>/<report_date>/`.
- `portfolio_context` (optional): existing positions, weights, mandate, and risk budget for portfolio-fit analysis.
- `benchmark` (optional): market or sector benchmark symbol, for example `SPY`, `QQQ`, or a sector ETF.

## Workflow
1. Resolve and normalize the ticker symbol.
2. Retrieve quote, fundamentals, filings, insider, and news context with `financial_search` first, using `coverage: "comprehensive"` for numeric claims.
3. Build a data ledger that separates observed values, modeled assumptions, and analytical inference.
4. Run the technical analysis module:
   - trend regime and momentum context
   - volatility and drawdown profile
   - support and resistance zones with source coverage notes
5. Run the fundamental analysis module:
   - profitability, valuation, liquidity, and cash flow quality review
   - normalization adjustments with explicit rationale in `adjustment-log.md`
6. Run the risk assessment module:
   - business model, balance sheet, valuation, and event risks
   - downside pathways and break-the-thesis thresholds
7. Run the portfolio-fit module:
   - estimate diversification or concentration impact relative to `portfolio_context` and `benchmark` when provided
   - if not provided, render `Not evaluated: missing portfolio holdings, benchmark, and mandate`
8. Run the market-intelligence module:
   - sector and macro context
   - catalyst calendar and monitoring triggers
9. Run scenario-based forecast and valuation:
   - base/bull/bear assumptions with probabilities
   - sensitivity and value-attribution summary
10. Compute directional conviction output:
   - produce `directional_conviction_score` in `0-100`
   - map score bands to `bearish` (0-39), `neutral` (40-59), or `bullish` (60-100)
   - provide top positive and negative drivers with weighting rationale
11. Produce deliverables and reproducibility metadata.
12. After writing all report artifacts, ask whether to generate a PDF:
   - use `question` with:
     - header: `PDF Export`
     - question: `Generate a polished PDF report now?`
     - options:
       - `Yes (Recommended)` - generate PDF
       - `No` - skip PDF generation
     - `custom: false`
   - if user picks `Yes (Recommended)`, call `report_pdf` with:
     - `subcommand`: `report`
     - `outputRoot`: `reports/<ticker>/<report_date>/`
     - `filename`: `<ticker>-<report_date>.pdf`
   - if `question` is unavailable in this client context, skip PDF export and complete the report.

## Output Requirements
- Return a concise in-chat executive summary with:
  - thesis, top risks, catalysts, monitoring triggers, and directional conviction output.
- Write markdown-first artifacts to `reports/<ticker>/<report_date>/`:
  - `report.md`: full comprehensive report
  - `dashboard.md`: one-page KPI, threshold, and catalyst dashboard
  - `assumptions.json`: scenario assumptions, probabilities, and key drivers
  - `adjustment-log.md`: normalization entries and rationale
- Optionally write PDF artifact when user opts in via `question`:
  - `<ticker>-<report_date>.pdf`
  - first page: summary of ticker report
  - remaining pages: report information from `report.md`, `dashboard.md`, and `assumptions.json` (exclude `adjustment-log.md`)
  - footer on every page: display `opencode.finance`, linked to `https://opencode.finance`
- Ensure `report.md` includes dedicated sections for:
  - technical analysis
  - fundamental analysis
  - risk assessment
  - portfolio fit
  - market intelligence
  - scenario valuation
  - directional conviction score and monitoring triggers
  - `## Sources` (IEEE-format bibliography, must be the final section in `report.md`)
- Ensure `report.md` includes explicit metadata lines at the **top of the file** (before the first analytical section). These lines are extracted for the PDF cover page and must not be repeated inline in analytical sections:
  - `Sector: <value>` — use human-readable labels (e.g. "Automotive", "Technology"), not raw API format like `CONSUMER CYCLICAL`
  - `Headquarters: <value>` — use short format `City, State, Country` (e.g. "Austin, TX, USA"), not full street address
  - `Website: <value>`
  - `Icon URL: <value>`
- Ensure `report.md` includes explicit driver headings with concise, human-readable bullet points (not raw inference sentences):
  - `Top Positive Drivers`
  - `Top Negative Drivers`
- Ensure insider analysis uses `financial_search` with `intent: "insider"` and `coverage: "comprehensive"` and references returned `ownershipChange` when available.
- Ensure KPI rows include separate entries for:
  - Stock price
  - Previous close
  - Daily change
  - Daily change percent
  - 52W high/low or 52W range
  - YTD return
  - Market cap
  - Analyst consensus
  - Revenue
  - Net income
  - Free cash flow
  - Debt-to-equity
- Ensure KPI source labels and source URLs are coherent (for example, Yahoo chart label must use Yahoo chart URL).
- Use period-aware metric labels in KPI/ledger rows (`TTM`, `FY`, or `Q`) based on `metricPeriods`; do not force `(TTM)` when period differs.
- Ensure `assumptions.json` includes:
  - `scenario_assumptions`
  - `score_inputs`
  - `factor_weights`
  - `uncertainty_flags`

## Data and Citation Rules
- Use IEEE-style numbered citations: place `[N]` markers in-text for each factual claim. Collect all references in a final `## Sources` section at the end of `report.md`.
- Each entry in `## Sources` must follow this format:
  `[N] Publisher/Domain Label, "page or dataset title," URL. Retrieved YYYY-MM-DD.`
- The `## Sources` section must be the **last** section in `report.md`. No analytical content may appear after it.
- **Never** use alternative section names like `Source Register`, `Reference List`, or alternative marker formats like `S1`, `Sn`, `(S1)`. Only `## Sources` with `[N]` markers.
- Use `financial_search` as the primary source for finance data, with `coverage: "comprehensive"` for numeric claims.
- Use Exa (`websearch`) only for qualitative market and catalyst context, never for numeric financial metrics.
- Never use generic source labels (`websearch`, `exa`, `search`, `internet`) in output artifacts.
- If tool outputs are incomplete or errors are present:
  - mark unresolved fields as `unknown`
  - never use `N/A` in artifacts
  - keep uncertainty explicit
  - do not invent missing values.
- Clearly separate:
  - observed data
  - model assumptions
  - analytical inference.

## Failure Modes
- Missing or invalid ticker:
  - stop and request a valid symbol.
- Insufficient data to support a section:
  - keep section with `unknown` placeholders and list specific gaps.
- Missing `portfolio_context` or `benchmark`:
  - continue and render portfolio fit as `Not evaluated: missing portfolio holdings, benchmark, and mandate`.
- Conflicting data across providers:
  - prefer most recent timestamped source and record discrepancy in `adjustment-log.md`.
- Tool/provider failure:
  - return partial report with explicit `known_unknowns` and next retrieval steps.

## Completion Criteria
- Deliver all four artifacts under the default output path unless user overrides output root.
- Ensure each major section has at least one cited source or an explicit `unknown` note.
- Include `directional_conviction_score`, score band, weighted drivers, and explicit non-advice disclaimer.
- End with a non-advice decision framework:
  - what must be true
  - what breaks the thesis
  - how to detect breaks early.
