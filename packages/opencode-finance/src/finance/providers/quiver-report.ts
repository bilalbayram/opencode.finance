import { abortAfterAny } from "../../util/abort"
import { normalizeErrorText } from "../parser"
import { tierAllows, type QuiverEndpointTier, type QuiverTier } from "../quiver-tier"

const QUIVER_BASE = "https://api.quiverquant.com"
const DEFAULT_TIMEOUT_MS = 12_000

export type QuiverReportErrorCode = "TIER_DENIED" | "NETWORK" | "TIMEOUT"
export type QuiverReportStatus = "ok" | "failed" | "not_attempted_due_to_tier"

export type QuiverReportError = {
  code: QuiverReportErrorCode
  message: string
}

export type QuiverReportDataset = {
  id: string
  label: string
  endpoint: string
  endpoint_tier: QuiverEndpointTier
  status: QuiverReportStatus
  timestamp: string
  source_url: string
  rows: Record<string, unknown>[]
  error?: QuiverReportError
}

export type QuiverReportInput = {
  apiKey: string
  tier: QuiverTier
  ticker?: string
  limit?: number
  timeoutMs?: number
  signal?: AbortSignal
}

type Endpoint = {
  id: string
  label: string
  endpoint: string
  tier: QuiverEndpointTier
  query?: (input: QuiverReportInput) => Record<string, string | number | boolean | undefined>
}

const GLOBAL: Endpoint[] = [
  {
    id: "global_congress_trading",
    label: "Global Congress Trading",
    endpoint: "/beta/live/congresstrading",
    tier: "tier_1",
  },
  {
    id: "global_senate_trading",
    label: "Global Senate Trading",
    endpoint: "/beta/live/senatetrading",
    tier: "tier_1",
  },
  {
    id: "global_house_trading",
    label: "Global House Trading",
    endpoint: "/beta/live/housetrading",
    tier: "tier_1",
  },
]

const TICKER_GOV: Endpoint[] = [
  {
    id: "ticker_congress_trading",
    label: "Ticker Congress Trading",
    endpoint: "/beta/historical/congresstrading/{ticker}",
    tier: "tier_1",
  },
  {
    id: "ticker_senate_trading",
    label: "Ticker Senate Trading",
    endpoint: "/beta/historical/senatetrading/{ticker}",
    tier: "tier_1",
  },
  {
    id: "ticker_house_trading",
    label: "Ticker House Trading",
    endpoint: "/beta/historical/housetrading/{ticker}",
    tier: "tier_1",
  },
]

const TICKER_ALT: Endpoint[] = [
  {
    id: "ticker_lobbying",
    label: "Ticker Lobbying",
    endpoint: "/beta/historical/lobbying/{ticker}",
    tier: "tier_1",
  },
  {
    id: "ticker_gov_contracts",
    label: "Ticker Government Contracts",
    endpoint: "/beta/historical/govcontractsall/{ticker}",
    tier: "tier_1",
  },
  {
    id: "ticker_off_exchange",
    label: "Ticker Off-Exchange Activity",
    endpoint: "/beta/historical/offexchange/{ticker}",
    tier: "tier_1",
  },
]

const INSIDERS: Endpoint = {
  id: "insiders_form4",
  label: "Live Insider Form 4",
  endpoint: "/beta/live/insiders",
  tier: "tier_2",
  query: (input) => ({
    ticker: input.ticker,
    page_size: clampLimit(input.limit),
    page: 1,
  }),
}

function clampLimit(input?: number) {
  if (!Number.isFinite(input)) return 50
  const value = Math.floor(input ?? 50)
  if (value < 1) return 1
  if (value > 100) return 100
  return value
}

function buildUrl(endpoint: string, input: QuiverReportInput, query?: Record<string, string | number | boolean | undefined>) {
  const path = endpoint.includes("{ticker}") ? endpoint.replace("{ticker}", encodeURIComponent(input.ticker ?? "")) : endpoint
  const url = new URL(path, QUIVER_BASE)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

function rows(payload: unknown) {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
  }
  if (!payload || typeof payload !== "object") return []
  const data = payload as Record<string, unknown>
  if (Array.isArray(data.data)) {
    return data.data.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
  }
  if (Array.isArray(data.results)) {
    return data.results.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
  }
  if (Array.isArray(data.items)) {
    return data.items.flatMap((item) => (item && typeof item === "object" ? [item as Record<string, unknown>] : []))
  }
  return []
}

function normalizeHttpError(status: number, body: string): QuiverReportError {
  const text = body.trim()
  const denied = status === 402 || status === 403 || /upgrade|subscription|tier|plan|entitlement/i.test(text)
  if (denied) {
    return {
      code: "TIER_DENIED",
      message: `quiver-quant tier denied (${status}): ${text || "access denied"}`,
    }
  }
  return {
    code: "NETWORK",
    message: `quiver-quant request failed (${status}): ${text || "request failed"}`,
  }
}

function normalizeThrownError(error: unknown, timeoutMs: number): QuiverReportError {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      code: "TIMEOUT",
      message: `quiver-quant request timed out after ${timeoutMs}ms`,
    }
  }
  return {
    code: "NETWORK",
    message: normalizeErrorText(error),
  }
}

async function fetchDataset(def: Endpoint, input: QuiverReportInput): Promise<QuiverReportDataset> {
  const timestamp = new Date().toISOString()
  const source = buildUrl(def.endpoint, input, def.query?.(input)).toString()
  if (!tierAllows(def.tier, input.tier)) {
    return {
      id: def.id,
      label: def.label,
      endpoint: def.endpoint,
      endpoint_tier: def.tier,
      status: "not_attempted_due_to_tier",
      timestamp,
      source_url: source,
      rows: [],
    }
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { signal, clearTimeout } = abortAfterAny(timeoutMs, ...(input.signal ? [input.signal] : []))
  try {
    const response = await fetch(source, {
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Token ${input.apiKey}`,
        "User-Agent": "opencode-finance/1.0",
      },
    })
    if (!response.ok) {
      const body = await response.text()
      return {
        id: def.id,
        label: def.label,
        endpoint: def.endpoint,
        endpoint_tier: def.tier,
        status: "failed",
        timestamp: new Date().toISOString(),
        source_url: source,
        rows: [],
        error: normalizeHttpError(response.status, body),
      }
    }
    const payload = (await response.json()) as unknown
    return {
      id: def.id,
      label: def.label,
      endpoint: def.endpoint,
      endpoint_tier: def.tier,
      status: "ok",
      timestamp: new Date().toISOString(),
      source_url: source,
      rows: rows(payload),
    }
  } catch (error) {
    return {
      id: def.id,
      label: def.label,
      endpoint: def.endpoint,
      endpoint_tier: def.tier,
      status: "failed",
      timestamp: new Date().toISOString(),
      source_url: source,
      rows: [],
      error: normalizeThrownError(error, timeoutMs),
    }
  } finally {
    clearTimeout()
  }
}

export async function fetchGlobalGovTrading(input: QuiverReportInput) {
  return Promise.all(GLOBAL.map((item) => fetchDataset(item, input)))
}

export async function fetchTickerGovTrading(input: QuiverReportInput & { ticker: string }) {
  return Promise.all(TICKER_GOV.map((item) => fetchDataset(item, input)))
}

export async function fetchTickerAlt(input: QuiverReportInput & { ticker: string }) {
  return Promise.all(TICKER_ALT.map((item) => fetchDataset(item, input)))
}

export async function fetchInsiders(input: QuiverReportInput) {
  return fetchDataset(INSIDERS, input)
}
