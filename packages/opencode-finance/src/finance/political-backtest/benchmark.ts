import { EventStudyError } from "./error"
import type { BenchmarkMode, BenchmarkSelection } from "./types"

const DEFAULT_SECTOR_ETF_MAP: Record<string, string> = {
  "communication services": "XLC",
  consumer: "XLY",
  "consumer discretionary": "XLY",
  "consumer staples": "XLP",
  energy: "XLE",
  financial: "XLF",
  healthcare: "XLV",
  industrials: "XLI",
  materials: "XLB",
  "real estate": "XLRE",
  technology: "XLK",
  utilities: "XLU",
}

function normalizeSector(input?: string | null) {
  if (!input) return null
  const value = input.trim().toLowerCase().replace(/\s+/g, " ")
  return value || null
}

export function sectorETF(input: string | null | undefined, map: Record<string, string> = DEFAULT_SECTOR_ETF_MAP) {
  const normalized = normalizeSector(input)
  if (!normalized) return null
  return map[normalized] ?? null
}

export function selectBenchmarks(input: {
  sector: string | null | undefined
  mode: BenchmarkMode
  sector_to_etf?: Record<string, string>
}): BenchmarkSelection {
  const selected = new Set<string>(["SPY"])
  const map = input.sector_to_etf ?? DEFAULT_SECTOR_ETF_MAP
  const sector = normalizeSector(input.sector)
  const sectorEtf = sectorETF(sector, map)
  const rationale = ["SPY baseline included for all runs."]

  if (input.mode === "spy_only") {
    rationale.push("Sector benchmark disabled by benchmark mode.")
    return {
      symbols: [...selected],
      rationale,
      sector,
      sector_etf: null,
    }
  }

  if (!sector) {
    if (input.mode === "spy_plus_sector_required") {
      throw new EventStudyError("Sector benchmark is required but sector metadata is unavailable.", "MISSING_BENCHMARK_MAPPING", {
        mode: input.mode,
      })
    }
    rationale.push("Sector benchmark not added because sector metadata is unavailable.")
    return {
      symbols: [...selected],
      rationale,
      sector: null,
      sector_etf: null,
    }
  }

  if (!sectorEtf) {
    if (input.mode === "spy_plus_sector_required") {
      throw new EventStudyError(`No sector ETF mapping exists for sector '${sector}'.`, "MISSING_BENCHMARK_MAPPING", {
        mode: input.mode,
        sector,
      })
    }
    rationale.push(`Sector '${sector}' has no configured ETF mapping; using SPY only.`)
    return {
      symbols: [...selected],
      rationale,
      sector,
      sector_etf: null,
    }
  }

  if (sectorEtf !== "SPY") selected.add(sectorEtf)
  rationale.push(`Sector benchmark '${sectorEtf}' added for sector '${sector}'.`)
  return {
    symbols: [...selected],
    rationale,
    sector,
    sector_etf: sectorEtf,
  }
}

export const POLITICAL_BACKTEST_SECTOR_ETF_MAP = DEFAULT_SECTOR_ETF_MAP
