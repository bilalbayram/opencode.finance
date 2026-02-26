import { describe, expect, test } from "bun:test"
import { ReportPdfInternal } from "../../src/tool/report_pdf"

const VALID_REPORT = `# Political Event Backtest: AAA

Generated at: 2026-02-26T00:00:00.000Z
Mode: ticker
Tickers: AAA
Anchor Mode: transaction
Windows (sessions): 1, 5
Benchmark Mode: spy_plus_sector_if_relevant
Benchmarks: SPY, XLF

## Executive Summary
- Political events analyzed: 4
`

const VALID_DASHBOARD = `# Political Backtest Dashboard: AAA

- Mode: ticker
- Tickers: AAA
- Events: 4
- Benchmarks: SPY, XLF

| Anchor | Window | Benchmark | Sample | Hit Rate % | Median Return % | Mean Return % | Mean Excess % |
|---|---:|---|---:|---:|---:|---:|---:|
| transaction | 1 | SPY | 4 | 50.00 | 0.200 | 0.250 | 0.100 |
`

const VALID_ASSUMPTIONS = JSON.stringify(
  {
    workflow: "financial_political_backtest",
  },
  null,
  2,
)

const VALID_AGGREGATE = JSON.stringify(
  [
    {
      anchor_kind: "transaction",
      window_sessions: 1,
      benchmark_symbol: "SPY",
      sample_size: 4,
      hit_rate_percent: 50,
      mean_return_percent: 0.25,
      median_return_percent: 0.2,
      stdev_return_percent: 0.3,
      mean_excess_return_percent: 0.1,
      mean_relative_return_percent: 0.1,
    },
  ],
  null,
  2,
)

const VALID_COMPARISON = JSON.stringify(
  {
    first_run: false,
    baseline: {
      output_root: "/tmp/reports/AAA/2026-02-25",
      generated_at: "2026-02-25T00:00:00.000Z",
    },
    aggregate_drift: [],
    event_sample: {
      current: 4,
      baseline: 3,
      new_events: ["e4"],
      removed_events: [],
      persisted_events: ["e1", "e2", "e3"],
    },
    conclusion_changes: [],
  },
  null,
  2,
)

const MIN_INFO = {
  title: "Political Event Backtest: AAA",
  ticker: "AAA",
  date: "2026-02-26",
  sector: "political backtest",
  headquarters: "unknown",
  icon: "",
  score: "BKT",
  band: "NEUTRAL",
  summary: "summary",
  positive: ["signal"],
  negative: ["delta"],
  metrics: [],
}

describe("report_pdf political-backtest profile", () => {
  test("accepts political-backtest subcommand", () => {
    expect(ReportPdfInternal.parsePdfSubcommand("political-backtest")).toBe("political-backtest")
  })

  test("builds expected section plan for political-backtest profile", () => {
    const sections = ReportPdfInternal.sectionPlanForSubcommand("political-backtest", {
      report: VALID_REPORT,
      dashboard: VALID_DASHBOARD,
      assumptions: VALID_ASSUMPTIONS,
      aggregateJson: VALID_AGGREGATE,
      comparisonJson: VALID_COMPARISON,
    })

    expect(sections.map((item) => item.title)).toEqual([
      "Dashboard",
      "Full Report",
      "Aggregate Results",
      "Longitudinal Comparison",
      "Assumptions",
    ])
  })

  test("routes political-backtest profile through dedicated quality gate", () => {
    const issues = ReportPdfInternal.qualityIssuesBySubcommand({
      subcommand: "political-backtest",
      info: MIN_INFO,
      report: VALID_REPORT,
      dashboard: VALID_DASHBOARD,
      assumptions: VALID_ASSUMPTIONS,
      comparisonJson: VALID_COMPARISON,
    })

    expect(issues.some((item) => item.includes("aggregate-results.json"))).toBe(true)
  })

  test("flags invalid comparison shape for non-first-run payload", () => {
    const issues = ReportPdfInternal.qualityIssuesPoliticalBacktest({
      report: VALID_REPORT,
      dashboard: VALID_DASHBOARD,
      assumptions: VALID_ASSUMPTIONS,
      aggregateJson: VALID_AGGREGATE,
      comparisonJson: JSON.stringify({
        first_run: false,
        baseline: null,
        event_sample: {
          current: 4,
          baseline: 3,
          new_events: [],
          removed_events: [],
        },
      }),
    })

    expect(issues.some((item) => item.includes("baseline"))).toBe(true)
  })

  test("passes political-backtest quality gates with valid required artifacts", () => {
    const issues = ReportPdfInternal.qualityIssuesPoliticalBacktest({
      report: VALID_REPORT,
      dashboard: VALID_DASHBOARD,
      assumptions: VALID_ASSUMPTIONS,
      aggregateJson: VALID_AGGREGATE,
      comparisonJson: VALID_COMPARISON,
    })

    expect(issues).toHaveLength(0)
  })
})
