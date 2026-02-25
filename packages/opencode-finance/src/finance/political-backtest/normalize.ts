import { EventStudyError } from "./error"
import { normalizeQuiverRows } from "./normalize-quiver-events"
import type { PoliticalEvent } from "./types"

function asText(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

function toNumber(value: unknown): number | null {
  const text = asText(value).replace(/[^0-9.-]/g, "")
  if (!text) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function fieldLookup(row: Record<string, unknown>) {
  return new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
}

function pick(row: Record<string, unknown>, candidates: readonly string[]) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && asText(row[key])) return row[key]
  }
  const lower = fieldLookup(row)
  for (const key of candidates) {
    const value = lower.get(key.toLowerCase())
    if (value !== undefined && value !== null && asText(value)) return value
  }
  return undefined
}

function sharesForRow(row: Record<string, unknown>) {
  return toNumber(pick(row, ["shares_traded", "shareschanged", "changeinshares", "shares", "quantity", "amount"]))
}

export function assertUniqueEventIDs(events: readonly PoliticalEvent[]) {
  const seen = new Set<string>()
  events.forEach((event) => {
    if (seen.has(event.event_id)) {
      throw new EventStudyError(`Duplicate political event id detected: ${event.event_id}`, "DUPLICATE_EVENT_ID", {
        event_id: event.event_id,
      })
    }
    seen.add(event.event_id)
  })
}

export function normalizePoliticalEvents(input: {
  ticker: string
  datasets: Array<{ id: string; rows: Record<string, unknown>[] }>
}): PoliticalEvent[] {
  const ticker = input.ticker.trim().toUpperCase()
  if (!ticker) throw new EventStudyError("Ticker is required to normalize political events.", "INVALID_EVENT_DATE")
  if (!Array.isArray(input.datasets) || input.datasets.length === 0) {
    throw new EventStudyError("At least one dataset is required to normalize political events.", "EMPTY_EVENT_SET")
  }

  const events: PoliticalEvent[] = []
  for (const dataset of input.datasets) {
    if (!dataset.id.trim()) {
      throw new EventStudyError("Dataset id is required for political event normalization.", "INVALID_EVENT_DATE")
    }

    const normalized = normalizeQuiverRows({
      datasetId: dataset.id,
      datasetLabel: dataset.id,
      symbol: ticker,
      rows: dataset.rows,
    })

    normalized.forEach((item) => {
      const raw = dataset.rows[item.sourceRowIndex]
      const shares = raw && typeof raw === "object" && !Array.isArray(raw) ? sharesForRow(raw) : null
      events.push({
        event_id: item.eventId,
        ticker: item.symbol,
        source_dataset_id: item.sourceDatasetId,
        actor: item.actor,
        side: item.transactionType,
        transaction_date: item.transactionDate,
        report_date: item.reportDate,
        shares,
      })
    })
  }

  if (events.length === 0) {
    throw new EventStudyError("No political-trading events were returned for the requested ticker.", "EMPTY_EVENT_SET", {
      ticker,
      datasets: input.datasets.map((item) => item.id),
    })
  }

  assertUniqueEventIDs(events)
  return events.toSorted((a, b) => {
    const left = a.transaction_date ?? a.report_date ?? ""
    const right = b.transaction_date ?? b.report_date ?? ""
    return left.localeCompare(right)
  })
}
