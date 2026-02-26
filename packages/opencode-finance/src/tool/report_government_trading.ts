import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./report_government_trading.txt"
import { Auth } from "../auth"
import { Env } from "../env"
import { FINANCE_AUTH_PROVIDER } from "../finance/auth-provider"
import { resolveStrictQuiverAuth } from "../finance/quiver-auth"
import { listPortfolio } from "../finance/portfolio"
import { normalizeTicker } from "../finance/parser"
import { computeGovernmentTradingDelta } from "../finance/government-trading/delta"
import { loadGovernmentTradingHistory } from "../finance/government-trading/history"
import { normalizeGovernmentTradingEvents } from "../finance/government-trading/normalize"
import { renderGovernmentTradingArtifacts } from "../finance/government-trading/renderer"
import { collectGovernmentTradingSourceRows } from "../finance/government-trading/source-rows"
import type { GovernmentTradingHistoryRun, GovernmentTradingNormalizedEvent } from "../finance/government-trading/types"
import { quiverPlanLabel, type QuiverTier } from "../finance/quiver-tier"
import * as QuiverReport from "../finance/providers/quiver-report"
import { assertExternalDirectory } from "./external-directory"

const LOGIN_HINT =
  "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

const REQUIRED_GLOBAL_IDS = ["global_congress_trading", "global_senate_trading", "global_house_trading"] as const
const REQUIRED_TICKER_IDS = ["ticker_congress_trading", "ticker_senate_trading", "ticker_house_trading"] as const

const MAX_PERSISTENCE_ROWS_IN_ARTIFACTS = 75

const parameters = z.object({
  ticker: z.string().optional().describe("Optional ticker for ticker mode; omit for portfolio mode."),
  output_root: z
    .string()
    .optional()
    .describe("Optional output root. Defaults to reports/government-trading under the project/worktree."),
  limit: z.number().int().min(1).max(200).optional().describe("Optional dataset limit (1..200, default 50)."),
  refresh: z.boolean().optional().describe("Pass-through refresh metadata flag for orchestrators."),
})

type ReportGovernmentTradingMetadata = {
  mode: "ticker" | "portfolio"
  scope: string
  tier: QuiverTier
  generated_at: string
  run_id: string
  baseline_run_id: string | null
  output_root: string
  report_path: string
  dashboard_path: string
  assumptions_path: string
  normalized_events_path: string
  delta_events_path: string
  data_path: string
  summary: {
    current_events: number
    new_events: number
    updated_events: number
    unchanged_events: number
    no_longer_present_events: number
    historical_runs: number
  }
}

type DatasetSnapshot = {
  scope: "global" | "ticker"
  ticker?: string
  id: string
  label: string
  endpoint: string
  endpoint_tier: string
  status: QuiverReport.QuiverReportStatus
  timestamp: string
  source_url: string
  row_count: number
  error?: QuiverReport.QuiverReportError
}

type PersistenceTrend = {
  identity_key: string
  dataset_id: string
  actor: string
  ticker: string
  transaction_date: string
  transaction_type: string
  amount: string
  seen_in_prior_runs: number
  seen_including_current: number
  total_runs_including_current: number
  persistence_ratio: number
  first_seen_run_id: string
  last_seen_run_id: string
  consecutive_run_streak: number
}

function projectRoot(context: Pick<Tool.Context, "directory" | "worktree">) {
  return context.worktree === "/" ? context.directory : context.worktree
}

function normalizeOutputRoot(context: Pick<Tool.Context, "directory" | "worktree">, outputRoot?: string) {
  if (!outputRoot) return path.join(projectRoot(context), "reports", "government-trading")
  return path.isAbsolute(outputRoot) ? path.normalize(outputRoot) : path.resolve(context.directory, outputRoot)
}

function normalizeScope(mode: "ticker" | "portfolio", ticker: string, tickers: string[]) {
  if (mode === "ticker") return ticker
  return tickers.length > 0 ? "portfolio" : "global"
}

function createRunId(generatedAt: string) {
  const date = generatedAt.slice(0, 10)
  const time = generatedAt.slice(11).replace(/:/g, "-")
  return `${date}__${time}`
}

function clampLimit(input: number) {
  if (!Number.isFinite(input)) return 50
  const value = Math.floor(input)
  if (value < 1) return 1
  if (value > 200) return 200
  return value
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|")
}

