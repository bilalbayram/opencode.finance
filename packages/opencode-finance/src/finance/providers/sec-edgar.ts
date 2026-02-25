import { abortAfterAny } from "../../util/abort"
import { normalizeErrorText } from "../parser"
import { ProviderError } from "../provider"
import type { FinanceProvider } from "../provider"
import type {
  FinanceDataEnvelope,
  FinanceIntent,
  FinanceProviderData,
  FinanceFilingsData,
  FinanceInsiderData,
  NormalizedFinanceQuery,
} from "../types"

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
const SEC_SUBMISSIONS_BASE = "https://data.sec.gov/submissions"
const DEFAULT_TIMEOUT_MS = 12_000

let tickerMapCache: Map<string, string> | undefined

function asText(input: unknown): string {
  if (input === null || input === undefined) return ""
  return String(input)
}

function normalizeForm(input: string): string {
  return input.replace(/\s+/g, "").replace(/-/g, "").toUpperCase()
}

function toIsoDate(input: unknown): string {
  const text = asText(input).trim()
  if (!text) return new Date().toISOString().slice(0, 10)
  const date = new Date(text)
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
  return text
}

function padCik(input: string): string {
  return input.padStart(10, "0")
}

function stripCik(input: string): string {
  const value = Number.parseInt(input, 10)
  if (Number.isFinite(value)) return String(value)
  return input.replace(/^0+/, "")
}

function parseFilings(payload: Record<string, unknown>, ticker: string, limit: number, form?: string): FinanceFilingsData {
  const filings = (payload.filings as Record<string, unknown> | undefined) ?? {}
  const recent = (filings.recent as Record<string, unknown> | undefined) ?? {}
  const forms = Array.isArray(recent.form) ? recent.form : []
  const filingDates = Array.isArray(recent.filingDate) ? recent.filingDate : []
  const reportDates = Array.isArray(recent.reportDate) ? recent.reportDate : []
  const accessionNumbers = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : []
  const primaryDocuments = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : []
  const cik = stripCik(asText(payload.cik))
  const filter = form ? normalizeForm(form) : ""
  const rows = []

  for (let idx = 0; idx < forms.length; idx += 1) {
    const value = asText(forms[idx])
    if (filter && normalizeForm(value) !== filter) continue
    const accession = asText(accessionNumbers[idx])
    const document = asText(primaryDocuments[idx])
    const filingDate = toIsoDate(filingDates[idx])
    const reportDate = toIsoDate(reportDates[idx])
    const accessionSlug = accession.replace(/-/g, "")
    const url = document
      ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionSlug}/${document}`
      : `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionSlug}`
    rows.push({
      form: value,
      accessionNumber: accession,
      filingDate,
      reportDate,
      url,
      summary: `${value} filed with SEC`,
    })
    if (rows.length >= limit) break
  }

  return {
    symbol: ticker.toUpperCase(),
    filings: rows,
  }
}

function parseInsiderFromFilings(payload: Record<string, unknown>, ticker: string, limit: number): FinanceInsiderData {
  const filings = parseFilings(payload, ticker, Math.max(1, limit), "4").filings
  const entries = filings.slice(0, Math.max(1, limit)).map((item) => ({
    owner: "Form 4 filer",
    date: item.filingDate,
    shares: 0,
    sharesChange: 0,
    transactionType: "other" as const,
    security: `${ticker.toUpperCase()} Form 4`,
  }))
  const latest = filings[0]?.filingDate
  const summary = filings.length
    ? `SEC Form 4 activity observed: ${filings.length} recent filings${latest ? ` (latest ${latest})` : ""}.`
    : "No recent SEC Form 4 filings observed in submissions feed."

  return {
    symbol: ticker.toUpperCase(),
    ownershipChange: 0,
    entries,
    summary: {
      source: "sec-edgar",
      text: summary,
    },
  }
}

interface SecEdgarOptions {
  identity?: string
  timeoutMs?: number
}

export class SecEdgarProvider implements FinanceProvider {
  readonly id = "sec-edgar"
  readonly displayName = "SEC EDGAR"
  private readonly identity: string | undefined
  private readonly timeoutMs: number

  constructor(options: SecEdgarOptions = {}) {
    this.identity = options.identity
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  supports(intent: FinanceIntent): boolean {
    return intent === "filings" || intent === "insider"
  }

  enabled(): boolean {
    return Boolean(this.identity)
  }

  private async request(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "User-Agent": this.identity!,
      },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new ProviderError(`sec-edgar request failed (${response.status}): ${body || response.statusText}`, this.id, String(response.status))
    }
    return (await response.json()) as Record<string, unknown>
  }

  private async tickerMap(signal: AbortSignal): Promise<Map<string, string>> {
    if (tickerMapCache) return tickerMapCache
    const payload = await this.request(SEC_TICKERS_URL, signal)
    const entries = Object.values(payload).flatMap((item) =>
      item && typeof item === "object" ? [item as Record<string, unknown>] : [],
    )
    const map = new Map<string, string>()
    for (const entry of entries) {
      const ticker = asText(entry.ticker).toUpperCase()
      const cik = asText(entry.cik_str)
      if (!ticker || !cik) continue
      map.set(ticker, padCik(cik))
    }
    tickerMapCache = map
    return map
  }

  async fetch(
    input: NormalizedFinanceQuery,
    options?: { signal?: AbortSignal },
  ): Promise<FinanceDataEnvelope<FinanceProviderData>> {
    if (input.intent !== "filings" && input.intent !== "insider") {
      throw new ProviderError(`Unsupported intent for ${this.id}: ${input.intent}`, this.id, "UNSUPPORTED")
    }
    const { signal, clearTimeout } = abortAfterAny(this.timeoutMs, ...(options?.signal ? [options.signal] : []))
    try {
      const map = await this.tickerMap(signal)
      const cik = map.get(input.ticker.toUpperCase())
      if (!cik) {
        throw new ProviderError(`Ticker ${input.ticker} not found in SEC mapping`, this.id, "NOT_FOUND")
      }

      const payload = await this.request(`${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`, signal)
      clearTimeout()
      return {
        source: this.id,
        timestamp: new Date().toISOString(),
        attribution: [
          {
            publisher: "SEC EDGAR",
            domain: "sec.gov",
            url: `${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`,
          },
        ],
        data:
          input.intent === "filings"
            ? parseFilings(payload, input.ticker, input.limit, input.form)
            : parseInsiderFromFilings(payload, input.ticker, input.limit),
        errors: [],
      }
    } catch (error) {
      clearTimeout()
      if (error instanceof ProviderError) throw error
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("sec-edgar request timed out", this.id, "TIMEOUT", this.timeoutMs)
      }
      throw new ProviderError(normalizeErrorText(error), this.id, "NETWORK")
    }
  }
}
