import { quiverPlanLabel, type QuiverTier } from "../../finance/quiver-tier"
import type { TransitionRecord } from "../../finance/darkpool-anomaly"
import type { TickerRun } from "./types"

export function formatNumber(input: number, digits = 4) {
    if (!Number.isFinite(input)) return "unknown"
    return input.toLocaleString("en-US", {
        maximumFractionDigits: digits,
    })
}

export function transitionCounts(input: TransitionRecord[]) {
    return {
        new: input.filter((item) => item.state === "new").length,
        persisted: input.filter((item) => item.state === "persisted").length,
        severity_change: input.filter((item) => item.state === "severity_change").length,
        resolved: input.filter((item) => item.state === "resolved").length,
    }
}

function stateByCurrentKey(input: TransitionRecord[]) {
    const map = new Map<string, TransitionRecord["state"]>()
    for (const item of input) {
        if (!item.current) continue
        map.set(item.current.key, item.state)
    }
    return map
}

function scoreline(input: TickerRun) {
    const a = input.analysis
    if (!a.significant || !input.anomaly) {
        return `- ${input.ticker}: no significant anomaly (|z|=${formatNumber(a.abs_z_score, 3)} < threshold).`
    }
    return `- ${input.ticker}: ${input.anomaly.severity} ${input.anomaly.direction} anomaly (|z|=${formatNumber(a.abs_z_score, 3)}; current=${formatNumber(a.current_value, 3)} vs baseline=${formatNumber(a.baseline_center, 3)}).`
}

