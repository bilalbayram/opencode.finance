import { abortAfterAny } from "../../util/abort"
import { normalizeErrorText } from "../parser"
import { ProviderError } from "../provider"
import type { FinanceProvider } from "../provider"
import type {
  FinanceDataEnvelope,
  FinanceFundamentalsData,
  FinanceIntent,
  FinanceNewsData,
  FinanceProviderData,
  FinanceQuoteData,
  NormalizedFinanceQuery,
} from "../types"

const YAHOO_BASE = "https://query1.finance.yahoo.com"
const DEFAULT_TIMEOUT_MS = 12_000

function asText(input: unknown): string {
  if (input === null || input === undefined) return ""
  return String(input)
}

function fromRaw(input: unknown): unknown {
  if (input && typeof input === "object" && "raw" in input) {
    return (input as Record<string, unknown>).raw
  }
  return input
}

function toNumber(input: unknown): number | null {
  const text = asText(fromRaw(input)).replace(/,/g, "").trim()
  if (!text) return null
  const value = Number(text.replace(/[^0-9.-]/g, ""))
  if (!Number.isFinite(value)) return null
  return value
}

function toPercent(input: unknown): number | null {
  const value = toNumber(input)
  if (value === null) return null
  if (Math.abs(value) <= 1) return Number((value * 100).toFixed(6))
  return value
}

