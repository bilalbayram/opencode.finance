import { computeAggregateStats } from "./aggregate-stats"
import type { AggregateWindow, BenchmarkRelativeReturn } from "./types"

function round(input: number, digits = 6) {
  const power = 10 ** digits
  return Math.round(input * power) / power
}

export function aggregateByWindow(rows: BenchmarkRelativeReturn[]): AggregateWindow[] {
  const grouped = new Map<string, BenchmarkRelativeReturn[]>()
  rows.forEach((row) => {
    const key = `${row.anchor_kind}|${row.window_sessions}|${row.benchmark_symbol}`
    const list = grouped.get(key) ?? []
    list.push(row)
    grouped.set(key, list)
  })

  return [...grouped.entries()]
    .map(([key, list]) => {
      const [anchorKind, windowRaw, benchmarkSymbol] = key.split("|")
      const forward = list.map((item) => item.forward_return_percent)
      const excess = list.map((item) => item.excess_return_percent)
      const relative = list.map((item) => item.relative_return_percent)
      const hitRate = computeAggregateStats(excess).hitRate
      const forwardStats = computeAggregateStats(forward)
      const excessStats = computeAggregateStats(excess)
      const relativeStats = computeAggregateStats(relative)

      return {
        anchor_kind: anchorKind as AggregateWindow["anchor_kind"],
        window_sessions: Number(windowRaw),
        benchmark_symbol: benchmarkSymbol,
        sample_size: list.length,
        hit_rate_percent: round(hitRate * 100, 4),
        mean_return_percent: round(forwardStats.mean),
        median_return_percent: round(forwardStats.median),
        stdev_return_percent: round(forwardStats.stdev),
        mean_excess_return_percent: round(excessStats.mean),
        mean_relative_return_percent: round(relativeStats.mean),
      } satisfies AggregateWindow
    })
    .toSorted((a, b) =>
      a.anchor_kind.localeCompare(b.anchor_kind) ||
      a.window_sessions - b.window_sessions ||
      a.benchmark_symbol.localeCompare(b.benchmark_symbol),
    )
}
