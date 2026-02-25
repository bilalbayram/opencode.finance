import { describe, expect, test } from "bun:test"
import {
  EventStudyError,
  runPoliticalEventStudyCore,
  selectBenchmarks,
  type PoliticalEvent,
  type PriceBar,
} from "../../src/finance/political-backtest"

describe("financial_political_backtest slice 3", () => {
  test("selects SPY and sector ETF when relevance criteria are satisfied", () => {
    const selection = selectBenchmarks({
      sector: "Financial",
      mode: "spy_plus_sector_if_relevant",
    })

    expect(selection.symbols).toEqual(["SPY", "XLF"])
    expect(selection.rationale.join(" ")).toContain("Sector benchmark 'XLF' added")
  })

  test("computes benchmark-relative metrics for both SPY and sector ETF", () => {
    const events: PoliticalEvent[] = [
      {
        event_id: "e1",
        ticker: "TEST",
        source_dataset_id: "ticker_house_trading",
        actor: "C",
        side: "buy",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 10,
      },
    ]

    const testBars: PriceBar[] = [
      { symbol: "TEST", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "TEST", date: "2025-01-06", adjusted_close: 110 },
    ]
    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 505 },
    ]
    const xlfBars: PriceBar[] = [
      { symbol: "XLF", date: "2025-01-03", adjusted_close: 40 },
      { symbol: "XLF", date: "2025-01-06", adjusted_close: 42 },
    ]

    const output = runPoliticalEventStudyCore({
      events,
      anchor_mode: "transaction",
      windows: [1],
      alignment: "next_session",
      benchmark_mode: "spy_plus_sector_if_relevant",
      sector: "Financial",
      price_by_symbol: {
        TEST: testBars,
        SPY: spyBars,
        XLF: xlfBars,
      },
    })

    expect(output.benchmark_selection.symbols).toEqual(["SPY", "XLF"])
    expect(output.benchmark_relative_returns).toHaveLength(2)

    const spy = output.benchmark_relative_returns.find((item) => item.benchmark_symbol === "SPY")
    const xlf = output.benchmark_relative_returns.find((item) => item.benchmark_symbol === "XLF")

    expect(spy).toBeDefined()
    expect(xlf).toBeDefined()
    expect(spy?.excess_return_percent).toBeCloseTo(9, 6)
    expect(xlf?.excess_return_percent).toBeCloseTo(5, 6)

    const aggregateBenchmarks = output.aggregates.map((item) => item.benchmark_symbol).sort()
    expect(aggregateBenchmarks).toEqual(["SPY", "XLF"])
  })

  test("fails loudly when required sector benchmark data is unavailable", () => {
    const events: PoliticalEvent[] = [
      {
        event_id: "e1",
        ticker: "TEST",
        source_dataset_id: "ticker_congress_trading",
        actor: "A",
        side: "buy",
        transaction_date: "2025-01-03",
        report_date: "2025-01-04",
        shares: 1,
      },
    ]

    const testBars: PriceBar[] = [
      { symbol: "TEST", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "TEST", date: "2025-01-06", adjusted_close: 101 },
    ]
    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 501 },
    ]

    expect(() =>
      runPoliticalEventStudyCore({
        events,
        anchor_mode: "transaction",
        windows: [1],
        alignment: "next_session",
        benchmark_mode: "spy_plus_sector_required",
        sector: "Technology",
        price_by_symbol: {
          TEST: testBars,
          SPY: spyBars,
        },
      }),
    ).toThrow(EventStudyError)

    try {
      runPoliticalEventStudyCore({
        events,
        anchor_mode: "transaction",
        windows: [1],
        alignment: "next_session",
        benchmark_mode: "spy_plus_sector_required",
        sector: "Technology",
        price_by_symbol: {
          TEST: testBars,
          SPY: spyBars,
        },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(EventStudyError)
      expect((error as EventStudyError).code).toBe("MISSING_PRICE_SERIES")
    }
  })
})
