import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import {
  DEFAULT_ASSUMPTIONS_FILENAME,
  DEFAULT_NORMALIZED_EVENTS_FILENAME,
  loadGovernmentTradingHistory,
} from "./history"
import { normalizeGovernmentTradingEvent } from "./normalize"

function fixtureEvent() {
  return normalizeGovernmentTradingEvent({
    datasetId: "ticker_congress_trading",
    datasetLabel: "Ticker Congress Trading",
    row: {
      ticker: "AAPL",
      date: "2025-01-20",
      representative: "Jane Doe",
      transaction_type: "purchase",
      amount: 500,
    },
  })
}

describe("loadGovernmentTradingHistory", () => {
  it("discovers prior parsed runs and loads normalized events + assumptions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gov-trading-history-"))
    try {
      const parsedRunDir = path.join(root, "2026-01-20")
      const ignoredRunDir = path.join(root, "2026-01-19")
      await Promise.all([fs.mkdir(parsedRunDir, { recursive: true }), fs.mkdir(ignoredRunDir, { recursive: true })])

      await Promise.all([
        fs.writeFile(
          path.join(parsedRunDir, DEFAULT_NORMALIZED_EVENTS_FILENAME),
          JSON.stringify([fixtureEvent()], null, 2),
          "utf8",
        ),
        fs.writeFile(
          path.join(parsedRunDir, DEFAULT_ASSUMPTIONS_FILENAME),
          JSON.stringify({ identity_strategy: "alias_pick_first", material_fields_excluded: ["timestamp"] }, null, 2),
          "utf8",
        ),
      ])

      const runs = await loadGovernmentTradingHistory({ historyRoot: root })
      expect(runs).toHaveLength(1)
      expect(runs[0]?.runId).toBe("2026-01-20")
      expect(runs[0]?.normalizedEvents).toHaveLength(1)
      expect(runs[0]?.assumptions).toEqual({
        identity_strategy: "alias_pick_first",
        material_fields_excluded: ["timestamp"],
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("throws when a parsed run is missing required assumptions metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gov-trading-history-"))
    try {
      const parsedRunDir = path.join(root, "2026-01-21")
      await fs.mkdir(parsedRunDir, { recursive: true })
      await fs.writeFile(
        path.join(parsedRunDir, DEFAULT_NORMALIZED_EVENTS_FILENAME),
        JSON.stringify([fixtureEvent()], null, 2),
        "utf8",
      )

      await expect(loadGovernmentTradingHistory({ historyRoot: root })).rejects.toThrow(
        /Missing required assumptions file for parsed run/,
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