function eventLabel(event: GovernmentTradingNormalizedEvent) {
  const actor = event.identityFields.actor || "unknown actor"
  const ticker = event.identityFields.ticker || "unknown ticker"
  const date = event.identityFields.transaction_date || "unknown date"
  const type = event.identityFields.transaction_type || "unknown action"
  const amount = event.identityFields.amount || "unknown amount"
  return `${date} | ${actor} | ${ticker} | ${type} | ${amount}`
}

function projectDatasetSnapshots(input: {
  globalDatasets: QuiverReport.QuiverReportDataset[]
  tickerDatasets: Array<{ ticker: string; datasets: QuiverReport.QuiverReportDataset[] }>
}) {
  const snapshots: DatasetSnapshot[] = []

  for (const dataset of input.globalDatasets) {
    snapshots.push({
      scope: "global",
      id: dataset.id,
      label: dataset.label,
      endpoint: dataset.endpoint,
      endpoint_tier: dataset.endpoint_tier,
      status: dataset.status,
      timestamp: dataset.timestamp,
      source_url: dataset.source_url,
      row_count: dataset.rows.length,
      error: dataset.error,
    })
  }

  for (const item of input.tickerDatasets) {
    for (const dataset of item.datasets) {
      snapshots.push({
        scope: "ticker",
        ticker: item.ticker,
        id: dataset.id,
        label: dataset.label,
        endpoint: dataset.endpoint,
        endpoint_tier: dataset.endpoint_tier,
        status: dataset.status,
        timestamp: dataset.timestamp,
        source_url: dataset.source_url,
        row_count: dataset.rows.length,
        error: dataset.error,
      })
    }
  }

  return snapshots
}

function assertRequiredDatasets(input: {
  datasets: QuiverReport.QuiverReportDataset[]
  requiredIds: readonly string[]
  scope: string
}) {
  const byId = new Map(input.datasets.map((item) => [item.id, item]))

  for (const requiredId of input.requiredIds) {
    const dataset = byId.get(requiredId)
    if (!dataset) {
      throw new Error(`Missing required ${input.scope} dataset: ${requiredId}`)
    }

    if (dataset.status === "ok") continue

    if (dataset.status === "failed") {
      throw new Error(
        `Required ${input.scope} dataset ${dataset.id} failed: ${dataset.error?.message ?? "request failed"}`,
      )
    }

    throw new Error(
      `Required ${input.scope} dataset ${dataset.id} was not attempted due to plan tier. Upgrade Quiver Quant to Hobbyist (Tier 0 + Tier 1) or higher and rerun ${LOGIN_HINT}. If your key was upgraded recently, re-run login to refresh stored plan metadata.`,
    )
  }
}

