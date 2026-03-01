import path from "path"
import z from "zod"
import { Tool } from "../tool"
import DESCRIPTION from "./report_government_trading.txt"
import { normalizeTicker } from "../../finance/parser"
import { computeGovernmentTradingDelta } from "../../finance/government-trading/delta"
import { loadGovernmentTradingHistory } from "../../finance/government-trading/history"
import { normalizeGovernmentTradingEvents } from "../../finance/government-trading/normalize"
import { renderGovernmentTradingArtifacts } from "../../finance/government-trading/renderer"
import { collectGovernmentTradingSourceRows } from "../../finance/government-trading/source-rows"
import { quiverPlanLabel, type QuiverTier } from "../../finance/quiver-tier"
import * as QuiverReport from "../../finance/providers/quiver-report"
import { projectRoot, resolveQuiverAuth, writeToolArtifacts } from "../_shared"
import type { ReportGovernmentTradingMode, ReportGovernmentTradingMetadata } from "./types"
import { projectDatasetSnapshots, assertRequiredDatasets, buildReportMarkdown, buildDashboardMarkdown } from "./render"
import { clampLimit, createRunId, buildPersistenceTrends } from "./persistence"

const REQUIRED_GLOBAL_IDS = ["global_congress_trading", "global_senate_trading", "global_house_trading"] as const
const REQUIRED_TICKER_IDS = ["ticker_congress_trading", "ticker_senate_trading", "ticker_house_trading"] as const

const parameters = z.object({
  ticker: z.string().optional().describe("Optional ticker for ticker mode; omit for global mode."),
  output_root: z
    .string()
    .optional()
    .describe("Optional output root. Defaults to reports/government-trading under the project/worktree."),
  limit: z.number().int().min(1).max(200).optional().describe("Optional dataset limit (1..200, default 50)."),
  refresh: z.boolean().optional().describe("Pass-through refresh metadata flag for orchestrators."),
})

function normalizeOutputRoot(context: Pick<Tool.Context, "directory" | "worktree">, outputRoot?: string) {
  if (!outputRoot) return path.join(projectRoot(context), "reports", "government-trading")
  return path.isAbsolute(outputRoot) ? path.normalize(outputRoot) : path.resolve(context.directory, outputRoot)
}

function normalizeScope(mode: ReportGovernmentTradingMode, ticker: string) {
  if (mode === "ticker") return ticker
  return "global"
}

async function resolveAuth() {
  return resolveQuiverAuth({
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
  const files = await writeToolArtifacts({
    ctx: input.ctx,
    outputRoot: input.runDirectory,
    files: {
      "report.md": input.reportMarkdown,
      "dashboard.md": input.dashboardMarkdown,
      "assumptions.json": input.assumptionsJson,
      "normalized-events.json": input.normalizedEventsJson,
      "delta-events.json": input.deltaEventsJson,
      "data.json": input.dataJson,
    },
  })

  return {
    reportPath: files["report.md"]!,
    dashboardPath: files["dashboard.md"]!,
    assumptionsPath: files["assumptions.json"]!,
    normalizedEventsPath: files["normalized-events.json"]!,
    deltaEventsPath: files["delta-events.json"]!,
    dataPath: files["data.json"]!,
  }
}

export const ReportGovernmentTradingTool = Tool.define("report_government_trading", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      const auth = await resolveAuth()
      const mode: ReportGovernmentTradingMode = params.ticker ? "ticker" : "global"
      const ticker = params.ticker ? normalizeTicker(params.ticker) : ""

      if (mode === "ticker" && !ticker) {
        throw new Error("ticker must include at least one valid symbol character")
      }

      const tickers = mode === "ticker" ? [ticker] : []

      const scope = normalizeScope(mode, ticker)
      const limitRequested = params.limit ?? 50
      const limitEffective = clampLimit(limitRequested)
      const generatedAt = new Date().toISOString()
      const runId = createRunId(generatedAt)

      const outputBase = normalizeOutputRoot(ctx, params.output_root)
      const historyRoot =
        mode === "ticker" ? path.join(outputBase, "ticker", scope) : path.join(outputBase, "global")
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
        title: mode === "ticker" ? `Government Trading Report (${scope})` : "Government Trading Report (Global)",
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
        title: mode === "ticker" ? `report_government_trading: ${scope}` : "report_government_trading: global",
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
