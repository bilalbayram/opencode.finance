import path from "path"
import z from "zod"
import { Tool } from "../tool"
import DESCRIPTION from "./financial_political_backtest.txt"
import { Auth } from "../../auth"
import { normalizeTicker } from "../../finance/parser"
import { listPortfolio } from "../../finance/portfolio"
import {
  endpointMinimumPlan,
  quiverPlanLabel,
  resolveQuiverTierFromAuth,
  tierAllows,
  type QuiverTier,
} from "../../finance/quiver-tier"
import * as QuiverReport from "../../finance/providers/quiver-report"
import { projectRoot, resolveQuiverAuth, writeToolArtifacts } from "../_shared"
import {
  EventStudyError,
  computeEventWindowReturns,
  aggregateByWindow,
  normalizePoliticalEvents,
  resolveAnchors,
  runPoliticalEventStudyCore,
  type BacktestRunSnapshot,
  type BenchmarkMode,
  type EventAnchorMode,
  type NonTradingAlignment,
} from "../../finance/political-backtest"
import type { BacktestMetadata, BacktestArtifactPaths } from "./types"
import { toReport, toDashboard } from "./render"
import { parseChartBars, fetchYahooDailyBars, fetchSector } from "./market-data"
import { selectBenchmarksByTicker, computePortfolioBenchmarkRelativeRows } from "./benchmark"
import { buildRunComparison } from "./comparison"

const LOGIN_HINT =
  "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

const DEFAULT_WINDOWS = [5]
const DEFAULT_ALIGNMENT: NonTradingAlignment = "next_session"
const BACKTEST_WORKFLOW_DIR = "political-backtest"

const parameters = z.object({
  ticker: z.string().optional().describe("Optional ticker symbol. Omit for portfolio mode."),
  anchor: z
    .enum(["transaction", "report", "both"])
    .optional()
    .describe("Event anchor mode. Defaults to transaction."),
  windows: z.array(z.number().int().min(1).max(252)).optional().describe("Forward windows in trading sessions."),
  benchmark_mode: z
    .enum(["spy_only", "spy_plus_sector_if_relevant", "spy_plus_sector_required"])
    .optional()
    .describe("Benchmark policy. Defaults to spy_plus_sector_if_relevant."),
  output_root: z.string().optional().describe("Optional report output directory override."),
  limit: z.number().int().min(1).max(200).optional().describe("Rows limit per dataset (default: 100)."),
  refresh: z.boolean().optional().describe("Reserved for compatibility; datasets are fetched live."),
})

function scopeLabel(input: { mode: "ticker" | "portfolio"; ticker?: string }) {
  if (input.mode === "portfolio") return "portfolio"
  return input.ticker!
}

function defaultOutputRoot(input: {
  context: Pick<Tool.Context, "directory" | "worktree">
  mode: "ticker" | "portfolio"
  ticker?: string
}) {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(projectRoot(input.context), "reports", BACKTEST_WORKFLOW_DIR, scopeLabel(input), date)
}

function toDate(input: string) {
  return new Date(`${input}T00:00:00Z`)
}

function isoDate(input: Date) {
  return input.toISOString().slice(0, 10)
}

function addDays(input: Date, days: number) {
  const value = new Date(input)
  value.setUTCDate(value.getUTCDate() + days)
  return value
}

function resolveAuthFromState(input: {
  auth: Awaited<ReturnType<typeof Auth.get>>
  env: string | undefined
}) {
  const auth = input.auth
  if (!auth || auth.type !== "api") {
    if (input.env) {
      throw new Error(`Quiver plan metadata is missing. Run \`${LOGIN_HINT}\` to store key + plan.`)
    }
    throw new Error(`Quiver Quant is required for political backtests. Run \`${LOGIN_HINT}\`.`)
  }

  const key = input.env ?? auth.key
  if (!key?.trim()) {
    throw new Error(`Quiver Quant API key is missing. Run \`${LOGIN_HINT}\`.`)
  }

  const tier = resolveQuiverTierFromAuth(auth)
  if (!tierAllows("tier_1", tier.tier)) {
    throw new Error(
      `Quiver plan ${quiverPlanLabel(tier.tier)} does not include government-trading datasets required by this backtest. Upgrade to ${endpointMinimumPlan("tier_1")} and rerun \`${LOGIN_HINT}\`.`,
    )
  }

  return {
    key,
    tier: tier.tier,
    inferred: tier.inferred,
    warning: tier.warning,
  }
}

async function resolveAuth() {
  return resolveQuiverAuth({
    requiredEndpointTier: "tier_1",
    capabilityLabel: "Tier 1 government-trading datasets required by this backtest",
  })
}

