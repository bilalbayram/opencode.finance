import {
    EventStudyError,
    type PriceBar,
} from "../../finance/political-backtest"

const YAHOO_BASE = "https://query1.finance.yahoo.com"

function asText(input: unknown) {
    if (input === null || input === undefined) return ""
    return String(input)
}

function toDate(input: string) {
    return new Date(`${input}T00:00:00Z`)
}

function addDays(input: Date, days: number) {
    const value = new Date(input)
    value.setUTCDate(value.getUTCDate() + days)
    return value
}

export function parseChartBars(input: { symbol: string; payload: Record<string, unknown> }): PriceBar[] {
    const chart = input.payload.chart as Record<string, unknown> | undefined
    const result = ((chart?.result as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
    const timestamps = (result.timestamp as unknown[] | undefined) ?? []
    const indicators = (result.indicators as Record<string, unknown> | undefined) ?? {}
    const adjusted = (
        ((indicators.adjclose as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined) ?? {}
    ).adjclose as Array<number | null | undefined> | undefined
    const closes = (
        ((indicators.quote as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined) ?? {}
    ).close as Array<number | null | undefined> | undefined

    if (!Array.isArray(timestamps) || timestamps.length === 0) {
        throw new EventStudyError(`No usable price rows returned for ${input.symbol}.`, "MISSING_PRICE_SERIES", {
            symbol: input.symbol,
        })
    }

    const rows: PriceBar[] = []
    for (const [index, rawTimestamp] of timestamps.entries()) {
        if (typeof rawTimestamp !== "number" || !Number.isFinite(rawTimestamp)) {
            throw new EventStudyError(`Malformed timestamp in Yahoo series for ${input.symbol} at index ${index}.`, "INVALID_PRICE_SERIES", {
                symbol: input.symbol,
                row_index: index,
                timestamp: rawTimestamp,
            })
        }
        const timestamp = rawTimestamp
        const date = new Date(timestamp * 1000)
        if (Number.isNaN(date.getTime())) {
            throw new EventStudyError(`Invalid timestamp date conversion for ${input.symbol} at index ${index}.`, "INVALID_PRICE_SERIES", {
                symbol: input.symbol,
                row_index: index,
                timestamp,
            })
        }
        const price = adjusted?.[index] ?? closes?.[index]
        if (!Number.isFinite(price) || (price ?? 0) <= 0) {
            throw new EventStudyError(`Malformed price in Yahoo series for ${input.symbol} at index ${index}.`, "INVALID_PRICE_SERIES", {
                symbol: input.symbol,
                row_index: index,
                adjusted_close: adjusted?.[index],
                close: closes?.[index],
            })
        }
        rows.push({
            symbol: input.symbol,
            date: date.toISOString().slice(0, 10),
            adjusted_close: Number(price),
        })
    }

    if (rows.length === 0) {
        throw new EventStudyError(`No usable price rows returned for ${input.symbol}.`, "MISSING_PRICE_SERIES", {
            symbol: input.symbol,
        })
    }

    return rows
}

export async function fetchYahooDailyBars(input: {
    symbol: string
    startDate: string
    endDate: string
    signal?: AbortSignal
}): Promise<PriceBar[]> {
    const start = Math.floor(toDate(input.startDate).getTime() / 1000)
    const end = Math.floor(addDays(toDate(input.endDate), 1).getTime() / 1000)
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(input.symbol)}?period1=${start}&period2=${end}&interval=1d&events=history&includeAdjustedClose=true`
    const response = await fetch(url, {
        signal: input.signal,
        headers: {
            Accept: "application/json",
            "User-Agent": "opencode-finance/1.0",
        },
    })
    if (!response.ok) {
        const body = await response.text()
        throw new EventStudyError(
            `Failed to load market history for ${input.symbol} from Yahoo (${response.status}): ${body || "request failed"}`,
            "MISSING_PRICE_SERIES",
            {
                symbol: input.symbol,
                status: response.status,
            },
        )
    }
    const payload = (await response.json()) as Record<string, unknown>
    return parseChartBars({ symbol: input.symbol, payload })
}

export async function fetchSector(input: { ticker: string; signal?: AbortSignal }): Promise<string | null> {
    const modules = "assetProfile"
    const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(input.ticker)}?modules=${encodeURIComponent(modules)}`
    const response = await fetch(url, {
        signal: input.signal,
        headers: {
            Accept: "application/json",
            "User-Agent": "opencode-finance/1.0",
        },
    }).catch(() => undefined)

    if (!response?.ok) return null
    const payload = (await response.json()) as Record<string, unknown>
    const row = (((payload.quoteSummary as Record<string, unknown> | undefined)?.result as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
    const profile = (row.assetProfile as Record<string, unknown> | undefined) ?? {}
    const sector = asText(profile.sector).trim()
    return sector || null
}
