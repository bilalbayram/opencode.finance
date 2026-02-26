import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it } from "bun:test"
import { ReportPdfTool } from "./report_pdf"

function toolContext(worktree: string) {
  return {
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  } as any
}

describe("ReportPdfTool", () => {
  it("generates PDF for government-trading artifacts without equity quality-gate requirements", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gov-pdf-"))
    try {
      await Promise.all([
        fs.writeFile(
          path.join(root, "report.md"),
          [
            "# Government Trading Report",
            "",
            "## Run Metadata",
            "- mode: ticker",
            "- scope: AAPL",
            "- generated_at: 2026-02-26T00:00:00.000Z",
            "- run_id: 2026-02-26__00-00-00.000Z",
          ].join("\n"),
          "utf8",
        ),
        fs.writeFile(
          path.join(root, "dashboard.md"),
          [
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
          "utf8",
        ),
        fs.writeFile(path.join(root, "assumptions.json"), JSON.stringify({ mode: "ticker" }, null, 2), "utf8"),
      ])

      const tool = await ReportPdfTool.init()
      const result = await tool.execute({ outputRoot: root, filename: "government-trading.pdf" }, toolContext(root))

      const outputPath = path.join(root, "government-trading.pdf")
      const stat = await fs.stat(outputPath)
      expect(result.output).toContain("Generated PDF report at")
      expect(stat.size).toBeGreaterThan(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("keeps equity quality-gate enforcement for incomplete company reports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "equity-pdf-"))
    try {
      await Promise.all([
        fs.writeFile(path.join(root, "report.md"), "# ACME Report\nTicker: unknown\n", "utf8"),
        fs.writeFile(path.join(root, "dashboard.md"), "# Dashboard\n", "utf8"),
        fs.writeFile(path.join(root, "assumptions.json"), "{}\n", "utf8"),
      ])

      const tool = await ReportPdfTool.init()
      await expect(tool.execute({ outputRoot: root, filename: "equity.pdf" }, toolContext(root))).rejects.toThrow(
        /PDF export blocked by institutional quality gate/,
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
