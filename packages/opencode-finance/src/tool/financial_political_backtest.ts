import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./financial_political_backtest.txt"
import { Auth } from "../auth"
import { Env } from "../env"
import { FINANCE_AUTH_PROVIDER } from "../finance/auth-provider"
import { normalizeTicker } from "../finance/parser"
import {
  endpointMinimumPlan,
  quiverPlanLabel,
  resolveQuiverTierFromAuth,
  tierAllows,
  type QuiverTier,
} from "../finance/quiver-tier"
import * as QuiverReport from "../finance/providers/quiver-report"
import { assertExternalDirectory } from "./external-directory"
import {
  compareRuns,
  discoverHistoricalRuns,
  EventStudyError,
  normalizePoliticalEvents,
  resolveAnchors,
  selectBenchmarks,
  runPoliticalEventStudyCore,
  type BacktestRunComparison,
  type BacktestRunSnapshot,
  type BenchmarkMode,
  type EventAnchorMode,
  type NonTradingAlignment,
  type PriceBar,
} from "../finance/political-backtest"

const LOGIN_HINT =
  "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

const YAHOO_BASE = "https://query1.finance.yahoo.com"
const DEFAULT_WINDOWS = [5]
const DEFAULT_ALIGNMENT: NonTradingAlignment = "next_session"

const parameters = z.object({
  ticker: z.string().describe("Ticker symbol for backtest mode, for example AAPL."),
  anchor: z
    .enum(["transaction", "report", "both"])
    .optional()
    .describe("Event anchor mode. Defaults to transaction."),
  windows: z.array(z.number().int().min(1).max(252)).optional().describe("Forward windows in trading sessions."),
  benchmark_mode: z
    .enum(["spy_only", "spy_plus_sector_if_relevant", "spy_plus_sector_required"])
    .optional()
    .describe("Benchmark policy. Defaults to spy_only for tracer bullet mode."),
  output_root: z.string().optional().describe("Optional report output directory override."),
  limit: z.number().int().min(1).max(200).optional().describe("Rows limit per dataset (default: 100)."),
  refresh: z.boolean().optional().describe("Reserved for compatibility; datasets are fetched live."),
})

type BacktestMetadata = {
  mode: "ticker"
  ticker: string
  anchor_mode: EventAnchorMode
  windows: number[]
  benchmark_mode: BenchmarkMode
  quiver_tier: QuiverTier
  output_root: string
  report_path: string
  dashboard_path: string
  assumptions_path: string
  raw_paths: string[]
  events: number
}

type BacktestArtifactPaths = {
  reportPath: string
  dashboardPath: string
  assumptionsPath: string
  eventsPath: string
  windowReturnsPath: string
  benchmarkReturnsPath: string
  aggregatePath: string
  comparisonPath: string
}

function projectRoot(context: Pick<Tool.Context, "directory" | "worktree">) {
  return context.worktree === "/" ? context.directory : context.worktree
}

function defaultOutputRoot(context: Pick<Tool.Context, "directory" | "worktree">, ticker: string) {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(projectRoot(context), "reports", ticker, date)
}

