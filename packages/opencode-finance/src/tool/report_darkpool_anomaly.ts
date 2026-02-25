import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./report_darkpool_anomaly.txt"
import { Auth } from "../auth"
import { Env } from "../env"
import { FINANCE_AUTH_PROVIDER } from "../finance/auth-provider"
import { listPortfolio } from "../finance/portfolio"
import { normalizeTicker } from "../finance/parser"
import {
  endpointMinimumPlan,
  quiverPlanLabel,
  resolveQuiverTierFromAuth,
  type QuiverTier,
} from "../finance/quiver-tier"
import * as QuiverReport from "../finance/providers/quiver-report"
import {
  analyzeTickerOffExchange,
  classifyAnomalyTransitions,
  normalizeThresholds,
  toAnomalyRecord,
  type AnomalyRecord,
  type TransitionRecord,
  type TickerAnalysis,
} from "../finance/darkpool-anomaly"
import { assertExternalDirectory } from "./external-directory"

const LOGIN_HINT =
  "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const parameters = z.object({
  ticker: z.string().optional().describe("Optional ticker for ticker mode; omit for portfolio mode."),
  output_root: z.string().optional().describe("Optional report directory override."),
  lookback_days: z.number().int().min(14).max(730).optional().describe("Lookback window for baseline computation."),
  min_samples: z.number().int().min(10).max(365).optional().describe("Minimum baseline sample size required."),
  significance_threshold: z.number().positive().max(10).optional().describe("Absolute robust z-score threshold for anomaly significance."),
  severity_medium: z.number().positive().max(20).optional().describe("Optional medium-severity threshold override."),
  severity_high: z.number().positive().max(20).optional().describe("Optional high-severity threshold override."),
  limit: z.number().int().min(10).max(500).optional().describe("Maximum off-exchange rows used for analysis."),
  refresh: z.boolean().optional().describe("Reserved for compatibility; Quiver endpoints are always fetched live."),
})

type DarkpoolMetadata = {
  mode: "ticker" | "portfolio"
  tier: QuiverTier
  output_root: string
  report_path: string
  dashboard_path: string
  assumptions_path: string
  evidence_path: string
  anomalies: number
  transitions: {
    new: number
    persisted: number
    severity_change: number
    resolved: number
  }
  historical_runs_considered: number
}

type TickerRun = {
  ticker: string
  source_url: string
  retrieved_at: string
  row_count: number
  analysis: TickerAnalysis
  anomaly?: AnomalyRecord
}

type HistoricalRun = {
  generated_at: string
  anomalies: AnomalyRecord[]
  path: string
}

function projectRoot(context: Pick<Tool.Context, "directory" | "worktree">) {
  return context.worktree === "/" ? context.directory : context.worktree
}

function dateToday() {
  return new Date().toISOString().slice(0, 10)
}

function defaultRoot(
  context: Pick<Tool.Context, "directory" | "worktree">,
  mode: "ticker" | "portfolio",
  ticker?: string,
  date = dateToday(),
) {
  if (mode === "ticker") return path.join(projectRoot(context), "reports", ticker!, date, "darkpool-anomaly")
  return path.join(projectRoot(context), "reports", "portfolio", date, "darkpool-anomaly")
}

function asRelative(worktree: string, filepath: string) {
  return path.relative(worktree, filepath)
}

function formatNumber(input: number, digits = 4) {
  if (!Number.isFinite(input)) return "unknown"
  return input.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  })
}

