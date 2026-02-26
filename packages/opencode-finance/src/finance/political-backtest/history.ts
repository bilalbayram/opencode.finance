import fs from "fs/promises"
import path from "path"
import { EventStudyError } from "./error"
import type { AggregateWindow } from "./types"

export type BacktestRunSnapshot = {
  workflow: "financial_political_backtest"
  output_root: string
  generated_at: string
  aggregates: AggregateWindow[]
  event_ids: string[]
}

export type AggregateDrift = {
  key: string
  anchor_kind: AggregateWindow["anchor_kind"]
  window_sessions: number
  benchmark_symbol: string
  baseline_sample_size: number
  current_sample_size: number
  sample_delta: number
  hit_rate_delta: number
  median_return_delta: number
  mean_excess_delta: number
}

export type ConclusionChange = {
  key: string
  benchmark_symbol: string
  window_sessions: number
  anchor_kind: AggregateWindow["anchor_kind"]
  baseline_view: "outperform" | "underperform" | "flat"
  current_view: "outperform" | "underperform" | "flat"
}

export type BacktestRunComparison = {
  first_run: boolean
  baseline: Pick<BacktestRunSnapshot, "output_root" | "generated_at"> | null
  aggregate_drift: AggregateDrift[]
  event_sample: {
    current: number
    baseline: number
    new_events: string[]
    removed_events: string[]
    persisted_events: string[]
  }
  conclusion_changes: ConclusionChange[]
}

function aggregateKey(row: Pick<AggregateWindow, "anchor_kind" | "window_sessions" | "benchmark_symbol">) {
  return `${row.anchor_kind}|${row.window_sessions}|${row.benchmark_symbol}`
}

function round(input: number, digits = 6) {
  const power = 10 ** digits
  return Math.round(input * power) / power
}

function view(input: number): "outperform" | "underperform" | "flat" {
  if (input > 0) return "outperform"
  if (input < 0) return "underperform"
  return "flat"
}

function asDate(input: unknown) {
  if (typeof input !== "string" || !input.trim()) return null
  const value = new Date(input)
  if (Number.isNaN(value.getTime())) return null
  return value.toISOString()
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await walk(full)
      files.push(...nested)
    } else {
      files.push(full)
    }
  }

  return files
}

function parseAggregateRows(input: unknown, root: string): AggregateWindow[] {
  if (!Array.isArray(input)) {
    throw new EventStudyError(`Invalid aggregate-results.json payload in ${root}`, "INVALID_PRICE_SERIES")
  }

  return input.map((item) => {
    const row = item as Record<string, unknown>
    const anchorKind = row.anchor_kind
    const benchmarkSymbol = row.benchmark_symbol
    const windowSessions = Number(row.window_sessions)

    if ((anchorKind !== "transaction" && anchorKind !== "report") || typeof benchmarkSymbol !== "string" || !Number.isFinite(windowSessions)) {
      throw new EventStudyError(`Invalid aggregate row in ${root}`, "INVALID_PRICE_SERIES", {
        row,
      })
    }

    return {
      anchor_kind: anchorKind,
      window_sessions: windowSessions,
      benchmark_symbol: benchmarkSymbol,
      sample_size: Number(row.sample_size ?? 0),
      hit_rate_percent: Number(row.hit_rate_percent ?? 0),
      mean_return_percent: Number(row.mean_return_percent ?? 0),
      median_return_percent: Number(row.median_return_percent ?? 0),
      stdev_return_percent: Number(row.stdev_return_percent ?? 0),
      mean_excess_return_percent: Number(row.mean_excess_return_percent ?? 0),
      mean_relative_return_percent: Number(row.mean_relative_return_percent ?? 0),
    } satisfies AggregateWindow
  })
}

