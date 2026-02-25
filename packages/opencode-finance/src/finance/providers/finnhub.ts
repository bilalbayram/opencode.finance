import { abortAfterAny } from "../../util/abort"
import { normalizeErrorText } from "../parser"
import { ProviderError } from "../provider"
import type { FinanceProvider } from "../provider"
import type {
  FinanceDataEnvelope,
  FinanceFundamentalsData,
  FinanceInsiderData,
  FinanceIntent,
  FinanceNewsData,
  FinanceProviderData,
  FinanceQuoteData,
  NormalizedFinanceQuery,
} from "../types"

const FINNHUB_BASE = "https://finnhub.io/api/v1"
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
  const raw = asText(input).trim()
  if (!raw) return new Date().toISOString()
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 9_999_999_999 ? numeric : numeric * 1000
    return new Date(ms).toISOString()
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

function headquarters(profile: Record<string, unknown>) {
  const city = asText(profile.city).trim()
  const state = asText(profile.state).trim()
  const country = asText(profile.country).trim()
  const parts = [city, state, country].filter((item) => item.length > 0)
  if (!parts.length) return null
  return parts.join(", ")
}

function transactionType(delta: number): "buy" | "sell" | "other" {
  if (delta < 0) return "sell"
  if (delta > 0) return "buy"
  return "other"
}

function rows(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
}

function statementValue(rows: Record<string, unknown>[], concepts: string[]): number | null {
  if (!rows.length) return null
  for (const concept of concepts) {
    const found = rows.find((row) => asText(row.concept).toLowerCase() === concept.toLowerCase())
    const value = toNumber(found?.value)
    if (value !== null) return value
  }
  return null
}

function fcfFromStatement(operatingCashFlow: number | null, capex: number | null, investingCashFlow: number | null) {
  if (operatingCashFlow === null) return null
  if (capex !== null) return operatingCashFlow - Math.abs(capex)
  if (investingCashFlow !== null) return operatingCashFlow + investingCashFlow
  return null
}

function parseFinancialsReported(payload: unknown) {
  const list = payload && typeof payload === "object" ? rows((payload as Record<string, unknown>).data) : []
  const latest = list[0] ?? {}
  const report = latest.report && typeof latest.report === "object" ? (latest.report as Record<string, unknown>) : {}
  const income = rows(report.ic)
  const balance = rows(report.bs)
  const cash = rows(report.cf)
  if (!income.length && !balance.length && !cash.length) return

  const revenue = statementValue(income, [
    "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax",
    "us-gaap_Revenues",
    "us-gaap_SalesRevenueNet",
  ])
  const netIncome = statementValue(income, ["us-gaap_NetIncomeLoss"])
  const grossProfit = statementValue(income, ["us-gaap_GrossProfit"])
  const operatingIncome = statementValue(income, ["us-gaap_OperatingIncomeLoss"])
  const longTermDebt = statementValue(balance, ["us-gaap_LongTermDebtNoncurrent"])
  const currentDebt = statementValue(balance, [
    "us-gaap_LongTermDebtCurrent",
    "us-gaap_DebtCurrent",
    "us-gaap_ShortTermBorrowings",
  ])
  const equity = statementValue(balance, [
    "us-gaap_StockholdersEquity",
    "us-gaap_StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    "us-gaap_StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ])
  const operatingCashFlow = statementValue(cash, ["us-gaap_NetCashProvidedByUsedInOperatingActivities"])
  const capex = statementValue(cash, [
    "us-gaap_PaymentsToAcquirePropertyPlantAndEquipment",
    "us-gaap_PaymentsToAcquireProductiveAssets",
    "us-gaap_PaymentsToAcquireBusinessesNetOfCashAcquired",
  ])
  const investingCashFlow = statementValue(cash, ["us-gaap_NetCashProvidedByUsedInInvestingActivities"])
  const totalDebt = [longTermDebt, currentDebt].filter((item): item is number => item !== null).reduce((acc, item) => acc + item, 0)
  const debtToEquity = totalDebt !== 0 && equity !== null && equity !== 0 ? Number((totalDebt / equity).toFixed(6)) : null
  const grossMarginPercent = revenue !== null && revenue !== 0 && grossProfit !== null ? Number(((grossProfit / revenue) * 100).toFixed(6)) : null
  const operatingMarginPercent =
    revenue !== null && revenue !== 0 && operatingIncome !== null ? Number(((operatingIncome / revenue) * 100).toFixed(6)) : null
  const freeCashFlow = fcfFromStatement(operatingCashFlow, capex, investingCashFlow)
  const quarter = Number(toNumber(latest.quarter) ?? 0)
  const period = quarter > 0 ? "Q" : "FY"
  const fiscalPeriodEnd = asText(latest.endDate || latest.filedDate || latest.acceptedDate).trim() || null

  return {
    metrics: {
      revenue,
      netIncome,
      grossMarginPercent,
      debtToEquity,
      returnOnEquityPercent: null,
      operatingMarginPercent,
      freeCashFlow,
    },
    metricPeriods: {
      revenue: revenue === null ? "Unknown" : period,
      netIncome: netIncome === null ? "Unknown" : period,
      grossMarginPercent: grossMarginPercent === null ? "Unknown" : period,
      debtToEquity: debtToEquity === null ? "Unknown" : period,
      returnOnEquityPercent: "Unknown",
      operatingMarginPercent: operatingMarginPercent === null ? "Unknown" : period,
      freeCashFlow: freeCashFlow === null ? "Unknown" : period,
    },
    metricDerivation: {
      revenue: "reported",
      netIncome: "reported",
      grossMarginPercent: "derived",
      debtToEquity: "derived",
      returnOnEquityPercent: "reported",
      operatingMarginPercent: "derived",
      freeCashFlow: "derived",
    },
    fiscalPeriodEnd,
    period,
  } as const
}

