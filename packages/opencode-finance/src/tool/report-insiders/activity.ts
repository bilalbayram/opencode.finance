import { endpointMinimumPlan } from "../../finance/quiver-tier"
import type * as QuiverReport from "../../finance/providers/quiver-report"
import type { ActivitySummary, ActivityWindow, InsiderActivity, TickerSummary } from "./types"

function asText(input: unknown) {
    if (input === null || input === undefined) return ""
    return String(input)
}

function asNumber(input: unknown) {
    const value = asText(input).replace(/[^0-9.-]/g, "").trim()
    if (!value) return 0
    const output = Number(value)
    if (!Number.isFinite(output)) return 0
    return output
}

function toNumber(input: unknown): number {
    return asNumber(input)
}

function asDate(input: unknown) {
    const text = asText(input).trim()
    const value = new Date(text)
    if (Number.isNaN(value.getTime())) return ""
    return value.toISOString().slice(0, 10)
}

function fieldNames(row: Record<string, unknown>) {
    return new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
}

function pick(row: Record<string, unknown>, candidates: string[]) {
    for (const key of candidates) if (row[key] !== undefined && row[key] !== null && asText(row[key]).trim()) return asText(row[key])

    const normalized = fieldNames(row)
    for (const key of candidates) {
        const value = normalized.get(key.toLowerCase())
        if (value !== undefined && value !== null && asText(value).trim()) return asText(value)
    }
    return ""
}

function formatActor(row: Record<string, unknown>) {
    return (
        pick(row, ["name", "owner", "insider_name", "insidername", "person", "representative", "senator", "member", "holder", "investor", "trader", "lobbyist"]) ||
        "Unknown actor"
    )
}

function formatTicker(row: Record<string, unknown>, fallback: string) {
    return (pick(row, ["ticker", "symbol", "security", "company"]) || fallback || "N/A").toUpperCase()
}

function formatDate(row: Record<string, unknown>) {
    return asDate(
        pick(row, [
            "date",
            "transactiondate",
            "filed",
            "filed_at",
            "fileddate",
            "reportdate",
            "disclosedate",
            "tradedate",
        ]),
    )
}

function formatShares(row: Record<string, unknown>) {
    const text = pick(row, ["shares_traded", "shareschanged", "changeinshares", "shares", "share", "quantity", "amount"])
    return Math.abs(toNumber(text))
}

function formatAction(row: Record<string, unknown>) {
    return transactionKind(pick(row, ["transactiontype", "transaction", "type", "acquireddisposed"]))
}

export function transactionKind(input: unknown): "buy" | "sell" | "other" {
    const text = asText(input).toLowerCase()
    if (text.includes("buy") || text.includes("purchase") || text.includes("acquired")) return "buy"
    if (text.includes("sell") || text.includes("dispose")) return "sell"
    return "other"
}

export function formatActivityWindow(end: string, days = 7) {
    const endDate = new Date(end)
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - (days - 1))
    return {
        start: startDate.toISOString().slice(0, 10),
        end: endDate.toISOString().slice(0, 10),
        days,
    } satisfies ActivityWindow
}

export function parseActivity(input: {
    dataset: QuiverReport.QuiverReportDataset
    fallbackTicker: string
    window: ActivityWindow
}) {
    if (input.dataset.status !== "ok") return [] as InsiderActivity[]

    return input.dataset.rows
        .map((row) => {
            const date = formatDate(row)
            if (!date) return undefined
            const shares = formatShares(row)
            return {
                actor: formatActor(row),
                action: formatAction(row),
                shares,
                ticker: formatTicker(row, input.fallbackTicker),
                date,
                source: input.dataset.label,
            } satisfies InsiderActivity
        })
        .filter((item): item is InsiderActivity => Boolean(item))
        .filter((item) => {
            const value = new Date(item.date)
            if (Number.isNaN(value.getTime())) return false
            const start = new Date(input.window.start)
            const end = new Date(input.window.end)
            return value >= start && value <= end
        })
}

export function summarizeActivity(input: {
    global: QuiverReport.QuiverReportDataset[]
    tickers: TickerSummary[]
    window: ActivityWindow
}) {
    const rows = [
        ...input.global.flatMap((dataset) => parseActivity({ dataset, fallbackTicker: "", window: input.window })),
        ...input.tickers.flatMap((ticker) =>
            ticker.datasets.flatMap((dataset) => parseActivity({ dataset, fallbackTicker: ticker.ticker, window: input.window })),
        ),
    ]

    const seen = new Set<string>()
    const deduped = rows.filter((item) => {
        const key = `${item.date}|${item.actor}|${item.action}|${item.shares}|${item.ticker}|${item.source}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })

    return {
        window: input.window,
        rows: deduped.toSorted((a, b) => b.date.localeCompare(a.date)),
    } satisfies ActivitySummary
}

export function summarizeInsiders(rows: Record<string, unknown>[]) {
    const stats = rows.reduce<{ buy: number; sell: number; other: number; net: number }>(
        (acc, row) => {
            const kind = transactionKind(row.TransactionType ?? row.Transaction ?? row.Type ?? row.AcquiredDisposed)
            const shares = toNumber(row.SharesTraded ?? row.SharesChanged ?? row.ChangeInShares ?? row.Shares)
            if (kind === "buy") {
                acc.buy += 1
                acc.net += Math.abs(shares)
            }
            if (kind === "sell") {
                acc.sell += 1
                acc.net -= Math.abs(shares)
            }
            if (kind === "other") acc.other += 1
            return acc
        },
        { buy: 0, sell: 0, other: 0, net: 0 },
    )
    return {
        transactions: rows.length,
        buy: stats.buy,
        sell: stats.sell,
        other: stats.other,
        net_share_delta: stats.net,
    }
}