function parseEventIDs(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const ids = input
    .map((item) => (item && typeof item === "object" && !Array.isArray(item) ? String((item as Record<string, unknown>).event_id ?? "") : ""))
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

export async function discoverHistoricalRuns(input: {
  reports_root: string
  ticker: string
  exclude_output_root?: string
}): Promise<BacktestRunSnapshot[]> {
  const base = path.join(input.reports_root, "reports", input.ticker)
  const files = await walk(base)
  const assumptionsFiles = files.filter((item) => path.basename(item) === "assumptions.json")

  const snapshots: BacktestRunSnapshot[] = []
  for (const assumptionsPath of assumptionsFiles) {
    const outputRoot = path.dirname(assumptionsPath)
    if (input.exclude_output_root && path.resolve(input.exclude_output_root) === path.resolve(outputRoot)) continue

    const assumptionsRaw = await Bun.file(assumptionsPath).json().catch(() => {
      throw new EventStudyError(`Failed to parse assumptions.json in ${outputRoot}`, "INVALID_PRICE_SERIES")
    })

    const assumptions = assumptionsRaw as Record<string, unknown>
    if (assumptions.workflow !== "financial_political_backtest") continue

    const aggregatePath = path.join(outputRoot, "aggregate-results.json")
    const eventsPath = path.join(outputRoot, "events.json")

    if (!(await Bun.file(aggregatePath).exists()) || !(await Bun.file(eventsPath).exists())) {
      throw new EventStudyError(`Historical run at ${outputRoot} is missing required raw artifacts.`, "INVALID_PRICE_SERIES", {
        output_root: outputRoot,
      })
    }

    const aggregateRaw = await Bun.file(aggregatePath).json().catch(() => {
      throw new EventStudyError(`Failed to parse aggregate-results.json in ${outputRoot}`, "INVALID_PRICE_SERIES")
    })
    const eventsRaw = await Bun.file(eventsPath).json().catch(() => {
      throw new EventStudyError(`Failed to parse events.json in ${outputRoot}`, "INVALID_PRICE_SERIES")
    })

    const generated = asDate(assumptions.generated_at) ?? new Date((await Bun.file(assumptionsPath).stat()).mtime).toISOString()

    snapshots.push({
      workflow: "financial_political_backtest",
      output_root: outputRoot,
      generated_at: generated,
      aggregates: parseAggregateRows(aggregateRaw, outputRoot),
      event_ids: parseEventIDs(eventsRaw),
    })
  }

  return snapshots.toSorted((a, b) => a.generated_at.localeCompare(b.generated_at))
}

export function compareRuns(input: {
  current: BacktestRunSnapshot
  baseline?: BacktestRunSnapshot | null
}): BacktestRunComparison {
  const baseline = input.baseline ?? null

  if (!baseline) {
    return {
      first_run: true,
      baseline: null,
      aggregate_drift: [],
      event_sample: {
        current: input.current.event_ids.length,
        baseline: 0,
        new_events: [...input.current.event_ids],
        removed_events: [],
        persisted_events: [],
      },
      conclusion_changes: [],
    }
  }

  const baselineByKey = new Map(baseline.aggregates.map((item) => [aggregateKey(item), item]))
  const currentByKey = new Map(input.current.aggregates.map((item) => [aggregateKey(item), item]))
  const allKeys = [...new Set([...baselineByKey.keys(), ...currentByKey.keys()])].sort((a, b) => a.localeCompare(b))

  const drift: AggregateDrift[] = []
  const conclusionChanges: ConclusionChange[] = []

  for (const key of allKeys) {
    const base = baselineByKey.get(key)
    const now = currentByKey.get(key)
    if (!base || !now) continue

    drift.push({
      key,
      anchor_kind: now.anchor_kind,
      window_sessions: now.window_sessions,
      benchmark_symbol: now.benchmark_symbol,
      baseline_sample_size: base.sample_size,
      current_sample_size: now.sample_size,
      sample_delta: now.sample_size - base.sample_size,
      hit_rate_delta: round(now.hit_rate_percent - base.hit_rate_percent),
      median_return_delta: round(now.median_return_percent - base.median_return_percent),
      mean_excess_delta: round(now.mean_excess_return_percent - base.mean_excess_return_percent),
    })

    const baselineView = view(base.mean_excess_return_percent)
    const currentView = view(now.mean_excess_return_percent)
    if (baselineView !== currentView) {
      conclusionChanges.push({
        key,
        benchmark_symbol: now.benchmark_symbol,
        window_sessions: now.window_sessions,
        anchor_kind: now.anchor_kind,
        baseline_view: baselineView,
        current_view: currentView,
      })
    }
  }

  const baselineEvents = new Set(baseline.event_ids)
  const currentEvents = new Set(input.current.event_ids)

  const newEvents = [...currentEvents].filter((item) => !baselineEvents.has(item)).sort((a, b) => a.localeCompare(b))
  const removedEvents = [...baselineEvents].filter((item) => !currentEvents.has(item)).sort((a, b) => a.localeCompare(b))
  const persistedEvents = [...currentEvents].filter((item) => baselineEvents.has(item)).sort((a, b) => a.localeCompare(b))

  return {
    first_run: false,
    baseline: {
      output_root: baseline.output_root,
      generated_at: baseline.generated_at,
    },
    aggregate_drift: drift,
    event_sample: {
      current: input.current.event_ids.length,
      baseline: baseline.event_ids.length,
      new_events: newEvents,
      removed_events: removedEvents,
      persisted_events: persistedEvents,
    },
    conclusion_changes: conclusionChanges,
  }
}
