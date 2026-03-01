import path from "path"
import type { PdfSubcommand, LoadedArtifacts } from "../types"

export async function readOptional(filepath: string) {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return
  return file.text()
}

export async function readRequired(filepath: string) {
  const content = await readOptional(filepath)
  if (content) return content
  throw new Error(`Missing required report artifact: ${filepath}`)
}

export async function loadArtifacts(root: string, subcommand: PdfSubcommand): Promise<LoadedArtifacts> {
  const report = path.join(root, "report.md")
  const dashboard = path.join(root, "dashboard.md")
  const assumptions = path.join(root, "assumptions.json")

  if (subcommand === "report") {
    return {
      report: await readRequired(report),
      dashboard: await readOptional(dashboard),
      assumptions: await readOptional(assumptions),
    }
  }

  if (subcommand === "government-trading") {
    return {
      report: await readRequired(report),
      dashboard: await readRequired(dashboard),
      assumptions: await readRequired(assumptions),
      normalizedEventsJson: await readRequired(path.join(root, "normalized-events.json")),
      deltaEventsJson: await readRequired(path.join(root, "delta-events.json")),
      dataJson: await readRequired(path.join(root, "data.json")),
    }
  }

  if (subcommand === "political-backtest") {
    return {
      report: await readRequired(report),
      dashboard: await readRequired(dashboard),
      assumptions: await readRequired(assumptions),
      aggregateJson: await readRequired(path.join(root, "aggregate-results.json")),
      comparisonJson: await readRequired(path.join(root, "comparison.json")),
    }
  }

  return {
    report: await readRequired(report),
    dashboard: await readRequired(dashboard),
    assumptions: await readRequired(assumptions),
    evidenceMarkdown: await readRequired(path.join(root, "evidence.md")),
    evidenceJson: await readRequired(path.join(root, "evidence.json")),
  }
}
