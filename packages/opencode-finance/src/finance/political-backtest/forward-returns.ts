import { InvalidDateError, InvalidWindowError, MissingPriceError, PriceSeriesError, SessionAlignmentError } from "./errors"
import { getSessionByOffset } from "./trading-calendar"
import type { CloseByDate, ComputeForwardReturnsInput, DailyClose, IsoDate, EventForwardReturnSet, WindowForwardReturn } from "./types"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function ensureIsoDate(value: IsoDate, field: string, details?: Record<string, unknown>) {
  if (!ISO_DATE_RE.test(value)) throw new InvalidDateError(field, value, details)
  const epochMs = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(epochMs)) throw new InvalidDateError(field, value, details)
  const normalized = new Date(epochMs).toISOString().slice(0, 10)
  if (normalized !== value) throw new InvalidDateError(field, value, details)
}

function normalizeSymbol(input: string, field: string) {
  const symbol = input.trim().toUpperCase()
  if (!symbol) {
    throw new PriceSeriesError(`Missing required symbol for ${field}`)
  }
  return symbol
}

function readClose(prices: CloseByDate, symbol: string, date: IsoDate) {
  const value = prices.get(date)
  if (value === undefined) {
    throw new MissingPriceError(symbol, date)
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new PriceSeriesError(`Invalid close price for ${symbol} on ${date}: ${String(value)}`, {
      symbol,
      date,
      value,
    })
  }
  return value
}

function computeSimpleReturn(entry: number, exit: number) {
  if (!Number.isFinite(entry) || entry <= 0) throw new PriceSeriesError(`Entry close must be a positive number: ${String(entry)}`)
  if (!Number.isFinite(exit) || exit <= 0) throw new PriceSeriesError(`Exit close must be a positive number: ${String(exit)}`)
  return exit / entry - 1
}

export function normalizeWindowList(windows: readonly number[]) {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new InvalidWindowError("At least one forward-return window is required")
  }
  const normalized: number[] = []
  const seen = new Set<number>()

  windows.forEach((window) => {
    if (!Number.isInteger(window) || window <= 0) {
      throw new InvalidWindowError(`Window must be a positive integer: ${String(window)}`, { window })
    }
    if (seen.has(window)) {
      throw new InvalidWindowError(`Duplicate window is not allowed: ${window}`, { window })
    }
    seen.add(window)
    normalized.push(window)
  })

  return normalized
}

export function createCloseMap(symbol: string, rows: readonly DailyClose[]): CloseByDate {
  const normalizedSymbol = normalizeSymbol(symbol, "createCloseMap")
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PriceSeriesError(`Price series for ${normalizedSymbol} cannot be empty`)
  }

  const map = new Map<IsoDate, number>()
  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new PriceSeriesError(`Invalid price row at index ${rowIndex}`, {
        symbol: normalizedSymbol,
        rowIndex,
      })
    }

    const date = String(row.date)
    ensureIsoDate(date, "priceDate", { symbol: normalizedSymbol, rowIndex })
    if (map.has(date)) {
      throw new PriceSeriesError(`Duplicate price row for ${normalizedSymbol} on ${date}`, {
        symbol: normalizedSymbol,
        date,
      })
    }

    if (!Number.isFinite(row.close) || row.close <= 0) {
      throw new PriceSeriesError(`Invalid close price for ${normalizedSymbol} on ${date}: ${String(row.close)}`, {
        symbol: normalizedSymbol,
        date,
      })
    }
    map.set(date, row.close)
  })

  return map
}

export function computeForwardReturns(input: ComputeForwardReturnsInput): EventForwardReturnSet {
  const symbol = normalizeSymbol(input.symbol, "computeForwardReturns")
  ensureIsoDate(input.anchorDate, "anchorDate", { eventId: input.eventId, symbol })
  const windows = normalizeWindowList(input.windows)

  if (!Number.isInteger(input.alignment.alignedIndex) || input.alignment.alignedIndex < 0) {
    throw new SessionAlignmentError(`Invalid aligned index: ${String(input.alignment.alignedIndex)}`, {
      eventId: input.eventId,
      symbol,
      alignedIndex: input.alignment.alignedIndex,
    })
  }

  const startDate = input.calendar.sessions[input.alignment.alignedIndex]
  if (!startDate) {
    throw new SessionAlignmentError(`Aligned index ${input.alignment.alignedIndex} is outside calendar range`, {
      eventId: input.eventId,
      symbol,
      alignedIndex: input.alignment.alignedIndex,
      sessionCount: input.calendar.sessions.length,
    })
  }
  if (startDate !== input.alignment.alignedDate) {
    throw new SessionAlignmentError("Alignment does not match calendar session at aligned index", {
      eventId: input.eventId,
      symbol,
      expected: startDate,
      actual: input.alignment.alignedDate,
      alignedIndex: input.alignment.alignedIndex,
    })
  }

  const symbolEntryClose = readClose(input.symbolCloses, symbol, startDate)
  const spyEntryClose = readClose(input.spyCloses, "SPY", startDate)

  const results: WindowForwardReturn[] = windows.map((windowSessions) => {
    const exitSession = getSessionByOffset(input.calendar, input.alignment.alignedIndex, windowSessions)
    const symbolExitClose = readClose(input.symbolCloses, symbol, exitSession.date)
    const spyExitClose = readClose(input.spyCloses, "SPY", exitSession.date)

    const symbolReturn = computeSimpleReturn(symbolEntryClose, symbolExitClose)
    const spyReturn = computeSimpleReturn(spyEntryClose, spyExitClose)
    return {
      windowSessions,
      startDate,
      endDate: exitSession.date,
      symbolReturn,
      spyReturn,
      relativeReturn: symbolReturn - spyReturn,
    }
  })

  return {
    eventId: input.eventId,
    symbol,
    anchorDate: input.anchorDate,
    entryDate: startDate,
    returns: results,
  }
}
