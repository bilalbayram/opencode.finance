import { resolveAnchors } from "./anchor"
import { aggregateByWindow } from "./aggregate"
import { selectBenchmarks } from "./benchmark"
import { EventStudyError } from "./error"
import { createCloseMap, normalizeWindowList } from "./forward-returns"
import { alignToNextSession, createTradingCalendar, getSessionByOffset } from "./trading-calendar"
import type {
  AggregateWindow,
  BenchmarkMode,
  BenchmarkRelativeReturn,
  EventAnchorMode,
  EventWindowReturn,
  NonTradingAlignment,
  PoliticalEvent,
  PriceBar,
  TradingCalendar,
} from "./types"

type SymbolHistory = {
  calendar: TradingCalendar
  closeByDate: ReadonlyMap<string, number>
}

function round(input: number, digits = 6) {
  const power = 10 ** digits
  return Math.round(input * power) / power
}

function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase()
  if (!symbol) throw new EventStudyError("Price history symbol cannot be empty.", "INVALID_PRICE_SERIES")
  return symbol
}

export function forwardReturnPercent(startClose: number, endClose: number): number {
  if (!Number.isFinite(startClose) || !Number.isFinite(endClose) || startClose <= 0 || endClose <= 0) {
    throw new EventStudyError("Cannot compute forward return from invalid close values.", "INVALID_PRICE_SERIES", {
      start_close: startClose,
      end_close: endClose,
    })
  }
  return round(((endClose / startClose) - 1) * 100)
}

export function relativeReturnPercent(assetReturnPercent: number, benchmarkReturnPercent: number): number {
  const asset = 1 + assetReturnPercent / 100
  const benchmark = 1 + benchmarkReturnPercent / 100
  if (asset <= 0 || benchmark <= 0) {
    throw new EventStudyError("Cannot compute relative return when compounded values are non-positive.", "INVALID_PRICE_SERIES", {
      asset_return_percent: assetReturnPercent,
      benchmark_return_percent: benchmarkReturnPercent,
    })
  }
  return round(((asset / benchmark) - 1) * 100)
}

function toSymbolHistory(symbol: string, bars: PriceBar[]): SymbolHistory {
  const normalizedSymbol = normalizeSymbol(symbol)
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new EventStudyError(`Missing price series for ${normalizedSymbol}.`, "MISSING_PRICE_SERIES", {
      symbol: normalizedSymbol,
    })
  }

  const rows = bars.map((bar, index) => {
    if (!bar || typeof bar !== "object" || Array.isArray(bar)) {
      throw new EventStudyError(`Invalid price row at index ${index} for ${normalizedSymbol}.`, "INVALID_PRICE_SERIES", {
        symbol: normalizedSymbol,
        row_index: index,
      })
    }
    if (!bar.date) {
      throw new EventStudyError(`Missing date in price row ${index} for ${normalizedSymbol}.`, "INVALID_PRICE_SERIES", {
        symbol: normalizedSymbol,
        row_index: index,
      })
    }
    if (!Number.isFinite(bar.adjusted_close) || bar.adjusted_close <= 0) {
      throw new EventStudyError(`Invalid adjusted close for ${normalizedSymbol} on ${bar.date}.`, "INVALID_PRICE_SERIES", {
        symbol: normalizedSymbol,
        date: bar.date,
        adjusted_close: bar.adjusted_close,
      })
    }
    const rowSymbol = normalizeSymbol(bar.symbol || normalizedSymbol)
    if (rowSymbol !== normalizedSymbol) {
      throw new EventStudyError(`Price row symbol mismatch for ${normalizedSymbol}: ${rowSymbol}.`, "INVALID_PRICE_SERIES", {
        expected: normalizedSymbol,
        actual: rowSymbol,
        date: bar.date,
      })
    }
    return {
      date: bar.date,
      close: bar.adjusted_close,
    }
  })

  let closeByDate: ReadonlyMap<string, number>
  try {
    closeByDate = createCloseMap(normalizedSymbol, rows)
  } catch (error) {
    throw EventStudyError.wrap(error, "INVALID_PRICE_SERIES")
  }

  let calendar: TradingCalendar
  try {
    calendar = createTradingCalendar([...closeByDate.keys()].toSorted((a, b) => a.localeCompare(b)))
  } catch (error) {
    throw EventStudyError.wrap(error, "INVALID_PRICE_SERIES")
  }

  return {
    calendar,
    closeByDate,
  }
}

