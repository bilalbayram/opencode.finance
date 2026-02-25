import { FinanceCache } from "./cache"
import {
  type FinanceAttribution,
  type FinanceCoverage,
  type FinanceDataEnvelope,
  type FinanceMetricDerivation,
  type FinanceMetricPeriod,
  type FinanceFilingsData,
  type FinanceFundamentalsData,
  type FinanceIntent,
  type FinanceInsiderData,
  type FinanceNewsData,
  type FinanceProviderData,
  type FinanceProviderRequest,
  type FinanceQuoteData,
  type NormalizedFinanceQuery,
  type FinanceErrorShape,
  type FinanceResult,
} from "./types"
import { createEmptyFinanceData, normalizeErrorText } from "./parser"

const DEFAULT_RATE_LIMIT_STATUS = 429

export interface FinanceProvider {
  readonly id: string
  readonly displayName: string
  supports(intent: FinanceIntent): boolean
  enabled(): boolean
  fetch(
    input: NormalizedFinanceQuery,
    options?: { signal?: AbortSignal },
  ): Promise<FinanceDataEnvelope<FinanceProviderData>>
}

export interface FinanceProviderOptions {
  providers?: FinanceProvider[]
  cache?: FinanceCache
  refresh?: boolean
  signal?: AbortSignal
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly code?: string,
    public readonly retryAfterMs?: number | null,
  ) {
    super(message)
    this.name = "ProviderError"
  }
}

export function normalizeProviderError(error: unknown, source: string): FinanceErrorShape {
  if (error instanceof ProviderError) {
    return {
      source,
      message: error.message,
      code: error.code,
      retryAfterMs: error.retryAfterMs ?? null,
    }
  }

  const message = normalizeErrorText(error)
  if (/rate.?limit/i.test(message) || /429/.test(message)) {
    return {
      source,
      message,
      code: "RATE_LIMIT",
      retryAfterMs: DEFAULT_RATE_LIMIT_STATUS,
    }
  }

  return { source, message, code: undefined, retryAfterMs: null }
}

export async function executeFinanceQuery(
  input: FinanceProviderRequest,
  options: FinanceProviderOptions = {},
): Promise<FinanceResult<FinanceProviderData>> {
  if (!input.ticker) {
    throw new Error("No ticker available for finance request")
  }

  const parsed: NormalizedFinanceQuery = {
    query: input.query,
    intent: input.intent,
    ticker: input.ticker.toUpperCase(),
    form: input.form?.trim(),
    coverage: normalizeCoverage(input.coverage),
    limit: Math.min(Math.max(1, Math.floor(input.limit ?? 10)), 50),
    source: input.source,
  }

  const cache = options.cache
  if (!input.refresh && cache) {
    const cached = cache.get<FinanceDataEnvelope<FinanceProviderData>>(parsed)
    if (cached) return cached
  }

  const providers = options.providers?.filter((provider) => provider.supports(parsed.intent) && provider.enabled())
  if (!providers || providers.length === 0) {
    return {
      source: "none",
      timestamp: new Date().toISOString(),
      data: createEmptyFinanceData(parsed.intent, parsed.ticker),
      errors: ["No finance providers available"],
    }
  }

  const failures: FinanceErrorShape[] = []
  if (parsed.coverage === "comprehensive") {
    let merged = createEmptyFinanceData(parsed.intent, parsed.ticker) as FinanceProviderData
    const results: FinanceDataEnvelope<FinanceProviderData>[] = []

    for (const provider of providers) {
      try {
        const result = await provider.fetch(parsed, { signal: options.signal })
        results.push(result)
        merged = mergeData(parsed.intent, merged, result.data, parsed.limit)
        if (isComplete(parsed.intent, merged, parsed.limit)) break
      } catch (error) {
        failures.push(normalizeProviderError(error, provider.id))
      }
    }

    if (results.length === 0) {
      return {
        source: "none",
        timestamp: new Date().toISOString(),
        data: createEmptyFinanceData(parsed.intent, parsed.ticker),
        errors: failures.map((item) => `${item.source}: ${item.message}`),
      }
    }

    const combined: FinanceDataEnvelope<FinanceProviderData> = {
      source: results.map((item) => item.source).join(","),
      timestamp: latestTimestamp(results),
      attribution: mergedAttribution(results),
      data: merged,
      errors: failures.map((item) => `${item.source}: ${item.message}`),
    }

    if (cache) cache.set(parsed, combined, parsed.intent)
    return combined
  }

  for (const provider of providers) {
    try {
      const result = await provider.fetch(parsed, { signal: options.signal })
      if (cache) cache.set(parsed, result, parsed.intent)
      return {
        ...result,
        errors: [],
      }
    } catch (error) {
      failures.push(normalizeProviderError(error, provider.id))
      if (provider === providers[providers.length - 1]) break
    }
  }

  return {
    source: "none",
    timestamp: new Date().toISOString(),
    data: createEmptyFinanceData(parsed.intent, parsed.ticker),
    errors: failures.map((item) => `${item.source}: ${item.message}`),
  }
}