function assertDatasetsComplete(datasets: QuiverReport.QuiverReportDataset[]) {
  const failed = datasets.filter((item) => item.status !== "ok")
  if (failed.length > 0) {
    const details = failed.map((item) => `${item.id}: ${item.error?.message ?? item.status}`).join("; ")
    throw new Error(`Backtest requires complete Tier 1 government-trading coverage. Failed datasets: ${details}`)
  }
}

function portfolioTickersFromHoldings(holdings: Array<{ ticker: string }>) {
  const tickers = [...new Set(holdings.map((item) => normalizeTicker(item.ticker)).filter(Boolean))]
  if (tickers.length === 0) {
    throw new Error("No holdings found. Add holdings with `/portfolio <ticker> <price_bought> <YYYY-MM-DD>` first.")
  }
  return tickers
}

function marketDateBounds(input: {
  anchors: ReturnType<typeof resolveAnchors>
  windows: number[]
}) {
  const all = input.anchors.map((item) => item.anchor_date)
  if (all.length === 0) {
    throw new EventStudyError("No anchors were resolved for this backtest run.", "EMPTY_EVENT_SET")
  }
  const startAnchor = all.toSorted((a, b) => a.localeCompare(b))[0]!
  const endAnchor = all.toSorted((a, b) => b.localeCompare(a))[0]!
  const maxWindow = Math.max(...input.windows)

  return {
    startDate: isoDate(addDays(toDate(startAnchor), -15)),
    endDate: isoDate(addDays(toDate(endAnchor), maxWindow * 4 + 10)),
  }
}

async function writeArtifacts(input: {
  ctx: Tool.Context
  outputRoot: string
  report: string
  dashboard: string
  assumptions: string
  events: string
  windowReturns: string
  benchmarkReturns: string
  aggregate: string
  comparison: string
}): Promise<BacktestArtifactPaths> {
  const filesToWrite = {
    "report.md": input.report,
    "dashboard.md": input.dashboard,
    "assumptions.json": input.assumptions,
    "events.json": input.events,
    "event-window-returns.json": input.windowReturns,
    "benchmark-relative-returns.json": input.benchmarkReturns,
    "aggregate-results.json": input.aggregate,
    "comparison.json": input.comparison,
  }
  const archived = Object.keys(filesToWrite).map((name) => path.join(input.outputRoot, name))
  const files = await writeToolArtifacts({
    ctx: input.ctx,
    outputRoot: input.outputRoot,
    files: filesToWrite,
    archivePaths: archived,
  })

  return {
    reportPath: files["report.md"]!,
    dashboardPath: files["dashboard.md"]!,
    assumptionsPath: files["assumptions.json"]!,
    eventsPath: files["events.json"]!,
    windowReturnsPath: files["event-window-returns.json"]!,
    benchmarkReturnsPath: files["benchmark-relative-returns.json"]!,
    aggregatePath: files["aggregate-results.json"]!,
    comparisonPath: files["comparison.json"]!,
  }
}

