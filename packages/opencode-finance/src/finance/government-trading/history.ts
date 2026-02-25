import fs from "node:fs/promises"
import path from "node:path"
import type {
  GovernmentTradingAssumptionsMetadata,
  GovernmentTradingHistoryLoadOptions,
  GovernmentTradingHistoryRun,
  GovernmentTradingNormalizedEvent,
  QuiverRow,
} from "./types"

export const DEFAULT_NORMALIZED_EVENTS_FILENAME = "normalized-events.json"
export const DEFAULT_ASSUMPTIONS_FILENAME = "assumptions.json"

function asObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return input as Record<string, unknown>
}

function asString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return input
}

function asInteger(input: unknown, label: string): number {
  if (!Number.isInteger(input) || Number(input) < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return Number(input)
}

function asStringRecord(input: unknown, label: string): Record<string, string> {
  const value = asObject(input, label)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${label}.${key} must be a string`)
    out[key] = entry
  }
  return out
}

function asRawRow(input: unknown, label: string): QuiverRow {
  return asObject(input, label)
}

async function readJsonFile(filepath: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(filepath, "utf8")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed reading JSON file ${filepath}: ${message}`)
  }

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in ${filepath}: ${message}`)
  }
}

function parseNormalizedEvent(input: unknown, filepath: string, index: number): GovernmentTradingNormalizedEvent {
  const value = asObject(input, `${filepath}[${index}]`)
  return {
    identityKey: asString(value.identityKey, `${filepath}[${index}].identityKey`),
    materialFingerprint: asString(value.materialFingerprint, `${filepath}[${index}].materialFingerprint`),
    datasetId: asString(value.datasetId, `${filepath}[${index}].datasetId`),
    datasetLabel: asString(value.datasetLabel, `${filepath}[${index}].datasetLabel`),
    rowIndex: asInteger(value.rowIndex, `${filepath}[${index}].rowIndex`),
    identityFields: asStringRecord(value.identityFields, `${filepath}[${index}].identityFields`),
    materialFields: asStringRecord(value.materialFields, `${filepath}[${index}].materialFields`),
    canonicalRow: asStringRecord(value.canonicalRow, `${filepath}[${index}].canonicalRow`),
    rawRow: asRawRow(value.rawRow, `${filepath}[${index}].rawRow`),
  }
}

async function loadNormalizedEvents(filepath: string): Promise<GovernmentTradingNormalizedEvent[]> {
  const parsed = await readJsonFile(filepath)
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${filepath} to contain a JSON array of normalized events`)
  }
  return parsed.map((event, index) => parseNormalizedEvent(event, filepath, index))
}

async function loadAssumptions(filepath: string): Promise<GovernmentTradingAssumptionsMetadata> {
  const parsed = await readJsonFile(filepath)
  return asObject(parsed, filepath)
}

async function pathExists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function listRunDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, "en-US"))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read history root ${root}: ${message}`)
  }
}

function normalizeMaxRuns(maxRuns: number | undefined): number | undefined {
  if (maxRuns === undefined) return
  if (!Number.isInteger(maxRuns) || maxRuns < 1) {
    throw new Error("maxRuns must be a positive integer when provided")
  }
  return maxRuns
}

export async function loadGovernmentTradingHistory(
  options: GovernmentTradingHistoryLoadOptions,
): Promise<GovernmentTradingHistoryRun[]> {
  if (!options || typeof options !== "object") throw new Error("History load options are required")

  const historyRoot = typeof options.historyRoot === "string" ? options.historyRoot.trim() : ""
  if (!historyRoot) throw new Error("historyRoot is required")

  const root = path.resolve(historyRoot)
  const normalizedEventsFilename = options.normalizedEventsFilename ?? DEFAULT_NORMALIZED_EVENTS_FILENAME
  const assumptionsFilename = options.assumptionsFilename ?? DEFAULT_ASSUMPTIONS_FILENAME
  const maxRuns = normalizeMaxRuns(options.maxRuns)

  const runNames = await listRunDirectories(root)
  const runs: GovernmentTradingHistoryRun[] = []

  for (const runName of runNames) {
    const directory = path.join(root, runName)
    const normalizedEventsPath = path.join(directory, normalizedEventsFilename)
    const assumptionsPath = path.join(directory, assumptionsFilename)
    const hasNormalizedEvents = await pathExists(normalizedEventsPath)

    if (!hasNormalizedEvents) continue

    const hasAssumptions = await pathExists(assumptionsPath)
    if (!hasAssumptions) {
      throw new Error(
        `Missing required assumptions file for parsed run ${directory}: expected ${assumptionsPath}`,
      )
    }

    const [normalizedEvents, assumptions] = await Promise.all([
      loadNormalizedEvents(normalizedEventsPath),
      loadAssumptions(assumptionsPath),
    ])

    runs.push({
      runId: runName,
      directory,
      normalizedEventsPath,
      assumptionsPath,
      normalizedEvents,
      assumptions,
    })
  }

  return maxRuns ? runs.slice(0, maxRuns) : runs
}
