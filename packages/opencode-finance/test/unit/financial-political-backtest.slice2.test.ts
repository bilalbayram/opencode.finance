import { describe, expect, test } from "bun:test"
import {
  EventStudyError,
  alignToNextSession,
  createTradingCalendar,
  resolveAnchors,
  runPoliticalEventStudyCore,
  type PoliticalEvent,
  type PriceBar,
} from "../../src/finance/political-backtest"

describe("financial_political_backtest slice 2", () => {
  test("supports transaction/report/both anchor modes", () => {
    const event: PoliticalEvent = {
      event_id: "e1",
      ticker: "TEST",
      source_dataset_id: "ticker_congress_trading",
      actor: "A",
      side: "buy",
      transaction_date: "2025-01-03",
      report_date: "2025-01-07",
      shares: 100,
    }

    expect(resolveAnchors([event], "transaction")).toHaveLength(1)
    expect(resolveAnchors([event], "report")).toHaveLength(1)
    expect(resolveAnchors([event], "both")).toHaveLength(2)

    expect(() =>
      resolveAnchors(
        [
          {
            ...event,
            report_date: null,
          },
        ],
        "both",
      ),
    ).toThrow("Missing report date")
  })

  test("aligns non-trading-day anchors to next trading session", () => {
    const calendar = createTradingCalendar(["2025-01-03", "2025-01-06", "2025-01-07"])
    const aligned = alignToNextSession(calendar, "2025-01-04")
    expect(aligned.alignedDate).toBe("2025-01-06")
    expect(aligned.shifted).toBe(true)
  })

  test("fails loudly when configured windows cannot be computed", () => {
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
        windows: [5],
        alignment: "next_session",
        benchmark_mode: "spy_only",
        sector: null,
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
        windows: [5],
        alignment: "next_session",
        benchmark_mode: "spy_only",
        sector: null,
        price_by_symbol: {
          TEST: testBars,
          SPY: spyBars,
        },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(EventStudyError)
      expect((error as EventStudyError).code).toBe("WINDOW_OUT_OF_RANGE")
    }
  })

  test("computes multiple configured windows deterministically", () => {
    const events: PoliticalEvent[] = [
      {
        event_id: "e1",
        ticker: "TEST",
        source_dataset_id: "ticker_senate_trading",
        actor: "B",
        side: "sell",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 50,
      },
    ]

    const testBars: PriceBar[] = [
      { symbol: "TEST", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "TEST", date: "2025-01-06", adjusted_close: 102 },
      { symbol: "TEST", date: "2025-01-07", adjusted_close: 104 },
      { symbol: "TEST", date: "2025-01-08", adjusted_close: 103 },
    ]

    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 501 },
      { symbol: "SPY", date: "2025-01-07", adjusted_close: 503 },
      { symbol: "SPY", date: "2025-01-08", adjusted_close: 504 },
    ]

    const output = runPoliticalEventStudyCore({
      events,
      anchor_mode: "transaction",
      windows: [1, 2],
      alignment: "next_session",
      benchmark_mode: "spy_only",
      sector: null,
      price_by_symbol: {
        TEST: testBars,
        SPY: spyBars,
      },
    })

    expect(output.event_window_returns).toHaveLength(2)
    expect(output.benchmark_relative_returns).toHaveLength(2)
    expect(output.event_window_returns.map((item) => item.window_sessions)).toEqual([1, 2])
  })
})
