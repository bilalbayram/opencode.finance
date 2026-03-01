import path from "path"
import {
    compareRuns,
    discoverHistoricalRuns,
    type BacktestRunSnapshot,
} from "../../finance/political-backtest"

const BACKTEST_WORKFLOW_DIR = "political-backtest"

export async function buildRunComparison(input: {
    reportsRoot: string
    scopeKey: string
    currentSnapshot: BacktestRunSnapshot
}) {
    const priorRuns = await discoverHistoricalRuns({
        reports_root: input.reportsRoot,
        ticker: path.join(BACKTEST_WORKFLOW_DIR, input.scopeKey),
    })
    return compareRuns({
        current: input.currentSnapshot,
        baseline: priorRuns.at(-1) ?? null,
    })
}
