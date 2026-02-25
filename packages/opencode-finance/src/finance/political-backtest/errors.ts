export class PoliticalBacktestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "PoliticalBacktestError"
  }
}

export class MissingRequiredFieldError extends PoliticalBacktestError {
  constructor(field: string, details?: Record<string, unknown>) {
    super(`Missing required field: ${field}`, "MISSING_REQUIRED_FIELD", details)
    this.name = "MissingRequiredFieldError"
  }
}

export class InvalidDateError extends PoliticalBacktestError {
  constructor(field: string, value: unknown, details?: Record<string, unknown>) {
    super(`Invalid date in field ${field}: ${String(value)}`, "INVALID_DATE", details)
    this.name = "InvalidDateError"
  }
}

export class InvalidQuiverRowError extends PoliticalBacktestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "INVALID_QUIVER_ROW", details)
    this.name = "InvalidQuiverRowError"
  }
}

export class TradingCalendarError extends PoliticalBacktestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "TRADING_CALENDAR_ERROR", details)
    this.name = "TradingCalendarError"
  }
}

export class SessionAlignmentError extends PoliticalBacktestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "SESSION_ALIGNMENT_ERROR", details)
    this.name = "SessionAlignmentError"
  }
}

export class InvalidWindowError extends PoliticalBacktestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "INVALID_WINDOW", details)
    this.name = "InvalidWindowError"
  }
}

export class PriceSeriesError extends PoliticalBacktestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PRICE_SERIES_ERROR", details)
    this.name = "PriceSeriesError"
  }
}

export class MissingPriceError extends PriceSeriesError {
  constructor(symbol: string, date: string, details?: Record<string, unknown>) {
    super(`Missing close price for ${symbol} on ${date}`, details)
    this.name = "MissingPriceError"
  }
}

export class StatsComputationError extends PoliticalBacktestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "STATS_COMPUTATION_ERROR", details)
    this.name = "StatsComputationError"
  }
}