function buildHistories(priceBySymbol: Record<string, PriceBar[]>): Map<string, SymbolHistory> {
  const out = new Map<string, SymbolHistory>()
  Object.entries(priceBySymbol).forEach(([symbol, bars]) => {
    out.set(normalizeSymbol(symbol), toSymbolHistory(symbol, bars))
  })
  return out
}

function historyFor(symbol: string, histories: Map<string, SymbolHistory>): SymbolHistory {
  const normalized = normalizeSymbol(symbol)
  const history = histories.get(normalized)
  if (!history) {
    throw new EventStudyError(`Missing required price series for ${normalized}.`, "MISSING_PRICE_SERIES", {
      symbol: normalized,
    })
  }
  return history
}

function closeAt(history: SymbolHistory, date: string, symbol: string) {
  const close = history.closeByDate.get(date)
  if (close === undefined) {
    throw new EventStudyError(`Missing close value for ${symbol} on ${date}.`, "MISSING_PRICE_SERIES", {
      symbol,
      date,
    })
  }
  if (!Number.isFinite(close) || close <= 0) {
    throw new EventStudyError(`Invalid close value for ${symbol} on ${date}.`, "INVALID_PRICE_SERIES", {
      symbol,
      date,
      close,
    })
  }
  return close
}

function ensureAlignmentPolicy(policy: NonTradingAlignment) {
  if (policy !== "next_session") {
    throw new EventStudyError(`Unsupported non-trading alignment policy: ${policy}`, "INVALID_EVENT_DATE", {
      policy,
    })
  }
}

export function computeEventWindowReturns(input: {
  events: PoliticalEvent[]
  anchor_mode: EventAnchorMode
  windows: number[]
  alignment: NonTradingAlignment
  price_by_symbol: Record<string, PriceBar[]>
}): EventWindowReturn[] {
  ensureAlignmentPolicy(input.alignment)
  const windows = normalizeWindowList(input.windows).toSorted((a, b) => a - b)
  const anchors = resolveAnchors(input.events, input.anchor_mode)
  const histories = buildHistories(input.price_by_symbol)
  const rows: EventWindowReturn[] = []

  for (const anchor of anchors) {
    const history = historyFor(anchor.ticker, histories)
    let alignment
    try {
      alignment = alignToNextSession(history.calendar, anchor.anchor_date)
    } catch (error) {
      throw EventStudyError.wrap(error, "ANCHOR_OUT_OF_RANGE")
    }

    for (const windowSessions of windows) {
      let end
      try {
        end = getSessionByOffset(history.calendar, alignment.alignedIndex, windowSessions)
      } catch (error) {
        throw EventStudyError.wrap(error, "WINDOW_OUT_OF_RANGE")
      }

      const startClose = closeAt(history, alignment.alignedDate, anchor.ticker)
      const endClose = closeAt(history, end.date, anchor.ticker)
      rows.push({
        event_id: anchor.event_id,
        ticker: anchor.ticker,
        anchor_kind: anchor.anchor_kind,
        anchor_date: anchor.anchor_date,
        aligned_anchor_date: alignment.alignedDate,
        window_sessions: windowSessions,
        start_close: startClose,
        end_close: endClose,
        forward_return_percent: forwardReturnPercent(startClose, endClose),
      })
    }
  }

  return rows
}