function quoteData(input: {
  ticker: string
  quote: Record<string, unknown>
  metric: Record<string, unknown>
  profile: Record<string, unknown>
}): FinanceQuoteData {
  return {
    symbol: input.ticker.toUpperCase(),
    price: toNumber(input.quote.c),
    currency: asText(input.profile.currency || "USD") || "USD",
    previousClose: toNumber(input.quote.pc),
    change: toNumber(input.quote.d),
    changePercent: toNumber(input.quote.dp),
    marketCap: toNumber(input.profile.marketCapitalization),
    fiftyTwoWeekHigh: toNumber(input.metric["52WeekHigh"]),
    fiftyTwoWeekLow: toNumber(input.metric["52WeekLow"]),
    ytdReturnPercent: toPercent(input.metric.ytdPriceReturnDaily),
  }
}

function fundamentalsData(input: {
  ticker: string
  metric: Record<string, unknown>
  profile: Record<string, unknown>
  recommendation: Record<string, unknown>
  financials?: ReturnType<typeof parseFinancialsReported>
}): FinanceFundamentalsData {
  const strongBuy = toNumber(input.recommendation.strongBuy)
  const buy = toNumber(input.recommendation.buy)
  const hold = toNumber(input.recommendation.hold)
  const sell = toNumber(input.recommendation.sell)
  const strongSell = toNumber(input.recommendation.strongSell)
  const revenueMetric = toNumber(input.metric.ttmRevenue)
  const netIncomeMetric = toNumber(input.metric.netIncome || input.metric.netIncomeTTM)
  const grossMarginMetric = toPercent(input.metric.grossMarginTTM || input.metric.grossMargin)
  const debtQuarterlyMetric = toNumber(input.metric.totalDebtToEquityQuarterly)
  const debtAnnualMetric = toNumber(input.metric.totalDebtToEquityAnnual)
  const debtMetric = debtQuarterlyMetric ?? debtAnnualMetric
  const roeMetric = toPercent(input.metric.roeTTM)
  const operatingMarginMetric = toPercent(input.metric.operatingMarginTTM)
  const freeCashFlowTTMMetric = toNumber(input.metric.freeCashFlowTTM)
  const freeCashFlowAnnualMetric = toNumber(input.metric.freeCashFlowAnnual)
  const freeCashFlowMetric = freeCashFlowTTMMetric ?? freeCashFlowAnnualMetric

  const revenue = revenueMetric ?? input.financials?.metrics.revenue ?? null
  const netIncome = netIncomeMetric ?? input.financials?.metrics.netIncome ?? null
  const grossMarginPercent = grossMarginMetric ?? input.financials?.metrics.grossMarginPercent ?? null
  const debtToEquity = debtMetric ?? input.financials?.metrics.debtToEquity ?? null
  const returnOnEquityPercent = roeMetric ?? input.financials?.metrics.returnOnEquityPercent ?? null
  const operatingMarginPercent = operatingMarginMetric ?? input.financials?.metrics.operatingMarginPercent ?? null
  const freeCashFlow = freeCashFlowMetric ?? input.financials?.metrics.freeCashFlow ?? null

  return {
    symbol: input.ticker.toUpperCase(),
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
      revenue: revenueMetric !== null ? "TTM" : (revenue === null ? "Unknown" : (input.financials?.metricPeriods.revenue ?? "Unknown")),
      netIncome:
        netIncomeMetric !== null ? "TTM" : (netIncome === null ? "Unknown" : (input.financials?.metricPeriods.netIncome ?? "Unknown")),
      grossMarginPercent:
        grossMarginMetric !== null
          ? "TTM"
          : (grossMarginPercent === null ? "Unknown" : (input.financials?.metricPeriods.grossMarginPercent ?? "Unknown")),
      debtToEquity:
        debtQuarterlyMetric !== null
          ? "Q"
          : debtAnnualMetric !== null
            ? "FY"
            : (debtToEquity === null ? "Unknown" : (input.financials?.metricPeriods.debtToEquity ?? "Unknown")),
      returnOnEquityPercent:
        roeMetric !== null
          ? "TTM"
          : (returnOnEquityPercent === null ? "Unknown" : (input.financials?.metricPeriods.returnOnEquityPercent ?? "Unknown")),
      operatingMarginPercent:
        operatingMarginMetric !== null
          ? "TTM"
          : (operatingMarginPercent === null ? "Unknown" : (input.financials?.metricPeriods.operatingMarginPercent ?? "Unknown")),
      freeCashFlow:
        freeCashFlowTTMMetric !== null
          ? "TTM"
          : freeCashFlowAnnualMetric !== null
            ? "FY"
            : (freeCashFlow === null ? "Unknown" : (input.financials?.metricPeriods.freeCashFlow ?? "Unknown")),
    },
    metricDerivation: {
      revenue: revenueMetric !== null ? "reported" : (input.financials?.metricDerivation.revenue ?? "reported"),
      netIncome:
        netIncomeMetric !== null ? "reported" : (input.financials?.metricDerivation.netIncome ?? "reported"),
      grossMarginPercent:
        grossMarginMetric !== null ? "reported" : (input.financials?.metricDerivation.grossMarginPercent ?? "reported"),
      debtToEquity:
        debtMetric !== null ? "reported" : (input.financials?.metricDerivation.debtToEquity ?? "reported"),
      returnOnEquityPercent:
        roeMetric !== null ? "reported" : (input.financials?.metricDerivation.returnOnEquityPercent ?? "reported"),
      operatingMarginPercent:
        operatingMarginMetric !== null ? "reported" : (input.financials?.metricDerivation.operatingMarginPercent ?? "reported"),
      freeCashFlow:
        freeCashFlowMetric !== null ? "reported" : (input.financials?.metricDerivation.freeCashFlow ?? "reported"),
    },
    fiscalPeriodEnd: asText(input.recommendation.period).trim() || input.financials?.fiscalPeriodEnd || null,
    marketCap: toNumber(input.profile.marketCapitalization),
    sector: asText(input.profile.finnhubIndustry).trim() || null,
    headquarters: headquarters(input.profile),
    website: asText(input.profile.weburl).trim() || null,
    iconUrl: asText(input.profile.logo).trim() || null,
    analystRatings: {
      strongBuy,
      buy,
      hold,
      sell,
      strongSell,
    },
    period:
      revenueMetric !== null ||
      netIncomeMetric !== null ||
      grossMarginMetric !== null ||
      roeMetric !== null ||
      operatingMarginMetric !== null ||
      freeCashFlowTTMMetric !== null
        ? "TTM"
        : debtQuarterlyMetric !== null
          ? "Q"
          : debtAnnualMetric !== null
            ? "FY"
            : (input.financials?.period ?? "Unknown"),
  }
}

