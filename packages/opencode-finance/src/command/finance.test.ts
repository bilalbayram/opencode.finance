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

    expect(template).toContain("for global mode.")
    expect(template).not.toContain("portfolio")
    expect(template).toContain("ask exactly one user question with the `question` tool")
    expect(template).toContain("header: `PDF Export`")
    expect(template).toContain("question: `Generate a polished PDF report now?`")
    expect(template).toContain("`Yes (Recommended)` - Generate a polished PDF in the same output directory.")
    expect(template).toContain("`No` - Skip PDF generation.")
    expect(template).toContain("custom: `false`")
    expect(template).toContain("If user selects `Yes (Recommended)`, call `report_pdf` with:")
    expect(template).toContain("`subcommand`: `government-trading`")
    expect(template).toContain("`outputRoot`: `<artifacts.output_root>`")
    expect(template).toContain("`filename`: `government-trading-<run_id>.pdf`")
    expect(template).toContain("If `question` is unavailable in this client context, skip PDF export and complete normally.")
  })

  it("contains report-pdf slash command template with report and government-trading profiles", () => {
    const command = getCommand("report-pdf")
    const template = command.template

    expect(command.aliases).toContain("pdf-report")
    expect(template).toContain("/report-pdf report <output_root> [filename]")
    expect(template).toContain("/report-pdf government-trading <output_root> [filename]")
    expect(template).toContain("Require `$1` to be exactly `report` or `government-trading`")
    expect(template).toContain("`subcommand`: `$1`")
    expect(template).toContain("`outputRoot`: `$2`")
  })

  it("contains report workflow report_pdf subcommand clause", () => {
    const command = getCommand("report")
    const template = command.template

    expect(template).toContain("If user selects `Yes (Recommended)`, call `report_pdf` with:")
    expect(template).toContain("`subcommand`: `report`")
    expect(template).toContain("`outputRoot`: `reports/$1/<YYYY-MM-DD>/`")
  })
})
