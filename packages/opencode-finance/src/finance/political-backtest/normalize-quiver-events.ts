import { createHash } from "node:crypto"
import { InvalidDateError, InvalidQuiverRowError, MissingRequiredFieldError } from "./errors"
import type { IsoDate, NormalizedPoliticalEvent, PoliticalTransactionType, QuiverPoliticalRowInput } from "./types"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/

const SYMBOL_KEYS = ["Ticker", "ticker", "Symbol", "symbol"] as const
const TRANSACTION_DATE_KEYS = [
  "TransactionDate",
  "transactionDate",
  "transaction_date",
  "TradeDate",
  "tradeDate",
  "Date",
  "date",
] as const
const REPORT_DATE_KEYS = [
  "ReportDate",
  "reportDate",
  "report_date",
  "FiledDate",
  "filedDate",
  "FiledAt",
  "filedAt",
  "DisclosureDate",
  "disclosureDate",
] as const
const ACTOR_KEYS = [
  "Name",
  "name",
  "Representative",
  "representative",
  "Senator",
  "senator",
  "OwnerName",
  "ownerName",
  "InsiderName",
  "insiderName",
] as const
const TYPE_KEYS = ["Transaction", "transaction", "TransactionType", "transactionType", "Type", "type"] as const

function asText(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

function normalizeFieldKey(input: string): string {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function normalizeStableValue(input: unknown): unknown {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return asText(input).toLowerCase()
  if (typeof input === "number") return Number.isFinite(input) ? input : ""
  if (typeof input === "boolean") return input
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? "" : input.toISOString()
  if (Array.isArray(input)) return input.map((item) => normalizeStableValue(item))
  if (typeof input === "object") {
    const row = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(row).sort()) {
      out[normalizeFieldKey(key)] = normalizeStableValue(row[key])
    }
    return out
  }
  return asText(String(input)).toLowerCase()
}

function stableStringify(input: unknown): string {
  return JSON.stringify(normalizeStableValue(input))
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function fieldLookup(row: Record<string, unknown>) {
  return new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
}

function pickField(row: Record<string, unknown>, candidates: readonly string[]): unknown {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }

  const lower = fieldLookup(row)
  for (const key of candidates) {
    const value = lower.get(key.toLowerCase())
    if (value !== undefined && value !== null) return value
  }

  return undefined
}

function normalizeSymbol(value: string, details: Record<string, unknown>) {
  const symbol = value.trim().toUpperCase()
  if (!symbol) throw new MissingRequiredFieldError("symbol", details)
  if (!SYMBOL_RE.test(symbol)) {
    throw new InvalidQuiverRowError(`Invalid symbol: ${symbol}`, details)
  }
  return symbol
}

function normalizeDate(value: unknown, field: string, details: Record<string, unknown>): IsoDate {
  const text = asText(value)
  if (!text) throw new MissingRequiredFieldError(field, details)

  if (ISO_DATE_RE.test(text)) {
    const epochMs = Date.parse(`${text}T00:00:00.000Z`)
    if (!Number.isFinite(epochMs)) throw new InvalidDateError(field, value, details)
    const normalized = new Date(epochMs).toISOString().slice(0, 10)
    if (normalized !== text) throw new InvalidDateError(field, value, details)
    return normalized
  }

  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) throw new InvalidDateError(field, value, details)
  return parsed.toISOString().slice(0, 10)
}

function readOptionalDate(
  row: Record<string, unknown>,
  candidates: readonly string[],
  field: string,
  details: Record<string, unknown>,
) {
  const value = pickField(row, candidates)
  if (value === undefined || value === null || asText(value).length === 0) return null
  return normalizeDate(value, field, details)
}

function normalizeTransactionType(value: unknown): PoliticalTransactionType {
  const text = asText(value).toLowerCase()
  if (!text) return "other"
  if (text.includes("buy") || text.includes("acquired") || text.includes("purchase")) return "buy"
  if (text.includes("sell") || text.includes("dispose")) return "sell"
  return "other"
}

