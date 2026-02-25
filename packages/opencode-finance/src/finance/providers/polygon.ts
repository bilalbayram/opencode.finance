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

const POLYGON_BASE = "https://api.polygon.io"
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

function rows(input: unknown) {
  if (!Array.isArray(input)) return [] as Record<string, unknown>[]
  return input.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
}

function transactionType(input: string): "buy" | "sell" | "other" {
  if (input.includes("sale") || input.includes("sell")) return "sell"
  if (input.includes("buy")) return "buy"
  return "other"
}

function referenceResult(input: unknown) {
  if (!input || typeof input !== "object") return {} as Record<string, unknown>
  const value = (input as Record<string, unknown>).results
  if (!value || typeof value !== "object") return {} as Record<string, unknown>
  return value as Record<string, unknown>
}

function metricValue(input: unknown) {
  if (!input || typeof input !== "object") return toNumber(input)
  const row = input as Record<string, unknown>
  if ("value" in row) return toNumber(row.value)
  return toNumber(input)
}

function financialResult(input: unknown) {
  if (!input || typeof input !== "object") return
  const list = rows((input as Record<string, unknown>).results)
  if (!list.length) return
  return list[0]
}

function fcf(input: {
  operatingCashFlow: number | null
  capex: number | null
  investingCashFlow: number | null
}) {
  if (input.operatingCashFlow === null) return null
  if (input.capex !== null) return input.operatingCashFlow - Math.abs(input.capex)
  if (input.investingCashFlow !== null) return input.operatingCashFlow + input.investingCashFlow
  return null
}

function parseFinancials(input: Record<string, unknown> | undefined) {
  if (!input) return
  const financials = input.financials && typeof input.financials === "object" ? (input.financials as Record<string, unknown>) : {}
  const income = financials.income_statement && typeof financials.income_statement === "object"
    ? (financials.income_statement as Record<string, unknown>)
    : {}
  const balance = financials.balance_sheet && typeof financials.balance_sheet === "object"
    ? (financials.balance_sheet as Record<string, unknown>)
    : {}
  const cash = financials.cash_flow_statement && typeof financials.cash_flow_statement === "object"
    ? (financials.cash_flow_statement as Record<string, unknown>)
    : {}

  const revenue = metricValue(income.revenues)
  const netIncome = metricValue(income.net_income_loss)
  const grossProfit = metricValue(income.gross_profit)
  const operatingIncome = metricValue(income.operating_income_loss)
  const liabilities = metricValue(balance.liabilities)
  const equity = metricValue(balance.equity)
  const operatingCashFlow = metricValue(
    cash.net_cash_flow_from_operating_activities ?? cash.net_cash_flow_from_operating_activities_continuing,
  )
  const capex = metricValue(cash.capital_expenditure ?? cash.capital_expenditures)
  const investingCashFlow = metricValue(
    cash.net_cash_flow_from_investing_activities ?? cash.net_cash_flow_from_investing_activities_continuing,
  )

  const debtToEquity =
    liabilities !== null && equity !== null && equity !== 0 ? Number((liabilities / equity).toFixed(6)) : null
  const grossMarginPercent =
    revenue !== null && grossProfit !== null && revenue !== 0 ? Number(((grossProfit / revenue) * 100).toFixed(6)) : null
  const operatingMarginPercent =
    revenue !== null && operatingIncome !== null && revenue !== 0 ? Number(((operatingIncome / revenue) * 100).toFixed(6)) : null
  const freeCashFlow = fcf({ operatingCashFlow, capex, investingCashFlow })

  const timeframe = asText(input.timeframe).trim().toLowerCase()
  const fiscalPeriod = asText(input.fiscal_period).trim().toUpperCase()
  const period = timeframe === "annual" || fiscalPeriod === "FY" ? "FY" : "Q"

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
    fiscalPeriodEnd: asText(input.end_date).trim() || null,
    period,
  } as const
}