export function renderDashboard(input: {
    generated_at: string
    mode: "ticker" | "portfolio"
    tickers: TickerRun[]
    transitions: TransitionRecord[]
    threshold: number
    priorRuns: number
}) {
    const counts = transitionCounts(input.transitions)
    const stateMap = stateByCurrentKey(input.transitions)
    const rows = [
        "# Darkpool Anomaly Dashboard",
        "",
        `Generated at: ${input.generated_at}`,
        `Mode: ${input.mode}`,
        `Significance threshold (|z|): ${input.threshold}`,
        `Historical runs considered: ${input.priorRuns}`,
        "",
        "## Summary",
        `- Tickers analyzed: ${input.tickers.length}`,
        `- Significant anomalies: ${input.tickers.filter((item) => Boolean(item.anomaly)).length}`,
        `- New: ${counts.new}, Persisted: ${counts.persisted}, Severity changed: ${counts.severity_change}, Resolved: ${counts.resolved}`,
        "",
        "## Anomaly Table",
        "| Ticker | Date | Metric | Current | Baseline | |z| | Severity | Direction | State |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]

    for (const ticker of input.tickers) {
        const a = ticker.analysis
        const state = ticker.anomaly ? (stateMap.get(ticker.anomaly.key) ?? "new") : "no_anomaly"
        rows.push(
            `| ${ticker.ticker} | ${a.current_date} | ${a.metric_label} | ${formatNumber(a.current_value, 3)} | ${formatNumber(a.baseline_center, 3)} | ${formatNumber(a.abs_z_score, 3)} | ${ticker.anomaly?.severity ?? "none"} | ${ticker.anomaly?.direction ?? "none"} | ${state} |`,
        )
    }

    return rows.join("\n") + "\n"
}

export function renderTransitions(input: TransitionRecord[]) {
    if (input.length === 0) {
        return ["- No transition deltas were detected."]
    }

    return input.map((item) => {
        if (item.state === "resolved" && item.previous) {
            return `- resolved: ${item.previous.ticker} ${item.previous.metric_label} (${item.previous.severity})`
        }

        if (item.current && item.previous && item.state === "severity_change") {
            return `- severity_change: ${item.current.ticker} ${item.current.metric_label} ${item.previous.severity} -> ${item.current.severity}`
        }

        if (item.current) {
            return `- ${item.state}: ${item.current.ticker} ${item.current.metric_label} (${item.current.severity})`
        }

        return `- ${item.state}: ${item.key}`
    })
}

export function renderReport(input: {
    generated_at: string
    mode: "ticker" | "portfolio"
    tier: QuiverTier
    lookback_days: number
    min_samples: number
    threshold: number
    tickers: TickerRun[]
    transitions: TransitionRecord[]
    priorRuns: number
    latestPrior?: string
}) {
    const counts = transitionCounts(input.transitions)
    const lines = [
        "# Darkpool Anomaly Report",
        "",
        `Generated at: ${input.generated_at}`,
        `Mode: ${input.mode}`,
        `Quiver plan: ${quiverPlanLabel(input.tier)}`,
        `Lookback days: ${input.lookback_days}`,
        `Minimum baseline samples: ${input.min_samples}`,
        `Significance threshold (|z|): ${input.threshold}`,
        `Historical runs considered: ${input.priorRuns}`,
        ...(input.latestPrior ? [`Latest prior run: ${input.latestPrior}`] : ["Latest prior run: none (first-run initialization)"]),
        "",
        "## Executive Summary",
        `- ${input.tickers.filter((item) => Boolean(item.anomaly)).length} significant anomalies across ${input.tickers.length} analyzed tickers.`,
        `- Transition counts -> new: ${counts.new}, persisted: ${counts.persisted}, severity-change: ${counts.severity_change}, resolved: ${counts.resolved}.`,
        "",
        "## Methodology",
        "- Off-exchange observations are pulled from Quiver Tier 1 historical endpoint for each ticker.",
        "- Baseline uses robust center/dispersion (median + MAD/IQR fallback) to reduce outlier contamination.",
        "- Significance is two-sided using absolute robust z-score; direction is captured as positive or negative deviation.",
        "- Runs fail loudly when auth, dataset, or sample requirements are not met.",
        "",
        "## Findings",
        ...input.tickers.map(scoreline),
        "",
        "## Change Log",
        ...renderTransitions(input.transitions),
        "",
        "## Evidence Annex",
        "| Ticker | Date | Current | Baseline | Dispersion | z-score | Direction | Source | Source URL | Retrieved At |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]

    for (const ticker of input.tickers) {
        const a = ticker.analysis
        lines.push(
            `| ${ticker.ticker} | ${a.current_date} | ${formatNumber(a.current_value, 3)} | ${formatNumber(a.baseline_center, 3)} | ${formatNumber(a.baseline_dispersion, 3)} | ${formatNumber(a.z_score, 3)} | ${a.direction} | quiver-quant | ${ticker.source_url} | ${ticker.retrieved_at} |`,
        )
    }

    return lines.join("\n") + "\n"
}

export function renderEvidenceMarkdown(input: {
    generated_at: string
    tickers: TickerRun[]
    transitions: TransitionRecord[]
}) {
    const lines = [
        "# Darkpool Raw Evidence",
        "",
        `Generated at: ${input.generated_at}`,
        "",
        "## Current Ticker Analyses",
    ]

    input.tickers.forEach((item) => {
        lines.push(
            "",
            `### ${item.ticker}`,
            `- metric_key: ${item.analysis.metric_key}`,
            `- date_key: ${item.analysis.date_key}`,
            `- sample_count: ${item.analysis.sample_count}`,
            `- baseline_count: ${item.analysis.baseline_count}`,
            `- current_date: ${item.analysis.current_date}`,
            `- current_value: ${formatNumber(item.analysis.current_value, 6)}`,
            `- baseline_center: ${formatNumber(item.analysis.baseline_center, 6)}`,
            `- baseline_dispersion: ${formatNumber(item.analysis.baseline_dispersion, 6)}`,
            `- z_score: ${formatNumber(item.analysis.z_score, 6)}`,
            `- significant: ${item.analysis.significant}`,
            `- source_url: ${item.source_url}`,
            `- retrieved_at: ${item.retrieved_at}`,
        )
    })

    lines.push("", "## Transition Records")
    renderTransitions(input.transitions).forEach((line) => lines.push(line))

    return lines.join("\n") + "\n"
}
