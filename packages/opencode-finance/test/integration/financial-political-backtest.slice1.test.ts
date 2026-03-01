import { describe, expect, test } from "bun:test"
import { runPoliticalEventStudyCore, type PoliticalEvent, type PriceBar } from "../../src/finance/political-backtest"
import { FinancialPoliticalBacktestInternal } from "../../src/tool/financial-political-backtest"

describe("financial_political_backtest slice 1", () => {
  test("computes a strict ticker tracer-bullet run against SPY", () => {
    const events: PoliticalEvent[] = [
      {
        event_id: "e1",
        ticker: "TEST",
        source_dataset_id: "ticker_congress_trading",
        actor: "A",
        side: "buy",
        transaction_date: "2025-01-04",
        report_date: "2025-01-06",
        shares: 100,
      },
    ]

    const testBars: PriceBar[] = [
      { symbol: "TEST", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "TEST", date: "2025-01-06", adjusted_close: 102 },
      { symbol: "TEST", date: "2025-01-07", adjusted_close: 105 },
      { symbol: "TEST", date: "2025-01-08", adjusted_close: 107 },
      { symbol: "TEST", date: "2025-01-09", adjusted_close: 108 },
      { symbol: "TEST", date: "2025-01-10", adjusted_close: 109 },
    ]

    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 501 },
      { symbol: "SPY", date: "2025-01-07", adjusted_close: 502 },
      { symbol: "SPY", date: "2025-01-08", adjusted_close: 503 },
      { symbol: "SPY", date: "2025-01-09", adjusted_close: 504 },
      { symbol: "SPY", date: "2025-01-10", adjusted_close: 505 },
    ]

    const output = runPoliticalEventStudyCore({
      events,
      anchor_mode: "transaction",
      windows: [1],
      alignment: "next_session",
      benchmark_mode: "spy_only",
      sector: null,
      price_by_symbol: {
        TEST: testBars,
        SPY: spyBars,
      },
    })

    expect(output.event_window_returns).toHaveLength(1)
    expect(output.benchmark_relative_returns).toHaveLength(1)
    expect(output.aggregates).toHaveLength(1)
    expect(output.benchmark_selection.symbols).toEqual(["SPY"])

    const row = output.benchmark_relative_returns[0]
    expect(row.aligned_anchor_date).toBe("2025-01-06")
    expect(row.forward_return_percent).toBeCloseTo(2.941176, 5)
  })

  test("fails loudly when auth is missing", () => {
    expect(() =>
      FinancialPoliticalBacktestInternal.resolveAuthFromState({
        auth: undefined,
        env: undefined,
      }),
    ).toThrow("Quiver Quant is required for political backtests")
  })

  test("fails loudly when required dataset did not return successfully", () => {
    expect(() =>
      FinancialPoliticalBacktestInternal.assertDatasetsComplete([
        {
          id: "ticker_congress_trading",
          label: "Ticker Congress Trading",
          endpoint: "/beta/historical/congresstrading/{ticker}",
          endpoint_tier: "tier_1",
          status: "failed",
          timestamp: new Date().toISOString(),
          source_url: "https://api.quiverquant.com/beta/historical/congresstrading/TEST",
          rows: [],
          error: {
            code: "NETWORK",
            message: "request failed",
          },
        },
      ]),
    ).toThrow("Backtest requires complete Tier 1 government-trading coverage")
  })
})
