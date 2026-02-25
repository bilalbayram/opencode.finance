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

describe("report_pdf darkpool profile", () => {
  test("accepts valid darkpool artifact set", () => {
    const issues = ReportPdfInternal.qualityIssuesDarkpool({
      report:
        "# Darkpool Anomaly Report\n\nMode: ticker\nSignificance threshold (|z|): 3\n",
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
          tickers: [],
          anomalies: [],
          transitions: [],
        },
        null,
        2,
      ),
    })

    expect(issues).toEqual([])
  })

  test("fails when evidence json is missing transitions", () => {
    const issues = ReportPdfInternal.qualityIssuesDarkpool({
      report: "# Darkpool Anomaly Report\nMode: ticker\nSignificance threshold (|z|): 3\n",
      dashboard:
        "| Ticker | Date | Metric | Current | Baseline | |z| | Severity | Direction | State |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| AAPL | 2026-02-25 | OffExchangeVolume | 120 | 100 | 3.2 | medium | positive | new |\n",
      assumptions: JSON.stringify({ detection_parameters: { lookback_days: 120, min_samples: 30, significance_threshold: 3 } }),
      evidenceMarkdown: "# Darkpool Raw Evidence\n",
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

describe("report_pdf root hint parsing", () => {
  test("extracts ticker/date for darkpool roots", () => {
    const hints = ReportPdfInternal.defaultRootHints(
      "/tmp/reports/AAPL/2026-02-25/darkpool-anomaly",
      "darkpool-anomaly",
    )
    expect(hints).toEqual({ ticker: "AAPL", date: "2026-02-25" })
  })
})
