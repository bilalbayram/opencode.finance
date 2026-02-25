import { StatsComputationError } from "./errors"
import type { AggregateStats, EventForwardReturnSet, WindowAggregateStats } from "./types"

function validateValues(values: readonly number[]) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new StatsComputationError("At least one numeric value is required to compute aggregate stats")
  }
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new StatsComputationError(`Non-finite numeric value at index ${index}: ${String(value)}`, {
        index,
        value,
      })
    }
  })
}

export function computeAggregateStats(values: readonly number[]): AggregateStats {
  validateValues(values)
  const count = values.length
  const sum = values.reduce((acc, value) => acc + value, 0)
  const mean = sum / count
  const variance = values.reduce((acc, value) => {
    const diff = value - mean
    return acc + diff * diff
  }, 0) / count
  const sorted = [...values].sort((a, b) => a - b)

  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)]

  const hits = values.reduce((acc, value) => (value > 0 ? acc + 1 : acc), 0)
  return {
    sampleCount: count,
    hitRate: hits / count,
    mean,
    median,
    stdev: Math.sqrt(variance),
  }
}

function ensureComparableReturnShapes(events: readonly EventForwardReturnSet[]) {
  if (events.length === 0) {
    throw new StatsComputationError("At least one event return set is required for window aggregation")
  }

  const baseline = events[0].returns.map((item) => item.windowSessions)
  if (baseline.length === 0) {
    throw new StatsComputationError("Event return sets must include at least one configured window")
  }

  events.forEach((event, eventIndex) => {
    const current = event.returns.map((item) => item.windowSessions)
    if (current.length !== baseline.length) {
      throw new StatsComputationError(`Event ${event.eventId} has a mismatched window count`, {
        eventIndex,
        expected: baseline.length,
        actual: current.length,
      })
    }
    current.forEach((windowSessions, idx) => {
      if (windowSessions !== baseline[idx]) {
        throw new StatsComputationError(`Event ${event.eventId} has inconsistent windows`, {
          eventIndex,
          index: idx,
          expected: baseline[idx],
          actual: windowSessions,
        })
      }
    })
  })
}

export function aggregateForwardReturnSets(events: readonly EventForwardReturnSet[]): WindowAggregateStats[] {
  ensureComparableReturnShapes(events)

  const windowCount = events[0].returns.length
  const output: WindowAggregateStats[] = []

  for (let index = 0; index < windowCount; index += 1) {
    const windowSessions = events[0].returns[index].windowSessions
    const symbolValues = events.map((event) => event.returns[index].symbolReturn)
    const spyValues = events.map((event) => event.returns[index].spyReturn)
    const relativeValues = events.map((event) => event.returns[index].relativeReturn)

    output.push({
      windowSessions,
      symbolReturn: computeAggregateStats(symbolValues),
      spyReturn: computeAggregateStats(spyValues),
      relativeReturn: computeAggregateStats(relativeValues),
    })
  }

  return output
}
