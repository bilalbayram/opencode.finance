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

const FMP_BASE = "https://financialmodelingprep.com/stable"
const DEFAULT_TIMEOUT_MS = 12_000

function asText(input: unknown): string {
  if (input === null || input === undefined) return ""
  return String(input)
}

function toNumber(input: unknown): number | null {
  const text = asText(input).replace(/,/g, "").trim()
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
  const text = asText(input).trim()
  if (!text) return new Date().toISOString()
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

function firstRow(input: unknown): Record<string, unknown> {
  if (!Array.isArray(input)) return {}
  const row = input[0]
  if (!row || typeof row !== "object") return {}
  return row as Record<string, unknown>
}

function rows(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
}

function headquarters(profile: Record<string, unknown>) {
  const city = asText(profile.city).trim()
  const state = asText(profile.state).trim()
  const country = asText(profile.country).trim()
  const parts = [city, state, country].filter((item) => item.length > 0)
  if (!parts.length) return null
  return parts.join(", ")
}

function parseRange(input: unknown) {
  const text = asText(input).trim()
  const hit = text.match(/([-+]?\d+(?:\.\d+)?)\s*-\s*([-+]?\d+(?:\.\d+)?)/)
  if (!hit) return { low: null, high: null }
  const low = toNumber(hit[1])
  const high = toNumber(hit[2])
  return { low, high }
}

function quoteData(input: {
  ticker: string
  profile: Record<string, unknown>
}): FinanceQuoteData {
  const range = parseRange(input.profile.range)
  const price = toNumber(input.profile.price)
  const change = toNumber(input.profile.change)
  return {
    symbol: input.ticker.toUpperCase(),
    price,
    currency: asText(input.profile.currency || "USD") || "USD",
    previousClose: price !== null && change !== null ? Number((price - change).toFixed(6)) : null,
    change,
    changePercent: toNumber(input.profile.changePercentage),
    marketCap: toNumber(input.profile.marketCap),
    fiftyTwoWeekHigh: range.high,
    fiftyTwoWeekLow: range.low,
    ytdReturnPercent: null,
  }
}

function fundamentalsData(input: {
  ticker: string
  profile: Record<string, unknown>
}): FinanceFundamentalsData {
  return {
    symbol: input.ticker.toUpperCase(),
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
    fiscalPeriodEnd: null,
    marketCap: toNumber(input.profile.marketCap),
    sector: asText(input.profile.sector || input.profile.industry).trim() || null,
    headquarters: headquarters(input.profile),
    website: asText(input.profile.website).trim() || null,
    iconUrl: asText(input.profile.image || input.profile.logo).trim() || null,
    analystRatings: null,
    period: "Unknown",
  }
}

function newsData(ticker: string, payload: unknown, limit: number): FinanceNewsData {
  return {
    symbol: ticker.toUpperCase(),
    items: rows(payload).slice(0, Math.max(1, limit)).map((row) => ({
      title: asText(row.title || row.text).trim() || "FMP headline",
      source: asText(row.site || "Financial Modeling Prep"),
      publishedAt: toIsoDate(row.publishedDate),
      url: asText(row.url),
      summary: asText(row.text || row.title),
      sentiment: null,
    })),
  }
}

interface FinancialModelingPrepOptions {
  apiKey?: string
  timeoutMs?: number
}

export class FinancialModelingPrepProvider implements FinanceProvider {
  readonly id = "financial-modeling-prep"
  readonly displayName = "Financial Modeling Prep"
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number

  constructor(options: FinancialModelingPrepOptions = {}) {
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  supports(intent: FinanceIntent): boolean {
    return intent === "quote" || intent === "fundamentals" || intent === "news"
  }

  enabled(): boolean {
    return Boolean(this.apiKey)
  }

  private async request(path: string, query: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    query.set("apikey", this.apiKey!)
    const url = `${FMP_BASE}${path}?${query.toString()}`
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "opencode-finance/1.0",
      },
    })
    if (!response.ok) {
      const text = await response.text()
      if ((response.status === 402 || response.status === 403) && /(legacy|premium|restricted|subscription|upgrade)/i.test(text)) {
        throw new ProviderError(`financial-modeling-prep tier denied (${response.status}): ${text}`, this.id, "TIER_DENIED")
      }
      throw new ProviderError(`financial-modeling-prep request failed (${response.status}): ${text || response.statusText}`, this.id, String(response.status))
    }
    const payload = (await response.json()) as unknown
    if (payload && typeof payload === "object" && "Error Message" in payload) {
      const message = asText((payload as Record<string, unknown>)["Error Message"])
      if (message.trim()) {
        if (/(legacy|premium|restricted|subscription|upgrade)/i.test(message)) {
          throw new ProviderError(`financial-modeling-prep tier denied: ${message}`, this.id, "TIER_DENIED")
        }
        throw new ProviderError(`financial-modeling-prep rejected request: ${message}`, this.id, "PROVIDER_ERROR")
      }
    }
    return payload
  }

  private attribution(input: NormalizedFinanceQuery) {
    if (input.intent === "quote") {
      return [
        {
          publisher: "Financial Modeling Prep",
          domain: "financialmodelingprep.com",
          url: `${FMP_BASE}/profile?symbol=${encodeURIComponent(input.ticker)}`,
        },
      ]
    }

    if (input.intent === "fundamentals") {
      return [
        {
          publisher: "Financial Modeling Prep",
          domain: "financialmodelingprep.com",
          url: `${FMP_BASE}/profile?symbol=${encodeURIComponent(input.ticker)}`,
        },
      ]
    }

    return [
      {
        publisher: "Financial Modeling Prep",
        domain: "financialmodelingprep.com",
        url: `${FMP_BASE}/stock-news?symbol=${encodeURIComponent(input.ticker)}&limit=${Math.min(Math.max(1, input.limit), 50)}`,
      },
    ]
  }

  async fetch(
    input: NormalizedFinanceQuery,
    options?: { signal?: AbortSignal },
  ): Promise<FinanceDataEnvelope<FinanceProviderData>> {
    const { signal, clearTimeout } = abortAfterAny(this.timeoutMs, ...(options?.signal ? [options.signal] : []))

    try {
      if (input.intent === "quote") {
        const profilePayload = await this.request(
          "/profile",
          new URLSearchParams({
            symbol: input.ticker,
          }),
          signal,
        )
        clearTimeout()

        const profile = firstRow(profilePayload)

        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: quoteData({
            ticker: input.ticker,
            profile,
          }),
          errors: [],
        }
      }

      if (input.intent === "fundamentals") {
        const profilePayload = await this.request(
          "/profile",
          new URLSearchParams({
            symbol: input.ticker,
          }),
          signal,
        )
        clearTimeout()

        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: fundamentalsData({
            ticker: input.ticker,
            profile: firstRow(profilePayload),
          }),
          errors: [],
        }
      }

      if (input.intent === "news") {
        const payload = await this.request(
          "/stock-news",
          new URLSearchParams({
            symbol: input.ticker,
            limit: `${Math.min(Math.max(1, input.limit), 50)}`,
          }),
          signal,
        )
        clearTimeout()
        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: newsData(input.ticker, payload, input.limit),
          errors: [],
        }
      }

      throw new ProviderError(`Unsupported intent for ${this.id}: ${input.intent}`, this.id, "UNSUPPORTED")
    } catch (error) {
      clearTimeout()
      if (error instanceof ProviderError) throw error
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("financial-modeling-prep request timed out", this.id, "TIMEOUT", this.timeoutMs)
      }
      throw new ProviderError(normalizeErrorText(error), this.id, "NETWORK")
    }
  }
}
