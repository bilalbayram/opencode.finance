import { describe, expect, test } from "bun:test"
import { OpenCodeFinanceInternal } from "../../src/index"

describe("finance plugin report runtime hints", () => {
  test("includes explicit report_pdf subcommand for /report execution constraints", () => {
    const lines = OpenCodeFinanceInternal.reportExecutionConstraintLines({
      outputRoot: "/tmp/reports/AAPL/2026-02-26",
      focus: "valuation",
      quiverSetupHint: "setup-command",
    })
    const text = lines.join("\n")

    expect(text).toContain('call `report_pdf` with `subcommand: "report"`')
    expect(text).toContain("- Focus area for this run: `valuation`.")
    expect(text).toContain("- Write artifacts only under `/tmp/reports/AAPL/2026-02-26`.")
  })
})