export const FinancialPoliticalBacktestTool = Tool.define("financial_political_backtest", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      const inputTicker = normalizeTicker(params.ticker ?? "")
      const mode: "ticker" | "portfolio" = inputTicker ? "ticker" : "portfolio"
      let tickers: string[] = []

      if (mode === "ticker") {
        tickers = [inputTicker]
      } else {
        await ctx.ask({
          permission: "portfolio",
          patterns: ["list", "report", "backtest"],
          always: ["*"],
          metadata: {
            action: "financial_political_backtest",
            mode: "portfolio",
          },
        })
        const holdings = await listPortfolio()
        tickers = portfolioTickersFromHoldings(holdings)
      }

      const auth = await resolveAuth()
      const anchorMode: EventAnchorMode = params.anchor ?? "transaction"
      const windows = [...new Set((params.windows?.length ? params.windows : DEFAULT_WINDOWS).map((item) => Math.floor(item)).filter((item) => item > 0))]
      if (windows.length === 0) {
        throw new Error("windows must include at least one positive integer")
      }
      const benchmarkMode: BenchmarkMode = params.benchmark_mode ?? "spy_plus_sector_if_relevant"

      await ctx.ask({
        permission: "financial_search",
        patterns: [...tickers.map((item) => `${item} political trading`), ...tickers.map((item) => `${item} market history`), "SPY market history"],
        always: ["*"],
        metadata: {
          source: "financial_political_backtest_tool",
          mode,
          tickers,
          anchor_mode: anchorMode,
          windows,
          benchmark_mode: benchmarkMode,
          refresh: params.refresh,
        },
      })

      const limit = params.limit ?? 100
      const datasetsByTicker = await Promise.all(
        tickers.map(async (ticker) => ({
          ticker,
          datasets: await QuiverReport.fetchTickerGovTrading({
            apiKey: auth.key,
            tier: auth.tier,
            ticker,
            limit,
            signal: ctx.abort,
          }),
        })),
      )
      datasetsByTicker.forEach((item) => assertDatasetsComplete(item.datasets))

      const normalizedByTicker = datasetsByTicker.map((item) => ({
        ticker: item.ticker,
        events: normalizePoliticalEvents({
          ticker: item.ticker,
          datasets: item.datasets.map((dataset) => ({
            id: dataset.id,
            rows: dataset.rows,
          })),
        }),
      }))
      const normalized = normalizedByTicker.flatMap((item) => item.events)

      const anchors = resolveAnchors(normalized, anchorMode)
      const bounds = marketDateBounds({
        anchors,
        windows,
      })

      const sectorsByTicker = (
        await Promise.all(
          tickers.map(async (ticker) => {
            const sector = await fetchSector({
              ticker,
              signal: ctx.abort,
            })
            return [ticker, sector] as const
          }),
        )
      ).reduce(
        (acc, [ticker, sector]) => {
          acc[ticker] = sector
          return acc
        },
        {} as Record<string, string | null>,
      )

      const benchmarkSelection = selectBenchmarksByTicker({
        tickers,
        benchmarkMode,
        sectorsByTicker,
      })
      const benchmarkSymbolsByTicker = Object.fromEntries(
        Object.entries(benchmarkSelection.byTicker).map(([ticker, selected]) => [ticker, selected.symbols]),
      )
      const requiredSymbols = [...new Set([...tickers, ...benchmarkSelection.symbols])]
      const priceBySymbol = (
        await Promise.all(
          requiredSymbols.map(async (symbol) => {
            const bars = await fetchYahooDailyBars({
              symbol,
              startDate: bounds.startDate,
              endDate: bounds.endDate,
              signal: ctx.abort,
            })
            return [symbol, bars] as const
          }),
        )
      ).reduce(
        (acc, [symbol, bars]) => {
          acc[symbol] = bars
          return acc
        },
        {} as Record<string, import("../../finance/political-backtest").PriceBar[]>,
      )

      const core =
        mode === "ticker"
          ? runPoliticalEventStudyCore({
            events: normalized,
            anchor_mode: anchorMode,
            windows,
            alignment: DEFAULT_ALIGNMENT,
            benchmark_mode: benchmarkMode,
            sector: sectorsByTicker[tickers[0]!] ?? null,
            price_by_symbol: priceBySymbol,
          })
          : (() => {
            const eventWindowReturns = computeEventWindowReturns({
              events: normalized,
              anchor_mode: anchorMode,
              windows,
              alignment: DEFAULT_ALIGNMENT,
              price_by_symbol: priceBySymbol,
            })
            const benchmarkRelativeReturns = computePortfolioBenchmarkRelativeRows({
              tickers,
              eventWindowReturns,
              benchmarkSymbolsByTicker,
              alignment: DEFAULT_ALIGNMENT,
              price_by_symbol: priceBySymbol,
            })
            return {
              event_window_returns: eventWindowReturns,
              benchmark_relative_returns: benchmarkRelativeReturns,
              aggregates: aggregateByWindow(benchmarkRelativeReturns),
              benchmark_selection: {
                symbols: benchmarkSelection.symbols,
                rationale: benchmarkSelection.rationale,
                sector: null,
                sector_etf: null,
              },
            }
          })()

      const scopeKey = mode === "ticker" ? tickers[0]! : "portfolio"
      const outputRoot = params.output_root
        ? path.isAbsolute(params.output_root)
          ? path.normalize(params.output_root)
          : path.resolve(ctx.directory, params.output_root)
        : defaultOutputRoot({
          context: ctx,
          mode,
          ticker: tickers[0],
        })

      const generatedAt = new Date().toISOString()
      const currentSnapshot: BacktestRunSnapshot = {
        workflow: "financial_political_backtest",
        output_root: outputRoot,
        generated_at: generatedAt,
        aggregates: core.aggregates,
        event_ids: [...new Set(normalized.map((item) => item.event_id))].sort((a, b) => a.localeCompare(b)),
      }
      const comparison = await buildRunComparison({
        reportsRoot: projectRoot(ctx),
        scopeKey,
        currentSnapshot,
      })

      const warnings = [
        ...(auth.warning ? [auth.warning] : []),
        ...(auth.inferred ? ["Quiver plan tier was inferred from fallback metadata."] : []),
      ]

      const assumptions = {
        workflow: "financial_political_backtest",
        generated_at: generatedAt,
        mode,
        scope_key: scopeKey,
        ticker: mode === "ticker" ? tickers[0] : undefined,
        tickers,
        anchor_mode: anchorMode,
        windows,
        alignment_policy: DEFAULT_ALIGNMENT,
        benchmark_mode: benchmarkMode,
        benchmark_selection: core.benchmark_selection,
        sectors_by_ticker: sectorsByTicker,
        quiver: {
          tier: auth.tier,
          inferred: auth.inferred,
          warning: auth.warning,
          datasets_by_ticker: datasetsByTicker.map((item) => ({
            ticker: item.ticker,
            datasets: item.datasets.map((dataset) => ({
              id: dataset.id,
              label: dataset.label,
              source_url: dataset.source_url,
              rows: dataset.rows.length,
              status: dataset.status,
            })),
          })),
        },
        market_history: {
          start_date: bounds.startDate,
          end_date: bounds.endDate,
          symbols: Object.keys(priceBySymbol),
        },
        historical_comparison: {
          first_run: comparison.first_run,
          baseline: comparison.baseline,
          event_sample: comparison.event_sample,
          conclusion_changes: comparison.conclusion_changes,
        },
        policy: {
          strict_failure: true,
          non_advisory: true,
        },
      }

      const report = toReport({
        mode,
        tickers,
        anchorMode,
        windows,
        benchmarkMode,
        generatedAt,
        events: normalized.length,
        benchmarkSymbols: core.benchmark_selection.symbols,
        benchmarkRationale: core.benchmark_selection.rationale,
        aggregates: core.aggregates,
        comparison,
        warnings,
      })

      const dashboard = toDashboard({
        mode,
        tickers,
        events: normalized.length,
        benchmarks: core.benchmark_selection.symbols,
        aggregates: core.aggregates,
        comparison,
      })

      const files = await writeArtifacts({
        ctx,
        outputRoot,
        report,
        dashboard,
        assumptions: JSON.stringify(assumptions, null, 2),
        events: JSON.stringify(normalized, null, 2),
        windowReturns: JSON.stringify(core.event_window_returns, null, 2),
        benchmarkReturns: JSON.stringify(core.benchmark_relative_returns, null, 2),
        aggregate: JSON.stringify(core.aggregates, null, 2),
        comparison: JSON.stringify(comparison, null, 2),
      })

      const metadata: BacktestMetadata = {
        mode,
        ticker: mode === "ticker" ? tickers[0] : undefined,
        tickers,
        anchor_mode: anchorMode,
        windows,
        benchmark_mode: benchmarkMode,
        quiver_tier: auth.tier,
        output_root: outputRoot,
        report_path: files.reportPath,
        dashboard_path: files.dashboardPath,
        assumptions_path: files.assumptionsPath,
        raw_paths: [files.eventsPath, files.windowReturnsPath, files.benchmarkReturnsPath, files.aggregatePath, files.comparisonPath],
        events: normalized.length,
      }

      return {
        title: mode === "ticker" ? `financial_political_backtest: ${tickers[0]}` : `financial_political_backtest: portfolio (${tickers.length})`,
        metadata,
        output: JSON.stringify(
          {
            generated_at: generatedAt,
            mode,
            scope_key: scopeKey,
            ticker: mode === "ticker" ? tickers[0] : undefined,
            tickers,
            events: normalized.length,
            aggregate_rows: core.aggregates.length,
            artifacts: {
              output_root: outputRoot,
              report: files.reportPath,
              dashboard: files.dashboardPath,
              assumptions: files.assumptionsPath,
              raw: {
                events: files.eventsPath,
                event_window_returns: files.windowReturnsPath,
                benchmark_relative_returns: files.benchmarkReturnsPath,
                aggregate: files.aggregatePath,
                comparison: files.comparisonPath,
              },
            },
          },
          null,
          2,
        ),
      }
    },
  }
})

export const FinancialPoliticalBacktestInternal = {
  resolveAuthFromState,
  assertDatasetsComplete,
  portfolioTickersFromHoldings,
  defaultOutputRoot,
  selectBenchmarksByTicker,
  computePortfolioBenchmarkRelativeRows,
  buildRunComparison,
  writeArtifacts,
  parseChartBars,
  fetchYahooDailyBars,
  marketDateBounds,
  toReport,
  toDashboard,
}
