import {
  MissingPriceError,
  InvalidDateError,
  InvalidQuiverRowError,
  MissingRequiredFieldError,
  InvalidWindowError,
  PriceSeriesError,
  SessionAlignmentError,
  StatsComputationError,
  TradingCalendarError,
} from "./errors"

export const EVENT_STUDY_ERROR_CODE = [
  "MISSING_REQUIRED_ANCHOR_DATE",
  "INVALID_EVENT_DATE",
  "EMPTY_EVENT_SET",
  "DUPLICATE_EVENT_ID",
  "MISSING_PRICE_SERIES",
  "INVALID_PRICE_SERIES",
  "ANCHOR_OUT_OF_RANGE",
  "WINDOW_OUT_OF_RANGE",
  "MISSING_BENCHMARK_SERIES",
  "MISSING_BENCHMARK_MAPPING",
] as const

export type EventStudyErrorCode = (typeof EVENT_STUDY_ERROR_CODE)[number]

function inferCode(error: unknown): EventStudyErrorCode {
  if (error instanceof MissingRequiredFieldError) return "MISSING_REQUIRED_ANCHOR_DATE"
  if (error instanceof InvalidDateError) return "INVALID_EVENT_DATE"
  if (error instanceof InvalidQuiverRowError) return "INVALID_EVENT_DATE"
  if (error instanceof MissingPriceError) return "MISSING_PRICE_SERIES"
  if (error instanceof PriceSeriesError) return "INVALID_PRICE_SERIES"
  if (error instanceof TradingCalendarError) return "INVALID_PRICE_SERIES"
  if (error instanceof SessionAlignmentError) return "ANCHOR_OUT_OF_RANGE"
  if (error instanceof InvalidWindowError) return "WINDOW_OUT_OF_RANGE"
  if (error instanceof StatsComputationError) return "INVALID_PRICE_SERIES"
  return "INVALID_EVENT_DATE"
}

export class EventStudyError extends Error {
  constructor(
    message: string,
    public readonly code: EventStudyErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "EventStudyError"
  }

  static wrap(error: unknown, fallbackCode?: EventStudyErrorCode): EventStudyError {
    if (error instanceof EventStudyError) return error
    if (error instanceof Error) {
      return new EventStudyError(error.message, fallbackCode ?? inferCode(error), {
        cause: error.name,
      })
    }
    return new EventStudyError(String(error), fallbackCode ?? inferCode(error))
  }
}
