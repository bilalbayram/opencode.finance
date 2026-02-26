import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { FinancialPoliticalBacktestInternal } from "../../src/tool/financial_political_backtest"

describe("financial_political_backtest slice 7", () => {
  test("uses workflow-specific default output roots to avoid /report path collisions", () => {
    const context = {
      directory: "/tmp/project",
      worktree: "/tmp/project",
    }
    const tickerRoot = FinancialPoliticalBacktestInternal.defaultOutputRoot({
      context,
      mode: "ticker",
      ticker: "AAPL",
    })
    const portfolioRoot = FinancialPoliticalBacktestInternal.defaultOutputRoot({
      context,
      mode: "portfolio",
    })

    expect(tickerRoot).toContain("/reports/political-backtest/AAPL/")
    expect(portfolioRoot).toContain("/reports/political-backtest/portfolio/")
    expect(tickerRoot).not.toContain("/reports/AAPL/")
    expect(portfolioRoot).not.toContain("/reports/portfolio/")
  })

  test("does not mutate artifacts when edit permission is denied", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "political-backtest-permission-"))
    const outputRoot = path.join(temp, "reports", "TEST", "2025-01-01")
    const reportPath = path.join(outputRoot, "report.md")
    const dashboardPath = path.join(outputRoot, "dashboard.md")
    const historyRoot = path.join(outputRoot, "history")

    try {
      await fs.mkdir(outputRoot, { recursive: true })
      await Bun.write(reportPath, "existing report")
      await Bun.write(dashboardPath, "existing dashboard")

      const ctx = {
        directory: temp,
        worktree: temp,
        abort: undefined,
        metadata: () => {},
        ask: async (input: { permission: string }) => {
          if (input.permission === "edit") throw new Error("edit denied")
        },
      } as any

      await expect(
        FinancialPoliticalBacktestInternal.writeArtifacts({
          ctx,
          outputRoot,
          report: "new report",
          dashboard: "new dashboard",
          assumptions: "{}",
          events: "[]",
          windowReturns: "[]",
          benchmarkReturns: "[]",
          aggregate: "[]",
          comparison: "{}",
        }),
      ).rejects.toThrow("edit denied")

      expect(await Bun.file(reportPath).text()).toBe("existing report")
      expect(await Bun.file(dashboardPath).text()).toBe("existing dashboard")
      const historyExists = await fs
        .stat(historyRoot)
        .then(() => true)
        .catch(() => false)
      expect(historyExists).toBe(false)
    } finally {
      await fs.rm(temp, { recursive: true, force: true })
    }
  })
})
