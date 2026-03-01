import { endpointMinimumPlan, type QuiverTier } from "../../finance/quiver-tier"
import type * as QuiverReport from "../../finance/providers/quiver-report"
import type { ActivitySummary, TickerSummary } from "./types"

function coverage(datasets: QuiverReport.QuiverReportDataset[]) {
    const attempted = datasets.filter((item) => item.status === "ok").length
    const skipped = datasets.filter((item) => item.status === "not_attempted_due_to_tier").length
    const failed = datasets.filter((item) => item.status === "failed").length
    return {
        attempted,
        skipped,
        failed,
    }
}

export { coverage }

function datasetLine(item: QuiverReport.QuiverReportDataset) {
    if (item.status === "ok") return `${item.label}: ok (${item.rows.length} rows)`
    if (item.status === "not_attempted_due_to_tier") {
        return `${item.label}: not_attempted_due_to_tier (requires ${endpointMinimumPlan(item.endpoint_tier)})`
    }
    return `${item.label}: failed (${item.error?.code ?? "NETWORK"}) ${item.error?.message ?? "request failed"}`
}

function activityLines(input: ActivitySummary) {
    if (input.rows.length === 0) return ["- No dated insider or government activity in the window."]

    const verb = {
        buy: "bought",
        sell: "sold",
        other: "recorded",
    } as const

    return input.rows.map((item) => {
        const size = item.shares ? `${item.shares.toLocaleString("en-US")} shares` : "activity"
        return `- ${item.date}: ${item.actor} ${verb[item.action]} ${size} of ${item.ticker} (${item.source})`
    })
}

export function toMarkdown(input: {
    generatedAt: string
    mode: "ticker" | "portfolio"
    tier: QuiverTier
    warnings: string[]
    global: QuiverReport.QuiverReportDataset[]
    ticker: TickerSummary[]
    totalCoverage: ReturnType<typeof coverage>
    activity: ActivitySummary
}) {
    const lines = [
        "# Insider Report",
        "",
        `Generated at: ${input.generatedAt}`,
        `Mode: ${input.mode}`,
        `Tier: ${input.tier}`,
        "",
        "## Executive Summary",
        `- Coverage: attempted ${input.totalCoverage.attempted}, skipped ${input.totalCoverage.skipped}, failed ${input.totalCoverage.failed}.`,
        `- Insider activity in last ${input.activity.window.days} days: ${input.activity.rows.length}.`,
        `- Global government datasets: ${input.global.filter((item) => item.status === "ok").reduce((acc, item) => acc + item.rows.length, 0)} rows across congress/senate/house feeds.`,
        `- Tickers analyzed: ${input.ticker.length}.`,
    ]

    if (input.warnings.length > 0) {
        lines.push("", "## Warnings")
        input.warnings.forEach((item) => lines.push(`- ${item}`))
    }

    lines.push("", "## Global Government Trading")
    input.global.forEach((item) => lines.push(`- ${datasetLine(item)}`))

    lines.push(
        "",
        `## Recent Insider / Government Activity (${input.activity.window.start} to ${input.activity.window.end})`,
        ...activityLines(input.activity),
    )

    input.ticker.forEach((item) => {
        lines.push("", `## ${item.ticker}`)
        lines.push(`- Insider rows: ${item.insiders_rows}`)
        lines.push(`- Government rows: ${item.government_rows}`)
        item.datasets.forEach((dataset) => lines.push(`- ${datasetLine(dataset)}`))
    })

    return lines.join("\n") + "\n"
}
