export type Severity = "low" | "medium" | "high"
export type Direction = "positive" | "negative"

export type DetectionThresholds = {
  significance: number
  medium: number
  high: number
}

export type RawObservation = {
  date: string
  value: number
  row_count: number
}

export type ParsedDataset = {
  metric_key: string
  metric_label: string
  date_key: string
  observations: RawObservation[]
}

export type RobustStats = {
  center: number
  dispersion: number
  median: number
  mad: number
  iqr: number
}

export type AnomalyRecord = {
  key: string
  ticker: string
  metric_key: string
  metric_label: string
  date: string
  current_value: number
  baseline_center: number
  baseline_dispersion: number
  z_score: number
  abs_z_score: number
  direction: Direction
  severity: Severity
}

export type TransitionState = "new" | "persisted" | "severity_change" | "resolved"

export type TransitionRecord = {
  state: TransitionState
  key: string
  current?: AnomalyRecord
  previous?: AnomalyRecord
}

export type TickerAnalysis = {
  ticker: string
  metric_key: string
  metric_label: string
  date_key: string
  lookback_days: number
  sample_count: number
  baseline_count: number
  current_date: string
  current_value: number
  baseline_center: number
  baseline_dispersion: number
  z_score: number
  abs_z_score: number
  direction: Direction
  significant: boolean
  severity?: Severity
  anomaly_key: string
  robust_stats: {
    median: number
    mad: number
    iqr: number
  }
}

const EPSILON = 1e-9
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/
const DATE_CANDIDATES = [
  "date",
  "datetime",
  "timestamp",
  "reportdate",
  "report_date",
  "trade_date",
  "tradedate",
  "asof",
  "as_of",
]

const METRIC_PATTERNS: Array<{ regex: RegExp; weight: number }> = [
  { regex: /off[\s_-]*exchange.*(ratio|percent|pct|share)/i, weight: 600 },
  { regex: /dark[\s_-]*pool.*(ratio|percent|pct|share)/i, weight: 600 },
  { regex: /off[\s_-]*exchange.*(volume|shares|amount|notional)/i, weight: 500 },
  { regex: /dark[\s_-]*pool.*(volume|shares|amount|notional)/i, weight: 500 },
  { regex: /(off[\s_-]*exchange|dark[\s_-]*pool)/i, weight: 400 },
  { regex: /(volume|shares|amount|notional|value|ratio|percent|pct)/i, weight: 150 },
]

export function normalizeThresholds(input: {
  significance: number
  medium?: number
  high?: number
}): DetectionThresholds {
  if (!Number.isFinite(input.significance) || input.significance <= 0) {
    throw new Error("significance_threshold must be a positive number")
  }

  const significance = input.significance
  const medium = input.medium ?? significance * 1.5
  const high = input.high ?? significance * 2

  if (!Number.isFinite(medium) || medium < significance) {
    throw new Error("severity_medium must be >= significance_threshold")
  }

  if (!Number.isFinite(high) || high < medium) {
    throw new Error("severity_high must be >= severity_medium")
  }

  return {
    significance,
    medium,
    high,
  }
}

function asText(input: unknown) {
  if (input === null || input === undefined) return ""
  return String(input).trim()
}

function toDate(input: unknown) {
  const text = asText(input)
  if (!text) return ""
  const value = new Date(text)
  if (!Number.isFinite(value.getTime())) return ""
  return value.toISOString().slice(0, 10)
}

function toNumber(input: unknown) {
  if (typeof input === "number") return Number.isFinite(input) ? input : Number.NaN
  const text = asText(input)
  if (!text) return Number.NaN
  const compact = text.replace(/,/g, "").replace(/%$/, "")
  if (!NUMERIC_RE.test(compact)) return Number.NaN
  const value = Number(compact)
  return Number.isFinite(value) ? value : Number.NaN
}

function uniqueKeys(rows: Record<string, unknown>[]) {
  const out = new Set<string>()
  rows.forEach((row) => Object.keys(row).forEach((key) => out.add(key)))
  return [...out]
}

function numericCount(rows: Record<string, unknown>[], key: string) {
  let count = 0
  for (const row of rows) {
    const value = toNumber(row[key])
    if (Number.isFinite(value)) count += 1
  }
  return count
}

