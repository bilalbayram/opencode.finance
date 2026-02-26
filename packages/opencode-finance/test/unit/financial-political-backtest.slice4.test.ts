import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import {
  compareRuns,
  discoverHistoricalRuns,
  type BacktestRunSnapshot,
  type AggregateWindow,
} from "../../src/finance/political-backtest"
import { FinancialPoliticalBacktestInternal } from "../../src/tool/financial_political_backtest"

function aggregate(input: Partial<AggregateWindow>): AggregateWindow {
  return {
    anchor_kind: input.anchor_kind ?? "transaction",
    window_sessions: input.window_sessions ?? 5,
    benchmark_symbol: input.benchmark_symbol ?? "SPY",
    sample_size: input.sample_size ?? 1,
    hit_rate_percent: input.hit_rate_percent ?? 0,
    mean_return_percent: input.mean_return_percent ?? 0,
    median_return_percent: input.median_return_percent ?? 0,
    stdev_return_percent: input.stdev_return_percent ?? 0,
    mean_excess_return_percent: input.mean_excess_return_percent ?? 0,
    mean_relative_return_percent: input.mean_relative_return_percent ?? 0,
  }
}

describe("financial_political_backtest slice 4", () => {
  test("first run initializes longitudinal tracking without baseline", () => {
    const current: BacktestRunSnapshot = {
      workflow: "financial_political_backtest",
      output_root: "/tmp/reports/TEST/2025-01-01",
      generated_at: "2025-01-01T00:00:00.000Z",
      aggregates: [aggregate({ sample_size: 2 })],
      event_ids: ["e1", "e2"],
    }

    const comparison = compareRuns({
      current,
      baseline: null,
    })

    expect(comparison.first_run).toBe(true)
    expect(comparison.baseline).toBeNull()
    expect(comparison.event_sample.new_events).toEqual(["e1", "e2"])
    expect(comparison.aggregate_drift).toHaveLength(0)
  })

  test("follow-up run detects metric drift, sample changes, and conclusion flips", () => {
    const baseline: BacktestRunSnapshot = {
      workflow: "financial_political_backtest",
      output_root: "/tmp/reports/TEST/2025-01-01",
      generated_at: "2025-01-01T00:00:00.000Z",
      aggregates: [
        aggregate({
          sample_size: 2,
          mean_excess_return_percent: -1.2,
          hit_rate_percent: 20,
          median_return_percent: -0.4,
        }),
      ],
      event_ids: ["e1", "e2"],
    }

    const current: BacktestRunSnapshot = {
      workflow: "financial_political_backtest",
      output_root: "/tmp/reports/TEST/2025-01-02",
      generated_at: "2025-01-02T00:00:00.000Z",
      aggregates: [
        aggregate({
          sample_size: 3,
          mean_excess_return_percent: 1.1,
          hit_rate_percent: 66.67,
          median_return_percent: 0.9,
        }),
      ],
      event_ids: ["e2", "e3", "e4"],
    }

    const comparison = compareRuns({
      current,
      baseline,
    })

    expect(comparison.first_run).toBe(false)
    expect(comparison.aggregate_drift).toHaveLength(1)
    expect(comparison.aggregate_drift[0]?.sample_delta).toBe(1)
    expect(comparison.event_sample.new_events).toEqual(["e3", "e4"])
    expect(comparison.event_sample.removed_events).toEqual(["e1"])
    expect(comparison.conclusion_changes).toHaveLength(1)
    expect(comparison.conclusion_changes[0]?.baseline_view).toBe("underperform")
    expect(comparison.conclusion_changes[0]?.current_view).toBe("outperform")
  })

  test("discovers prior runs from reports artifacts", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "political-backtest-history-"))
    const runRoot = path.join(temp, "reports", "TEST", "2025-01-01")
    await fs.mkdir(runRoot, { recursive: true })

    await Bun.write(
      path.join(runRoot, "assumptions.json"),
      JSON.stringify(
        {
          workflow: "financial_political_backtest",
          generated_at: "2025-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    )
    await Bun.write(path.join(runRoot, "aggregate-results.json"), JSON.stringify([aggregate({})], null, 2))
    await Bun.write(path.join(runRoot, "events.json"), JSON.stringify([{ event_id: "e1" }], null, 2))

    const runs = await discoverHistoricalRuns({
      reports_root: temp,
      ticker: "TEST",
    })

    expect(runs).toHaveLength(1)
    expect(runs[0]?.output_root).toBe(runRoot)
    expect(runs[0]?.event_ids).toEqual(["e1"])

    await fs.rm(temp, { recursive: true, force: true })
  })

  test("includes same output root historical artifacts as comparison baseline", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "political-backtest-same-root-"))
    const runRoot = path.join(temp, "reports", "TEST", "2025-01-01")
    await fs.mkdir(runRoot, { recursive: true })

    await Bun.write(
      path.join(runRoot, "assumptions.json"),
      JSON.stringify(
        {
          workflow: "financial_political_backtest",
          generated_at: "2025-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    )
    await Bun.write(path.join(runRoot, "aggregate-results.json"), JSON.stringify([aggregate({ sample_size: 2 })], null, 2))
    await Bun.write(path.join(runRoot, "events.json"), JSON.stringify([{ event_id: "e1" }, { event_id: "e2" }], null, 2))

    const comparison = await FinancialPoliticalBacktestInternal.buildRunComparison({
      reportsRoot: temp,
      scopeKey: "TEST",
      currentSnapshot: {
        workflow: "financial_political_backtest",
        output_root: runRoot,
        generated_at: "2025-01-02T00:00:00.000Z",
        aggregates: [aggregate({ sample_size: 3 })],
        event_ids: ["e1", "e2", "e3"],
      },
    })

    expect(comparison.first_run).toBe(false)
    expect(comparison.baseline?.output_root).toBe(runRoot)
    expect(comparison.event_sample.baseline).toBe(2)

    await fs.rm(temp, { recursive: true, force: true })
  })
})