function insiderData(ticker: string, payload: Record<string, unknown>): FinanceInsiderData {
  const rows = Array.isArray(payload.data)
    ? payload.data.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
    : []
  const entries = rows.map((row) => {
    const delta = toNumber(row.change) ?? 0
    const kind = transactionType(delta)
    return {
      owner: asText(row.name || row.person || row.insiderName).trim() || "Unknown Insider",
      date: toIsoDate(row.transactionDate || row.filingDate).slice(0, 10),
      shares: Math.abs(delta),
      sharesChange: delta,
      transactionType: kind,
      security: asText(row.securityType || `${ticker} Common Stock`),
    }
  })
  return {
    symbol: ticker.toUpperCase(),
    ownershipChange: entries.reduce((acc, item) => acc + item.sharesChange, 0),
    entries,
    summary: null,
  }
}

function newsData(ticker: string, payload: unknown, limit: number): FinanceNewsData {
  const rows = Array.isArray(payload)
    ? payload.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
    : []
  return {
    symbol: ticker.toUpperCase(),
    items: rows.slice(0, Math.max(1, limit)).map((row) => ({
      title: asText(row.headline || row.summary).trim() || "Finnhub headline",
      source: asText(row.source || "Finnhub"),
      publishedAt: toIsoDate(row.datetime),
      url: asText(row.url),
      summary: asText(row.summary || row.headline),
      sentiment: null,
    })),
  }
}

