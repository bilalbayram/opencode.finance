import { ProviderError } from "../provider"
import type { FinanceProvider } from "../provider"
import { abortAfterAny } from "../../util/abort"
import { normalizeErrorText } from "../parser"
import type {
  FinanceFundamentalsData,
  FinanceNewsData,
  FinanceQuoteData,
  FinanceProviderData,
  FinanceDataEnvelope,
  FinanceIntent,
  NormalizedFinanceQuery,
} from "../types"

const ALPHA_BASE_URL = "https://www.alphavantage.co/query"
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_NEWS_LIMIT = 10

function asText(input: unknown): string {
  if (input === null || input === undefined) return ""
  const value = String(input).trim()
  if (!value) return ""
  if (/^(none|null|n\/?a|-|unknown)$/i.test(value)) return ""
  return value
}

function toNumber(value: unknown): number | null {
  const text = asText(value).replace(/,/g, "").trim()
  if (!text) return null
  const num = Number(text.replace(/[^0-9.-]/g, ""))
  return Number.isFinite(num) ? num : null
}

function parseQuote(payload: Record<string, unknown>): FinanceQuoteData {
  const raw = (payload["Global Quote"] as Record<string, unknown> | undefined) ?? {}
  return {
    symbol: asText(raw["01. symbol"] || payload["01. symbol"] || "")
      .toUpperCase()
      .trim(),
    price: toNumber(raw["05. price"]),
    currency: asText(raw["08. currency"] || "USD"),
    previousClose: toNumber(raw["08. previous close"]),
    change: toNumber(raw["09. change"]),
    changePercent: toNumber(asText(raw["10. change percent"]).replace("%", "")),
    marketCap: null,
  }
}

function parseFundamentals(payload: Record<string, unknown>): FinanceFundamentalsData {
  const revenue = toNumber(payload.RevenueTTM)
  const netIncome = toNumber(payload.NetIncomeTTM)
  const grossMargin = toNumber(payload.GrossMarginTTM)
  const grossProfit = toNumber(payload.GrossProfitTTM)
  const debtToEquity = toNumber(payload.DebtToEquityTTM)
  const returnOnEquityPercent = toNumber(payload.ReturnOnEquityTTM)
  const operatingMarginPercent = toNumber(payload.OperatingMarginTTM)
  const freeCashFlow = toNumber(payload.FreeCashFlowTTM ?? payload.OperatingCashflowTTM)
  const grossFallback = grossMargin ?? (grossProfit !== null && revenue !== null && revenue !== 0 ? Number((grossProfit / revenue).toFixed(6)) : null)
  const strongBuy = toNumber(payload.AnalystRatingStrongBuy)
  const buy = toNumber(payload.AnalystRatingBuy)
  const hold = toNumber(payload.AnalystRatingHold)
  const sell = toNumber(payload.AnalystRatingSell)
  const strongSell = toNumber(payload.AnalystRatingStrongSell)
  const periodFor = (value: number | null) => (value === null ? "Unknown" : "TTM")

  return {
    symbol: asText(payload.Symbol || payload.symbol).toUpperCase(),
    metrics: {
      revenue,
      netIncome,
      grossMarginPercent: grossFallback,
      debtToEquity,
      returnOnEquityPercent,
      operatingMarginPercent,
      freeCashFlow,
    },
    metricPeriods: {
      revenue: periodFor(revenue),
      netIncome: periodFor(netIncome),
      grossMarginPercent: periodFor(grossFallback),
      debtToEquity: periodFor(debtToEquity),
      returnOnEquityPercent: periodFor(returnOnEquityPercent),
      operatingMarginPercent: periodFor(operatingMarginPercent),
      freeCashFlow: periodFor(freeCashFlow),
    },
    metricDerivation: {
      revenue: "reported",
      netIncome: "reported",
      grossMarginPercent: grossMargin === null && grossFallback !== null ? "derived" : "reported",
      debtToEquity: "reported",
      returnOnEquityPercent: "reported",
      operatingMarginPercent: "reported",
      freeCashFlow: "reported",
    },
    fiscalPeriodEnd: asText(payload.LatestQuarter || payload.FiscalYearEnd || null),
    marketCap: toNumber(payload.MarketCapitalization),
    sector: asText(payload.Sector || payload.sector) || null,
    headquarters: asText(payload.Address || payload.address) || null,
    website: asText(payload.OfficialSite || payload.website) || null,
    iconUrl: null,
    analystRatings: {
      strongBuy,
      buy,
      hold,
      sell,
      strongSell,
    },
    period: "TTM",
  }
}