export function computeBenchmarkRelativeReturns(input: {
  base: EventWindowReturn[]
  benchmark_symbols: string[]
  alignment: NonTradingAlignment
  price_by_symbol: Record<string, PriceBar[]>
}): BenchmarkRelativeReturn[] {
  ensureAlignmentPolicy(input.alignment)
  if (!Array.isArray(input.benchmark_symbols) || input.benchmark_symbols.length === 0) {
    throw new EventStudyError("At least one benchmark symbol is required.", "MISSING_BENCHMARK_SERIES")
  }

  const histories = buildHistories(input.price_by_symbol)
  const out: BenchmarkRelativeReturn[] = []

  for (const row of input.base) {
    for (const benchmarkSymbol of input.benchmark_symbols) {
      const benchmarkHistory = historyFor(benchmarkSymbol, histories)
      let aligned
      try {
        aligned = alignToNextSession(benchmarkHistory.calendar, row.aligned_anchor_date)
      } catch (error) {
        throw EventStudyError.wrap(error, "ANCHOR_OUT_OF_RANGE")
      }
      let end
      try {
        end = getSessionByOffset(benchmarkHistory.calendar, aligned.alignedIndex, row.window_sessions)
      } catch (error) {
        throw EventStudyError.wrap(error, "WINDOW_OUT_OF_RANGE")
      }

      const benchmarkStart = closeAt(benchmarkHistory, aligned.alignedDate, benchmarkSymbol)
      const benchmarkEnd = closeAt(benchmarkHistory, end.date, benchmarkSymbol)
      const benchmarkReturn = forwardReturnPercent(benchmarkStart, benchmarkEnd)
      const excess = round(row.forward_return_percent - benchmarkReturn)

      out.push({
        ...row,
        benchmark_symbol: benchmarkSymbol,
        benchmark_return_percent: benchmarkReturn,
        excess_return_percent: excess,
        relative_return_percent: relativeReturnPercent(row.forward_return_percent, benchmarkReturn),
      })
    }
  }

  return out
}

export function runPoliticalEventStudyCore(input: {
  events: PoliticalEvent[]
  anchor_mode: EventAnchorMode
  windows: number[]
  alignment: NonTradingAlignment
  benchmark_mode: BenchmarkMode
  sector: string | null
  sector_to_etf?: Record<string, string>
  price_by_symbol: Record<string, PriceBar[]>
}): {
  event_window_returns: EventWindowReturn[]
  benchmark_relative_returns: BenchmarkRelativeReturn[]
  aggregates: AggregateWindow[]
  benchmark_selection: ReturnType<typeof selectBenchmarks>
} {
  const windows = normalizeWindowList(input.windows).toSorted((a, b) => a - b)
  if (windows.length === 0) {
    throw new EventStudyError("Backtest requires at least one forward window.", "WINDOW_OUT_OF_RANGE")
  }

  const benchmarkSelection = selectBenchmarks({
    mode: input.benchmark_mode,
    sector: input.sector,
    sector_to_etf: input.sector_to_etf,
  })

  const eventWindowReturns = computeEventWindowReturns({
    events: input.events,
    anchor_mode: input.anchor_mode,
    windows,
    alignment: input.alignment,
    price_by_symbol: input.price_by_symbol,
  })

  const benchmarkRelative = computeBenchmarkRelativeReturns({
    base: eventWindowReturns,
    benchmark_symbols: benchmarkSelection.symbols,
    alignment: input.alignment,
    price_by_symbol: input.price_by_symbol,
  })
  if (benchmarkRelative.length === 0) {
    throw new EventStudyError("No benchmark-relative rows were produced for this backtest run.", "MISSING_BENCHMARK_SERIES", {
      benchmarks: benchmarkSelection.symbols,
    })
  }

  return {
    event_window_returns: eventWindowReturns,
    benchmark_relative_returns: benchmarkRelative,
    aggregates: aggregateByWindow(benchmarkRelative),
    benchmark_selection: benchmarkSelection,
  }
}