interface FinnhubOptions {
  apiKey?: string
  timeoutMs?: number
}

export class FinnhubProvider implements FinanceProvider {
  readonly id = "finnhub"
  readonly displayName = "Finnhub"
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number

  constructor(options: FinnhubOptions = {}) {
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  supports(intent: FinanceIntent): boolean {
    return intent === "quote" || intent === "fundamentals" || intent === "insider" || intent === "news"
  }

  enabled(): boolean {
    return Boolean(this.apiKey)
  }

  private async request(path: string, query: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    query.set("token", this.apiKey!)
    const url = `${FINNHUB_BASE}${path}?${query.toString()}`
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "opencode-finance/1.0",
      },
    })
    if (!response.ok) {
      const text = await response.text()
      throw new ProviderError(`finnhub request failed (${response.status}): ${text || response.statusText}`, this.id, String(response.status))
    }
    const payload = (await response.json()) as unknown
    if (payload && typeof payload === "object" && "error" in payload) {
      const message = asText((payload as Record<string, unknown>).error)
      if (message.trim()) {
        throw new ProviderError(`finnhub rejected request: ${message}`, this.id, "PROVIDER_ERROR")
      }
    }
    return payload
  }

  private attribution(input: NormalizedFinanceQuery) {
    if (input.intent === "quote") {
      return [
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(input.ticker)}`,
        },
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/stock/profile2?symbol=${encodeURIComponent(input.ticker)}`,
        },
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/stock/metric?symbol=${encodeURIComponent(input.ticker)}&metric=all`,
        },
      ]
    }

    if (input.intent === "fundamentals") {
      return [
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/stock/profile2?symbol=${encodeURIComponent(input.ticker)}`,
        },
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/stock/metric?symbol=${encodeURIComponent(input.ticker)}&metric=all`,
        },
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/stock/recommendation?symbol=${encodeURIComponent(input.ticker)}`,
        },
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/stock/financials-reported?symbol=${encodeURIComponent(input.ticker)}&freq=annual`,
        },
      ]
    }

    if (input.intent === "insider") {
      return [
        {
          publisher: "Finnhub",
          domain: "finnhub.io",
          url: `${FINNHUB_BASE}/stock/insider-transactions?symbol=${encodeURIComponent(input.ticker)}`,
        },
      ]
    }

    const to = new Date()
    const from = new Date(to.getTime() - 1000 * 60 * 60 * 24 * 30)
    return [
      {
        publisher: "Finnhub",
        domain: "finnhub.io",
        url: `${FINNHUB_BASE}/company-news?symbol=${encodeURIComponent(input.ticker)}&from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`,
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
        const [quote, profile, metric] = await Promise.all([
          this.request("/quote", new URLSearchParams({ symbol: input.ticker }), signal),
          this.request("/stock/profile2", new URLSearchParams({ symbol: input.ticker }), signal),
          this.request("/stock/metric", new URLSearchParams({ symbol: input.ticker, metric: "all" }), signal),
        ])
        clearTimeout()
        const metricBlock = metric && typeof metric === "object" ? ((metric as Record<string, unknown>).metric as Record<string, unknown> | undefined) ?? {} : {}
        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: quoteData({
            ticker: input.ticker,
            quote: quote && typeof quote === "object" ? (quote as Record<string, unknown>) : {},
            metric: metricBlock,
            profile: profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {},
          }),
          errors: [],
        }
      }

      if (input.intent === "fundamentals") {
        const [profile, metric, recommendation, financialsAnnual] = await Promise.all([
          this.request("/stock/profile2", new URLSearchParams({ symbol: input.ticker }), signal),
          this.request("/stock/metric", new URLSearchParams({ symbol: input.ticker, metric: "all" }), signal),
          this.request("/stock/recommendation", new URLSearchParams({ symbol: input.ticker }), signal),
          this.request(
            "/stock/financials-reported",
            new URLSearchParams({ symbol: input.ticker, freq: "annual" }),
            signal,
          ).catch(() => undefined),
        ])
        const financials = parseFinancialsReported(financialsAnnual)
        const fallbackFinancials =
          financials ??
          parseFinancialsReported(
            await this.request(
              "/stock/financials-reported",
              new URLSearchParams({ symbol: input.ticker, freq: "quarterly" }),
              signal,
            ).catch(() => undefined),
          )
        clearTimeout()

        const recommendations = Array.isArray(recommendation)
          ? recommendation.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
          : []

        const latest = recommendations
          .sort((a, b) => (asText(a.period) > asText(b.period) ? -1 : 1))
          .at(0) ?? {}

        const metricBlock = metric && typeof metric === "object" ? ((metric as Record<string, unknown>).metric as Record<string, unknown> | undefined) ?? {} : {}

        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: fundamentalsData({
            ticker: input.ticker,
            metric: metricBlock,
            profile: profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {},
            recommendation: latest,
            financials: fallbackFinancials,
          }),
          errors: [],
        }
      }

      if (input.intent === "insider") {
        const payload = await this.request("/stock/insider-transactions", new URLSearchParams({ symbol: input.ticker }), signal)
        clearTimeout()
        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: insiderData(input.ticker, payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}),
          errors: [],
        }
      }

      if (input.intent === "news") {
        const to = new Date()
        const from = new Date(to.getTime() - 1000 * 60 * 60 * 24 * 30)
        const payload = await this.request(
          "/company-news",
          new URLSearchParams({
            symbol: input.ticker,
            from: from.toISOString().slice(0, 10),
            to: to.toISOString().slice(0, 10),
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
        throw new ProviderError("finnhub request timed out", this.id, "TIMEOUT", this.timeoutMs)
      }
      throw new ProviderError(normalizeErrorText(error), this.id, "NETWORK")
    }
  }
}
