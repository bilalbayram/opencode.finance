import type { GovernmentTradingHistoryRun, GovernmentTradingNormalizedEvent } from "../../finance/government-trading/types"
import type { PersistenceTrend } from "./types"

export function clampLimit(input: number) {
    if (!Number.isFinite(input)) return 50
    const value = Math.floor(input)
    if (value < 1) return 1
    if (value > 200) return 200
    return value
}

export function createRunId(generatedAt: string) {
    const date = generatedAt.slice(0, 10)
    const time = generatedAt.slice(11).replace(/:/g, "-")
    return `${date}__${time}`
}

export function buildPersistenceTrends(input: {
    currentEvents: GovernmentTradingNormalizedEvent[]
    historyRuns: GovernmentTradingHistoryRun[]
    runId: string
}) {
    const orderedHistory = input.historyRuns.toSorted((a, b) => a.runId.localeCompare(b.runId, "en-US"))
    const runPresence = orderedHistory.map((run) => ({
        runId: run.runId,
        identities: new Set(run.normalizedEvents.map((event) => event.identityKey)),
    }))

    const trends = input.currentEvents.map((event) => {
        const seenInRuns = runPresence.filter((entry) => entry.identities.has(event.identityKey)).map((entry) => entry.runId)

        let consecutivePriorRuns = 0
        for (let index = runPresence.length - 1; index >= 0; index -= 1) {
            const run = runPresence[index]
            if (!run || !run.identities.has(event.identityKey)) break
            consecutivePriorRuns += 1
        }

        const totalRunsIncludingCurrent = orderedHistory.length + 1
        const seenIncludingCurrent = seenInRuns.length + 1

        return {
            identity_key: event.identityKey,
            dataset_id: event.datasetId,
            actor: event.identityFields.actor ?? "",
            ticker: event.identityFields.ticker ?? "",
            transaction_date: event.identityFields.transaction_date ?? "",
            transaction_type: event.identityFields.transaction_type ?? "",
            amount: event.identityFields.amount ?? "",
            seen_in_prior_runs: seenInRuns.length,
            seen_including_current: seenIncludingCurrent,
            total_runs_including_current: totalRunsIncludingCurrent,
            persistence_ratio: Number((seenIncludingCurrent / totalRunsIncludingCurrent).toFixed(4)),
            first_seen_run_id: seenInRuns[0] ?? input.runId,
            last_seen_run_id: input.runId,
            consecutive_run_streak: consecutivePriorRuns + 1,
        } satisfies PersistenceTrend
    })

    return trends.toSorted(
        (a, b) =>
            b.seen_including_current - a.seen_including_current ||
            b.consecutive_run_streak - a.consecutive_run_streak ||
            a.identity_key.localeCompare(b.identity_key, "en-US"),
    )
}
