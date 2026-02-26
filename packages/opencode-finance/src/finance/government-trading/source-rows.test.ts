import { describe, expect, it } from "bun:test"
import type { QuiverReportDataset } from "../providers/quiver-report"
import { collectGovernmentTradingSourceRows } from "./source-rows"

function dataset(input: { id: string; label: string; rows: Record<string, unknown>[] }): QuiverReportDataset {
  return {
    id: input.id,
    label: input.label,
    endpoint: `/beta/${input.id}`,
    endpoint_tier: "tier_1",
    status: "ok",
    timestamp: "2026-02-26T00:00:00.000Z",
    source_url: `https://example.com/${input.id}`,
    rows: input.rows,
  }
}

describe("collectGovernmentTradingSourceRows", () => {
  it("applies limit per dataset across global and ticker datasets", () => {
    const result = collectGovernmentTradingSourceRows({
      globalDatasets: [
        dataset({
          id: "global_congress_trading",
          label: "Global Congress Trading",
          rows: [{ index: 1 }, { index: 2 }, { index: 3 }],
        }),
        dataset({
          id: "global_senate_trading",
          label: "Global Senate Trading",
          rows: [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }],
        }),
      ],
      tickerDatasets: [
        {
          ticker: "AAPL",
          datasets: [
            dataset({
              id: "ticker_congress_trading",
              label: "Ticker Congress Trading",
              rows: [{ index: 1 }, { index: 2 }, { index: 3 }],
            }),
          ],
        },
        {
          ticker: "MSFT",
          datasets: [
            dataset({
              id: "ticker_congress_trading",
              label: "Ticker Congress Trading",
              rows: [{ index: 1 }, { index: 2 }, { index: 3 }],
            }),
          ],
        },
      ],
      limitPerDataset: 2,
    })

    const countsByLabel = result.reduce<Record<string, number>>((acc, row) => {
      acc[row.datasetLabel] = (acc[row.datasetLabel] ?? 0) + 1
      return acc
    }, {})

    expect(countsByLabel["Global Congress Trading"]).toBe(2)
    expect(countsByLabel["Global Senate Trading"]).toBe(2)
    expect(countsByLabel["Ticker Congress Trading (AAPL)"]).toBe(2)
    expect(countsByLabel["Ticker Congress Trading (MSFT)"]).toBe(2)
    expect(result).toHaveLength(8)
  })

  it("injects requested_ticker for ticker datasets while preserving per-dataset truncation", () => {
    const result = collectGovernmentTradingSourceRows({
      globalDatasets: [],
      tickerDatasets: [
        {
          ticker: "TSLA",
          datasets: [
            dataset({
              id: "ticker_house_trading",
              label: "Ticker House Trading",
              rows: [{ amount: 10 }, { amount: 20 }],
            }),
          ],
        },
      ],
      limitPerDataset: 1,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.datasetLabel).toBe("Ticker House Trading (TSLA)")
    expect(result[0]?.row.requested_ticker).toBe("TSLA")
    expect(result[0]?.row.amount).toBe(10)
  })

  it("supports edge limits of 1 and 200", () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ index }))
    const global = [dataset({ id: "global_house_trading", label: "Global House Trading", rows })]

    const one = collectGovernmentTradingSourceRows({
      globalDatasets: global,
      tickerDatasets: [],
      limitPerDataset: 1,
    })
    expect(one).toHaveLength(1)
    expect(one[0]?.rowIndex).toBe(0)

    const twoHundred = collectGovernmentTradingSourceRows({
      globalDatasets: global,
      tickerDatasets: [],
      limitPerDataset: 200,
    })
    expect(twoHundred).toHaveLength(200)
    expect(twoHundred[199]?.rowIndex).toBe(199)
  })
})