export function normalizeQuiverRow(input: {
  datasetId: string
  datasetLabel: string
  symbol: string
  row: Record<string, unknown>
  rowIndex: number
}): NormalizedPoliticalEvent {
  if (!input.datasetId.trim()) {
    throw new MissingRequiredFieldError("datasetId", { rowIndex: input.rowIndex })
  }
  if (!input.datasetLabel.trim()) {
    throw new MissingRequiredFieldError("datasetLabel", { datasetId: input.datasetId, rowIndex: input.rowIndex })
  }
  if (!input.row || typeof input.row !== "object" || Array.isArray(input.row)) {
    throw new InvalidQuiverRowError("Quiver row must be an object", {
      datasetId: input.datasetId,
      rowIndex: input.rowIndex,
    })
  }

  const symbol = normalizeSymbol(input.symbol, {
    datasetId: input.datasetId,
    datasetLabel: input.datasetLabel,
    rowIndex: input.rowIndex,
  })

  const rowSymbol = pickField(input.row, SYMBOL_KEYS)
  if (rowSymbol !== undefined && rowSymbol !== null && asText(rowSymbol).length > 0) {
    const normalizedRowSymbol = normalizeSymbol(asText(rowSymbol), {
      datasetId: input.datasetId,
      datasetLabel: input.datasetLabel,
      rowIndex: input.rowIndex,
      field: "rowSymbol",
    })
    if (normalizedRowSymbol !== symbol) {
      throw new InvalidQuiverRowError(`Row symbol ${normalizedRowSymbol} does not match requested symbol ${symbol}`, {
        datasetId: input.datasetId,
        datasetLabel: input.datasetLabel,
        rowIndex: input.rowIndex,
      })
    }
  }

  const details = {
    datasetId: input.datasetId,
    datasetLabel: input.datasetLabel,
    rowIndex: input.rowIndex,
    symbol,
  }
  const transactionDate = readOptionalDate(input.row, TRANSACTION_DATE_KEYS, "transactionDate", details)
  const reportDate = readOptionalDate(input.row, REPORT_DATE_KEYS, "reportDate", details)
  if (!transactionDate && !reportDate) {
    throw new MissingRequiredFieldError("transactionDate or reportDate", details)
  }

  const actorRaw = pickField(input.row, ACTOR_KEYS)
  const actor = actorRaw === undefined || actorRaw === null ? null : asText(actorRaw) || null
  const transactionType = normalizeTransactionType(pickField(input.row, TYPE_KEYS))
  const rowFingerprint = stableHash(stableStringify(input.row))
  const eventIdentity = stableHash(
    stableStringify({
      dataset_id: input.datasetId,
      symbol,
      transaction_date: transactionDate ?? "",
      report_date: reportDate ?? "",
      actor: actor ?? "",
      transaction_type: transactionType,
      row_fingerprint: rowFingerprint,
    }),
  )
  const eventId = `${input.datasetId}:${symbol}:${eventIdentity}`

  return {
    eventId,
    symbol,
    sourceDatasetId: input.datasetId,
    sourceDatasetLabel: input.datasetLabel,
    sourceRowIndex: input.rowIndex,
    transactionDate,
    reportDate,
    transactionType,
    actor,
  }
}

export function normalizeQuiverRows(input: QuiverPoliticalRowInput): NormalizedPoliticalEvent[] {
  if (!Array.isArray(input.rows)) {
    throw new InvalidQuiverRowError("rows must be an array", {
      datasetId: input.datasetId,
      datasetLabel: input.datasetLabel,
    })
  }
  return input.rows.map((row, rowIndex) =>
    normalizeQuiverRow({
      datasetId: input.datasetId,
      datasetLabel: input.datasetLabel,
      symbol: input.symbol,
      row,
      rowIndex,
    }),
  )
}
