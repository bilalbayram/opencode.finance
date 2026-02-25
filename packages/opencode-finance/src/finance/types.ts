export const FINANCE_INTENTS = ["quote", "fundamentals", "filings", "insider", "news"] as const

export type FinanceIntent = (typeof FINANCE_INTENTS)[number]
export const FINANCE_COVERAGE = ["default", "comprehensive"] as const
export type FinanceCoverage = (typeof FINANCE_COVERAGE)[number]

export interface FinanceSearchInput {
  query: string
  intent?: FinanceIntent
  ticker?: string
  form?: string
  coverage?: FinanceCoverage
  limit?: number
  source?: string
  refresh?: boolean
}

export interface NormalizedFinanceQuery {
  query: string
  intent: FinanceIntent
  ticker: string
  source?: string
  form?: string
  coverage?: FinanceCoverage
  limit: number
}

export interface FinanceResult<TData = unknown> {
  source: string
  timestamp: string
  attribution?: FinanceAttribution[]
  data: TData
  errors: string[]
}

export interface FinanceAttribution {
  publisher: string
  domain: string
  url: string
}

export interface FinanceQuoteData {
  symbol: string
  price: number | null
  currency: string
  previousClose: number | null
  change: number | null
  changePercent: number | null
  marketCap?: number | null
  fiftyTwoWeekHigh?: number | null
  fiftyTwoWeekLow?: number | null
  ytdReturnPercent?: number | null
}

export type FinanceMetricPeriod = "TTM" | "FY" | "Q" | "Unknown"
export type FinanceMetricDerivation = "reported" | "derived"

export interface FinanceFundamentalsData {
  symbol: string
  metrics: {
    revenue: number | null
    netIncome: number | null
    grossMarginPercent: number | null
    debtToEquity: number | null
    returnOnEquityPercent: number | null
    operatingMarginPercent: number | null
    freeCashFlow: number | null
  }
  metricPeriods: {
    revenue: FinanceMetricPeriod
    netIncome: FinanceMetricPeriod
    grossMarginPercent: FinanceMetricPeriod
    debtToEquity: FinanceMetricPeriod
    returnOnEquityPercent: FinanceMetricPeriod
    operatingMarginPercent: FinanceMetricPeriod
    freeCashFlow: FinanceMetricPeriod
  }
  metricDerivation: {
    revenue: FinanceMetricDerivation
    netIncome: FinanceMetricDerivation
    grossMarginPercent: FinanceMetricDerivation
    debtToEquity: FinanceMetricDerivation
    returnOnEquityPercent: FinanceMetricDerivation
    operatingMarginPercent: FinanceMetricDerivation
    freeCashFlow: FinanceMetricDerivation
  }
  fiscalPeriodEnd?: string | null
  marketCap?: number | null
  sector?: string | null
  headquarters?: string | null
  website?: string | null
  iconUrl?: string | null
  analystRatings?: {
    strongBuy: number | null
    buy: number | null
    hold: number | null
    sell: number | null
    strongSell: number | null
  } | null
  period: FinanceMetricPeriod
}

export interface FinanceFilingItem {
  form: string
  accessionNumber: string
  filingDate: string
  reportDate?: string
  url: string
  summary?: string | null
}

export interface FinanceFilingsData {
  symbol: string
  filings: FinanceFilingItem[]
}

export interface FinanceInsiderItem {
  owner: string
  date: string
  shares: number
  sharesChange: number
  transactionType: "buy" | "sell" | "other"
  security: string
}

export interface FinanceInsiderData {
  symbol: string
  ownershipChange: number
  entries: FinanceInsiderItem[]
  summary?: {
    source: string
    text: string
  } | null
}

export interface FinanceNewsItem {
  title: string
  source: string
  publishedAt: string
  url: string
  summary: string
  sentiment?: number | null
}

export interface FinanceNewsData {
  symbol: string
  items: FinanceNewsItem[]
}

export interface FinanceErrorShape {
  source: string
  message: string
  code?: string
  retryAfterMs?: number | null
}

export type FinanceProviderData =
  | FinanceQuoteData
  | FinanceFundamentalsData
  | FinanceFilingsData
  | FinanceInsiderData
  | FinanceNewsData

export type FinanceDataByIntent<T extends FinanceIntent> = T extends "quote"
  ? FinanceQuoteData
  : T extends "fundamentals"
    ? FinanceFundamentalsData
    : T extends "filings"
      ? FinanceFilingsData
      : T extends "insider"
        ? FinanceInsiderData
        : FinanceNewsData

export interface FinanceDataEnvelope<TData = unknown> extends FinanceResult<TData> {}

export const CACHE_TTL_SECONDS = {
  quote: 300,
  fundamentals: 3600,
  filings: 3600 * 12,
  insider: 3600 * 12,
  news: 600,
} as const

export interface FinanceProviderRequest extends NormalizedFinanceQuery {
  source?: string
  refresh?: boolean
}
