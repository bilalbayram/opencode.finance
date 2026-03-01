import path from "path"
import z from "zod"
import { Tool } from "../tool"
import DESCRIPTION from "./report_insiders.txt"
import { listPortfolio } from "../../finance/portfolio"
import { normalizeTicker } from "../../finance/parser"
import type { QuiverTier } from "../../finance/quiver-tier"
import * as QuiverReport from "../../finance/providers/quiver-report"
import { projectRoot, resolveQuiverAuth, writeToolArtifacts } from "../_shared"
import type { ReportInsidersMetadata, TickerSummary } from "./types"
import { summarizeActivity, summarizeInsiders, formatActivityWindow } from "./activity"
import { coverage, toMarkdown } from "./render"

const parameters = z.object({
  ticker: z.string().optional().describe("Optional ticker for ticker mode; omit for portfolio mode."),
  output_root: z.string().optional().describe("Optional report directory override."),
  limit: z.number().int().min(1).max(200).optional().describe("Limit for list-like datasets (default: 50)."),
  refresh: z.boolean().optional().describe("Reserved for compatibility; Quiver endpoints are always fetched live."),
})

async function resolveAuth() {
  return resolveQuiverAuth({
    requiredEndpointTier: "tier_1",
    capabilityLabel: "Tier 1 insider/government datasets required by this report",
  })
}

function defaultRoot(
  context: Pick<Tool.Context, "directory" | "worktree">,
  mode: "ticker" | "portfolio",
  ticker?: string,
) {
  const date = new Date().toISOString().slice(0, 10)
  if (mode === "ticker") return path.join(projectRoot(context), "reports", ticker!, date)
  return path.join(projectRoot(context), "reports", "portfolio", date)
}

async function writeArtifacts(input: {
  outputRoot: string
  markdown: string
  json: string
  ctx: Tool.Context
}) {
  const files = await writeToolArtifacts({
    ctx: input.ctx,
    outputRoot: input.outputRoot,
    files: {
      "insiders-report.md": input.markdown,
      "insiders-data.json": input.json,
    },
  })

  return {
    reportPath: files["insiders-report.md"]!,
    dataPath: files["insiders-data.json"]!,
  }
}

export const ReportInsidersTool = Tool.define("report_insiders", async () => {
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
          patterns: ["list", "report", "insiders"],
          always: ["*"],
          metadata: {
            action: "report_insiders",
          },
        })
      }

      const tickers =
        mode === "ticker"
          ? [ticker]
          : await listPortfolio().then((items) => [...new Set(items.map((item) => normalizeTicker(item.ticker)).filter(Boolean))])

      if (tickers.length === 0) {
        throw new Error("No holdings found. Add holdings with `/portfolio <ticker> <price_bought> <YYYY-MM-DD>` first.")
      }

      await ctx.ask({
        permission: "financial_search",
        patterns: [...tickers.map((item) => `${item} insiders`), "congress trading", "senate trading", "house trading"],
        always: ["*"],
        metadata: {
          source: "report_insiders_tool",
          tier: auth.tier,
          mode,
          refresh: params.refresh,
        },
      })

      const limit = params.limit ?? 50
      const global = await QuiverReport.fetchGlobalGovTrading({
        apiKey: auth.key,
        tier: auth.tier,
        enforceTierGate: false,
        limit,
        signal: ctx.abort,
      })

      const tickerSummary = await Promise.all(
        tickers.map(async (symbol) => {
          const [gov, alt, insiders] = await Promise.all([
            QuiverReport.fetchTickerGovTrading({
              apiKey: auth.key,
              tier: auth.tier,
              enforceTierGate: false,
              ticker: symbol,
              limit,
              signal: ctx.abort,
            }),
            QuiverReport.fetchTickerAlt({
              apiKey: auth.key,
              tier: auth.tier,
              enforceTierGate: false,
              ticker: symbol,
              limit,
              signal: ctx.abort,
            }),
            QuiverReport.fetchInsiders({
              apiKey: auth.key,
              tier: auth.tier,
              enforceTierGate: false,
              ticker: symbol,
              limit,
              signal: ctx.abort,
            }),
          ])

          const datasets = [...gov, ...alt, insiders]
          return {
            ticker: symbol,
            datasets,
            insiders_rows: insiders.status === "ok" ? insiders.rows.length : 0,
            government_rows: [...gov, ...alt].reduce(
              (acc, item) => (item.status === "ok" ? acc + item.rows.length : acc),
              0,
            ),
          } satisfies TickerSummary
        }),
      )

      const allDatasets = [...global, ...tickerSummary.flatMap((item) => item.datasets)]
      const summaryCoverage = coverage(allDatasets)
      if (summaryCoverage.attempted === 0) {
        const failures = allDatasets
          .filter((item) => item.status === "failed")
          .map((item) => `${item.id}: ${item.error?.message ?? "request failed"}`)
        throw new Error(`No usable Quiver datasets were returned. ${failures.join("; ")}`.trim())
      }

      const warnings = [
        ...(auth.warning ? [auth.warning] : []),
        ...allDatasets
          .filter((item) => item.status === "failed")
          .map((item) => `${item.id} failed: ${item.error?.message ?? "request failed"}`),
      ]

      const outputRoot = params.output_root
        ? path.isAbsolute(params.output_root)
          ? path.normalize(params.output_root)
          : path.resolve(ctx.directory, params.output_root)
        : defaultRoot(ctx, mode, ticker)

      const generatedAt = new Date().toISOString()
      const tickerInsights = tickerSummary.map((item) => {
        const insiders = item.datasets.find((dataset) => dataset.id === "insiders_form4")
        const insiderRows = insiders?.status === "ok" ? insiders.rows : []
        return {
          ticker: item.ticker,
          insiders: {
            status: insiders?.status ?? "failed",
            summary: summarizeInsiders(insiderRows),
          },
          government_rows: item.government_rows,
          datasets: item.datasets,
        }
      })

      const activity = summarizeActivity({
        global,
        tickers: tickerSummary,
        window: formatActivityWindow(generatedAt, 7),
      })

      const payload = {
        generated_at: generatedAt,
        mode,
        tier: auth.tier,
        tier_inferred: auth.inferred,
        warnings,
        insider_activity: activity,
        coverage: summaryCoverage,
        global_government: {
          total_rows: global.reduce((acc, item) => (item.status === "ok" ? acc + item.rows.length : acc), 0),
          datasets: global,
        },
        tickers: tickerInsights,
      }

      const markdown = toMarkdown({
        generatedAt,
        mode,
        tier: auth.tier,
        warnings,
        global,
        ticker: tickerSummary,
        totalCoverage: summaryCoverage,
        activity,
      })

      const files = await writeArtifacts({
        outputRoot,
        markdown,
        json: JSON.stringify(payload, null, 2),
        ctx,
      })

      const metadata: ReportInsidersMetadata = {
        mode,
        tier: auth.tier,
        output_root: outputRoot,
        report_path: files.reportPath,
        data_path: files.dataPath,
        coverage: summaryCoverage,
        warnings: warnings.length,
      }

      return {
        title: mode === "ticker" ? `report_insiders: ${ticker}` : `report_insiders: portfolio (${tickers.length})`,
        metadata,
        output: JSON.stringify(
          {
            ...payload,
            artifacts: {
              output_root: outputRoot,
              markdown: files.reportPath,
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