function parseNews(payload: Record<string, unknown>, inputTicker: string): FinanceNewsData {
  const feed = Array.isArray(payload.feed) ? payload.feed : []
  return {
    symbol: inputTicker.toUpperCase(),
    items: feed.slice(0, DEFAULT_NEWS_LIMIT).map((entry) => {
      const row = (entry as Record<string, unknown>) ?? {}
      return {
        title: asText(row.title),
        source: asText(row.source),
        publishedAt: asText(row.time_published),
        url: asText(row.url),
        summary: asText(row.summary),
        sentiment: toNumber(row.overall_sentiment_score),
      }
    }),
  }
}

function attribution(input: NormalizedFinanceQuery) {
  const fn = input.intent === "quote" ? "GLOBAL_QUOTE" : input.intent === "fundamentals" ? "OVERVIEW" : "NEWS_SENTIMENT"
  const query = new URLSearchParams({
    function: fn,
    symbol: input.ticker,
  })
  if (input.intent === "news") {
    query.delete("symbol")
    query.set("tickers", input.ticker)
    query.set("limit", `${Math.min(input.limit, DEFAULT_NEWS_LIMIT)}`)
  }
  return [
    {
      publisher: "Alpha Vantage",
      domain: "alphavantage.co",
      url: `${ALPHA_BASE_URL}?${query.toString()}`,
    },
  ]
}

interface AlphaVantageOptions {
  apiKey?: string
  timeoutMs?: number
}

function makeFailure(message: string, code = "400", source: string): never {
  throw new ProviderError(message, source, code)
}

export class AlphaVantageProvider implements FinanceProvider {
  readonly id = "alphavantage"
  readonly displayName = "Alpha Vantage"
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number

  constructor(options: AlphaVantageOptions = {}) {
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  supports(intent: FinanceIntent): boolean {
    return intent === "quote" || intent === "fundamentals" || intent === "news"
  }

  enabled(): boolean {
    return Boolean(this.apiKey)
  }

  async fetch(
    input: NormalizedFinanceQuery,
    options?: { signal?: AbortSignal },
  ): Promise<FinanceDataEnvelope<FinanceProviderData>> {
    const { signal: timeoutSignal, clearTimeout } = abortAfterAny(
      this.timeoutMs,
      ...(options?.signal ? [options.signal] : []),
    )
    const params = new URLSearchParams({
      apikey: this.apiKey!,
      symbol: input.ticker,
    })

    if (input.intent === "quote") params.set("function", "GLOBAL_QUOTE")
    if (input.intent === "fundamentals") params.set("function", "OVERVIEW")
    if (input.intent === "news") {
      params.set("function", "NEWS_SENTIMENT")
      params.set("tickers", input.ticker)
      params.set("limit", `${Math.min(input.limit, DEFAULT_NEWS_LIMIT)}`)
    }

    try {
      const response = await fetch(`${ALPHA_BASE_URL}?${params.toString()}`, { signal: timeoutSignal })
      clearTimeout()

      if (!response.ok) {
        const text = await response.text()
        makeFailure(`alpha-vantage request failed (${response.status}): ${text || response.statusText}`, `${response.status}`, this.id)
      }

      const payload = (await response.json()) as Record<string, unknown>
      const providerMessage = asText(payload["Error Message"] || payload.Note || payload.Information)
      if (providerMessage) {
        makeFailure(`alpha-vantage rejected request: ${providerMessage}`, "PROVIDER_ERROR", this.id)
      }

      const timestamp = new Date().toISOString()

      switch (input.intent) {
        case "quote":
          return {
            source: this.id,
            timestamp,
            attribution: attribution(input),
            data: parseQuote(payload),
            errors: [],
          }
        case "fundamentals":
          return {
            source: this.id,
            timestamp,
            attribution: attribution(input),
            data: parseFundamentals(payload),
            errors: [],
          }
        case "news":
          return {
            source: this.id,
            timestamp,
            attribution: attribution(input),
            data: parseNews(payload, input.ticker),
            errors: [],
          }
        default:
          throw new ProviderError(`Unsupported intent for ${this.id}: ${input.intent}`, this.id, "UNSUPPORTED")
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("alpha-vantage request timed out", this.id, "TIMEOUT", this.timeoutMs)
      }
      if (error instanceof ProviderError) throw error
      throw new ProviderError(normalizeErrorText(error), this.id, "NETWORK")
    }
  }
}
