import { createHash } from "node:crypto"
import type { GovernmentTradingNormalizedEvent, GovernmentTradingSourceRow } from "./types"

const IDENTITY_FIELD_ALIASES = {
  actor: [
    "representative",
    "senator",
    "member",
    "name",
    "owner",
    "insider_name",
    "insidername",
    "person",
    "holder",
    "trader",
    "lobbyist",
  ],
  ticker: ["ticker", "symbol", "security", "company_ticker", "stock", "asset"],
  transaction_date: [
    "date",
    "transaction_date",
    "transactiondate",
    "trade_date",
    "tradedate",
    "report_date",
    "reportdate",
    "filed_at",
    "fileddate",
    "disclose_date",
    "disclosedate",
  ],
  transaction_type: [
    "transaction_type",
    "transactiontype",
    "transaction",
    "type",
    "action",
    "acquired_disposed",
    "acquireddisposed",
  ],
  amount: ["amount", "shares", "shares_traded", "sharecount", "value", "usd_amount"],
  asset: ["asset", "security", "company", "issuer", "description"],
} as const

const VOLATILE_FIELD_NAMES = new Set(
  [
    "timestamp",
    "retrieved_at",
    "retrievedat",
    "fetched_at",
    "fetchedat",
    "last_updated",
    "lastupdated",
    "updated_at",
    "updatedat",
    "ingested_at",
    "ingestedat",
    "source_url",
    "sourceurl",
  ].map((key) => normalizeFieldKey(key)),
)

function normalizeFieldKey(input: string): string {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function normalizeString(input: string): string {
  const collapsed = input.trim().replace(/\s+/g, " ")
  if (!collapsed) return ""
  const numericCandidate = collapsed.replace(/[$,]/g, "")
  if (/^-?\d+(\.\d+)?$/.test(numericCandidate)) {
    const numeric = Number(numericCandidate)
    if (Number.isFinite(numeric)) return String(numeric)
  }
  return collapsed.toLowerCase()
}

function normalizeForStableJson(input: unknown): unknown {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return normalizeString(input)
  if (typeof input === "number") return Number.isFinite(input) ? input : ""
  if (typeof input === "boolean") return input
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? "" : input.toISOString()
  if (Array.isArray(input)) return input.map((item) => normalizeForStableJson(item))
  if (typeof input === "object") {
    const row = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(row).sort()) {
      out[normalizeFieldKey(key)] = normalizeForStableJson(row[key])
    }
    return out
  }
  return normalizeString(String(input))
}

function stableStringify(input: unknown): string {
  return JSON.stringify(normalizeForStableJson(input))
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function sortRecord(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(input).sort()) out[key] = input[key] ?? ""
  return out
}

function normalizeUnknown(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return normalizeString(input)
  if (typeof input === "number") return Number.isFinite(input) ? String(input) : ""
  if (typeof input === "boolean") return input ? "true" : "false"
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? "" : input.toISOString()
  if (typeof input === "object") return stableStringify(input)
  return normalizeString(String(input))
}

function canonicalizeRow(input: GovernmentTradingSourceRow): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [originalKey, rawValue] of Object.entries(input.row)) {
    const key = normalizeFieldKey(originalKey)
    if (!key) continue

    const value = normalizeUnknown(rawValue)
    if (!(key in out)) {
      out[key] = value
      continue
    }

    if (!out[key] && value) {
      out[key] = value
      continue
    }
    if (out[key] === value || !value) continue
    throw new Error(
      `Field collision while normalizing dataset ${input.datasetId}: multiple source keys resolved to "${key}" with conflicting values`,
    )
  }

  if (Object.keys(out).length === 0) {
    throw new Error(`Row for dataset ${input.datasetId} does not contain normalizable fields`)
  }
  return sortRecord(out)
}

function pickAlias(canonicalRow: Record<string, string>, aliases: readonly string[]): string {
  for (const alias of aliases) {
    const key = normalizeFieldKey(alias)
    const value = canonicalRow[key]
    if (value) return value
  }
  return ""
}

function normalizeDateValue(input: string): string {
  if (!input) return ""
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return date.toISOString().slice(0, 10)
}

