import { describe, expect, it } from "bun:test"
import { FINANCE_SLASH_COMMANDS } from "./finance"

function getCommand(name: string) {
  const command = FINANCE_SLASH_COMMANDS.find((item) => item.name === name)
  if (!command) {
    throw new Error(`Expected slash command "${name}" to exist`)
  }
  return command
}

describe("FINANCE_SLASH_COMMANDS", () => {
  it("contains financial-government-trading with expected aliases", () => {
    const command = getCommand("financial-government-trading")

    expect(command.aliases).toContain("government-trading")
    expect(command.aliases).toContain("report-government-trading")
  })

  it("contains required question/report_pdf flow clauses for government-trading reports", () => {
    const command = getCommand("financial-government-trading")
    const template = command.template

    expect(template).toContain("ask exactly one user question with the `question` tool")
    expect(template).toContain("header: `PDF Export`")
    expect(template).toContain("question: `Generate a polished PDF report now?`")
    expect(template).toContain("`Yes (Recommended)` - Generate a polished PDF in the same output directory.")
    expect(template).toContain("`No` - Skip PDF generation.")
    expect(template).toContain("custom: `false`")
    expect(template).toContain("If user selects `Yes (Recommended)`, call `report_pdf` with:")
    expect(template).toContain("`outputRoot`: `<artifacts.output_root>`")
    expect(template).toContain("`filename`: `government-trading-<run_id>.pdf`")
    expect(template).toContain("If `question` is unavailable in this client context, skip PDF export and complete normally.")
  })
})
