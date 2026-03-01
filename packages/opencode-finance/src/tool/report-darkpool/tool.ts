import path from "path"
import z from "zod"
import { Tool } from "../tool"
import DESCRIPTION from "./report_darkpool_anomaly.txt"
import { listPortfolio } from "../../finance/portfolio"
import { normalizeTicker } from "../../finance/parser"
import {
  analyzeTickerOffExchange,
  classifyAnomalyTransitions,
  normalizeThresholds,
  toAnomalyRecord,
} from "../../finance/darkpool-anomaly"
import { projectRoot, resolveQuiverAuth, writeToolArtifacts } from "../_shared"
import type { DarkpoolMetadata, TickerRun } from "./types"
import { transitionCounts, renderReport, renderDashboard, renderEvidenceMarkdown } from "./render"
import { fetchRequiredOffExchange, readHistoricalRuns } from "./analysis"

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

async function resolveAuth() {
  const auth = await resolveQuiverAuth({
    capabilityLabel: "darkpool anomaly analysis",
  })
  return {
    key: auth.key,
    tier: auth.tier,
  }
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
  const files = await writeToolArtifacts({
    ctx: input.ctx,
    outputRoot: input.outputRoot,
    files: {
      "report.md": input.report,
      "dashboard.md": input.dashboard,
      "assumptions.json": input.assumptions,
      "evidence.json": input.evidence,
      "evidence.md": input.evidenceMd,
    },
  })

  return {
    reportPath: files["report.md"]!,
    dashboardPath: files["dashboard.md"]!,
    assumptionsPath: files["assumptions.json"]!,
    evidencePath: files["evidence.json"]!,
    evidenceMdPath: files["evidence.md"]!,
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