function asText(input: unknown) {
  if (input === null || input === undefined) return ""
  return String(input)
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

function parseChartBars(input: { symbol: string; payload: Record<string, unknown> }): PriceBar[] {
  const chart = input.payload.chart as Record<string, unknown> | undefined
  const result = ((chart?.result as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
  const timestamps = ((result.timestamp as number[] | undefined) ?? []).filter((item) => Number.isFinite(item))
  const indicators = (result.indicators as Record<string, unknown> | undefined) ?? {}
  const adjusted = (
    ((indicators.adjclose as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined) ?? {}
  ).adjclose as Array<number | null | undefined> | undefined
  const closes = (
    ((indicators.quote as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined) ?? {}
  ).close as Array<number | null | undefined> | undefined

  const rows: PriceBar[] = []
  for (const [index, timestamp] of timestamps.entries()) {
    const date = new Date(timestamp * 1000)
    if (Number.isNaN(date.getTime())) continue
    const price = adjusted?.[index] ?? closes?.[index]
    if (!Number.isFinite(price) || (price ?? 0) <= 0) continue
    rows.push({
      symbol: input.symbol,
      date: date.toISOString().slice(0, 10),
      adjusted_close: Number(price),
    })
  }

  if (rows.length === 0) {
    throw new EventStudyError(`No usable price rows returned for ${input.symbol}.`, "MISSING_PRICE_SERIES", {
      symbol: input.symbol,
    })
  }

  return rows
}

async function fetchYahooDailyBars(input: {
  symbol: string
  startDate: string
  endDate: string
  signal?: AbortSignal
}): Promise<PriceBar[]> {
  const start = Math.floor(toDate(input.startDate).getTime() / 1000)
  const end = Math.floor(addDays(toDate(input.endDate), 1).getTime() / 1000)
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(input.symbol)}?period1=${start}&period2=${end}&interval=1d&events=history&includeAdjustedClose=true`
  const response = await fetch(url, {
    signal: input.signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "opencode-finance/1.0",
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new EventStudyError(
      `Failed to load market history for ${input.symbol} from Yahoo (${response.status}): ${body || "request failed"}`,
      "MISSING_PRICE_SERIES",
      {
        symbol: input.symbol,
        status: response.status,
      },
    )
  }
  const payload = (await response.json()) as Record<string, unknown>
  return parseChartBars({ symbol: input.symbol, payload })
}

async function fetchSector(input: { ticker: string; signal?: AbortSignal }): Promise<string | null> {
  const modules = "assetProfile"
  const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(input.ticker)}?modules=${encodeURIComponent(modules)}`
  const response = await fetch(url, {
    signal: input.signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "opencode-finance/1.0",
    },
  }).catch(() => undefined)

  if (!response?.ok) return null
  const payload = (await response.json()) as Record<string, unknown>
  const row = (((payload.quoteSummary as Record<string, unknown> | undefined)?.result as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
  const profile = (row.assetProfile as Record<string, unknown> | undefined) ?? {}
  const sector = asText(profile.sector).trim()
  return sector || null
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
  const auth = await Auth.get("quiver-quant")
  const env = FINANCE_AUTH_PROVIDER["quiver-quant"].env.map((key) => Env.get(key)).find(Boolean)
  return resolveAuthFromState({
    auth,
    env,
  })
}

function assertDatasetsComplete(datasets: QuiverReport.QuiverReportDataset[]) {
  const failed = datasets.filter((item) => item.status !== "ok")
  if (failed.length > 0) {
    const details = failed.map((item) => `${item.id}: ${item.error?.message ?? item.status}`).join("; ")
    throw new Error(`Backtest requires complete Tier 1 government-trading coverage. Failed datasets: ${details}`)
  }
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

function toReport(input: {
  ticker: string
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
  const lines = [
    `# Political Event Backtest: ${input.ticker}`,
    "",
    `Generated at: ${input.generatedAt}`,
    `Ticker: ${input.ticker}`,
    `Mode: ticker`,
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

function toDashboard(input: {
  ticker: string
  events: number
  benchmarks: string[]
  aggregates: ReturnType<typeof runPoliticalEventStudyCore>["aggregates"]
  comparison: BacktestRunComparison
}) {
  const lines = [
    `# Political Backtest Dashboard: ${input.ticker}`,
    "",
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

function stampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

async function archiveExistingArtifacts(outputRoot: string, paths: string[]) {
  const existing = []
  for (const filepath of paths) {
    if (await Bun.file(filepath).exists()) {
      existing.push(filepath)
    }
  }
  if (existing.length === 0) return

  const historyRoot = path.join(outputRoot, "history", stampForPath())
  await fs.mkdir(historyRoot, { recursive: true })
  await Promise.all(existing.map((filepath) => fs.rename(filepath, path.join(historyRoot, path.basename(filepath)))))
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
  await assertExternalDirectory(input.ctx, input.outputRoot, { kind: "directory" })
  await fs.mkdir(input.outputRoot, { recursive: true })
  const worktree = projectRoot(input.ctx)

  const reportPath = path.join(input.outputRoot, "report.md")
  const dashboardPath = path.join(input.outputRoot, "dashboard.md")
  const assumptionsPath = path.join(input.outputRoot, "assumptions.json")
  const eventsPath = path.join(input.outputRoot, "events.json")
  const windowReturnsPath = path.join(input.outputRoot, "event-window-returns.json")
  const benchmarkReturnsPath = path.join(input.outputRoot, "benchmark-relative-returns.json")
  const aggregatePath = path.join(input.outputRoot, "aggregate-results.json")
  const comparisonPath = path.join(input.outputRoot, "comparison.json")

  await archiveExistingArtifacts(input.outputRoot, [
    reportPath,
    dashboardPath,
    assumptionsPath,
    eventsPath,
    windowReturnsPath,
    benchmarkReturnsPath,
    aggregatePath,
    comparisonPath,
  ])

  await input.ctx.ask({
    permission: "edit",
    patterns: [
      reportPath,
      dashboardPath,
      assumptionsPath,
      eventsPath,
      windowReturnsPath,
      benchmarkReturnsPath,
      aggregatePath,
      comparisonPath,
      path.join(input.outputRoot, "history", "*"),
    ].map((item) => path.relative(worktree, item)),
    always: ["*"],
    metadata: {
      output_root: input.outputRoot,
    },
  })

  await Promise.all([
    Bun.write(reportPath, input.report),
    Bun.write(dashboardPath, input.dashboard),
    Bun.write(assumptionsPath, input.assumptions),
    Bun.write(eventsPath, input.events),
    Bun.write(windowReturnsPath, input.windowReturns),
    Bun.write(benchmarkReturnsPath, input.benchmarkReturns),
    Bun.write(aggregatePath, input.aggregate),
    Bun.write(comparisonPath, input.comparison),
  ])

  return {
    reportPath,
    dashboardPath,
    assumptionsPath,
    eventsPath,
    windowReturnsPath,
    benchmarkReturnsPath,
    aggregatePath,
    comparisonPath,
  }
}

export const FinancialPoliticalBacktestTool = Tool.define("financial_political_backtest", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      const ticker = normalizeTicker(params.ticker)
      if (!ticker) {
        throw new Error("ticker must include at least one valid symbol character")
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
        patterns: [`${ticker} political trading`, `${ticker} market history`, "SPY market history"],
        always: ["*"],
        metadata: {
          source: "financial_political_backtest_tool",
          ticker,
          anchor_mode: anchorMode,
          windows,
          benchmark_mode: benchmarkMode,
          refresh: params.refresh,
        },
      })

      const limit = params.limit ?? 100
      const datasets = await QuiverReport.fetchTickerGovTrading({
        apiKey: auth.key,
        tier: auth.tier,
        ticker,
        limit,
        signal: ctx.abort,
      })
      assertDatasetsComplete(datasets)

      const normalized = normalizePoliticalEvents({
        ticker,
        datasets: datasets.map((item) => ({
          id: item.id,
          rows: item.rows,
        })),
      })
      const anchors = resolveAnchors(normalized, anchorMode)
      const bounds = marketDateBounds({
        anchors,
        windows,
      })

      const sector = await fetchSector({
        ticker,
        signal: ctx.abort,
      })

      const benchmarkSelection = selectBenchmarks({
        sector,
        mode: benchmarkMode,
      })

      const requiredSymbols = [...new Set([ticker, ...benchmarkSelection.symbols])]
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
        {} as Record<string, PriceBar[]>,
      )

      const core = runPoliticalEventStudyCore({
        events: normalized,
        anchor_mode: anchorMode,
        windows,
        alignment: DEFAULT_ALIGNMENT,
        benchmark_mode: benchmarkMode,
        sector,
        price_by_symbol: priceBySymbol,
      })

      const outputRoot = params.output_root
        ? path.isAbsolute(params.output_root)
          ? path.normalize(params.output_root)
          : path.resolve(ctx.directory, params.output_root)
        : defaultOutputRoot(ctx, ticker)

      const generatedAt = new Date().toISOString()
      const currentSnapshot: BacktestRunSnapshot = {
        workflow: "financial_political_backtest",
        output_root: outputRoot,
        generated_at: generatedAt,
        aggregates: core.aggregates,
        event_ids: [...new Set(normalized.map((item) => item.event_id))].sort((a, b) => a.localeCompare(b)),
      }
      const priorRuns = await discoverHistoricalRuns({
        reports_root: projectRoot(ctx),
        ticker,
        exclude_output_root: outputRoot,
      })
      const comparison = compareRuns({
        current: currentSnapshot,
        baseline: priorRuns.at(-1) ?? null,
      })

      const warnings = [
        ...(auth.warning ? [auth.warning] : []),
        ...(auth.inferred ? ["Quiver plan tier was inferred from fallback metadata."] : []),
      ]

      const assumptions = {
        workflow: "financial_political_backtest",
        generated_at: generatedAt,
        mode: "ticker",
        ticker,
        anchor_mode: anchorMode,
        windows,
        alignment_policy: DEFAULT_ALIGNMENT,
        benchmark_mode: benchmarkMode,
        benchmark_selection: core.benchmark_selection,
        quiver: {
          tier: auth.tier,
          inferred: auth.inferred,
          warning: auth.warning,
          datasets: datasets.map((item) => ({
            id: item.id,
            label: item.label,
            source_url: item.source_url,
            rows: item.rows.length,
            status: item.status,
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
        ticker,
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
        ticker,
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
        mode: "ticker",
        ticker,
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
        title: `financial_political_backtest: ${ticker}`,
        metadata,
        output: JSON.stringify(
          {
            generated_at: generatedAt,
            mode: "ticker",
            ticker,
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
  parseChartBars,
  fetchYahooDailyBars,
  marketDateBounds,
  toReport,
  toDashboard,
}