function buildPersistenceTrends(input: {
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

function sourceAttributionLines(snapshots: DatasetSnapshot[]) {
  return snapshots
    .toSorted((a, b) => {
      const scopeCompare = a.scope.localeCompare(b.scope, "en-US")
      if (scopeCompare !== 0) return scopeCompare
      const tickerCompare = (a.ticker ?? "").localeCompare(b.ticker ?? "", "en-US")
      if (tickerCompare !== 0) return tickerCompare
      return a.id.localeCompare(b.id, "en-US")
    })
    .map((snapshot) => {
      const scope = snapshot.scope === "ticker" ? `ticker:${snapshot.ticker}` : "global"
      return `- ${scope} | ${snapshot.label} (${snapshot.id}) | rows=${snapshot.row_count} | retrieved_at=${snapshot.timestamp} | source=${snapshot.source_url}`
    })
}

function buildReportMarkdown(input: {
  mode: "ticker" | "portfolio"
  scope: string
  generatedAt: string
  runId: string
  baselineRunId: string | null
  summary: {
    current_events: number
    new_events: number
    updated_events: number
    unchanged_events: number
    no_longer_present_events: number
    historical_runs: number
  }
  snapshots: DatasetSnapshot[]
  persistenceTrends: PersistenceTrend[]
  delta: ReturnType<typeof computeGovernmentTradingDelta>
  renderedReportMarkdown: string
}) {
  const lines = [
    "# Government Trading Report",
    "",
    "## Run Metadata",
    `- mode: ${input.mode}`,
    `- scope: ${input.scope}`,
    `- generated_at: ${input.generatedAt}`,
    `- run_id: ${input.runId}`,
    `- baseline_run_id: ${input.baselineRunId ?? "none"}`,
    "",
    "## Executive Summary",
    `- Current normalized events: ${input.summary.current_events}`,
    `- Delta new events: ${input.summary.new_events}`,
    `- Delta updated events: ${input.summary.updated_events}`,
    `- Delta unchanged events: ${input.summary.unchanged_events}`,
    `- Delta no longer present events: ${input.summary.no_longer_present_events}`,
    `- Historical runs loaded: ${input.summary.historical_runs}`,
    "",
    "## Source Attribution",
    ...sourceAttributionLines(input.snapshots),
    "",
    "## Persistence Trends",
  ]

  if (input.persistenceTrends.length === 0) {
    lines.push("- No current events were normalized, so no persistence trend entries are available.")
  } else {
    for (const item of input.persistenceTrends.slice(0, MAX_PERSISTENCE_ROWS_IN_ARTIFACTS)) {
      lines.push(
        `- ${item.identity_key}: seen=${item.seen_including_current}/${item.total_runs_including_current}, streak=${item.consecutive_run_streak}, actor=${item.actor || "unknown"}, ticker=${item.ticker || "unknown"}, date=${item.transaction_date || "unknown"}`,
      )
    }
    if (input.persistenceTrends.length > MAX_PERSISTENCE_ROWS_IN_ARTIFACTS) {
      lines.push(
        `- ...and ${input.persistenceTrends.length - MAX_PERSISTENCE_ROWS_IN_ARTIFACTS} more persistence rows in data.json`,
      )
    }
  }

  lines.push("", "## Delta Preview")
  const preview = [
    ...input.delta.newEvents.map((event) => ({ kind: "new", label: eventLabel(event) })),
    ...input.delta.updatedEvents.map((event) => ({ kind: "updated", label: eventLabel(event.current) })),
    ...input.delta.noLongerPresentEvents.map((event) => ({ kind: "no_longer_present", label: eventLabel(event) })),
  ]

  if (preview.length === 0) {
    lines.push("- No delta changes versus baseline run.")
  } else {
    for (const item of preview.slice(0, MAX_PERSISTENCE_ROWS_IN_ARTIFACTS)) {
      lines.push(`- [${item.kind}] ${item.label}`)
    }
    if (preview.length > MAX_PERSISTENCE_ROWS_IN_ARTIFACTS) {
      lines.push(`- ...and ${preview.length - MAX_PERSISTENCE_ROWS_IN_ARTIFACTS} more delta rows in delta-events.json`)
    }
  }

  const renderedDetailsStart = input.renderedReportMarkdown
    .split("\n")
    .findIndex((line) => line.trim() === "## New Events")

  if (renderedDetailsStart >= 0) {
    const renderedLines = input.renderedReportMarkdown.trimEnd().split("\n")
    lines.push("", "## Detailed Delta Sections", ...renderedLines.slice(renderedDetailsStart))
  }

  return `${lines.join("\n")}\n`
}

function buildDashboardMarkdown(input: {
  mode: "ticker" | "portfolio"
  scope: string
  generatedAt: string
  runId: string
  baselineRunId: string | null
  summary: {
    current_events: number
    new_events: number
    updated_events: number
    unchanged_events: number
    no_longer_present_events: number
    historical_runs: number
  }
  snapshots: DatasetSnapshot[]
  persistenceTrends: PersistenceTrend[]
}) {
  const lines = [
    "# Government Trading Dashboard",
    "",
    "## Run Metadata",
    "",
    "| Key | Value |",
    "| --- | --- |",
    `| mode | ${escapeCell(input.mode)} |`,
    `| scope | ${escapeCell(input.scope)} |`,
    `| generated_at | ${escapeCell(input.generatedAt)} |`,
    `| run_id | ${escapeCell(input.runId)} |`,
    `| baseline_run_id | ${escapeCell(input.baselineRunId ?? "none")} |`,
    "",
    "## Delta Counts",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| current_events | ${input.summary.current_events} |`,
    `| new_events | ${input.summary.new_events} |`,
    `| updated_events | ${input.summary.updated_events} |`,
    `| unchanged_events | ${input.summary.unchanged_events} |`,
    `| no_longer_present_events | ${input.summary.no_longer_present_events} |`,
    `| historical_runs | ${input.summary.historical_runs} |`,
    "",
    "## Required Dataset Sources",
    "",
    "| Scope | Dataset | Rows | Retrieved At | Source URL |",
    "| --- | --- | ---: | --- | --- |",
  ]

  for (const snapshot of input.snapshots.toSorted((a, b) => a.id.localeCompare(b.id, "en-US"))) {
    const scope = snapshot.scope === "ticker" ? `ticker:${snapshot.ticker}` : "global"
    lines.push(
      `| ${escapeCell(scope)} | ${escapeCell(`${snapshot.label} (${snapshot.id})`)} | ${snapshot.row_count} | ${escapeCell(snapshot.timestamp)} | ${escapeCell(snapshot.source_url)} |`,
    )
  }

  lines.push("", "## Persistence Trends (Current Events)", "", "| Identity Key | Seen/Total | Streak | Actor | Ticker | Date |", "| --- | ---: | ---: | --- | --- | --- |")

  if (input.persistenceTrends.length === 0) {
    lines.push("| none | 0/0 | 0 | none | none | none |")
  } else {
    for (const item of input.persistenceTrends.slice(0, MAX_PERSISTENCE_ROWS_IN_ARTIFACTS)) {
      lines.push(
        `| ${escapeCell(item.identity_key)} | ${item.seen_including_current}/${item.total_runs_including_current} | ${item.consecutive_run_streak} | ${escapeCell(item.actor || "unknown")} | ${escapeCell(item.ticker || "unknown")} | ${escapeCell(item.transaction_date || "unknown")} |`,
      )
    }
    if (input.persistenceTrends.length > MAX_PERSISTENCE_ROWS_IN_ARTIFACTS) {
      lines.push(
        `| ... | ... | ... | ... | ... | ...and ${input.persistenceTrends.length - MAX_PERSISTENCE_ROWS_IN_ARTIFACTS} more rows in data.json |`,
      )
    }
  }

  return `${lines.join("\n")}\n`
}

async function resolveAuth() {
  const auth = await Auth.get("quiver-quant")
  const env = FINANCE_AUTH_PROVIDER["quiver-quant"].env.map((key) => Env.get(key)).find(Boolean)

  return resolveStrictQuiverAuth({
    authInfo: auth,
    envKey: env,
    loginHint: LOGIN_HINT,
    requiredEndpointTier: "tier_1",
    capabilityLabel: "Tier 1 government-trading datasets required by this report",
  })
}

async function writeArtifacts(input: {
  ctx: Tool.Context
  runDirectory: string
  reportMarkdown: string
  dashboardMarkdown: string
  assumptionsJson: string
  normalizedEventsJson: string
  deltaEventsJson: string
  dataJson: string
}) {
  await assertExternalDirectory(input.ctx, input.runDirectory, { kind: "directory" })
  await fs.mkdir(input.runDirectory, { recursive: true })

  const files = {
    reportPath: path.join(input.runDirectory, "report.md"),
    dashboardPath: path.join(input.runDirectory, "dashboard.md"),
    assumptionsPath: path.join(input.runDirectory, "assumptions.json"),
    normalizedEventsPath: path.join(input.runDirectory, "normalized-events.json"),
    deltaEventsPath: path.join(input.runDirectory, "delta-events.json"),
    dataPath: path.join(input.runDirectory, "data.json"),
  }

  const worktree = projectRoot(input.ctx)

  await input.ctx.ask({
    permission: "edit",
    patterns: [
      path.relative(worktree, files.reportPath),
      path.relative(worktree, files.dashboardPath),
      path.relative(worktree, files.assumptionsPath),
      path.relative(worktree, files.normalizedEventsPath),
      path.relative(worktree, files.deltaEventsPath),
      path.relative(worktree, files.dataPath),
    ],
    always: ["*"],
    metadata: {
      output_root: input.runDirectory,
      ...files,
    },
  })

  try {
    await Promise.all([
      Bun.write(files.reportPath, input.reportMarkdown),
      Bun.write(files.dashboardPath, input.dashboardMarkdown),
      Bun.write(files.assumptionsPath, input.assumptionsJson),
      Bun.write(files.normalizedEventsPath, input.normalizedEventsJson),
      Bun.write(files.deltaEventsPath, input.deltaEventsJson),
      Bun.write(files.dataPath, input.dataJson),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed writing government-trading artifacts to ${input.runDirectory}: ${message}`)
  }

  return files
}

export const ReportGovernmentTradingTool = Tool.define("report_government_trading", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      const auth = await resolveAuth()
      const mode = params.ticker ? "ticker" : "portfolio"
      const ticker = params.ticker ? normalizeTicker(params.ticker) : ""

      if (mode === "ticker" && !ticker) {
        throw new Error("ticker must include at least one valid symbol character")
      }

      if (mode === "portfolio") {
        await ctx.ask({
          permission: "portfolio",
          patterns: ["list", "report", "government-trading"],
          always: ["*"],
          metadata: {
            action: "report_government_trading",
          },
        })
      }

      const tickers =
        mode === "ticker"
          ? [ticker]
          : await listPortfolio().then((items) => [...new Set(items.map((item) => normalizeTicker(item.ticker)).filter(Boolean))])

      const scope = normalizeScope(mode, ticker, tickers)
      const limitRequested = params.limit ?? 50
      const limitEffective = clampLimit(limitRequested)
      const generatedAt = new Date().toISOString()
      const runId = createRunId(generatedAt)

      const outputBase = normalizeOutputRoot(ctx, params.output_root)
      const historyRoot = path.join(outputBase, mode, scope)
      const runDirectory = path.join(historyRoot, runId)

      await ctx.ask({
        permission: "financial_search",
        patterns: [
          "global congress trading",
          "global senate trading",
          "global house trading",
          ...tickers.map((item) => `${item} congress trading`),
          ...tickers.map((item) => `${item} senate trading`),
          ...tickers.map((item) => `${item} house trading`),
        ],
        always: ["*"],
        metadata: {
          source: "report_government_trading_tool",
          tier: auth.tier,
          mode,
          scope,
          refresh: params.refresh,
          limit: limitEffective,
        },
      })

      const [globalDatasets, tickerDatasets] = await Promise.all([
        QuiverReport.fetchGlobalGovTrading({
          apiKey: auth.key,
          tier: auth.tier,
          limit: limitEffective,
          signal: ctx.abort,
        }),
        Promise.all(
          tickers.map(async (symbol) => ({
            ticker: symbol,
            datasets: await QuiverReport.fetchTickerGovTrading({
              apiKey: auth.key,
              tier: auth.tier,
              ticker: symbol,
              limit: limitEffective,
              signal: ctx.abort,
            }),
          })),
        ),
      ])

      assertRequiredDatasets({
        datasets: globalDatasets,
        requiredIds: REQUIRED_GLOBAL_IDS,
        scope: "global",
      })
      tickerDatasets.forEach((item) => {
        assertRequiredDatasets({
          datasets: item.datasets,
          requiredIds: REQUIRED_TICKER_IDS,
          scope: `ticker ${item.ticker}`,
        })
      })

      const normalizedInputRows = collectGovernmentTradingSourceRows({
        globalDatasets,
        tickerDatasets,
        limitPerDataset: limitEffective,
      })
      const normalizedEvents = normalizeGovernmentTradingEvents(normalizedInputRows)

      const historyRuns = await loadGovernmentTradingHistory({ historyRoot })
      const baseline = historyRuns[0]
      const delta = computeGovernmentTradingDelta(
        normalizedEvents,
        baseline?.normalizedEvents ?? [],
        { includeNoLongerPresent: true },
      )

      const persistenceTrends = buildPersistenceTrends({
        currentEvents: normalizedEvents,
        historyRuns,
        runId,
      })

      const datasetSnapshots = projectDatasetSnapshots({
        globalDatasets,
        tickerDatasets,
      })

      const assumptions = {
        mode,
        scope,
        generated_at: generatedAt,
        run_id: runId,
        baseline_run_id: baseline?.runId ?? null,
        quiver_tier: auth.tier,
        quiver_plan: quiverPlanLabel(auth.tier),
        quiver_tier_inferred: auth.inferred,
        quiver_tier_warning: auth.warning ?? null,
        required_dataset_ids: {
          global: REQUIRED_GLOBAL_IDS,
          ticker: tickers.length > 0 ? REQUIRED_TICKER_IDS : [],
        },
        limit_requested: limitRequested,
        limit_effective: limitEffective,
        refresh: params.refresh ?? false,
        output_root: outputBase,
      }

      const rendered = renderGovernmentTradingArtifacts({
        generatedAt,
        title:
          mode === "ticker"
            ? `Government Trading Report (${scope})`
            : scope === "global"
              ? "Government Trading Report (Global)"
              : "Government Trading Report (Portfolio)",
        assumptions,
        currentEvents: normalizedEvents,
        delta,
        historyRuns,
      })

      const summary = {
        current_events: normalizedEvents.length,
        new_events: delta.newEvents.length,
        updated_events: delta.updatedEvents.length,
        unchanged_events: delta.unchangedEvents.length,
        no_longer_present_events: delta.noLongerPresentEvents.length,
        historical_runs: historyRuns.length,
      }

      const reportMarkdown = buildReportMarkdown({
        mode,
        scope,
        generatedAt,
        runId,
        baselineRunId: baseline?.runId ?? null,
        summary,
        snapshots: datasetSnapshots,
        persistenceTrends,
        delta,
        renderedReportMarkdown: rendered.reportMarkdown,
      })

      const dashboardMarkdown = buildDashboardMarkdown({
        mode,
        scope,
        generatedAt,
        runId,
        baselineRunId: baseline?.runId ?? null,
        summary,
        snapshots: datasetSnapshots,
        persistenceTrends,
      })

      const deltaPayload = {
        generated_at: generatedAt,
        run_id: runId,
        baseline_run_id: baseline?.runId ?? null,
        summary,
        delta: {
          new_events: delta.newEvents,
          updated_events: delta.updatedEvents,
          unchanged_events: delta.unchangedEvents,
          no_longer_present_events: delta.noLongerPresentEvents,
        },
        persistence_trends: persistenceTrends,
      }

      const rawDataPayload = {
        generated_at: generatedAt,
        mode,
        scope,
        run_id: runId,
        baseline_run_id: baseline?.runId ?? null,
        tickers,
        tier: {
          id: auth.tier,
          label: quiverPlanLabel(auth.tier),
          inferred: auth.inferred,
          warning: auth.warning,
        },
        request: {
          limit_requested: limitRequested,
          limit_effective: assumptions.limit_effective,
          refresh: params.refresh ?? false,
        },
        summary,
        datasets: {
          global: globalDatasets,
          ticker: tickerDatasets,
          snapshots: datasetSnapshots,
        },
        normalized_events: normalizedEvents,
        delta: deltaPayload.delta,
        persistence_trends: persistenceTrends,
        history_runs: historyRuns.map((run) => ({
          run_id: run.runId,
          directory: run.directory,
          normalized_events_path: run.normalizedEventsPath,
          assumptions_path: run.assumptionsPath,
          normalized_event_count: run.normalizedEvents.length,
          assumptions: run.assumptions,
        })),
        rendered_payload: rendered.rawArtifactPayload,
      }

      const files = await writeArtifacts({
        ctx,
        runDirectory,
        reportMarkdown,
        dashboardMarkdown,
        assumptionsJson: `${JSON.stringify(assumptions, null, 2)}\n`,
        normalizedEventsJson: `${JSON.stringify(normalizedEvents, null, 2)}\n`,
        deltaEventsJson: `${JSON.stringify(deltaPayload, null, 2)}\n`,
        dataJson: `${JSON.stringify(rawDataPayload, null, 2)}\n`,
      })

      const metadata: ReportGovernmentTradingMetadata = {
        mode,
        scope,
        tier: auth.tier,
        generated_at: generatedAt,
        run_id: runId,
        baseline_run_id: baseline?.runId ?? null,
        output_root: runDirectory,
        report_path: files.reportPath,
        dashboard_path: files.dashboardPath,
        assumptions_path: files.assumptionsPath,
        normalized_events_path: files.normalizedEventsPath,
        delta_events_path: files.deltaEventsPath,
        data_path: files.dataPath,
        summary,
      }

      return {
        title:
          mode === "ticker"
            ? `report_government_trading: ${scope}`
            : scope === "global"
              ? "report_government_trading: global"
              : `report_government_trading: portfolio (${tickers.length})`,
        metadata,
        output: JSON.stringify(
          {
            generated_at: generatedAt,
            mode,
            scope,
            run_id: runId,
            baseline_run_id: baseline?.runId ?? null,
            summary,
            artifacts: {
              output_root: runDirectory,
              report: files.reportPath,
              dashboard: files.dashboardPath,
              assumptions: files.assumptionsPath,
              normalized_events: files.normalizedEventsPath,
              delta_events: files.deltaEventsPath,
              data: files.dataPath,
            },
          },
          null,
          2,
        ),
      }
    },
  }
})