function transitionCounts(input: TransitionRecord[]) {
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

function renderDashboard(input: {
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

function renderTransitions(input: TransitionRecord[]) {
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

function renderReport(input: {
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

function renderEvidenceMarkdown(input: {
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

async function resolveAuth() {
  const auth = await Auth.get("quiver-quant")
  const env = FINANCE_AUTH_PROVIDER["quiver-quant"].env.map((key) => Env.get(key)).find(Boolean)

  if (!auth || auth.type !== "api") {
    if (env) {
      throw new Error(`Quiver plan metadata is missing. Run \`${LOGIN_HINT}\` to store key + plan.`)
    }
    throw new Error(`Quiver Quant is required for darkpool anomaly analysis. Run \`${LOGIN_HINT}\`.`)
  }

  const key = env ?? auth.key
  if (!key?.trim()) {
    throw new Error(`Quiver Quant API key is missing. Run \`${LOGIN_HINT}\`.`)
  }

  const tier = resolveQuiverTierFromAuth(auth)

  return {
    key,
    tier: tier.tier,
  }
}

async function fetchRequiredOffExchange(input: {
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

async function readHistoricalRuns(input: { scopeRoots: string[]; outputRoot: string }): Promise<HistoricalRun[]> {
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

async function writeArtifacts(input: {
  outputRoot: string
  report: string
  dashboard: string
  assumptions: string
  evidence: string
  evidenceMd: string
  ctx: Tool.Context
}) {
  await assertExternalDirectory(input.ctx, input.outputRoot, { kind: "directory" })
  await fs.mkdir(input.outputRoot, { recursive: true })

  const worktree = projectRoot(input.ctx)
  const reportPath = path.join(input.outputRoot, "report.md")
  const dashboardPath = path.join(input.outputRoot, "dashboard.md")
  const assumptionsPath = path.join(input.outputRoot, "assumptions.json")
  const evidencePath = path.join(input.outputRoot, "evidence.json")
  const evidenceMdPath = path.join(input.outputRoot, "evidence.md")

  await input.ctx.ask({
    permission: "edit",
    patterns: [
      asRelative(worktree, reportPath),
      asRelative(worktree, dashboardPath),
      asRelative(worktree, assumptionsPath),
      asRelative(worktree, evidencePath),
      asRelative(worktree, evidenceMdPath),
    ],
    always: ["*"],
    metadata: {
      output_root: input.outputRoot,
      report_path: reportPath,
      dashboard_path: dashboardPath,
      assumptions_path: assumptionsPath,
      evidence_path: evidencePath,
      evidence_md_path: evidenceMdPath,
    },
  })

  await Promise.all([
    Bun.write(reportPath, input.report),
    Bun.write(dashboardPath, input.dashboard),
    Bun.write(assumptionsPath, input.assumptions),
    Bun.write(evidencePath, input.evidence),
    Bun.write(evidenceMdPath, input.evidenceMd),
  ])

  return {
    reportPath,
    dashboardPath,
    assumptionsPath,
    evidencePath,
    evidenceMdPath,
  }
}

export const ReportDarkpoolAnomalyTool = Tool.define("report_darkpool_anomaly", async () => {
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
          patterns: ["list", "report", "darkpool"],
          always: ["*"],
          metadata: {
            action: "report_darkpool_anomaly",
          },
        })
      }

      const tickers =
        mode === "ticker"
          ? [ticker]
          : await listPortfolio().then((items) => [...new Set(items.map((item) => normalizeTicker(item.ticker)).filter(Boolean))])

      if (tickers.length === 0) {
        throw new Error(
          "No holdings found for portfolio mode. Add holdings with `/portfolio <ticker> <price_bought> <YYYY-MM-DD>` or run ticker mode directly with `/financial-darkpool-anomaly <ticker>`.",
        )
      }

      await ctx.ask({
        permission: "financial_search",
        patterns: tickers.map((item) => `${item} off exchange darkpool`),
        always: ["*"],
        metadata: {
          source: "report_darkpool_anomaly",
          mode,
          tier: auth.tier,
          refresh: params.refresh,
        },
      })

      const lookbackDays = params.lookback_days ?? 120
      const minSamples = params.min_samples ?? 30
      const threshold = normalizeThresholds({
        significance: params.significance_threshold ?? 3,
        medium: params.severity_medium,
        high: params.severity_high,
      })

      const limit = params.limit ?? 200
      const tickerRuns = await Promise.all(
        tickers.map(async (symbol) => {
          const dataset = await fetchRequiredOffExchange({
            ticker: symbol,
            apiKey: auth.key,
            tier: auth.tier,
            limit,
            signal: ctx.abort,
          })

          const analysis = analyzeTickerOffExchange({
            ticker: symbol,
            rows: dataset.rows,
            lookback_days: lookbackDays,
            min_samples: minSamples,
            thresholds: threshold,
          })

          return {
            ticker: symbol,
            source_url: dataset.source_url,
            retrieved_at: dataset.timestamp,
            row_count: dataset.rows.length,
            analysis,
            anomaly: toAnomalyRecord(analysis),
          } satisfies TickerRun
        }),
      )

      const outputRoot = params.output_root
        ? path.isAbsolute(params.output_root)
          ? path.normalize(params.output_root)
          : path.resolve(ctx.directory, params.output_root)
        : defaultRoot(ctx, mode, ticker)

      const base = projectRoot(ctx)
      const scopeRoots =
        mode === "ticker"
          ? [path.join(base, "reports", ticker)]
          : [path.join(base, "reports", "portfolio")]

      const history = await readHistoricalRuns({
        scopeRoots,
        outputRoot,
      })

      const latestPrior = history.at(-1)
      const currentAnomalies = tickerRuns.flatMap((item) => (item.anomaly ? [item.anomaly] : []))
      const previousAnomalies = latestPrior?.anomalies ?? []
      const transitions = classifyAnomalyTransitions(currentAnomalies, previousAnomalies)
      const counts = transitionCounts(transitions)

      const generatedAt = new Date().toISOString()
      const assumptions = {
        generated_at: generatedAt,
        mode,
        tier: auth.tier,
        tickers,
        detection_parameters: {
          lookback_days: lookbackDays,
          min_samples: minSamples,
          significance_threshold: threshold.significance,
          severity_medium: threshold.medium,
          severity_high: threshold.high,
          dataset_limit: limit,
        },
        statistical_contract: {
          center: "median",
          dispersion: "MAD with IQR/stddev fallbacks",
          two_sided_significance: true,
          strict_failures: {
            missing_auth_or_tier: true,
            required_dataset_failure: true,
            insufficient_baseline_samples: true,
            zero_dispersion_baseline: true,
            artifact_write_failure: true,
          },
        },
      }

      const evidence = {
        generated_at: generatedAt,
        mode,
        tier: auth.tier,
        lookback_days: lookbackDays,
        min_samples: minSamples,
        threshold,
        tickers: tickerRuns,
        anomalies: currentAnomalies,
        transitions,
        historical: {
          considered_runs: history.length,
          latest_prior_generated_at: latestPrior?.generated_at,
          latest_prior_path: latestPrior?.path,
          prior_paths: history.map((item) => item.path),
        },
      }

      const report = renderReport({
        generated_at: generatedAt,
        mode,
        tier: auth.tier,
        lookback_days: lookbackDays,
        min_samples: minSamples,
        threshold: threshold.significance,
        tickers: tickerRuns,
        transitions,
        priorRuns: history.length,
        latestPrior: latestPrior?.generated_at,
      })

      const dashboard = renderDashboard({
        generated_at: generatedAt,
        mode,
        tickers: tickerRuns,
        transitions,
        threshold: threshold.significance,
        priorRuns: history.length,
      })

      const evidenceMd = renderEvidenceMarkdown({
        generated_at: generatedAt,
        tickers: tickerRuns,
        transitions,
      })

      const files = await writeArtifacts({
        outputRoot,
        report,
        dashboard,
        assumptions: JSON.stringify(assumptions, null, 2),
        evidence: JSON.stringify(evidence, null, 2),
        evidenceMd,
        ctx,
      })

      const metadata: DarkpoolMetadata = {
        mode,
        tier: auth.tier,
        output_root: outputRoot,
        report_path: files.reportPath,
        dashboard_path: files.dashboardPath,
        assumptions_path: files.assumptionsPath,
        evidence_path: files.evidencePath,
        anomalies: currentAnomalies.length,
        transitions: counts,
        historical_runs_considered: history.length,
      }

      return {
        title: mode === "ticker" ? `report_darkpool_anomaly: ${ticker}` : `report_darkpool_anomaly: portfolio (${tickers.length})`,
        metadata,
        output: JSON.stringify(
          {
            generated_at: generatedAt,
            mode,
            tier: auth.tier,
            tickers,
            anomalies: currentAnomalies,
            transitions,
            artifacts: {
              output_root: outputRoot,
              report: files.reportPath,
              dashboard: files.dashboardPath,
              assumptions: files.assumptionsPath,
              evidence: files.evidencePath,
              evidence_markdown: files.evidenceMdPath,
            },
          },
          null,
          2,
        ),
      }
    },
  }
})