function dateCount(rows: Record<string, unknown>[], key: string) {
  let count = 0
  for (const row of rows) {
    if (toDate(row[key])) count += 1
  }
  return count
}

function findDateKey(rows: Record<string, unknown>[]) {
  const keys = uniqueKeys(rows)
  let best = ""
  let bestScore = -1

  for (const key of keys) {
    const normalized = key.toLowerCase()
    const preferred = DATE_CANDIDATES.some((candidate) => normalized === candidate || normalized.includes(candidate))
    const count = dateCount(rows, key)
    if (count === 0) continue
    const score = (preferred ? 10_000 : 0) + count
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }

  if (!best) throw new Error("off-exchange dataset is missing a parseable date column")
  return best
}

function metricWeight(key: string) {
  for (const pattern of METRIC_PATTERNS) {
    if (pattern.regex.test(key)) return pattern.weight
  }
  return 0
}

function findMetricKey(rows: Record<string, unknown>[]) {
  const keys = uniqueKeys(rows)
  let best = ""
  let bestScore = -1

  for (const key of keys) {
    const count = numericCount(rows, key)
    if (count === 0) continue
    const weight = metricWeight(key)
    if (weight <= 0) continue
    const score = weight * 1_000 + count
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }

  if (!best) {
    throw new Error("off-exchange dataset does not include a numeric metric usable for anomaly detection")
  }

  return best
}

export function parseOffExchangeDataset(rows: Record<string, unknown>[]): ParsedDataset {
  if (rows.length === 0) {
    throw new Error("off-exchange dataset is empty")
  }

  const dateKey = findDateKey(rows)
  const metricKey = findMetricKey(rows)

  const grouped = new Map<string, { sum: number; count: number }>()
  for (const row of rows) {
    const date = toDate(row[dateKey])
    if (!date) continue
    const value = toNumber(row[metricKey])
    if (!Number.isFinite(value)) continue
    const current = grouped.get(date) ?? { sum: 0, count: 0 }
    current.sum += value
    current.count += 1
    grouped.set(date, current)
  }

  const observations = [...grouped.entries()]
    .map(([date, stats]) => ({
      date,
      value: stats.sum / stats.count,
      row_count: stats.count,
    }))
    .filter((item) => Number.isFinite(item.value))
    .toSorted((a, b) => a.date.localeCompare(b.date))

  if (observations.length === 0) {
    throw new Error("off-exchange dataset could not be normalized into dated numeric observations")
  }

  return {
    metric_key: metricKey,
    metric_label: metricKey,
    date_key: dateKey,
    observations,
  }
}

function mean(input: number[]) {
  if (input.length === 0) return Number.NaN
  return input.reduce((acc, value) => acc + value, 0) / input.length
}

function stddev(input: number[]) {
  if (input.length < 2) return 0
  const center = mean(input)
  const variance = input.reduce((acc, value) => acc + (value - center) ** 2, 0) / (input.length - 1)
  return Math.sqrt(variance)
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]
  const clamped = Math.min(1, Math.max(0, q))
  const pos = (sorted.length - 1) * clamped
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower]
  const fraction = pos - lower
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction
}

function median(input: number[]) {
  const sorted = [...input].sort((a, b) => a - b)
  return quantile(sorted, 0.5)
}

export function computeRobustStats(values: number[]): RobustStats {
  if (values.length === 0) {
    throw new Error("cannot compute baseline from empty samples")
  }

  const sorted = [...values].sort((a, b) => a - b)
  const med = quantile(sorted, 0.5)
  const abs = sorted.map((value) => Math.abs(value - med)).sort((a, b) => a - b)
  const mad = quantile(abs, 0.5)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1

  let dispersion = 1.4826 * mad
  if (!Number.isFinite(dispersion) || dispersion <= EPSILON) {
    dispersion = iqr / 1.349
  }
  if (!Number.isFinite(dispersion) || dispersion <= EPSILON) {
    dispersion = stddev(sorted)
  }
  if (!Number.isFinite(dispersion) || dispersion <= EPSILON) {
    throw new Error("baseline dispersion resolved to zero; dataset cannot support significance testing")
  }

  return {
    center: med,
    dispersion,
    median: med,
    mad,
    iqr,
  }
}

function severity(input: number, thresholds: DetectionThresholds): Severity {
  if (input >= thresholds.high) return "high"
  if (input >= thresholds.medium) return "medium"
  return "low"
}

