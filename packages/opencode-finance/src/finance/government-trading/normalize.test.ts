import { describe, expect, it } from "bun:test"
import { normalizeGovernmentTradingEvent } from "./normalize"

describe("normalizeGovernmentTradingEvent", () => {
  it("produces deterministic identity and material fingerprints for equivalent rows", () => {
    const left = normalizeGovernmentTradingEvent({
      datasetId: "ticker_congress_trading",
      datasetLabel: "Ticker Congress Trading",
      row: {
        Ticker: "aapl ",
        Date: "2025-01-03",
        Representative: "Jane Doe",
        TransactionType: "Purchase",
        Amount: "1,000",
        Last_Updated: "2025-01-03T13:00:00Z",
      },
    })

    const right = normalizeGovernmentTradingEvent({
      datasetId: "ticker_congress_trading",
      datasetLabel: "Ticker Congress Trading",
      row: {
        amount: 1000,
        transaction_type: "purchase",
        representative: "jane doe",
        date: "2025-01-03",
        ticker: "AAPL",
        lastUpdated: "2025-01-04T09:45:00Z",
      },
    })

    expect(left.identityKey).toBe(right.identityKey)
    expect(left.materialFingerprint).toBe(right.materialFingerprint)
    expect(left.identityFields.ticker).toBe("AAPL")
  })
})
