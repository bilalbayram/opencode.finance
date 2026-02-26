import { InvalidDateError, SessionAlignmentError, TradingCalendarError } from "./errors"
import type { IsoDate, TradingCalendar, TradingSessionAlignment } from "./types"

const MS_PER_DAY = 86_400_000
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toEpochDay(date: IsoDate, field: string, details?: Record<string, unknown>) {
  if (!ISO_DATE_RE.test(date)) throw new InvalidDateError(field, date, details)
  const epochMs = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(epochMs)) throw new InvalidDateError(field, date, details)
  const normalized = new Date(epochMs).toISOString().slice(0, 10)
  if (normalized !== date) throw new InvalidDateError(field, date, details)
  return Math.floor(epochMs / MS_PER_DAY)
}

function ensureCalendar(calendar: TradingCalendar) {
  if (calendar.sessions.length === 0) {
    throw new TradingCalendarError("Trading calendar cannot be empty")
  }
  if (calendar.sessions.length !== calendar.sessionEpochDays.length) {
    throw new TradingCalendarError("Trading calendar session and epoch lengths do not match", {
      sessions: calendar.sessions.length,
      epochDays: calendar.sessionEpochDays.length,
    })
  }
}

export function createTradingCalendar(sessions: readonly IsoDate[]): TradingCalendar {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new TradingCalendarError("Trading sessions are required")
  }

  const normalizedSessions: IsoDate[] = []
  const epochDays: number[] = []
  const indexByDate = new Map<IsoDate, number>()

  let previous: number | null = null
  sessions.forEach((session, index) => {
    const epochDay = toEpochDay(session, "sessionDate", { index })
    if (previous !== null && epochDay <= previous) {
      throw new TradingCalendarError("Trading sessions must be strictly increasing and unique", {
        previous: sessions[index - 1],
        current: session,
        index,
      })
    }
    if (indexByDate.has(session)) {
      throw new TradingCalendarError(`Duplicate session date: ${session}`, { index })
    }
    normalizedSessions.push(session)
    epochDays.push(epochDay)
    indexByDate.set(session, index)
    previous = epochDay
  })

  return {
    sessions: Object.freeze(normalizedSessions),
    sessionEpochDays: Object.freeze(epochDays),
    sessionIndexByDate: indexByDate,
  }
}

export function alignToNextSession(calendar: TradingCalendar, inputDate: IsoDate): TradingSessionAlignment {
  ensureCalendar(calendar)
  const targetDay = toEpochDay(inputDate, "inputDate")
  const firstEpochDay = calendar.sessionEpochDays[0]
  if (firstEpochDay === undefined) {
    throw new TradingCalendarError("Trading calendar cannot be empty")
  }
  if (targetDay < firstEpochDay) {
    throw new SessionAlignmentError(`Input date predates first available trading session: ${inputDate}`, {
      inputDate,
      firstSession: calendar.sessions[0],
    })
  }

  let low = 0
  let high = calendar.sessionEpochDays.length - 1
  let resolvedIndex = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const day = calendar.sessionEpochDays[mid]
    if (day >= targetDay) {
      resolvedIndex = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  if (resolvedIndex < 0) {
    throw new SessionAlignmentError(`No trading session exists on or after ${inputDate}`, {
      inputDate,
      lastSession: calendar.sessions[calendar.sessions.length - 1],
    })
  }

  const alignedDate = calendar.sessions[resolvedIndex]
  if (!alignedDate) {
    throw new TradingCalendarError("Aligned session index resolved to undefined date", {
      resolvedIndex,
      sessionCount: calendar.sessions.length,
    })
  }

  return {
    inputDate,
    alignedDate,
    alignedIndex: resolvedIndex,
    shifted: alignedDate !== inputDate,
  }
}

export function getSessionByOffset(calendar: TradingCalendar, startIndex: number, offset: number) {
  ensureCalendar(calendar)
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= calendar.sessions.length) {
    throw new SessionAlignmentError(`Invalid session start index: ${startIndex}`, {
      startIndex,
      sessionCount: calendar.sessions.length,
    })
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SessionAlignmentError(`Invalid session offset: ${offset}`, { offset })
  }

  const resolvedIndex = startIndex + offset
  if (resolvedIndex >= calendar.sessions.length) {
    throw new SessionAlignmentError(`Session offset exceeds available calendar range: start ${startIndex} + ${offset}`, {
      startIndex,
      offset,
      sessionCount: calendar.sessions.length,
    })
  }

  const date = calendar.sessions[resolvedIndex]
  if (!date) {
    throw new TradingCalendarError("Resolved session index points to undefined date", {
      resolvedIndex,
      sessionCount: calendar.sessions.length,
    })
  }

  return {
    index: resolvedIndex,
    date,
  }
}