function ytdPercent(input: Record<string, unknown>[], price: number | null) {
  if (price === null || !input.length) return null
  const oldest = input
    .map((row) => ({
      date: Number(toNumber(row.t) ?? 0),
      close: toNumber(row.c),
    }))
    .filter((item) => item.date > 0 && item.close !== null)
    .sort((a, b) => a.date - b.date)[0]

  if (!oldest || oldest.close === null || oldest.close === 0) return null
  return Number((((price - oldest.close) / oldest.close) * 100).toFixed(6))
}

function quoteData(input: {
  ticker: string
  prev: Record<string, unknown>
  oneYear: Record<string, unknown>[]
  ytd: Record<string, unknown>[]
  reference: Record<string, unknown>
}): FinanceQuoteData {
  const price = toNumber(input.prev.c)
  const previousClose = toNumber(input.prev.c)
  const change = price !== null && previousClose !== null ? Number((price - previousClose).toFixed(6)) : null
  const changePercent =
    price !== null && previousClose !== null && previousClose !== 0
      ? Number((((price - previousClose) / previousClose) * 100).toFixed(6))
      : null

  const highs = input.oneYear.map((row) => toNumber(row.h)).filter((value): value is number => value !== null)
  const lows = input.oneYear.map((row) => toNumber(row.l)).filter((value): value is number => value !== null)

  return {
    symbol: input.ticker.toUpperCase(),
    price,
    currency: asText(input.reference.currency_name || "USD") || "USD",
    previousClose,
    change,
    changePercent,
    marketCap: toNumber(input.reference.market_cap),
    fiftyTwoWeekHigh: highs.length ? Math.max(...highs) : null,
    fiftyTwoWeekLow: lows.length ? Math.min(...lows) : null,
    ytdReturnPercent: ytdPercent(input.ytd, price),
  }
}

function fundamentalsData(input: {
  ticker: string
  reference: Record<string, unknown>
  financials?: ReturnType<typeof parseFinancials>
}): FinanceFundamentalsData {
  return {
    symbol: input.ticker.toUpperCase(),
    metrics: {
      revenue: input.financials?.metrics.revenue ?? null,
      netIncome: input.financials?.metrics.netIncome ?? null,
      grossMarginPercent: input.financials?.metrics.grossMarginPercent ?? null,
      debtToEquity: input.financials?.metrics.debtToEquity ?? null,
      returnOnEquityPercent: input.financials?.metrics.returnOnEquityPercent ?? null,
      operatingMarginPercent: input.financials?.metrics.operatingMarginPercent ?? null,
      freeCashFlow: input.financials?.metrics.freeCashFlow ?? null,
    },
    metricPeriods: {
      revenue: input.financials?.metricPeriods.revenue ?? "Unknown",
      netIncome: input.financials?.metricPeriods.netIncome ?? "Unknown",
      grossMarginPercent: input.financials?.metricPeriods.grossMarginPercent ?? "Unknown",
      debtToEquity: input.financials?.metricPeriods.debtToEquity ?? "Unknown",
      returnOnEquityPercent: input.financials?.metricPeriods.returnOnEquityPercent ?? "Unknown",
      operatingMarginPercent: input.financials?.metricPeriods.operatingMarginPercent ?? "Unknown",
      freeCashFlow: input.financials?.metricPeriods.freeCashFlow ?? "Unknown",
    },
    metricDerivation: {
      revenue: input.financials?.metricDerivation.revenue ?? "reported",
      netIncome: input.financials?.metricDerivation.netIncome ?? "reported",
      grossMarginPercent: input.financials?.metricDerivation.grossMarginPercent ?? "reported",
      debtToEquity: input.financials?.metricDerivation.debtToEquity ?? "reported",
      returnOnEquityPercent: input.financials?.metricDerivation.returnOnEquityPercent ?? "reported",
      operatingMarginPercent: input.financials?.metricDerivation.operatingMarginPercent ?? "reported",
      freeCashFlow: input.financials?.metricDerivation.freeCashFlow ?? "reported",
    },
    marketCap: toNumber(input.reference.market_cap),
    sector: asText(input.reference.sic_description || input.reference.market).trim() || null,
    headquarters: null,
    website: asText(input.reference.homepage_url).trim() || null,
    iconUrl: asText((input.reference.branding as Record<string, unknown> | undefined)?.icon_url).trim() || null,
    analystRatings: null,
    fiscalPeriodEnd: input.financials?.fiscalPeriodEnd ?? null,
    period: input.financials?.period ?? "Unknown",
  }
}

