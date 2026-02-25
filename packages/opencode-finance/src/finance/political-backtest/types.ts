export type IsoDate = string

export type PoliticalTransactionType = "buy" | "sell" | "other"

export interface QuiverPoliticalRowInput {
  datasetId: string
  datasetLabel: string
  symbol: string
  rows: readonly Record<string, unknown>[]
}

export interface NormalizedPoliticalEvent {
  eventId: string
  symbol: string
  sourceDatasetId: string
  sourceDatasetLabel: string
  sourceRowIndex: number
  transactionDate: IsoDate | null
  reportDate: IsoDate | null
  transactionType: PoliticalTransactionType
  actor: string | null
}

export interface TradingCalendar {
  sessions: readonly IsoDate[]
  sessionEpochDays: readonly number[]
  sessionIndexByDate: ReadonlyMap<IsoDate, number>
}

export interface TradingSessionAlignment {
  inputDate: IsoDate
  alignedDate: IsoDate
  alignedIndex: number
  shifted: boolean
}

export interface DailyClose {
  date: IsoDate
  close: number
}

export type CloseByDate = ReadonlyMap<IsoDate, number>

export interface ComputeForwardReturnsInput {
  eventId: string
  symbol: string
  anchorDate: IsoDate
  alignment: TradingSessionAlignment
  windows: readonly number[]
  calendar: TradingCalendar
  symbolCloses: CloseByDate
  spyCloses: CloseByDate
}

export interface WindowForwardReturn {
  windowSessions: number
  startDate: IsoDate
  endDate: IsoDate
  symbolReturn: number
  spyReturn: number
  relativeReturn: number
}

export interface EventForwardReturnSet {
  eventId: string
  symbol: string
  anchorDate: IsoDate
  entryDate: IsoDate
  returns: readonly WindowForwardReturn[]
}

export interface AggregateStats {
  sampleCount: number
  hitRate: number
  mean: number
  median: number
  stdev: number
}

export interface WindowAggregateStats {
  windowSessions: number
  symbolReturn: AggregateStats
  spyReturn: AggregateStats
  relativeReturn: AggregateStats
}

export const EVENT_ANCHOR_MODE = ["transaction", "report", "both"] as const
export type EventAnchorMode = (typeof EVENT_ANCHOR_MODE)[number]

export const NON_TRADING_ALIGNMENT = ["next_session"] as const
export type NonTradingAlignment = (typeof NON_TRADING_ALIGNMENT)[number]

export const BENCHMARK_MODE = ["spy_only", "spy_plus_sector_if_relevant", "spy_plus_sector_required"] as const
export type BenchmarkMode = (typeof BENCHMARK_MODE)[number]

export interface PriceBar {
  symbol: string
  date: IsoDate
  adjusted_close: number
}

export interface PoliticalEvent {
  event_id: string
  ticker: string
  source_dataset_id: string
  actor: string | null
  side: PoliticalTransactionType
  transaction_date: IsoDate | null
  report_date: IsoDate | null
  shares: number | null
}

export interface EventAnchor {
  event_id: string
  ticker: string
  anchor_kind: "transaction" | "report"
  anchor_date: IsoDate
}

export interface EventWindowReturn {
  event_id: string
  ticker: string
  anchor_kind: "transaction" | "report"
  anchor_date: IsoDate
  aligned_anchor_date: IsoDate
  window_sessions: number
  start_close: number
  end_close: number
  forward_return_percent: number
}

export interface BenchmarkRelativeReturn extends EventWindowReturn {
  benchmark_symbol: string
  benchmark_return_percent: number
  excess_return_percent: number
  relative_return_percent: number
}

export interface AggregateWindow {
  anchor_kind: "transaction" | "report"
  window_sessions: number
  benchmark_symbol: string
  sample_size: number
  hit_rate_percent: number
  mean_return_percent: number
  median_return_percent: number
  stdev_return_percent: number
  mean_excess_return_percent: number
  mean_relative_return_percent: number
}

export interface BenchmarkSelection {
  symbols: string[]
  rationale: string[]
  sector: string | null
  sector_etf: string | null
}
