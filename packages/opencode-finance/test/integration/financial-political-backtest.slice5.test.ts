import { describe, expect, test } from "bun:test"
import {
  EventStudyError,
  computeEventWindowReturns,
  runPoliticalEventStudyCore,
  type PoliticalEvent,
  type PriceBar,
} from "../../src/finance/political-backtest"
import { FinancialPoliticalBacktestInternal } from "../../src/tool/financial_political_backtest"

describe("financial_political_backtest slice 5", () => {
  test("runs a portfolio-style backtest across multiple tickers", () => {
    const events: PoliticalEvent[] = [
      {
        event_id: "a1",
        ticker: "AAA",
        source_dataset_id: "ticker_congress_trading",
        actor: "Rep A",
        side: "buy",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 10,
      },
      {
        event_id: "b1",
        ticker: "BBB",
        source_dataset_id: "ticker_senate_trading",
        actor: "Sen B",
        side: "sell",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 15,
      },
    ]

    const aaaBars: PriceBar[] = [
      { symbol: "AAA", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "AAA", date: "2025-01-06", adjusted_close: 104 },
    ]
    const bbbBars: PriceBar[] = [
      { symbol: "BBB", date: "2025-01-03", adjusted_close: 50 },
      { symbol: "BBB", date: "2025-01-06", adjusted_close: 48 },
    ]
    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 505 },
    ]

    const output = runPoliticalEventStudyCore({
      events,
      anchor_mode: "transaction",
      windows: [1],
      alignment: "next_session",
      benchmark_mode: "spy_only",
      sector: null,
      price_by_symbol: {
        AAA: aaaBars,
        BBB: bbbBars,
        SPY: spyBars,
      },
    })

    expect(output.event_window_returns).toHaveLength(2)
    expect(output.benchmark_relative_returns).toHaveLength(2)
    expect(output.aggregates).toHaveLength(1)
    expect(output.aggregates[0]?.sample_size).toBe(2)
  })

  test("scopes portfolio benchmark-relative rows to each ticker's benchmark set", () => {
    const events: PoliticalEvent[] = [
      {
        event_id: "a1",
        ticker: "AAA",
        source_dataset_id: "ticker_congress_trading",
        actor: "Rep A",
        side: "buy",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 10,
      },
      {
        event_id: "b1",
        ticker: "BBB",
        source_dataset_id: "ticker_senate_trading",
        actor: "Sen B",
        side: "sell",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 15,
      },
    ]

    const aaaBars: PriceBar[] = [
      { symbol: "AAA", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "AAA", date: "2025-01-06", adjusted_close: 104 },
    ]
    const bbbBars: PriceBar[] = [
      { symbol: "BBB", date: "2025-01-03", adjusted_close: 50 },
      { symbol: "BBB", date: "2025-01-06", adjusted_close: 48 },
    ]
    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 505 },
    ]
    const xlfBars: PriceBar[] = [
      { symbol: "XLF", date: "2025-01-03", adjusted_close: 40 },
      { symbol: "XLF", date: "2025-01-06", adjusted_close: 41 },
    ]
    const xlvBars: PriceBar[] = [
      { symbol: "XLV", date: "2025-01-03", adjusted_close: 130 },
      { symbol: "XLV", date: "2025-01-06", adjusted_close: 131 },
    ]

    const eventWindowReturns = computeEventWindowReturns({
      events,
      anchor_mode: "transaction",
      windows: [1],
      alignment: "next_session",
      price_by_symbol: {
        AAA: aaaBars,
        BBB: bbbBars,
      },
    })

    const rows = FinancialPoliticalBacktestInternal.computePortfolioBenchmarkRelativeRows({
      tickers: ["AAA", "BBB"],
      eventWindowReturns,
      benchmarkSymbolsByTicker: {
        AAA: ["SPY", "XLF"],
        BBB: ["SPY", "XLV"],
      },
      alignment: "next_session",
      price_by_symbol: {
        AAA: aaaBars,
        BBB: bbbBars,
        SPY: spyBars,
        XLF: xlfBars,
        XLV: xlvBars,
      },
    })

    expect(rows).toHaveLength(4)
    expect(rows.filter((row) => row.ticker === "AAA").map((row) => row.benchmark_symbol).sort()).toEqual(["SPY", "XLF"])
    expect(rows.filter((row) => row.ticker === "BBB").map((row) => row.benchmark_symbol).sort()).toEqual(["SPY", "XLV"])
    expect(rows.some((row) => row.ticker === "AAA" && row.benchmark_symbol === "XLV")).toBe(false)
    expect(rows.some((row) => row.ticker === "BBB" && row.benchmark_symbol === "XLF")).toBe(false)
  })

  test("fails loudly when any portfolio ticker is missing scoped benchmark mapping", () => {
    const eventWindowReturns = [
      {
        event_id: "a1",
        ticker: "AAA",
        anchor_kind: "transaction",
        anchor_date: "2025-01-03",
        aligned_anchor_date: "2025-01-03",
        window_sessions: 1,
        start_close: 100,
        end_close: 104,
        forward_return_percent: 4,
      },
      {
        event_id: "b1",
        ticker: "BBB",
        anchor_kind: "transaction",
        anchor_date: "2025-01-03",
        aligned_anchor_date: "2025-01-03",
        window_sessions: 1,
        start_close: 50,
        end_close: 48,
        forward_return_percent: -4,
      },
    ] as const

    const aaaBars: PriceBar[] = [
      { symbol: "AAA", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "AAA", date: "2025-01-06", adjusted_close: 104 },
    ]
    const bbbBars: PriceBar[] = [
      { symbol: "BBB", date: "2025-01-03", adjusted_close: 50 },
      { symbol: "BBB", date: "2025-01-06", adjusted_close: 48 },
    ]
    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 505 },
    ]

    expect(() =>
      FinancialPoliticalBacktestInternal.computePortfolioBenchmarkRelativeRows({
        tickers: ["AAA", "BBB"],
        eventWindowReturns: [...eventWindowReturns],
        benchmarkSymbolsByTicker: {
          AAA: ["SPY"],
        },
        alignment: "next_session",
        price_by_symbol: {
          AAA: aaaBars,
          BBB: bbbBars,
          SPY: spyBars,
        },
      }),
    ).toThrow(EventStudyError)
  })

  test("fails loudly for empty portfolio prerequisites", () => {
    expect(() => FinancialPoliticalBacktestInternal.portfolioTickersFromHoldings([])).toThrow("No holdings found")
  })

  test("fails loudly when one portfolio ticker is missing required market history", () => {
    const events: PoliticalEvent[] = [
      {
        event_id: "a1",
        ticker: "AAA",
        source_dataset_id: "ticker_congress_trading",
        actor: "Rep A",
        side: "buy",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 10,
      },
      {
        event_id: "b1",
        ticker: "BBB",
        source_dataset_id: "ticker_senate_trading",
        actor: "Sen B",
        side: "sell",
        transaction_date: "2025-01-03",
        report_date: "2025-01-06",
        shares: 15,
      },
    ]

    const aaaBars: PriceBar[] = [
      { symbol: "AAA", date: "2025-01-03", adjusted_close: 100 },
      { symbol: "AAA", date: "2025-01-06", adjusted_close: 104 },
    ]
    const spyBars: PriceBar[] = [
      { symbol: "SPY", date: "2025-01-03", adjusted_close: 500 },
      { symbol: "SPY", date: "2025-01-06", adjusted_close: 505 },
    ]

    expect(() =>
      runPoliticalEventStudyCore({
        events,
        anchor_mode: "transaction",
        windows: [1],
        alignment: "next_session",
        benchmark_mode: "spy_only",
        sector: null,
        price_by_symbol: {
          AAA: aaaBars,
          SPY: spyBars,
        },
      }),
    ).toThrow(EventStudyError)
  })

  test("fails loudly when any ticker dataset fails in portfolio mode", () => {
    expect(() =>
      FinancialPoliticalBacktestInternal.assertDatasetsComplete([
        {
          id: "ticker_congress_trading",
          label: "Ticker Congress Trading",
          endpoint: "/beta/historical/congresstrading/{ticker}",
          endpoint_tier: "tier_1",
          status: "ok",
          timestamp: new Date().toISOString(),
          source_url: "https://api.quiverquant.com/beta/historical/congresstrading/AAA",
          rows: [{ id: "1" }],
        },
        {
          id: "ticker_senate_trading",
          label: "Ticker Senate Trading",
          endpoint: "/beta/historical/senatetrading/{ticker}",
          endpoint_tier: "tier_1",
          status: "failed",
          timestamp: new Date().toISOString(),
          source_url: "https://api.quiverquant.com/beta/historical/senatetrading/BBB",
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
