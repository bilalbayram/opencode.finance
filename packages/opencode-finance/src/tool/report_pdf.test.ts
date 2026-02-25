import { describe, expect, test } from "bun:test"
import { ReportPdfInternal } from "./report_pdf"

const COVER = {
  title: "Darkpool Anomaly Report",
  ticker: "AAPL",
  date: "2026-02-25",
  sector: "unknown",
  headquarters: "unknown",
  icon: "",
  score: "unknown",
  band: "UNKNOWN",
  summary: "summary",
  positive: ["unknown"],
  negative: ["unknown"],
  metrics: [
    { label: "Stock Price", value: "unknown", tone: "neutral" as const },
    { label: "Daily Change", value: "unknown", tone: "neutral" as const },
    { label: "YTD Return", value: "unknown", tone: "neutral" as const },
    { label: "52W Range", value: "unknown", tone: "neutral" as const },
    { label: "Analyst Consensus", value: "unknown", tone: "neutral" as const },
    { label: "Sector", value: "unknown", tone: "neutral" as const },
  ],
}

const DARKPOOL_ARTIFACTS = {
  report: "# Darkpool Anomaly Report\n\nMode: ticker\nSignificance threshold (|z|): 3\n",
  dashboard:
    "# Darkpool Anomaly Dashboard\n\n| Ticker | Date | Metric | Current | Baseline | |z| | Severity | Direction | State |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| AAPL | 2026-02-25 | OffExchangeVolume | 120 | 100 | 3.2 | medium | positive | new |\n",
  assumptions: JSON.stringify(
    {
      detection_parameters: {
        lookback_days: 120,
        min_samples: 30,
        significance_threshold: 3,
      },
    },
    null,
    2,
  ),
  evidenceMarkdown: "# Darkpool Raw Evidence\n",
  evidenceJson: JSON.stringify(
    {
      tickers: ["AAPL"],
      anomalies: [
        { key: "AAPL:DPI", ticker: "AAPL", severity: "medium", direction: "positive", abs_z_score: 3.2 },
        { key: "MSFT:DPI", ticker: "MSFT", severity: "high", direction: "negative", abs_z_score: 3.1 },
      ],
      transitions: [
        { state: "new", key: "AAPL:DPI", current: { key: "AAPL:DPI" } },
        { state: "persisted", key: "MSFT:DPI", current: { key: "MSFT:DPI" } },
      ],
    },
    null,
    2,
  ),
}

describe("report_pdf subcommand parsing", () => {
  test("rejects missing subcommand with friendly message", () => {
    expect(() => ReportPdfInternal.parsePdfSubcommand(undefined)).toThrow(
      /subcommand is required\. Use one of: report, darkpool-anomaly/,
    )
  })

  test("rejects invalid subcommand with friendly message", () => {
    expect(() => ReportPdfInternal.parsePdfSubcommand("unknown")).toThrow(
      /subcommand must be one of: report, darkpool-anomaly/,
    )
  })
})

describe("report_pdf darkpool profile", () => {
  test("accepts valid darkpool artifact set", () => {
    const issues = ReportPdfInternal.qualityIssuesDarkpool({
      report: DARKPOOL_ARTIFACTS.report,
      dashboard: DARKPOOL_ARTIFACTS.dashboard,
      assumptions: DARKPOOL_ARTIFACTS.assumptions,
      evidenceMarkdown: DARKPOOL_ARTIFACTS.evidenceMarkdown,
      evidenceJson: DARKPOOL_ARTIFACTS.evidenceJson,
    })

    expect(issues).toEqual([])
  })

  test("fails when evidence json is missing transitions", () => {
    const issues = ReportPdfInternal.qualityIssuesDarkpool({
      report: DARKPOOL_ARTIFACTS.report,
      dashboard: DARKPOOL_ARTIFACTS.dashboard,
      assumptions: DARKPOOL_ARTIFACTS.assumptions,
      evidenceMarkdown: DARKPOOL_ARTIFACTS.evidenceMarkdown,
      evidenceJson: JSON.stringify({ tickers: [], anomalies: [] }),
    })

    expect(issues.some((item) => item.includes("transitions"))).toBeTrue()
  })
})

describe("report_pdf report profile", () => {
  test("keeps comprehensive quality gate strict", () => {
    const issues = ReportPdfInternal.qualityIssuesBySubcommand({
      subcommand: "report",
      info: COVER,
      report: "# Report\n",
      dashboard: undefined,
      assumptions: undefined,
    })

    expect(issues.some((item) => item.includes("Directional conviction score"))).toBeTrue()
    expect(issues.some((item) => item.includes("Stock Price"))).toBeTrue()
  })
})

describe("report_pdf section plans", () => {
  test("darkpool section plan order is dashboard-first", () => {
    const plan = ReportPdfInternal.sectionPlanForSubcommand("darkpool-anomaly", DARKPOOL_ARTIFACTS)
    expect(plan.map((item) => item.title)).toEqual(["Dashboard", "Full Report", "Evidence", "Assumptions"])
  })

  test("report section plan remains unchanged", () => {
    const plan = ReportPdfInternal.sectionPlanForSubcommand("report", {
      report: "# Report\n",
      dashboard: "# Dashboard\n",
      assumptions: "{}",
    })
    expect(plan.map((item) => item.title)).toEqual(["Full Report", "Dashboard", "Assumptions"])
  })
})

describe("report_pdf darkpool cover extraction", () => {
  test("parses transitions and ranks anomalies by severity then abs z", () => {
    const parsed = ReportPdfInternal.extractDarkpoolCoverData(DARKPOOL_ARTIFACTS)
    expect(parsed.transitions).toEqual({ new: 1, persisted: 1, severity_change: 0, resolved: 0 })
    expect(parsed.topAnomalies[0]).toEqual({
      ticker: "MSFT",
      severity: "high",
      direction: "negative",
      absZ: 3.1,
      state: "persisted",
    })
  })

  test("fails predictably on malformed evidence payload", () => {
    expect(() =>
      ReportPdfInternal.extractDarkpoolCoverData({
        ...DARKPOOL_ARTIFACTS,
        evidenceJson: JSON.stringify({ transitions: "bad" }),
      }),
    ).toThrow(/`evidence\.json` must include `transitions` array\./)
  })
})

describe("report_pdf root hint parsing", () => {
  test("extracts ticker/date for darkpool roots", () => {
    const hints = ReportPdfInternal.defaultRootHints("/tmp/reports/AAPL/2026-02-25/darkpool-anomaly", "darkpool-anomaly")
    expect(hints).toEqual({ ticker: "AAPL", date: "2026-02-25" })
  })
})
