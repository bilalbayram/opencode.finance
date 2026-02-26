import { describe, expect, it } from "bun:test"
import z from "zod"
import { ReportGovernmentTradingTool } from "./report_government_trading"

describe("ReportGovernmentTradingTool", () => {
  it("init returns a zod object schema for parameters", async () => {
    const tool = await ReportGovernmentTradingTool.init()
    expect(tool.parameters).toBeInstanceOf(z.ZodObject)
  })

  it("defines ticker/output_root/limit/refresh with expected constraints", async () => {
    const tool = await ReportGovernmentTradingTool.init()
    const { parameters } = tool

    expect(parameters.safeParse({}).success).toBe(true)
    expect(parameters.safeParse({ ticker: "AAPL" }).success).toBe(true)
    expect(parameters.safeParse({ output_root: "reports/government-trading" }).success).toBe(true)
    expect(parameters.safeParse({ limit: 1 }).success).toBe(true)
    expect(parameters.safeParse({ limit: 200 }).success).toBe(true)
    expect(parameters.safeParse({ refresh: true }).success).toBe(true)

    expect(parameters.safeParse({ ticker: 123 }).success).toBe(false)
    expect(parameters.safeParse({ output_root: 123 }).success).toBe(false)
    expect(parameters.safeParse({ limit: 0 }).success).toBe(false)
    expect(parameters.safeParse({ limit: 201 }).success).toBe(false)
    expect(parameters.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(parameters.safeParse({ refresh: "true" }).success).toBe(false)
  })

  it("documents no-ticker behavior as global-only", async () => {
    const tool = await ReportGovernmentTradingTool.init()
    const { parameters } = tool

    expect(tool.description).toContain("no-ticker mode: omit `ticker` to run global datasets only")
    expect(tool.description).not.toContain("if holdings exist")
    expect(parameters.shape.ticker.description).toContain("global mode")
  })
})
