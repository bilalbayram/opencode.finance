import { describe, expect, test } from "bun:test"
import { FINANCE_SLASH_COMMANDS } from "../../src/command/finance"

function templateFor(name: string) {
  const command = FINANCE_SLASH_COMMANDS.find((item) => item.name === name)
  if (!command) throw new Error(`Missing slash command: ${name}`)
  return command.template
}

describe("financial_political_backtest slice 6", () => {
  test("documents one explicit PDF export question with yes/no options", () => {
    const template = templateFor("financial-political-backtest")
    expect(template).toContain("header: `PDF Export`")
    expect(template).toContain("question: `Generate a polished PDF report now?`")
    expect(template).toContain("`Yes (Recommended)`")
    expect(template).toContain("`No`")
  })

  test("documents PDF yes-path invocation through report_pdf", () => {
    const template = templateFor("financial-political-backtest")
    expect(template).toContain("If user selects `Yes (Recommended)`, call `report_pdf`")
    expect(template).toContain("`outputRoot`")
    expect(template).toContain("`filename`")
  })

  test("documents PDF no-path and explicit failure behavior", () => {
    const template = templateFor("financial-political-backtest")
    expect(template).toContain("If user selects `No`, skip PDF generation")
    expect(template).toContain("If `report_pdf` fails, treat the run as failed")
  })

  test("keeps objective non-advisory output requirement", () => {
    const template = templateFor("financial-political-backtest")
    expect(template).toContain("Do not provide investment advice")
  })
})
