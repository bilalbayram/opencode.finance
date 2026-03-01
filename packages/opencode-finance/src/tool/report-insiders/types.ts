import type { QuiverTier } from "../../finance/quiver-tier"
import type * as QuiverReport from "../../finance/providers/quiver-report"

export type ReportInsidersMetadata = {
  mode: "ticker" | "portfolio"
  tier: QuiverTier
  output_root: string
  report_path: string
  data_path: string
  coverage: {
    attempted: number
    skipped: number
    failed: number
  }
  warnings: number
}

export type TickerSummary = {
  ticker: string
  datasets: QuiverReport.QuiverReportDataset[]
  insiders_rows: number
  government_rows: number
}

export type InsiderActivity = {
  actor: string
  action: "buy" | "sell" | "other"
  shares: number
  ticker: string
  date: string
  source: string
}

export type ActivityWindow = {
  start: string
  end: string
  days: number
}

export type ActivitySummary = {
  window: ActivityWindow
  rows: InsiderActivity[]
}
