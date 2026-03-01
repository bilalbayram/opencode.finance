import type {
    BacktestRunComparison,
    EventAnchorMode,
    BenchmarkMode,
} from "../../finance/political-backtest"
import { runPoliticalEventStudyCore } from "../../finance/political-backtest"

export function toReport(input: {
    mode: "ticker" | "portfolio"
    tickers: string[]
    anchorMode: EventAnchorMode
    windows: number[]
    benchmarkMode: BenchmarkMode
    generatedAt: string
    events: number
    benchmarkSymbols: string[]
    benchmarkRationale: string[]
    aggregates: ReturnType<typeof runPoliticalEventStudyCore>["aggregates"]
    comparison: BacktestRunComparison
    warnings: string[]
}) {
    const scope = input.mode === "portfolio" ? "PORTFOLIO" : input.tickers[0]!
    const lines = [
        `# Political Event Backtest: ${scope}`,
        "",
        `Generated at: ${input.generatedAt}`,
        `Mode: ${input.mode}`,
        `Tickers: ${input.tickers.join(", ")}`,
        `Anchor Mode: ${input.anchorMode}`,
        `Windows (sessions): ${input.windows.join(", ")}`,
        `Benchmark Mode: ${input.benchmarkMode}`,
        `Benchmarks: ${input.benchmarkSymbols.join(", ")}`,
        `Date Alignment Policy: next_session`,
        "",
        "## Executive Summary",
        `- Political events analyzed: ${input.events}`,
        `- Benchmark-relative rows computed: ${input.aggregates.reduce((acc, item) => acc + item.sample_size, 0)}`,
        `- Benchmark rationale: ${input.benchmarkRationale.join(" ")}`,
        "",
        "## Aggregate Results",
    ]

    for (const item of input.aggregates) {
        lines.push(
            `- ${item.anchor_kind} ${item.window_sessions}D vs ${item.benchmark_symbol}: hit rate ${item.hit_rate_percent.toFixed(2)}%, median ${item.median_return_percent.toFixed(3)}%, mean excess ${item.mean_excess_return_percent.toFixed(3)}% (n=${item.sample_size})`,
        )
    }

    lines.push("", "## Longitudinal Comparison")
    if (input.comparison.first_run) {
        lines.push("- No prior backtest run was discovered. This run initializes historical tracking.")
    } else {
        lines.push(
            `- Baseline run: ${input.comparison.baseline?.generated_at ?? "unknown"} (${input.comparison.baseline?.output_root ?? "unknown"})`,
        )
        lines.push(
            `- Event sample: current ${input.comparison.event_sample.current}, baseline ${input.comparison.event_sample.baseline}, new ${input.comparison.event_sample.new_events.length}, removed ${input.comparison.event_sample.removed_events.length}.`,
        )
        if (input.comparison.conclusion_changes.length === 0) {
            lines.push("- Benchmark-relative directional conclusions did not change versus baseline.")
        } else {
            lines.push("- Benchmark-relative conclusion changes:")
            input.comparison.conclusion_changes.forEach((item) =>
                lines.push(
                    `  - ${item.anchor_kind} ${item.window_sessions}D vs ${item.benchmark_symbol}: ${item.baseline_view} -> ${item.current_view}`,
                ),
            )
        }
    }

    if (input.warnings.length > 0) {
        lines.push("", "## Warnings")
        input.warnings.forEach((warning) => lines.push(`- ${warning}`))
    }

    lines.push("", "## Policy", "- This output is analytic and non-advisory.")
    return `${lines.join("\n")}\n`
}

export function toDashboard(input: {
    mode: "ticker" | "portfolio"
    tickers: string[]
    events: number
    benchmarks: string[]
    aggregates: ReturnType<typeof runPoliticalEventStudyCore>["aggregates"]
    comparison: BacktestRunComparison
}) {
    const scope = input.mode === "portfolio" ? "PORTFOLIO" : input.tickers[0]!
    const lines = [
        `# Political Backtest Dashboard: ${scope}`,
        "",
        `- Mode: ${input.mode}`,
        `- Tickers: ${input.tickers.join(", ")}`,
        `- Events: ${input.events}`,
        `- Benchmarks: ${input.benchmarks.join(", ")}`,
        "",
        "| Anchor | Window | Benchmark | Sample | Hit Rate % | Median Return % | Mean Return % | Mean Excess % |",
        "|---|---:|---|---:|---:|---:|---:|---:|",
    ]

    for (const item of input.aggregates) {
        lines.push(
            `| ${item.anchor_kind} | ${item.window_sessions} | ${item.benchmark_symbol} | ${item.sample_size} | ${item.hit_rate_percent.toFixed(2)} | ${item.median_return_percent.toFixed(3)} | ${item.mean_return_percent.toFixed(3)} | ${item.mean_excess_return_percent.toFixed(3)} |`,
        )
    }

    lines.push("", "## Longitudinal Snapshot")
    if (input.comparison.first_run) {
        lines.push("- Baseline: none (first run)")
    } else {
        lines.push(`- Baseline generated at: ${input.comparison.baseline?.generated_at ?? "unknown"}`)
        lines.push(`- New events: ${input.comparison.event_sample.new_events.length}`)
        lines.push(`- Removed events: ${input.comparison.event_sample.removed_events.length}`)
        lines.push(`- Conclusion changes: ${input.comparison.conclusion_changes.length}`)
    }

    lines.push("", "Analytic output only. No investment advice.")
    return `${lines.join("\n")}\n`
}
