import { describe, expect, it } from "bun:test"
import { computeGovernmentTradingDelta } from "./delta"
import { normalizeGovernmentTradingEvent } from "./normalize"

function event(row: Record<string, unknown>) {
  return normalizeGovernmentTradingEvent({
    datasetId: "ticker_congress_trading",
    datasetLabel: "Ticker Congress Trading",
    row,
  })
}

describe("computeGovernmentTradingDelta", () => {
  it("classifies rows as new, updated, unchanged, and no longer present", () => {
    const unchangedPrevious = event({
      ticker: "AAPL",
      date: "2025-01-10",
      representative: "Jane Doe",
      transaction_type: "purchase",
      amount: 1000,
    })
    const updatedPrevious = event({
      ticker: "MSFT",
      date: "2025-01-12",
      representative: "John Doe",
      transaction_type: "sell",
      amount: 400,
    })
    const removedPrevious = event({
      ticker: "NVDA",
      date: "2025-01-14",
      representative: "Alex Smith",
      transaction_type: "purchase",
      amount: 200,
    })

    const unchangedCurrent = event({
      ticker: "AAPL",
      date: "2025-01-10",
      representative: "Jane Doe",
      transaction_type: "purchase",
      amount: 1000,
    })
    const updatedCurrent = event({
      ticker: "MSFT",
      date: "2025-01-12",
      representative: "John Doe",
      transaction_type: "sell",
      amount: 650,
    })
    const newCurrent = event({
      ticker: "TSLA",
      date: "2025-01-16",
      representative: "Taylor Kim",
      transaction_type: "purchase",
      amount: 300,
    })

    const delta = computeGovernmentTradingDelta(
      [unchangedCurrent, updatedCurrent, newCurrent],
      [unchangedPrevious, updatedPrevious, removedPrevious],
      { includeNoLongerPresent: true },
    )

    expect(delta.newEvents).toHaveLength(1)
    expect(delta.updatedEvents).toHaveLength(1)
    expect(delta.unchangedEvents).toHaveLength(1)
    expect(delta.noLongerPresentEvents).toHaveLength(1)
    expect(delta.updatedEvents[0]?.changedFields).toEqual(["amount"])
    expect(delta.noLongerPresentEvents[0]?.identityFields.ticker).toBe("NVDA")
  })

  it("keeps requested_ticker rows distinct to avoid duplicate identity collisions", () => {
    const sameShapeAapl = event({
      requested_ticker: "AAPL",
      date: "2025-01-10",
      representative: "Jane Doe",
      transaction_type: "purchase",
      amount: 1000,
    })
    const sameShapeMsft = event({
      requested_ticker: "MSFT",
      date: "2025-01-10",
      representative: "Jane Doe",
      transaction_type: "purchase",
      amount: 1000,
    })

    const delta = computeGovernmentTradingDelta([sameShapeAapl, sameShapeMsft], [])
    expect(delta.newEvents).toHaveLength(2)
    expect(delta.newEvents.map((item) => item.identityFields.ticker)).toEqual(["AAPL", "MSFT"])
  })
})
