import {
  FINANCE_COVERAGE,
  FINANCE_INTENTS,
  type FinanceCoverage,
  type FinanceIntent,
  type FinanceSearchInput,
  type NormalizedFinanceQuery,
} from "./types"
import type {
  FinanceQuoteData,
  FinanceFundamentalsData,
  FinanceFilingsData,
  FinanceInsiderData,
  FinanceNewsData,
} from "./types"

const DEFAULT_LIMIT = 10

const STOP_WORDS = new Set([
  "WITH",
  "STATS",
  "PRICE",
  "QUOTE",
  "LOOK",
  "UP",
  "SHOW",
  "GET",
  "LATEST",
  "RECENT",
  "THIS",
  "THAT",
  "WHAT",
  "FOR",
  "THE",
  "A",
  "LAST",
  "AND",
  "WHEN",
  "IS",
  "BE",
  "CAN",
  "SUMMARIZE",
  "ME",
  "PLEASE",
  "OF",
  "WHATS",
])

const TICKER_RE = /\b[A-Z][A-Z0-9]{1,4}(?:\.[A-Z]{1,3})?\b/g
const FORM_RE = /\b(10[-\s]?K|10[-\s]?Q|8[-\s]?K)\b/i

function normalizeKeyword(value: string) {
  return value.toLowerCase()
}

export function normalizeTicker(value: string): string {
  return value.replace(/[^\w.]/g, "").toUpperCase().trim()
}

export function parseFinanceTicker(input: string): string {
  const normalized = input.toUpperCase()
  const explicit = [...normalized.matchAll(/\$([A-Z][A-Z0-9]{0,4}(?:\.[A-Z]{1,3})?)/g)][0]?.[1]
  if (explicit) return explicit

  const direct = normalized.match(/^\$?([A-Z][A-Z0-9]{0,4}(?:\.[A-Z]{1,3})?)$/)?.[1]
  if (direct) return direct

  const matches = [...normalized.matchAll(TICKER_RE)].map((x) => x[0])
  for (const match of matches) {
    if (STOP_WORDS.has(match)) continue
    if (match.length < 2) continue
    return match
  }

  return ""
}

function detectIntentFromQuery(query: string): FinanceIntent {
  const value = normalizeKeyword(query)
  const has = (needle: string) => value.includes(needle)

  if (has("10-k") || has("10-q") || has("sec filing") || has("filing") || has("8-k") || has("8k")) return "filings"
  if (has("insider") || has("ownership") || has("officer") || has("beneficial") || has("inside")) return "insider"
  if (has("revenue") || has("earnings") || has("fundamentals") || has("metric") || has("financial")) return "fundamentals"
  if (has("news") || has("headline") || has("press release") || has("announc")) return "news"
  return "quote"
}

function detectFilingForm(input: string): string | undefined {
  const match = FORM_RE.exec(input)
  if (!match) return undefined
  const value = match[1].replace(/\s+/g, "-").toUpperCase()
  return value
}

export function parseFinanceQuery(input: FinanceSearchInput): NormalizedFinanceQuery {
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new Error("Finance query must include text")
  }

  const normalizedTicker = parseFinanceTicker(input.ticker ?? input.query)
  if (!normalizedTicker) {
    throw new Error("Could not determine ticker from request")
  }

  const normalizedIntent = input.intent ?? detectIntentFromQuery(input.query)
  if (!FINANCE_INTENTS.includes(normalizedIntent)) {
    throw new Error(`Unsupported finance intent: ${input.intent}`)
  }

  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)), 50)
  const form = input.form?.trim() ?? detectFilingForm(input.query)
  const coverage = normalizeCoverage(input.coverage)

  return {
    query: input.query,
    intent: normalizedIntent,
    ticker: normalizedTicker,
    form,
    coverage,
    limit,
  }
}

function normalizeCoverage(input?: FinanceCoverage): FinanceCoverage {
  if (input && FINANCE_COVERAGE.includes(input)) return input
  return "default"
}

export function normalizeErrorText(input?: unknown): string {
  if (input instanceof Error) return input.message
  if (typeof input === "string") return input
  if (input && typeof input === "object" && "message" in input && typeof input.message === "string") return input.message
  return "Unknown finance provider error"
}

export function createEmptyFinanceData(
  intent: FinanceIntent,
  ticker: string,
): FinanceQuoteData | FinanceFundamentalsData | FinanceFilingsData | FinanceInsiderData | FinanceNewsData {
  switch (intent) {
    case "quote":
      return {
        symbol: ticker,
        price: null,
        currency: "USD",
        previousClose: null,
        change: null,
        changePercent: null,
        marketCap: null,
        fiftyTwoWeekHigh: null,
        fiftyTwoWeekLow: null,
        ytdReturnPercent: null,
      }
    case "fundamentals":
      return {
        symbol: ticker,
        metrics: {
          revenue: null,
          netIncome: null,
          grossMarginPercent: null,
          debtToEquity: null,
          returnOnEquityPercent: null,
          operatingMarginPercent: null,
          freeCashFlow: null,
        },
        metricPeriods: {
          revenue: "Unknown",
          netIncome: "Unknown",
          grossMarginPercent: "Unknown",
          debtToEquity: "Unknown",
          returnOnEquityPercent: "Unknown",
          operatingMarginPercent: "Unknown",
          freeCashFlow: "Unknown",
        },
        metricDerivation: {
          revenue: "reported",
          netIncome: "reported",
          grossMarginPercent: "reported",
          debtToEquity: "reported",
          returnOnEquityPercent: "reported",
          operatingMarginPercent: "reported",
          freeCashFlow: "reported",
        },
        marketCap: null,
        sector: null,
        headquarters: null,
        website: null,
        iconUrl: null,
        analystRatings: {
          strongBuy: null,
          buy: null,
          hold: null,
          sell: null,
          strongSell: null,
        },
        period: "Unknown",
      }
    case "filings":
      return {
        symbol: ticker,
        filings: [],
      } as const
    case "insider":
      return {
        symbol: ticker,
        ownershipChange: 0,
        entries: [],
        summary: null,
      }
    case "news":
      return {
        symbol: ticker,
        items: [],
      }
  }
}
