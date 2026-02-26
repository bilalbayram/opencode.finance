import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it } from "bun:test"
import { ReportPdfInternal, ReportPdfTool } from "./report_pdf"

const COVER = {
  title: "AAPL Research Report",
  ticker: "AAPL",
  date: "2026-02-26",
  sector: "Technology",
  headquarters: "Cupertino",
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

const GOVERNMENT_ARTIFACTS = {
  report: [
    "# Government Trading Report",
    "",
    "## Run Metadata",
    "- mode: ticker",
    "- scope: AAPL",
    "- generated_at: 2026-02-26T00:00:00.000Z",
    "- run_id: 2026-02-26__00-00-00.000Z",
  ].join("\n"),
  dashboard: [
    "# Government Trading Dashboard",
    "",
    "## Delta Counts",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    "| current_events | 10 |",
    "| new_events | 2 |",
    "| updated_events | 1 |",
    "| unchanged_events | 7 |",
    "| no_longer_present_events | 0 |",
  ].join("\n"),
  assumptions: JSON.stringify({ mode: "ticker", run_id: "2026-02-26__00-00-00.000Z" }, null, 2),
  normalizedEventsJson: JSON.stringify([{ identityKey: "x" }], null, 2),
  deltaEventsJson: JSON.stringify({ delta: { new_events: [] } }, null, 2),
  dataJson: JSON.stringify({ summary: { current_events: 10 } }, null, 2),
}

function toolContext(worktree: string) {
  return {
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  } as any
}

describe("report_pdf subcommand parsing", () => {
  it("rejects missing subcommand with friendly message", () => {
    expect(() => ReportPdfInternal.parsePdfSubcommand(undefined)).toThrow(
      /subcommand is required\. Use one of: report, government-trading/,
    )
  })

  it("rejects invalid subcommand with friendly message", () => {
    expect(() => ReportPdfInternal.parsePdfSubcommand("unknown")).toThrow(
      /subcommand must be one of: report, government-trading/,
    )
  })
})

describe("report_pdf government-trading profile", () => {
  it("accepts valid government-trading artifact set", () => {
    const issues = ReportPdfInternal.qualityIssuesGovernmentTrading({
      report: GOVERNMENT_ARTIFACTS.report,
      dashboard: GOVERNMENT_ARTIFACTS.dashboard,
      assumptions: GOVERNMENT_ARTIFACTS.assumptions,
      normalizedEventsJson: GOVERNMENT_ARTIFACTS.normalizedEventsJson,
      deltaEventsJson: GOVERNMENT_ARTIFACTS.deltaEventsJson,
      dataJson: GOVERNMENT_ARTIFACTS.dataJson,
    })

    expect(issues).toEqual([])
  })

  it("fails when required delta metric is missing", () => {
    const issues = ReportPdfInternal.qualityIssuesGovernmentTrading({
      report: GOVERNMENT_ARTIFACTS.report,
      dashboard: GOVERNMENT_ARTIFACTS.dashboard.replace("| updated_events | 1 |", ""),
      assumptions: GOVERNMENT_ARTIFACTS.assumptions,
      normalizedEventsJson: GOVERNMENT_ARTIFACTS.normalizedEventsJson,
      deltaEventsJson: GOVERNMENT_ARTIFACTS.deltaEventsJson,
      dataJson: GOVERNMENT_ARTIFACTS.dataJson,
    })

    expect(issues.some((item) => item.includes("updated_events"))).toBeTrue()
  })

  it("fails when normalized-events.json is invalid", () => {
    const issues = ReportPdfInternal.qualityIssuesGovernmentTrading({
      report: GOVERNMENT_ARTIFACTS.report,
      dashboard: GOVERNMENT_ARTIFACTS.dashboard,
      assumptions: GOVERNMENT_ARTIFACTS.assumptions,
      normalizedEventsJson: "{\"bad\":true}",
      deltaEventsJson: GOVERNMENT_ARTIFACTS.deltaEventsJson,
      dataJson: GOVERNMENT_ARTIFACTS.dataJson,
    })

    expect(issues.some((item) => item.includes("normalized-events.json"))).toBeTrue()
  })
})

describe("report_pdf report profile", () => {
  it("keeps comprehensive quality gate strict", () => {
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
  it("government-trading section plan order is dashboard-first", () => {
    const plan = ReportPdfInternal.sectionPlanForSubcommand("government-trading", {
      report: GOVERNMENT_ARTIFACTS.report,
      dashboard: GOVERNMENT_ARTIFACTS.dashboard,
      assumptions: GOVERNMENT_ARTIFACTS.assumptions,
      normalizedEventsJson: GOVERNMENT_ARTIFACTS.normalizedEventsJson,
      deltaEventsJson: GOVERNMENT_ARTIFACTS.deltaEventsJson,
      dataJson: GOVERNMENT_ARTIFACTS.dataJson,
    })
    expect(plan.map((item) => item.title)).toEqual([
      "Dashboard",
      "Full Report",
      "Assumptions",
      "Delta Events",
      "Normalized Events",
    ])
  })

  it("report section plan remains unchanged", () => {
    const plan = ReportPdfInternal.sectionPlanForSubcommand("report", {
      report: "# Report\n",
      dashboard: "# Dashboard\n",
      assumptions: "{}",
    })
    expect(plan.map((item) => item.title)).toEqual(["Full Report", "Dashboard", "Assumptions"])
  })
})

describe("report_pdf root hint parsing", () => {
  it("extracts scope/run id for government-trading roots", () => {
    const hints = ReportPdfInternal.defaultRootHints(
      "/tmp/reports/government-trading/ticker/AAPL/2026-02-26__00-00-00.000Z",
      "government-trading",
    )
    expect(hints).toEqual({ ticker: "AAPL", date: "2026-02-26__00-00-00.000Z" })
  })
})

describe("ReportPdfTool execution", () => {
  it("generates PDF for government-trading artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gov-pdf-subcommand-"))
    try {
      await Promise.all([
        fs.writeFile(path.join(root, "report.md"), GOVERNMENT_ARTIFACTS.report, "utf8"),
        fs.writeFile(path.join(root, "dashboard.md"), GOVERNMENT_ARTIFACTS.dashboard, "utf8"),
        fs.writeFile(path.join(root, "assumptions.json"), GOVERNMENT_ARTIFACTS.assumptions, "utf8"),
        fs.writeFile(path.join(root, "normalized-events.json"), GOVERNMENT_ARTIFACTS.normalizedEventsJson, "utf8"),
        fs.writeFile(path.join(root, "delta-events.json"), GOVERNMENT_ARTIFACTS.deltaEventsJson, "utf8"),
        fs.writeFile(path.join(root, "data.json"), GOVERNMENT_ARTIFACTS.dataJson, "utf8"),
      ])

      const tool = await ReportPdfTool.init()
      const result = await tool.execute(
        { subcommand: "government-trading", outputRoot: root, filename: "government-trading.pdf" },
        toolContext(root),
      )

      const outputPath = path.join(root, "government-trading.pdf")
      const stat = await fs.stat(outputPath)
      expect(result.output).toContain("Generated PDF report at")
      expect(stat.size).toBeGreaterThan(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
