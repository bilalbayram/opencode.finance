import {
    EventStudyError,
    selectBenchmarks,
    computeBenchmarkRelativeReturns,
    computeEventWindowReturns,
    type BenchmarkMode,
    type NonTradingAlignment,
    type PriceBar,
} from "../../finance/political-backtest"

export function selectBenchmarksByTicker(input: {
    tickers: string[]
    benchmarkMode: BenchmarkMode
    sectorsByTicker: Record<string, string | null>
}) {
    const byTicker: Record<string, ReturnType<typeof selectBenchmarks>> = {}
    const benchmarkSymbols = new Set<string>()
    const benchmarkRationale: string[] = []

    for (const ticker of input.tickers) {
        const selected = selectBenchmarks({
            sector: input.sectorsByTicker[ticker] ?? null,
            mode: input.benchmarkMode,
        })
        if (!Array.isArray(selected.symbols) || selected.symbols.length === 0) {
            throw new EventStudyError(`No benchmark symbols were resolved for ${ticker}.`, "MISSING_BENCHMARK_SERIES", {
                ticker,
                benchmark_mode: input.benchmarkMode,
            })
        }
        byTicker[ticker] = selected
        selected.symbols.forEach((symbol) => benchmarkSymbols.add(symbol))
        benchmarkRationale.push(`${ticker}: ${selected.rationale.join(" ")}`)
    }

    return {
        byTicker,
        symbols: [...benchmarkSymbols],
        rationale: benchmarkRationale,
    }
}

export function computePortfolioBenchmarkRelativeRows(input: {
    tickers: string[]
    eventWindowReturns: ReturnType<typeof computeEventWindowReturns>
    benchmarkSymbolsByTicker: Record<string, string[]>
    alignment: NonTradingAlignment
    price_by_symbol: Record<string, PriceBar[]>
}) {
    const benchmarkRelativeReturns: ReturnType<typeof computeBenchmarkRelativeReturns> = []

    for (const ticker of input.tickers) {
        const scopedRows = input.eventWindowReturns.filter((row) => row.ticker === ticker)
        if (scopedRows.length === 0) {
            throw new EventStudyError(`No event-window rows were produced for ${ticker} in portfolio mode.`, "EMPTY_EVENT_SET", {
                ticker,
            })
        }

        const benchmarkSymbols = input.benchmarkSymbolsByTicker[ticker]
        if (!Array.isArray(benchmarkSymbols) || benchmarkSymbols.length === 0) {
            throw new EventStudyError(`No scoped benchmark symbols were resolved for ${ticker}.`, "MISSING_BENCHMARK_SERIES", {
                ticker,
            })
        }

        const scopedRelative = computeBenchmarkRelativeReturns({
            base: scopedRows,
            benchmark_symbols: benchmarkSymbols,
            alignment: input.alignment,
            price_by_symbol: input.price_by_symbol,
        })
        if (scopedRelative.length === 0) {
            throw new EventStudyError(`No benchmark-relative rows were produced for ${ticker} in portfolio mode.`, "MISSING_BENCHMARK_SERIES", {
                ticker,
                benchmarks: benchmarkSymbols,
            })
        }

        benchmarkRelativeReturns.push(...scopedRelative)
    }

    if (benchmarkRelativeReturns.length === 0) {
        throw new EventStudyError("No benchmark-relative rows were produced for this backtest run.", "MISSING_BENCHMARK_SERIES")
    }

    return benchmarkRelativeReturns
}
