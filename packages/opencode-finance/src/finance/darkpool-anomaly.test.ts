import { describe, expect, test } from "bun:test"
import {
  analyzeTickerOffExchange,
  classifyAnomalyTransitions,
  normalizeThresholds,
  parseOffExchangeDataset,
  toAnomalyRecord,
  type AnomalyRecord,
} from "./darkpool-anomaly"

function rows(values: number[]) {
  return values.map((value, index) => ({
    Date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    OffExchangeVolume: value,
  }))
}

describe("analyzeTickerOffExchange", () => {
  test("flags significant positive deviation", () => {
    const result = analyzeTickerOffExchange({
      ticker: "AAPL",
      rows: rows([100, 98, 101, 99, 102, 100, 97, 103, 100, 190]),
      lookback_days: 14,
      min_samples: 5,
      thresholds: normalizeThresholds({ significance: 2.5 }),
    })

    expect(result.significant).toBeTrue()
    expect(result.direction).toBe("positive")
    expect(result.severity).toBe("high")
  })

  test("flags significant negative deviation", () => {
    const result = analyzeTickerOffExchange({
      ticker: "MSFT",
      rows: rows([100, 99, 101, 98, 102, 103, 97, 100, 99, 20]),
      lookback_days: 14,
      min_samples: 5,
      thresholds: normalizeThresholds({ significance: 2.5 }),
    })

    expect(result.significant).toBeTrue()
    expect(result.direction).toBe("negative")
    expect(result.severity).toBe("high")
  })

  test("fails when sample count is insufficient", () => {
    expect(() =>
      analyzeTickerOffExchange({
        ticker: "TSLA",
        rows: rows([100, 101, 102, 103]),
        lookback_days: 14,
        min_samples: 5,
        thresholds: normalizeThresholds({ significance: 2.5 }),
      }),
    ).toThrow(/Insufficient off-exchange sample count/)
  })

  test("parses Quiver OTC schema and selects numeric metric", () => {
    const input = [
      { Ticker: "AAPL", Date: "2026-01-01", OTC_Short: 10, OTC_Total: 20, DPI: 0.5 },
      { Ticker: "AAPL", Date: "2026-01-02", OTC_Short: 11, OTC_Total: 22, DPI: 0.5 },
    ]
    const parsed = parseOffExchangeDataset(input)

    expect(parsed.date_key).toBe("Date")
    expect(parsed.metric_key).toBe("DPI")
    expect(parsed.observations.length).toBe(2)
  })
})

describe("classifyAnomalyTransitions", () => {
  test("classifies new, persisted, severity-change, and resolved", () => {
    const current: AnomalyRecord[] = [
      {
        key: "AAPL:offexchange",
        ticker: "AAPL",
        metric_key: "offexchange",
        metric_label: "OffExchange",
        date: "2026-01-10",
        current_value: 200,
        baseline_center: 100,
        baseline_dispersion: 20,
        z_score: 5,
        abs_z_score: 5,
        direction: "positive",
        severity: "high",
      },
      {
        key: "MSFT:offexchange",
        ticker: "MSFT",
        metric_key: "offexchange",
        metric_label: "OffExchange",
        date: "2026-01-10",
        current_value: 140,
        baseline_center: 100,
        baseline_dispersion: 20,
        z_score: 2,
        abs_z_score: 2,
        direction: "positive",
        severity: "low",
      },
      {
        key: "NVDA:offexchange",
        ticker: "NVDA",
        metric_key: "offexchange",
        metric_label: "OffExchange",
        date: "2026-01-10",
        current_value: 150,
        baseline_center: 100,
        baseline_dispersion: 20,
        z_score: 2.5,
        abs_z_score: 2.5,
        direction: "positive",
        severity: "medium",
      },
    ]

    const previous: AnomalyRecord[] = [
      {
        key: "MSFT:offexchange",
        ticker: "MSFT",
        metric_key: "offexchange",
        metric_label: "OffExchange",
        date: "2026-01-09",
        current_value: 130,
        baseline_center: 100,
        baseline_dispersion: 20,
        z_score: 1.5,
        abs_z_score: 1.5,
        direction: "positive",
        severity: "low",
      },
      {
        key: "NVDA:offexchange",
        ticker: "NVDA",
        metric_key: "offexchange",
        metric_label: "OffExchange",
        date: "2026-01-09",
        current_value: 130,
        baseline_center: 100,
        baseline_dispersion: 20,
        z_score: 1.5,
        abs_z_score: 1.5,
        direction: "positive",
        severity: "low",
      },
      {
        key: "AMZN:offexchange",
        ticker: "AMZN",
        metric_key: "offexchange",
        metric_label: "OffExchange",
        date: "2026-01-09",
        current_value: 130,
        baseline_center: 100,
        baseline_dispersion: 20,
        z_score: 1.5,
        abs_z_score: 1.5,
        direction: "positive",
        severity: "medium",
      },
    ]

    const transitions = classifyAnomalyTransitions(current, previous)

    const statesByKey = new Map(transitions.map((item) => [item.key, item.state]))
    expect(statesByKey.get("AAPL:offexchange")).toBe("new")
    expect(statesByKey.get("MSFT:offexchange")).toBe("persisted")
    expect(statesByKey.get("NVDA:offexchange")).toBe("severity_change")
    expect(statesByKey.get("AMZN:offexchange")).toBe("resolved")
  })

  test("toAnomalyRecord omits non-significant rows", () => {
    const result = analyzeTickerOffExchange({
      ticker: "META",
      rows: rows([100, 100.5, 99.5, 100, 100.2, 99.8, 100.1, 100.3, 99.9, 100.1]),
      lookback_days: 14,
      min_samples: 5,
      thresholds: normalizeThresholds({ significance: 3 }),
    })

    expect(result.significant).toBeFalse()
    expect(toAnomalyRecord(result)).toBeUndefined()
  })
})
