import { describe, expect, test } from "bun:test"
import { EventStudyError, normalizePoliticalEvents } from "../../src/finance/political-backtest"
import { FinancialPoliticalBacktestInternal } from "../../src/tool/financial-political-backtest"

describe("financial_political_backtest slice 8", () => {
  test("generates stable event ids for equivalent rows regardless of row ordering", () => {
    const baseRows = [
      {
        Ticker: "AAA",
        TransactionDate: "2025-01-03",
        Representative: "Rep A",
        TransactionType: "Purchase",
        Amount: "1000",
      },
      {
        Ticker: "AAA",
        TransactionDate: "2025-01-08",
        Representative: "Rep B",
        TransactionType: "Sale",
        Amount: "500",
      },
    ]
    const reversedRows = [baseRows[1]!, baseRows[0]!]

    const first = normalizePoliticalEvents({
      ticker: "AAA",
      datasets: [{ id: "ticker_congress_trading", rows: baseRows }],
    })
    const second = normalizePoliticalEvents({
      ticker: "AAA",
      datasets: [{ id: "ticker_congress_trading", rows: reversedRows }],
    })

    const firstIDs = first.map((item) => item.event_id).toSorted((a, b) => a.localeCompare(b))
    const secondIDs = second.map((item) => item.event_id).toSorted((a, b) => a.localeCompare(b))

    expect(firstIDs).toEqual(secondIDs)
  })

  test("keeps event id stable when logical row shifts index position", () => {
    const first = normalizePoliticalEvents({
      ticker: "AAA",
      datasets: [
        {
          id: "ticker_senate_trading",
          rows: [
            {
              Ticker: "AAA",
              TransactionDate: "2025-01-03",
              Senator: "Sen A",
              TransactionType: "Purchase",
              Amount: "1000",
            },
            {
              Ticker: "AAA",
              TransactionDate: "2025-01-10",
              Senator: "Sen B",
              TransactionType: "Sale",
              Amount: "1500",
            },
          ],
        },
      ],
    })
    const second = normalizePoliticalEvents({
      ticker: "AAA",
      datasets: [
        {
          id: "ticker_senate_trading",
          rows: [
            {
              Ticker: "AAA",
              TransactionDate: "2025-01-10",
              Senator: "Sen B",
              TransactionType: "Sale",
              Amount: "1500",
            },
            {
              Ticker: "AAA",
              TransactionDate: "2025-01-03",
              Senator: "Sen A",
              TransactionType: "Purchase",
              Amount: "1000",
            },
          ],
        },
      ],
    })

    const firstID = first.find((item) => item.transaction_date === "2025-01-03")?.event_id
    const secondID = second.find((item) => item.transaction_date === "2025-01-03")?.event_id
    expect(firstID).toBeDefined()
    expect(secondID).toBeDefined()
    expect(firstID).toBe(secondID)
  })

  test("parses non-ISO timezone-less dates in UTC for stable calendar-day normalization", () => {
    const events = normalizePoliticalEvents({
      ticker: "AAA",
      datasets: [
        {
          id: "ticker_house_trading",
          rows: [
            {
              Ticker: "AAA",
              TransactionDate: "01/03/2025 23:00:00",
              Representative: "Rep A",
              TransactionType: "Purchase",
              Amount: "1000",
            },
          ],
        },
      ],
    })

    expect(events[0]?.transaction_date).toBe("2025-01-03")
  })

  test("preserves explicit timezone semantics when normalizing non-ISO dates", () => {
    const events = normalizePoliticalEvents({
      ticker: "AAA",
      datasets: [
        {
          id: "ticker_house_trading",
          rows: [
            {
              Ticker: "AAA",
              TransactionDate: "2025-01-03T23:00:00-05:00",
              Representative: "Rep A",
              TransactionType: "Purchase",
              Amount: "1000",
            },
          ],
        },
      ],
    })

    expect(events[0]?.transaction_date).toBe("2025-01-04")
  })

  test("preserves timestamp/price positional alignment when parsing chart bars", () => {
    const rows = FinancialPoliticalBacktestInternal.parseChartBars({
      symbol: "AAA",
      payload: {
        chart: {
          result: [
            {
              timestamp: [1735689600, 1735776000],
              indicators: {
                adjclose: [{ adjclose: [101, 111] }],
                quote: [{ close: [100, 110] }],
              },
            },
          ],
        },
      },
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      symbol: "AAA",
      date: "2025-01-01",
      adjusted_close: 101,
    })
    expect(rows[1]).toEqual({
      symbol: "AAA",
      date: "2025-01-02",
      adjusted_close: 111,
    })
  })

  test("fails loudly on malformed timestamps instead of silently reindexing", () => {
    expect(() =>
      FinancialPoliticalBacktestInternal.parseChartBars({
        symbol: "AAA",
        payload: {
          chart: {
            result: [
              {
                timestamp: [1735689600, null],
                indicators: {
                  adjclose: [{ adjclose: [101, 111] }],
                  quote: [{ close: [100, 110] }],
                },
              },
            ],
          },
        },
      }),
    ).toThrow(EventStudyError)

    try {
      FinancialPoliticalBacktestInternal.parseChartBars({
        symbol: "AAA",
        payload: {
          chart: {
            result: [
              {
                timestamp: [1735689600, null],
                indicators: {
                  adjclose: [{ adjclose: [101, 111] }],
                  quote: [{ close: [100, 110] }],
                },
              },
            ],
          },
        },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(EventStudyError)
      expect((error as EventStudyError).code).toBe("INVALID_PRICE_SERIES")
    }
  })

  test("fails loudly on malformed mapped prices instead of skipping rows", () => {
    expect(() =>
      FinancialPoliticalBacktestInternal.parseChartBars({
        symbol: "AAA",
        payload: {
          chart: {
            result: [
              {
                timestamp: [1735689600, 1735776000],
                indicators: {
                  adjclose: [{ adjclose: [101, null] }],
                  quote: [{ close: [100, null] }],
                },
              },
            ],
          },
        },
      }),
    ).toThrow(EventStudyError)

    try {
      FinancialPoliticalBacktestInternal.parseChartBars({
        symbol: "AAA",
        payload: {
          chart: {
            result: [
              {
                timestamp: [1735689600, 1735776000],
                indicators: {
                  adjclose: [{ adjclose: [101, null] }],
                  quote: [{ close: [100, null] }],
                },
              },
            ],
          },
        },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(EventStudyError)
      expect((error as EventStudyError).code).toBe("INVALID_PRICE_SERIES")
    }
  })
})