function insiderData(ticker: string, payload: unknown): FinanceInsiderData {
  const list = payload && typeof payload === "object" ? rows((payload as Record<string, unknown>).results) : []
  const entries = list.map((row) => {
    const delta = toNumber(row.shares) ?? 0
    const raw = asText(row.transaction_type).toLowerCase()
    const kind = transactionType(raw)
    return {
      owner: asText(row.insider_name || row.name).trim() || "Unknown Insider",
      date: toIsoDate(row.filing_date).slice(0, 10),
      shares: Math.abs(delta),
      sharesChange: kind === "sell" ? -Math.abs(delta) : Math.abs(delta),
      transactionType: kind,
      security: asText(row.security_title || `${ticker} Common Stock`),
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
  const list = payload && typeof payload === "object" ? rows((payload as Record<string, unknown>).results) : []
  return {
    symbol: ticker.toUpperCase(),
    items: list.slice(0, Math.max(1, limit)).map((row) => ({
      title: asText(row.title || row.description).trim() || "Polygon headline",
      source: asText((row.publisher as Record<string, unknown> | undefined)?.name || "Polygon"),
      publishedAt: toIsoDate(row.published_utc),
      url: asText(row.article_url),
      summary: asText(row.description || row.title),
      sentiment: null,
    })),
  }
}

interface PolygonOptions {
  apiKey?: string
  timeoutMs?: number
}

export class PolygonProvider implements FinanceProvider {
  readonly id = "polygon"
  readonly displayName = "Polygon"
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number

  constructor(options: PolygonOptions = {}) {
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
    query.set("apiKey", this.apiKey!)
    const url = `${POLYGON_BASE}${path}?${query.toString()}`
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "opencode-finance/1.0",
      },
    })
    if (!response.ok) {
      const text = await response.text()
      throw new ProviderError(`polygon request failed (${response.status}): ${text || response.statusText}`, this.id, String(response.status))
    }
    const payload = (await response.json()) as unknown
    if (payload && typeof payload === "object") {
      const status = asText((payload as Record<string, unknown>).status).toLowerCase()
      const error = asText((payload as Record<string, unknown>).error)
      if ((status === "error" || error.trim()) && !rows((payload as Record<string, unknown>).results).length) {
        const message = error || asText((payload as Record<string, unknown>).message)
        if (message.trim()) throw new ProviderError(`polygon rejected request: ${message}`, this.id, "PROVIDER_ERROR")
      }
    }
    return payload
  }

  private attribution(input: NormalizedFinanceQuery) {
    if (input.intent === "quote") {
      return [
        {
          publisher: "Polygon",
          domain: "polygon.io",
          url: `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(input.ticker)}/prev`,
        },
        {
          publisher: "Polygon",
          domain: "polygon.io",
          url: `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(input.ticker)}/range/1/day/<from>/<to>`,
        },
        {
          publisher: "Polygon",
          domain: "polygon.io",
          url: `${POLYGON_BASE}/v3/reference/tickers/${encodeURIComponent(input.ticker)}`,
        },
      ]
    }

    if (input.intent === "fundamentals") {
      return [
        {
          publisher: "Polygon",
          domain: "polygon.io",
          url: `${POLYGON_BASE}/v3/reference/tickers/${encodeURIComponent(input.ticker)}`,
        },
        {
          publisher: "Polygon",
          domain: "polygon.io",
          url: `${POLYGON_BASE}/vX/reference/financials?ticker=${encodeURIComponent(input.ticker)}&timeframe=annual&limit=1`,
        },
      ]
    }

    if (input.intent === "insider") {
      return [
        {
          publisher: "Polygon",
          domain: "polygon.io",
          url: `${POLYGON_BASE}/v3/reference/insider-transactions?ticker=${encodeURIComponent(input.ticker)}`,
        },
      ]
    }

    return [
      {
        publisher: "Polygon",
        domain: "polygon.io",
        url: `${POLYGON_BASE}/v2/reference/news?ticker=${encodeURIComponent(input.ticker)}&limit=${Math.min(Math.max(1, input.limit), 50)}`,
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
        const now = new Date()
        const oneYear = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 370)
        const ytdStart = new Date(now.getFullYear(), 0, 1)

        const [prevPayload, oneYearPayload, ytdPayload, referencePayload] = await Promise.all([
          this.request(`/v2/aggs/ticker/${encodeURIComponent(input.ticker)}/prev`, new URLSearchParams({ adjusted: "true" }), signal),
          this.request(
            `/v2/aggs/ticker/${encodeURIComponent(input.ticker)}/range/1/day/${oneYear.toISOString().slice(0, 10)}/${now.toISOString().slice(0, 10)}`,
            new URLSearchParams({ adjusted: "true", sort: "asc", limit: "50000" }),
            signal,
          ),
          this.request(
            `/v2/aggs/ticker/${encodeURIComponent(input.ticker)}/range/1/day/${ytdStart.toISOString().slice(0, 10)}/${now.toISOString().slice(0, 10)}`,
            new URLSearchParams({ adjusted: "true", sort: "asc", limit: "50000" }),
            signal,
          ),
          this.request(`/v3/reference/tickers/${encodeURIComponent(input.ticker)}`, new URLSearchParams(), signal),
        ])
        clearTimeout()

        const prev = rows((prevPayload as Record<string, unknown>).results)[0] ?? {}
        const oneYearRows = rows((oneYearPayload as Record<string, unknown>).results)
        const ytdRows = rows((ytdPayload as Record<string, unknown>).results)

        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: quoteData({
            ticker: input.ticker,
            prev,
            oneYear: oneYearRows,
            ytd: ytdRows,
            reference: referenceResult(referencePayload),
          }),
          errors: [],
        }
      }

      if (input.intent === "fundamentals") {
        const [referencePayload, annualFinancialsPayload] = await Promise.all([
          this.request(`/v3/reference/tickers/${encodeURIComponent(input.ticker)}`, new URLSearchParams(), signal),
          this.request(
            "/vX/reference/financials",
            new URLSearchParams({
              ticker: input.ticker,
              timeframe: "annual",
              limit: "1",
            }),
            signal,
          ).catch(() => undefined),
        ])
        const financialsAnnual = parseFinancials(financialResult(annualFinancialsPayload))
        const financials =
          financialsAnnual ??
          parseFinancials(
            financialResult(
              await this.request(
                "/vX/reference/financials",
                new URLSearchParams({
                  ticker: input.ticker,
                  timeframe: "quarterly",
                  limit: "1",
                }),
                signal,
              ).catch(() => undefined),
            ),
          )
        clearTimeout()
        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: fundamentalsData({
            ticker: input.ticker,
            reference: referenceResult(referencePayload),
            financials,
          }),
          errors: [],
        }
      }

      if (input.intent === "insider") {
        const payload = await this.request(
          "/v3/reference/insider-transactions",
          new URLSearchParams({ ticker: input.ticker, limit: `${Math.min(Math.max(1, input.limit), 50)}` }),
          signal,
        )
        clearTimeout()
        return {
          source: this.id,
          timestamp: new Date().toISOString(),
          attribution: this.attribution(input),
          data: insiderData(input.ticker, payload),
          errors: [],
        }
      }

      if (input.intent === "news") {
        const payload = await this.request(
          "/v2/reference/news",
          new URLSearchParams({ ticker: input.ticker, limit: `${Math.min(Math.max(1, input.limit), 50)}` }),
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
        throw new ProviderError("polygon request timed out", this.id, "TIMEOUT", this.timeoutMs)
      }
      throw new ProviderError(normalizeErrorText(error), this.id, "NETWORK")
    }
  }
}
