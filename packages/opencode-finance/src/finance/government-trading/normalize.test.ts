import { describe, expect, it } from "bun:test"
import { normalizeGovernmentTradingEvent, normalizeGovernmentTradingEvents } from "./normalize"

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

  it("disambiguates duplicate base identities using canonical row hash fallback", () => {
    const events = normalizeGovernmentTradingEvents([
      {
        datasetId: "ticker_congress_trading",
        datasetLabel: "Ticker Congress Trading",
        row: {
          ticker: "AAPL",
          date: "2025-01-03",
          representative: "Jane Doe",
          transaction_type: "purchase",
          amount: "1,000",
        },
      },
      {
        datasetId: "ticker_congress_trading",
        datasetLabel: "Ticker Congress Trading",
        row: {
          ticker: "AAPL",
          date: "2025-01-03",
          representative: "Jane Doe",
          transaction_type: "purchase",
          amount: "2,000",
        },
      },
    ])

    expect(events).toHaveLength(2)
    expect(events[0]?.identityFields.amount).toBe("1000")
    expect(events[1]?.identityFields.amount).toBe("2000")
    expect(events[0]?.identityKey).not.toBe(events[1]?.identityKey)
  })
})
