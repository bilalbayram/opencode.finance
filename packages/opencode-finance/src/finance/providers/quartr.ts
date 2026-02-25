import { abortAfterAny } from "../../util/abort"
import { normalizeErrorText } from "../parser"
import { ProviderError } from "../provider"
import type { FinanceProvider } from "../provider"
import type {
  FinanceDataEnvelope,
  FinanceFilingsData,
  FinanceIntent,
  FinanceNewsData,
  FinanceProviderData,
  NormalizedFinanceQuery,
} from "../types"

const QUARTR_BASE = "https://api.quartr.com/public/v3"
const DEFAULT_TIMEOUT_MS = 12_000

function asText(input: unknown): string {
  if (input === null || input === undefined) return ""
  return String(input)
}

function toIsoDate(input: unknown): string {
  const text = asText(input).trim()
  if (!text) return new Date().toISOString().slice(0, 10)
  const date = new Date(text)
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
  return text
}

function inferForm(row: Record<string, unknown>): string {
  const title = asText((row.event as Record<string, unknown> | undefined)?.title || row.title).toLowerCase()
  const label = asText((row.event as Record<string, unknown> | undefined)?.fiscalPeriod || row.fiscalPeriod).toLowerCase()
  if (title.includes("10-k") || title.includes("annual") || label.includes("fy")) return "10-K"
  if (title.includes("10-q") || label.includes("q1") || label.includes("q2") || label.includes("q3")) return "10-Q"
  if (title.includes("8-k")) return "8-K"
  return "Report"
}

function filings(payload: Record<string, unknown>, ticker: string, limit: number): FinanceFilingsData {
  const data = ((payload.data as unknown[]) ?? []).flatMap((item) =>
    item && typeof item === "object" ? [item as Record<string, unknown>] : [],
  )
  return {
    symbol: ticker.toUpperCase(),
    filings: data.slice(0, limit).map((row) => {
      const event = (row.event as Record<string, unknown> | undefined) ?? {}
      const date = toIsoDate(event.date ?? row.date ?? row.updatedAt)
      const form = inferForm(row)
      return {
        form,
        accessionNumber: `quartr-${asText(row.id || row.reportId || row.fileId)}`,
        filingDate: date,
        reportDate: date,
        url: asText(row.fileUrl || row.url || `https://quartr.com`),
        summary: asText(event.title || row.title || `${form} report`),
      }
    }),
  }
}

function news(payload: Record<string, unknown>, ticker: string, limit: number): FinanceNewsData {
  const data = ((payload.data as unknown[]) ?? []).flatMap((item) =>
    item && typeof item === "object" ? [item as Record<string, unknown>] : [],
  )
  return {
    symbol: ticker.toUpperCase(),
    items: data.slice(0, limit).map((row) => {
      const id = asText(row.id)
      return {
        title: asText(row.title || "Quartr event"),
        source: "Quartr",
        publishedAt: toIsoDate(row.date || row.createdAt),
        url: asText(row.url || (id ? `https://quartr.com/events/${id}` : "https://quartr.com")),
        summary: asText(row.description || row.title || "Quartr event"),
        sentiment: null,
      }
    }),
  }
}

interface QuartrOptions {
  apiKey?: string
  timeoutMs?: number
}

export class QuartrProvider implements FinanceProvider {
  readonly id = "quartr"
  readonly displayName = "Quartr"
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number

  constructor(options: QuartrOptions = {}) {
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  supports(intent: FinanceIntent): boolean {
    return intent === "filings" || intent === "news"
  }

  enabled(): boolean {
    return Boolean(this.apiKey)
  }

  async fetch(
    input: NormalizedFinanceQuery,
    options?: { signal?: AbortSignal },
  ): Promise<FinanceDataEnvelope<FinanceProviderData>> {
    const { signal, clearTimeout } = abortAfterAny(this.timeoutMs, ...(options?.signal ? [options.signal] : []))
    const headers = {
      Accept: "application/json",
      "x-api-key": this.apiKey!,
      "User-Agent": "opencode-finance/1.0",
    }
    const timestamp = new Date().toISOString()

    try {
      if (input.intent === "filings") {
        const params = new URLSearchParams({
          tickers: input.ticker,
          limit: String(Math.min(Math.max(1, input.limit), 50)),
          direction: "desc",
          expand: "event",
        })
        const response = await fetch(`${QUARTR_BASE}/documents/reports?${params.toString()}`, {
          signal,
          headers,
        })
        clearTimeout()
        if (!response.ok) {
          const body = await response.text()
          throw new ProviderError(
            `quartr filings request failed (${response.status}): ${body || response.statusText}`,
            this.id,
            String(response.status),
          )
        }
        const payload = (await response.json()) as Record<string, unknown>
        return {
          source: this.id,
          timestamp,
          attribution: [
            {
              publisher: "Quartr",
              domain: "api.quartr.com",
              url: `${QUARTR_BASE}/documents/reports?${params.toString()}`,
            },
          ],
          data: filings(payload, input.ticker, input.limit),
          errors: [],
        }
      }

      if (input.intent === "news") {
        const params = new URLSearchParams({
          tickers: input.ticker,
          limit: String(Math.min(Math.max(1, input.limit), 50)),
          direction: "desc",
          sortBy: "date",
        })
        const response = await fetch(`${QUARTR_BASE}/events?${params.toString()}`, {
          signal,
          headers,
        })
        clearTimeout()
        if (!response.ok) {
          const body = await response.text()
          throw new ProviderError(
            `quartr events request failed (${response.status}): ${body || response.statusText}`,
            this.id,
            String(response.status),
          )
        }
        const payload = (await response.json()) as Record<string, unknown>
        return {
          source: this.id,
          timestamp,
          attribution: [
            {
              publisher: "Quartr",
              domain: "api.quartr.com",
              url: `${QUARTR_BASE}/events?${params.toString()}`,
            },
          ],
          data: news(payload, input.ticker, input.limit),
          errors: [],
        }
      }

      throw new ProviderError(`Unsupported intent for ${this.id}: ${input.intent}`, this.id, "UNSUPPORTED")
    } catch (error) {
      clearTimeout()
      if (error instanceof ProviderError) throw error
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("quartr request timed out", this.id, "TIMEOUT", this.timeoutMs)
      }
      throw new ProviderError(normalizeErrorText(error), this.id, "NETWORK")
    }
  }
}