function toIsoDate(input: unknown): string {
  if (typeof input === "number") {
    const ms = input > 999_999_999_9 ? input : input * 1000
    return new Date(ms).toISOString()
  }
  if (typeof input === "string" && input.trim()) {
    const date = new Date(input)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

function parseQuote(payload: Record<string, unknown>, ticker: string): FinanceQuoteData {
  const list = ((payload.quoteResponse as Record<string, unknown> | undefined)?.result as Record<string, unknown>[] | undefined) ?? []
  const row = list[0] ?? {}
  return {
    symbol: asText(row.symbol || ticker).toUpperCase(),
    price: toNumber(row.regularMarketPrice),
    currency: asText(row.currency || "USD"),
    previousClose: toNumber(row.regularMarketPreviousClose),
    change: toNumber(row.regularMarketChange),
    changePercent: toNumber(row.regularMarketChangePercent),
    marketCap: toNumber(row.marketCap),
    fiftyTwoWeekHigh: toNumber(row.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: toNumber(row.fiftyTwoWeekLow),
    ytdReturnPercent: null,
  }
}

function parseChartQuote(payload: Record<string, unknown>, ticker: string): FinanceQuoteData {
  const chart = payload.chart as Record<string, unknown> | undefined
  const row = ((chart?.result as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
  const meta = (row.meta as Record<string, unknown> | undefined) ?? {}
  const timestamps = ((row.timestamp as number[] | undefined) ?? []).filter((item) => Number.isFinite(item))
  const closes = (
    (((row.indicators as Record<string, unknown> | undefined)?.quote as Record<string, unknown>[] | undefined)?.[0] as
      | Record<string, unknown>
      | undefined) ?? {}
  ).close as number[] | undefined

  const price = toNumber(meta.regularMarketPrice)
  const previousClose = toNumber(meta.chartPreviousClose) ?? (Array.isArray(closes) && closes.length >= 2 ? toNumber(closes[closes.length - 2]) : null)
  const change = price !== null && previousClose !== null ? Number((price - previousClose).toFixed(6)) : null
  const changePercent =
    price !== null && previousClose !== null && previousClose !== 0
      ? Number((((price - previousClose) / previousClose) * 100).toFixed(6))
      : null

  return {
    symbol: asText(meta.symbol || ticker).toUpperCase(),
    price,
    currency: asText(meta.currency || "USD"),
    previousClose,
    change,
    changePercent,
    marketCap: toNumber(meta.marketCap),
    fiftyTwoWeekHigh: toNumber(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: toNumber(meta.fiftyTwoWeekLow),
    ytdReturnPercent: ytdReturn(timestamps, closes, price),
  }
}

function ytdReturn(timestamps: number[], closes: number[] | undefined, price: number | null): number | null {
  if (!Array.isArray(closes) || !closes.length || !timestamps.length || price === null) return null
  const rows = timestamps
    .map((item, index) => ({
      date: new Date(item * 1000),
      close: toNumber(closes[index]),
    }))
    .filter((item) => !Number.isNaN(item.date.getTime()) && item.close !== null && item.date.getUTCFullYear() === new Date().getUTCFullYear())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
  const start = rows[0]?.close
  if (start === null || start === undefined || start === 0) return null
  return Number((((price - start) / start) * 100).toFixed(6))
}

function parseFundamentals(payload: Record<string, unknown>, ticker: string): FinanceFundamentalsData {
  const quoteSummary = payload.quoteSummary as Record<string, unknown> | undefined
  const row = (quoteSummary?.result as Record<string, unknown>[] | undefined)?.[0] ?? {}
  const financialData = (row.financialData as Record<string, unknown> | undefined) ?? {}
  const price = (row.price as Record<string, unknown> | undefined) ?? {}
  const stats = (row.defaultKeyStatistics as Record<string, unknown> | undefined) ?? {}
  const revenue = toNumber(financialData.totalRevenue)
  const netIncome = toNumber(financialData.netIncomeToCommon)
  const grossMarginPercent = toPercent(financialData.grossMargins)
  const debtToEquity = toNumber(financialData.debtToEquity)
  const returnOnEquityPercent = toPercent(financialData.returnOnEquity)
  const operatingMarginPercent = toPercent(financialData.operatingMargins)
  const freeCashFlow = toNumber(financialData.freeCashflow)
  const periodFor = (value: number | null) => (value === null ? "Unknown" : "TTM")
  return {
    symbol: asText(price.symbol || ticker).toUpperCase(),
    metrics: {
      revenue,
      netIncome,
      grossMarginPercent,
      debtToEquity,
      returnOnEquityPercent,
      operatingMarginPercent,
      freeCashFlow,
    },
    metricPeriods: {
      revenue: periodFor(revenue),
      netIncome: periodFor(netIncome),
      grossMarginPercent: periodFor(grossMarginPercent),
      debtToEquity: periodFor(debtToEquity),
      returnOnEquityPercent: periodFor(returnOnEquityPercent),
      operatingMarginPercent: periodFor(operatingMarginPercent),
      freeCashFlow: periodFor(freeCashFlow),
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
    fiscalPeriodEnd: asText(stats.lastFiscalYearEnd ? toIsoDate(stats.lastFiscalYearEnd).slice(0, 10) : null),
    period: "TTM",
  }
}

function parseNews(payload: Record<string, unknown>, ticker: string, limit: number): FinanceNewsData {
  const rows = (payload.news as Record<string, unknown>[] | undefined) ?? []
  return {
    symbol: ticker.toUpperCase(),
    items: rows.slice(0, Math.max(1, limit)).map((row) => ({
      title: asText(row.title),
      source: asText(row.publisher || "Yahoo Finance"),
      publishedAt: toIsoDate(row.providerPublishTime),
      url: asText(row.link),
      summary: asText(row.summary || row.title),
      sentiment: null,
    })),
  }
}

function attribution(input: NormalizedFinanceQuery) {
  if (input.intent === "quote") {
    return [
      {
        publisher: "Yahoo Finance",
        domain: "query1.finance.yahoo.com",
        url: `${YAHOO_BASE}/v7/finance/quote?symbols=${encodeURIComponent(input.ticker)}`,
      },
      {
        publisher: "Yahoo Finance",
        domain: "query1.finance.yahoo.com",
        url: `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(input.ticker)}?range=1y&interval=1d`,
      },
    ]
  }
  if (input.intent === "fundamentals") {
    const modules = "financialData,defaultKeyStatistics,price"
    return [
      {
        publisher: "Yahoo Finance",
        domain: "query1.finance.yahoo.com",
        url: `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(input.ticker)}?modules=${encodeURIComponent(modules)}`,
      },
    ]
  }
  const params = new URLSearchParams({
    q: input.ticker,
    quotesCount: "0",
    newsCount: String(Math.min(Math.max(1, input.limit), 25)),
  })
  return [
    {
      publisher: "Yahoo Finance",
      domain: "query1.finance.yahoo.com",
      url: `${YAHOO_BASE}/v1/finance/search?${params.toString()}`,
    },
  ]
}

interface YFinanceOptions {
  timeoutMs?: number
}

export class YFinanceProvider implements FinanceProvider {
  readonly id = "yfinance"
  readonly displayName = "Yahoo Finance"
  private readonly timeoutMs: number

  constructor(options: YFinanceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  supports(intent: FinanceIntent): boolean {
    return intent === "quote" || intent === "fundamentals" || intent === "news"
  }

  enabled(): boolean {
    return true
  }

  async fetch(
    input: NormalizedFinanceQuery,
    options?: { signal?: AbortSignal },
  ): Promise<FinanceDataEnvelope<FinanceProviderData>> {
    const { signal, clearTimeout } = abortAfterAny(this.timeoutMs, ...(options?.signal ? [options.signal] : []))
    const headers = {
      Accept: "application/json",
      "User-Agent": "opencode-finance/1.0",
    }
    const timestamp = new Date().toISOString()

    try {
      if (input.intent === "quote") {
        const url = `${YAHOO_BASE}/v7/finance/quote?symbols=${encodeURIComponent(input.ticker)}`
        const response = await fetch(url, { headers, signal })
        if (response.ok) {
          clearTimeout()
          const payload = (await response.json()) as Record<string, unknown>
          return {
            source: this.id,
            timestamp,
            attribution: attribution(input),
            data: parseQuote(payload, input.ticker),
            errors: [],
          }
        }

        const chartUrl = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(input.ticker)}?range=1y&interval=1d`
        const chartResponse = await fetch(chartUrl, { headers, signal })
        clearTimeout()
        if (!chartResponse.ok) {
          throw new ProviderError(
            `yfinance quote requests failed (${response.status}, ${chartResponse.status})`,
            this.id,
            String(chartResponse.status),
          )
        }
        const payload = (await chartResponse.json()) as Record<string, unknown>
        return {
          source: this.id,
          timestamp,
          attribution: attribution(input),
          data: parseChartQuote(payload, input.ticker),
          errors: [],
        }
      }

      if (input.intent === "fundamentals") {
        const modules = "financialData,defaultKeyStatistics,price"
        const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(input.ticker)}?modules=${encodeURIComponent(modules)}`
        const response = await fetch(url, { headers, signal })
        clearTimeout()
        if (!response.ok) {
          throw new ProviderError(
            `yfinance fundamentals request failed (${response.status})`,
            this.id,
            String(response.status),
          )
        }
        const payload = (await response.json()) as Record<string, unknown>
        const error = ((payload.quoteSummary as Record<string, unknown> | undefined)?.error as Record<string, unknown> | undefined)?.description
        if (error) {
          throw new ProviderError(`yfinance fundamentals rejected request: ${asText(error)}`, this.id, "PROVIDER_ERROR")
        }
        return {
          source: this.id,
          timestamp,
          attribution: attribution(input),
          data: parseFundamentals(payload, input.ticker),
          errors: [],
        }
      }

      if (input.intent === "news") {
        const params = new URLSearchParams({
          q: input.ticker,
          quotesCount: "0",
          newsCount: String(Math.min(Math.max(1, input.limit), 25)),
        })
        const url = `${YAHOO_BASE}/v1/finance/search?${params.toString()}`
        const response = await fetch(url, { headers, signal })
        clearTimeout()
        if (!response.ok) {
          throw new ProviderError(`yfinance news request failed (${response.status})`, this.id, String(response.status))
        }
        const payload = (await response.json()) as Record<string, unknown>
        return {
          source: this.id,
          timestamp,
          attribution: attribution(input),
          data: parseNews(payload, input.ticker, input.limit),
          errors: [],
        }
      }

      throw new ProviderError(`Unsupported intent for ${this.id}: ${input.intent}`, this.id, "UNSUPPORTED")
    } catch (error) {
      clearTimeout()
      if (error instanceof ProviderError) throw error
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("yfinance request timed out", this.id, "TIMEOUT", this.timeoutMs)
      }
      throw new ProviderError(normalizeErrorText(error), this.id, "NETWORK")
    }
  }
}
