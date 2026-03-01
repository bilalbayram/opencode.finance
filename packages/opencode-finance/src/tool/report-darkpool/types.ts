import type { QuiverTier } from "../../finance/quiver-tier"
import type { TickerAnalysis, AnomalyRecord } from "../../finance/darkpool-anomaly"

export type DarkpoolMetadata = {
  mode: "ticker" | "portfolio"
  tier: QuiverTier
  output_root: string
  report_path: string
  dashboard_path: string
  assumptions_path: string
  evidence_path: string
  anomalies: number
  transitions: {
    new: number
    persisted: number
    severity_change: number
    resolved: number
  }
  historical_runs_considered: number
}

export type TickerRun = {
  ticker: string
  source_url: string
  retrieved_at: string
  row_count: number
  analysis: TickerAnalysis
  anomaly?: AnomalyRecord
}

export type HistoricalRun = {
  generated_at: string
  anomalies: AnomalyRecord[]
  path: string
}