function normalizeTickerValue(input: string): string {
  if (!input) return ""
  return input.replace(/[^a-z0-9.]/gi, "").toUpperCase()
}

function normalizeAmountValue(input: string): string {
  if (!input) return ""
  const numericCandidate = input.replace(/[$,\s]/g, "")
  if (/^-?\d+(\.\d+)?$/.test(numericCandidate)) {
    const numeric = Number(numericCandidate)
    if (Number.isFinite(numeric)) return String(numeric)
  }
  return input
}

function buildIdentityFields(canonicalRow: Record<string, string>, datasetId: string): Record<string, string> {
  const identityFields: Record<string, string> = {
    dataset_id: normalizeString(datasetId),
    actor: pickAlias(canonicalRow, IDENTITY_FIELD_ALIASES.actor),
    ticker: normalizeTickerValue(pickAlias(canonicalRow, IDENTITY_FIELD_ALIASES.ticker)),
    transaction_date: normalizeDateValue(pickAlias(canonicalRow, IDENTITY_FIELD_ALIASES.transaction_date)),
    transaction_type: pickAlias(canonicalRow, IDENTITY_FIELD_ALIASES.transaction_type),
    amount: normalizeAmountValue(pickAlias(canonicalRow, IDENTITY_FIELD_ALIASES.amount)),
    asset: pickAlias(canonicalRow, IDENTITY_FIELD_ALIASES.asset),
  }

  if (Object.values(identityFields).filter(Boolean).length <= 1) {
    identityFields.row_hash = stableHash(stableStringify(canonicalRow))
  }

  return sortRecord(identityFields)
}

function buildMaterialFields(canonicalRow: Record<string, string>, datasetId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(canonicalRow).sort()) {
    if (VOLATILE_FIELD_NAMES.has(key)) continue
    out[key] = canonicalRow[key]
  }

  if (Object.keys(out).length === 0) {
    throw new Error(
      `Row for dataset ${datasetId} only includes volatile fields; cannot compute material fingerprint`,
    )
  }

  return out
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return input.trim()
}

function normalizeRowIndex(input: number | undefined): number {
  if (input === undefined) return 0
  if (!Number.isInteger(input) || input < 0) {
    throw new Error(`rowIndex must be a non-negative integer when provided`)
  }
  return input
}

export function normalizeGovernmentTradingEvent(input: GovernmentTradingSourceRow): GovernmentTradingNormalizedEvent {
  const datasetId = requireNonEmptyString(input.datasetId, "datasetId")
  const datasetLabel = requireNonEmptyString(input.datasetLabel, "datasetLabel")
  const rowIndex = normalizeRowIndex(input.rowIndex)

  if (!input.row || typeof input.row !== "object" || Array.isArray(input.row)) {
    throw new Error(`row for dataset ${datasetId} must be an object`)
  }

  const canonicalRow = canonicalizeRow({ ...input, datasetId, datasetLabel })
  const identityFields = buildIdentityFields(canonicalRow, datasetId)
  const materialFields = buildMaterialFields(canonicalRow, datasetId)
  const identitySeed = sortRecord({
    dataset_id: identityFields.dataset_id ?? "",
    actor: identityFields.actor ?? "",
    ticker: identityFields.ticker ?? "",
    transaction_date: identityFields.transaction_date ?? "",
    transaction_type: identityFields.transaction_type ?? "",
    asset: identityFields.asset ?? "",
    row_hash: identityFields.row_hash ?? "",
  })

  return {
    identityKey: stableHash(stableStringify(identitySeed)),
    materialFingerprint: stableHash(stableStringify(materialFields)),
    datasetId,
    datasetLabel,
    rowIndex,
    identityFields,
    materialFields,
    canonicalRow,
    rawRow: input.row,
  }
}

export function normalizeGovernmentTradingEvents(input: GovernmentTradingSourceRow[]): GovernmentTradingNormalizedEvent[] {
  return input.map((item, index) =>
    normalizeGovernmentTradingEvent({
      ...item,
      rowIndex: item.rowIndex ?? index,
    }),
  )
}
