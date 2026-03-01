import type { QuiverTier } from "../../finance/quiver-tier"
import type * as QuiverReport from "../../finance/providers/quiver-report"
import type { GovernmentTradingNormalizedEvent } from "../../finance/government-trading/types"

export type ReportGovernmentTradingMode = "ticker" | "global"

export type ReportGovernmentTradingMetadata = {
  mode: ReportGovernmentTradingMode
  scope: string
  tier: QuiverTier
  generated_at: string
  run_id: string
  baseline_run_id: string | null
  output_root: string
  report_path: string
  dashboard_path: string
  assumptions_path: string
  normalized_events_path: string
  delta_events_path: string
  data_path: string
  summary: {
    current_events: number
    new_events: number
    updated_events: number
    unchanged_events: number
    no_longer_present_events: number
    historical_runs: number
  }
}

export type DatasetSnapshot = {
  scope: "global" | "ticker"
  ticker?: string
  id: string
  label: string
  endpoint: string
  endpoint_tier: string
  status: QuiverReport.QuiverReportStatus
  timestamp: string
  source_url: string
  row_count: number
  error?: QuiverReport.QuiverReportError
}

export type PersistenceTrend = {
  identity_key: string
  dataset_id: string
  actor: string
  ticker: string
  transaction_date: string
  transaction_type: string
  amount: string
  seen_in_prior_runs: number
  seen_including_current: number
  total_runs_including_current: number
  persistence_ratio: number
  first_seen_run_id: string
  last_seen_run_id: string
  consecutive_run_streak: number
}