function normalizeCoverage(input?: FinanceCoverage): FinanceCoverage {
  return input === "comprehensive" ? "comprehensive" : "default"
}

function latestTimestamp(results: FinanceDataEnvelope<FinanceProviderData>[]) {
  return results
    .map((item) => item.timestamp)
    .filter((item) => item.length > 0)
    .sort((a, b) => (a > b ? -1 : 1))[0] ?? new Date().toISOString()
}

function mergedAttribution(results: FinanceDataEnvelope<FinanceProviderData>[]): FinanceAttribution[] {
  const seen = new Set<string>()
  const out: FinanceAttribution[] = []
  results.forEach((result) => {
    const attribution = result.attribution ?? []
    attribution.forEach((item) => {
      const key = `${item.publisher}|${item.domain}|${item.url}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(item)
    })
  })
  return out
}

function hasNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function hasText(value: unknown): value is string {
  if (typeof value !== "string") return false
  const text = value.trim()
  if (!text) return false
  if (/\bunknown\b/i.test(text)) return false
  if (/^(n\/?a|-|none)$/i.test(text)) return false
  return true
}

function pickNumber(current: number | null | undefined, next: number | null | undefined) {
  if (hasNumber(current)) return current
  if (hasNumber(next)) return next
  return null
}

function pickText(current: string | null | undefined, next: string | null | undefined) {
  if (hasText(current)) return current
  if (hasText(next)) return next
  return null
}

function pickFundamentalValue(
  key: keyof FinanceFundamentalsData["metrics"],
  current: FinanceFundamentalsData,
  next: FinanceFundamentalsData,
) {
  const currentValue = current.metrics[key]
  if (hasNumber(currentValue)) {
    return {
      value: currentValue,
      period: current.metricPeriods[key],
      derivation: current.metricDerivation[key],
    }
  }

  const nextValue = next.metrics[key]
  if (hasNumber(nextValue)) {
    return {
      value: nextValue,
      period: next.metricPeriods[key],
      derivation: next.metricDerivation[key],
    }
  }

  return {
    value: null,
    period: current.metricPeriods[key] ?? next.metricPeriods[key] ?? ("Unknown" as FinanceMetricPeriod),
    derivation: current.metricDerivation[key] ?? next.metricDerivation[key] ?? ("reported" as FinanceMetricDerivation),
  }
}

function coarsePeriod(input: FinanceFundamentalsData) {
  if (input.period !== "Unknown") return input.period
  const periods = Object.values(input.metricPeriods)
  if (periods.includes("TTM")) return "TTM" as const
  if (periods.includes("FY")) return "FY" as const
  if (periods.includes("Q")) return "Q" as const
  return "Unknown" as const
}

function mergeData(intent: FinanceIntent, current: FinanceProviderData, next: FinanceProviderData, limit: number): FinanceProviderData {
  if (intent === "quote") return mergeQuote(current as FinanceQuoteData, next as FinanceQuoteData)
  if (intent === "fundamentals") return mergeFundamentals(current as FinanceFundamentalsData, next as FinanceFundamentalsData)
  if (intent === "filings") return mergeFilings(current as FinanceFilingsData, next as FinanceFilingsData, limit)
  if (intent === "insider") return mergeInsider(current as FinanceInsiderData, next as FinanceInsiderData, limit)
  return mergeNews(current as FinanceNewsData, next as FinanceNewsData, limit)
}

function mergeQuote(current: FinanceQuoteData, next: FinanceQuoteData): FinanceQuoteData {
  return {
    symbol: current.symbol || next.symbol,
    price: pickNumber(current.price, next.price),
    currency: pickText(current.currency, next.currency) ?? "USD",
    previousClose: pickNumber(current.previousClose, next.previousClose),
    change: pickNumber(current.change, next.change),
    changePercent: pickNumber(current.changePercent, next.changePercent),
    marketCap: pickNumber(current.marketCap, next.marketCap),
    fiftyTwoWeekHigh: pickNumber(current.fiftyTwoWeekHigh, next.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: pickNumber(current.fiftyTwoWeekLow, next.fiftyTwoWeekLow),
    ytdReturnPercent: pickNumber(current.ytdReturnPercent, next.ytdReturnPercent),
  }
}

function mergeFundamentals(current: FinanceFundamentalsData, next: FinanceFundamentalsData): FinanceFundamentalsData {
  const currentRatings = current.analystRatings ?? {
    strongBuy: null,
    buy: null,
    hold: null,
    sell: null,
    strongSell: null,
  }
  const nextRatings = next.analystRatings ?? {
    strongBuy: null,
    buy: null,
    hold: null,
    sell: null,
    strongSell: null,
  }
  const revenue = pickFundamentalValue("revenue", current, next)
  const netIncome = pickFundamentalValue("netIncome", current, next)
  const grossMarginPercent = pickFundamentalValue("grossMarginPercent", current, next)
  const debtToEquity = pickFundamentalValue("debtToEquity", current, next)
  const returnOnEquityPercent = pickFundamentalValue("returnOnEquityPercent", current, next)
  const operatingMarginPercent = pickFundamentalValue("operatingMarginPercent", current, next)
  const freeCashFlow = pickFundamentalValue("freeCashFlow", current, next)

  const merged: FinanceFundamentalsData = {
    symbol: current.symbol || next.symbol,
    metrics: {
      revenue: revenue.value,
      netIncome: netIncome.value,
      grossMarginPercent: grossMarginPercent.value,
      debtToEquity: debtToEquity.value,
      returnOnEquityPercent: returnOnEquityPercent.value,
      operatingMarginPercent: operatingMarginPercent.value,
      freeCashFlow: freeCashFlow.value,
    },
    metricPeriods: {
      revenue: revenue.period,
      netIncome: netIncome.period,
      grossMarginPercent: grossMarginPercent.period,
      debtToEquity: debtToEquity.period,
      returnOnEquityPercent: returnOnEquityPercent.period,
      operatingMarginPercent: operatingMarginPercent.period,
      freeCashFlow: freeCashFlow.period,
    },
    metricDerivation: {
      revenue: revenue.derivation,
      netIncome: netIncome.derivation,
      grossMarginPercent: grossMarginPercent.derivation,
      debtToEquity: debtToEquity.derivation,
      returnOnEquityPercent: returnOnEquityPercent.derivation,
      operatingMarginPercent: operatingMarginPercent.derivation,
      freeCashFlow: freeCashFlow.derivation,
    },
    fiscalPeriodEnd: pickText(current.fiscalPeriodEnd, next.fiscalPeriodEnd),
    marketCap: pickNumber(current.marketCap, next.marketCap),
    sector: pickText(current.sector, next.sector),
    headquarters: pickText(current.headquarters, next.headquarters),
    website: pickText(current.website, next.website),
    iconUrl: pickText(current.iconUrl, next.iconUrl),
    analystRatings: {
      strongBuy: pickNumber(currentRatings.strongBuy, nextRatings.strongBuy),
      buy: pickNumber(currentRatings.buy, nextRatings.buy),
      hold: pickNumber(currentRatings.hold, nextRatings.hold),
      sell: pickNumber(currentRatings.sell, nextRatings.sell),
      strongSell: pickNumber(currentRatings.strongSell, nextRatings.strongSell),
    },
    period: "Unknown",
  }
  return {
    ...merged,
    period: coarsePeriod(merged),
  }
}

function mergeFilings(current: FinanceFilingsData, next: FinanceFilingsData, limit: number): FinanceFilingsData {
  const seen = new Set<string>()
  const filings = [...(current.filings ?? []), ...(next.filings ?? [])]
    .filter((item) => {
      const key = `${item.accessionNumber}|${item.url}|${item.form}|${item.filingDate}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (a.filingDate > b.filingDate ? -1 : 1))
    .slice(0, Math.max(1, limit))

  return {
    symbol: current.symbol || next.symbol,
    filings,
  }
}

function mergeInsider(current: FinanceInsiderData, next: FinanceInsiderData, limit: number): FinanceInsiderData {
  const seen = new Set<string>()
  const entries = [...(current.entries ?? []), ...(next.entries ?? [])]
    .filter((item) => {
      const key = `${item.owner}|${item.date}|${item.shares}|${item.sharesChange}|${item.security}|${item.transactionType}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, Math.max(1, limit * 5))

  return {
    symbol: current.symbol || next.symbol,
    ownershipChange: entries.reduce((acc, item) => acc + item.sharesChange, 0),
    entries,
    summary: current.summary ?? next.summary ?? null,
  }
}

function mergeNews(current: FinanceNewsData, next: FinanceNewsData, limit: number): FinanceNewsData {
  const seen = new Set<string>()
  const items = [...(current.items ?? []), ...(next.items ?? [])]
    .filter((item) => {
      const key = `${item.url}|${item.title}|${item.publishedAt}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (a.publishedAt > b.publishedAt ? -1 : 1))
    .slice(0, Math.max(1, limit))

  return {
    symbol: current.symbol || next.symbol,
    items,
  }
}

function isComplete(intent: FinanceIntent, data: FinanceProviderData, limit: number) {
  if (intent === "quote") {
    const quote = data as FinanceQuoteData
    return (
      hasNumber(quote.price) &&
      hasNumber(quote.previousClose) &&
      hasNumber(quote.changePercent) &&
      hasNumber(quote.marketCap) &&
      hasNumber(quote.fiftyTwoWeekHigh) &&
      hasNumber(quote.fiftyTwoWeekLow) &&
      hasNumber(quote.ytdReturnPercent)
    )
  }

  if (intent === "fundamentals") {
    const fundamentals = data as FinanceFundamentalsData
    const ratings = fundamentals.analystRatings
    const hasRatings =
      (ratings?.strongBuy !== null && ratings?.strongBuy !== undefined) ||
      (ratings?.buy !== null && ratings?.buy !== undefined) ||
      (ratings?.hold !== null && ratings?.hold !== undefined) ||
      (ratings?.sell !== null && ratings?.sell !== undefined) ||
      (ratings?.strongSell !== null && ratings?.strongSell !== undefined)

    return (
      hasNumber(fundamentals.metrics.revenue) &&
      hasNumber(fundamentals.metrics.netIncome) &&
      hasNumber(fundamentals.metrics.grossMarginPercent) &&
      hasNumber(fundamentals.metrics.debtToEquity) &&
      hasNumber(fundamentals.metrics.freeCashFlow) &&
      hasNumber(fundamentals.marketCap) &&
      hasText(fundamentals.sector) &&
      hasText(fundamentals.headquarters) &&
      hasRatings
    )
  }

  if (intent === "filings") {
    const filings = data as FinanceFilingsData
    return filings.filings.length >= Math.min(limit, 5)
  }

  if (intent === "insider") {
    const insider = data as FinanceInsiderData
    return insider.entries.length > 0 || Boolean(insider.summary?.text)
  }

  const news = data as FinanceNewsData
  return news.items.length >= Math.min(limit, 3)
}
