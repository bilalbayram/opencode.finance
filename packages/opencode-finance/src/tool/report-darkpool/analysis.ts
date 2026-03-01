import fs from "fs/promises"
import path from "path"
import { endpointMinimumPlan, type QuiverTier } from "../../finance/quiver-tier"
import * as QuiverReport from "../../finance/providers/quiver-report"
import type { AnomalyRecord } from "../../finance/darkpool-anomaly"
import type { HistoricalRun } from "./types"

const LOGIN_HINT =
    "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function fetchRequiredOffExchange(input: {
    ticker: string
    apiKey: string
    tier: QuiverTier
    limit: number
    signal: AbortSignal
}) {
    const datasets = await QuiverReport.fetchTickerAlt({
        apiKey: input.apiKey,
        tier: input.tier,
        enforceTierGate: false,
        ticker: input.ticker,
        limit: input.limit,
        signal: input.signal,
    })

    const dataset = datasets.find((item) => item.id === "ticker_off_exchange")
    if (!dataset) {
        throw new Error(`Required off-exchange dataset definition was not found for ${input.ticker}.`)
    }

    if (dataset.status === "not_attempted_due_to_tier") {
        throw new Error(
            `Required dataset ${dataset.label} was not attempted for ${input.ticker}; minimum plan is ${endpointMinimumPlan(dataset.endpoint_tier)}. Re-run ${LOGIN_HINT} to refresh stored plan metadata.`,
        )
    }

    if (dataset.status === "failed") {
        if (dataset.error?.code === "TIER_DENIED") {
            throw new Error(
                `Required dataset ${dataset.label} is not available for ${input.ticker} with the currently active Quiver key. Confirm your Quiver account is Hobbyist (Tier 0 + Tier 1) or higher and re-run ${LOGIN_HINT}.`,
            )
        }
        throw new Error(
            `Required dataset ${dataset.label} failed for ${input.ticker}: ${dataset.error?.code ?? "NETWORK"} ${dataset.error?.message ?? "request failed"}`,
        )
    }

    if (dataset.rows.length === 0) {
        throw new Error(`Required dataset ${dataset.label} returned zero rows for ${input.ticker}.`)
    }

    const boundedRows = dataset.rows.slice(0, input.limit)
    if (boundedRows.length === 0) {
        throw new Error(`Required dataset ${dataset.label} returned zero usable rows after applying limit for ${input.ticker}.`)
    }

    return {
        ...dataset,
        rows: boundedRows,
    }
}

export async function readHistoricalRuns(input: { scopeRoots: string[]; outputRoot: string }): Promise<HistoricalRun[]> {
    const runs: HistoricalRun[] = []
    const current = path.resolve(input.outputRoot)

    for (const scopeRoot of input.scopeRoots) {
        const exists = await Bun.file(scopeRoot).exists()
        if (!exists) continue

        const dates = await fs.readdir(scopeRoot, { withFileTypes: true })
        for (const entry of dates) {
            if (!entry.isDirectory()) continue
            if (!DATE_RE.test(entry.name)) continue

            const root = path.join(scopeRoot, entry.name, "darkpool-anomaly")
            if (path.resolve(root) === current) continue

            const evidencePath = path.join(root, "evidence.json")
            const file = Bun.file(evidencePath)
            if (!(await file.exists())) continue

            const json = await file
                .text()
                .then((text) => JSON.parse(text) as { generated_at?: string; anomalies?: AnomalyRecord[] })
                .catch(() => undefined)

            if (!json?.generated_at || !Array.isArray(json.anomalies)) continue

            runs.push({
                generated_at: json.generated_at,
                anomalies: json.anomalies,
                path: evidencePath,
            })
        }
    }

    return runs.toSorted((a, b) => a.generated_at.localeCompare(b.generated_at))
}