function startDateFromLookback(latestDate: string, lookbackDays: number) {
  const date = new Date(`${latestDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - (lookbackDays - 1))
  return date.toISOString().slice(0, 10)
}

export function analyzeTickerOffExchange(input: {
  ticker: string
  rows: Record<string, unknown>[]
  lookback_days: number
  min_samples: number
  thresholds: DetectionThresholds
}): TickerAnalysis {
  if (!Number.isInteger(input.lookback_days) || input.lookback_days < 2) {
    throw new Error("lookback_days must be an integer >= 2")
  }

  if (!Number.isInteger(input.min_samples) || input.min_samples < 2) {
    throw new Error("min_samples must be an integer >= 2")
  }

  const parsed = parseOffExchangeDataset(input.rows)
  const latestDate = parsed.observations[parsed.observations.length - 1]?.date
  if (!latestDate) {
    throw new Error(`No dated observations were found for ${input.ticker}`)
  }

  const lookbackStart = startDateFromLookback(latestDate, input.lookback_days)
  const scoped = parsed.observations.filter((item) => item.date >= lookbackStart)

  if (scoped.length < input.min_samples + 1) {
    throw new Error(
      `Insufficient off-exchange sample count for ${input.ticker}. Required at least ${input.min_samples + 1} dated points in the configured lookback window, found ${scoped.length}.`,
    )
  }

  const current = scoped[scoped.length - 1]
  const baseline = scoped.slice(0, -1)

  if (baseline.length < input.min_samples) {
    throw new Error(
      `Insufficient baseline samples for ${input.ticker}. Required at least ${input.min_samples}, found ${baseline.length}.`,
    )
  }

  const stats = computeRobustStats(baseline.map((item) => item.value))
  const zScore = (current.value - stats.center) / stats.dispersion
  const absZ = Math.abs(zScore)
  const direction: Direction = zScore >= 0 ? "positive" : "negative"
  const significant = absZ >= input.thresholds.significance

  return {
    ticker: input.ticker,
    metric_key: parsed.metric_key,
    metric_label: parsed.metric_label,
    date_key: parsed.date_key,
    lookback_days: input.lookback_days,
    sample_count: scoped.length,
    baseline_count: baseline.length,
    current_date: current.date,
    current_value: current.value,
    baseline_center: stats.center,
    baseline_dispersion: stats.dispersion,
    z_score: zScore,
    abs_z_score: absZ,
    direction,
    significant,
    severity: significant ? severity(absZ, input.thresholds) : undefined,
    anomaly_key: `${input.ticker}:${parsed.metric_key}`,
    robust_stats: {
      median: stats.median,
      mad: stats.mad,
      iqr: stats.iqr,
    },
  }
}

export function toAnomalyRecord(input: TickerAnalysis): AnomalyRecord | undefined {
  if (!input.significant || !input.severity) return
  return {
    key: input.anomaly_key,
    ticker: input.ticker,
    metric_key: input.metric_key,
    metric_label: input.metric_label,
    date: input.current_date,
    current_value: input.current_value,
    baseline_center: input.baseline_center,
    baseline_dispersion: input.baseline_dispersion,
    z_score: input.z_score,
    abs_z_score: input.abs_z_score,
    direction: input.direction,
    severity: input.severity,
  }
}

export function classifyAnomalyTransitions(current: AnomalyRecord[], previous: AnomalyRecord[]): TransitionRecord[] {
  const previousByKey = new Map(previous.map((item) => [item.key, item]))
  const currentByKey = new Map(current.map((item) => [item.key, item]))

  const transitions: TransitionRecord[] = []

  for (const item of current) {
    const prior = previousByKey.get(item.key)
    if (!prior) {
      transitions.push({ state: "new", key: item.key, current: item })
      continue
    }

    if (prior.severity !== item.severity) {
      transitions.push({
        state: "severity_change",
        key: item.key,
        current: item,
        previous: prior,
      })
      continue
    }

    transitions.push({
      state: "persisted",
      key: item.key,
      current: item,
      previous: prior,
    })
  }

  for (const item of previous) {
    if (currentByKey.has(item.key)) continue
    transitions.push({ state: "resolved", key: item.key, previous: item })
  }

  return transitions
}
