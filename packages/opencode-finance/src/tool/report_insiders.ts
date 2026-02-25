import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./report_insiders.txt"
import { Auth } from "../auth"
import { Env } from "../env"
import { FINANCE_AUTH_PROVIDER } from "../finance/auth-provider"
import { listPortfolio } from "../finance/portfolio"
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

const LOGIN_HINT =
  "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

const parameters = z.object({
  ticker: z.string().optional().describe("Optional ticker for ticker mode; omit for portfolio mode."),
  output_root: z.string().optional().describe("Optional report directory override."),
  limit: z.number().int().min(1).max(200).optional().describe("Limit for list-like datasets (default: 50)."),
  refresh: z.boolean().optional().describe("Reserved for compatibility; Quiver endpoints are always fetched live."),
})

type ReportInsidersMetadata = {
  mode: "ticker" | "portfolio"
  tier: QuiverTier
  output_root: string
  report_path: string
  data_path: string
  coverage: {
    attempted: number
    skipped: number
    failed: number
  }
  warnings: number
}

type TickerSummary = {
  ticker: string
  datasets: QuiverReport.QuiverReportDataset[]
  insiders_rows: number
  government_rows: number
}

type InsiderActivity = {
  actor: string
  action: "buy" | "sell" | "other"
  shares: number
  ticker: string
  date: string
  source: string
}

type ActivityWindow = {
  start: string
  end: string
  days: number
}

type ActivitySummary = {
  window: ActivityWindow
  rows: InsiderActivity[]
}

function projectRoot(context: Pick<Tool.Context, "directory" | "worktree">) {
  return context.worktree === "/" ? context.directory : context.worktree
}

function asText(input: unknown) {
  if (input === null || input === undefined) return ""
  return String(input)
}

function asNumber(input: unknown) {
  const value = asText(input).replace(/[^0-9.-]/g, "").trim()
  if (!value) return 0
  const output = Number(value)
  if (!Number.isFinite(output)) return 0
  return output
}

function toNumber(input: unknown): number {
  return asNumber(input)
}

function asDate(input: unknown) {
  const text = asText(input).trim()
  const value = new Date(text)
  if (Number.isNaN(value.getTime())) return ""
  return value.toISOString().slice(0, 10)
}

function fieldNames(row: Record<string, unknown>) {
  return new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
}

function pick(row: Record<string, unknown>, candidates: string[]) {
  for (const key of candidates) if (row[key] !== undefined && row[key] !== null && asText(row[key]).trim()) return asText(row[key])

  const normalized = fieldNames(row)
  for (const key of candidates) {
    const value = normalized.get(key.toLowerCase())
    if (value !== undefined && value !== null && asText(value).trim()) return asText(value)
  }
  return ""
}

function formatActor(row: Record<string, unknown>) {
  return (
    pick(row, ["name", "owner", "insider_name", "insidername", "person", "representative", "senator", "member", "holder", "investor", "trader", "lobbyist"]) ||
    "Unknown actor"
  )
}

function formatTicker(row: Record<string, unknown>, fallback: string) {
  return (pick(row, ["ticker", "symbol", "security", "company"]) || fallback || "N/A").toUpperCase()
}

function formatDate(row: Record<string, unknown>) {
  return asDate(
    pick(row, [
      "date",
      "transactiondate",
      "filed",
      "filed_at",
      "fileddate",
      "reportdate",
      "disclosedate",
      "tradedate",
    ]),
  )
}

function formatShares(row: Record<string, unknown>) {
  const text = pick(row, ["shares_traded", "shareschanged", "changeinshares", "shares", "share", "quantity", "amount"])
  return Math.abs(toNumber(text))
}

function formatAction(row: Record<string, unknown>) {
  return transactionKind(pick(row, ["transactiontype", "transaction", "type", "acquireddisposed"]))
}

function formatActivityWindow(end: string, days = 7) {
  const endDate = new Date(end)
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - (days - 1))
  return {
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
    days,
  } satisfies ActivityWindow
}

function parseActivity(input: {
  dataset: QuiverReport.QuiverReportDataset
  fallbackTicker: string
  window: ActivityWindow
}) {
  if (input.dataset.status !== "ok") return [] as InsiderActivity[]

  return input.dataset.rows
    .map((row) => {
      const date = formatDate(row)
      if (!date) return undefined
      const shares = formatShares(row)
      return {
        actor: formatActor(row),
        action: formatAction(row),
        shares,
        ticker: formatTicker(row, input.fallbackTicker),
        date,
        source: input.dataset.label,
      } satisfies InsiderActivity
    })
    .filter((item): item is InsiderActivity => Boolean(item))
    .filter((item) => {
      const value = new Date(item.date)
      if (Number.isNaN(value.getTime())) return false
      const start = new Date(input.window.start)
      const end = new Date(input.window.end)
      return value >= start && value <= end
    })
}

function summarizeActivity(input: {
  global: QuiverReport.QuiverReportDataset[]
  tickers: TickerSummary[]
  window: ActivityWindow
}) {
  const rows = [
    ...input.global.flatMap((dataset) => parseActivity({ dataset, fallbackTicker: "", window: input.window })),
    ...input.tickers.flatMap((ticker) =>
      ticker.datasets.flatMap((dataset) => parseActivity({ dataset, fallbackTicker: ticker.ticker, window: input.window })),
    ),
  ]

  const seen = new Set<string>()
  const deduped = rows.filter((item) => {
    const key = `${item.date}|${item.actor}|${item.action}|${item.shares}|${item.ticker}|${item.source}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    window: input.window,
    rows: deduped.toSorted((a, b) => b.date.localeCompare(a.date)),
  } satisfies ActivitySummary
}

function activityLines(input: ActivitySummary) {
  if (input.rows.length === 0) return ["- No dated insider or government activity in the window."]

  const verb = {
    buy: "bought",
    sell: "sold",
    other: "recorded",
  } as const

  return input.rows.map((item) => {
    const size = item.shares ? `${item.shares.toLocaleString("en-US")} shares` : "activity"
    return `- ${item.date}: ${item.actor} ${verb[item.action]} ${size} of ${item.ticker} (${item.source})`
  })
}

function transactionKind(input: unknown): "buy" | "sell" | "other" {
  const text = asText(input).toLowerCase()
  if (text.includes("buy") || text.includes("purchase") || text.includes("acquired")) return "buy"
  if (text.includes("sell") || text.includes("dispose")) return "sell"
  return "other"
}

function coverage(datasets: QuiverReport.QuiverReportDataset[]) {
  const attempted = datasets.filter((item) => item.status === "ok").length
  const skipped = datasets.filter((item) => item.status === "not_attempted_due_to_tier").length
  const failed = datasets.filter((item) => item.status === "failed").length
  return {
    attempted,
    skipped,
    failed,
  }
}

function datasetLine(item: QuiverReport.QuiverReportDataset) {
  if (item.status === "ok") return `${item.label}: ok (${item.rows.length} rows)`
  if (item.status === "not_attempted_due_to_tier") {
    return `${item.label}: not_attempted_due_to_tier (requires ${endpointMinimumPlan(item.endpoint_tier)})`
  }
  return `${item.label}: failed (${item.error?.code ?? "NETWORK"}) ${item.error?.message ?? "request failed"}`
}

function summarizeInsiders(rows: Record<string, unknown>[]) {
  const stats = rows.reduce<{ buy: number; sell: number; other: number; net: number }>(
    (acc, row) => {
      const kind = transactionKind(row.TransactionType ?? row.Transaction ?? row.Type ?? row.AcquiredDisposed)
      const shares = toNumber(row.SharesTraded ?? row.SharesChanged ?? row.ChangeInShares ?? row.Shares)
      if (kind === "buy") {
        acc.buy += 1
        acc.net += Math.abs(shares)
      }
      if (kind === "sell") {
        acc.sell += 1
        acc.net -= Math.abs(shares)
      }
      if (kind === "other") acc.other += 1
      return acc
    },
    { buy: 0, sell: 0, other: 0, net: 0 },
  )
  return {
    transactions: rows.length,
    buy: stats.buy,
    sell: stats.sell,
    other: stats.other,
    net_share_delta: stats.net,
  }
}

async function resolveAuth() {
  const auth = await Auth.get("quiver-quant")
  const env = FINANCE_AUTH_PROVIDER["quiver-quant"].env.map((key) => Env.get(key)).find(Boolean)

  if (!auth || auth.type !== "api") {
    if (env) {
      throw new Error(`Quiver plan metadata is missing. Run \`${LOGIN_HINT}\` to store key + plan.`)
    }
    throw new Error(`Quiver Quant is required for this report. Run \`${LOGIN_HINT}\`.`)
  }

  const key = env ?? auth.key
  if (!key?.trim()) {
    throw new Error(`Quiver Quant API key is missing. Run \`${LOGIN_HINT}\`.`)
  }

  const tier = resolveQuiverTierFromAuth(auth)
  if (!tierAllows("tier_1", tier.tier)) {
    throw new Error(
      `Quiver plan ${quiverPlanLabel(tier.tier)} does not include insider/government datasets required by this report. Upgrade to Hobbyist (Tier 0 + Tier 1) or higher and rerun \`${LOGIN_HINT}\`.`,
    )
  }
  return {
    key,
    tier: tier.tier,
    inferred: tier.inferred,
    warning: tier.warning,
  }
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
  await assertExternalDirectory(input.ctx, input.outputRoot, { kind: "directory" })
  await fs.mkdir(input.outputRoot, { recursive: true })
  const worktree = projectRoot(input.ctx)

  const reportPath = path.join(input.outputRoot, "insiders-report.md")
  const dataPath = path.join(input.outputRoot, "insiders-data.json")

  await input.ctx.ask({
    permission: "edit",
    patterns: [path.relative(worktree, reportPath), path.relative(worktree, dataPath)],
    always: ["*"],
    metadata: {
      output_root: input.outputRoot,
      report_path: reportPath,
      data_path: dataPath,
    },
  })

  await Promise.all([Bun.write(reportPath, input.markdown), Bun.write(dataPath, input.json)])

  return {
    reportPath,
    dataPath,
  }
}

function toMarkdown(input: {
  generatedAt: string
  mode: "ticker" | "portfolio"
  tier: QuiverTier
  warnings: string[]
  global: QuiverReport.QuiverReportDataset[]
  ticker: TickerSummary[]
  totalCoverage: ReturnType<typeof coverage>
  activity: ActivitySummary
}) {
  const lines = [
    "# Insider Report",
    "",
    `Generated at: ${input.generatedAt}`,
    `Mode: ${input.mode}`,
    `Tier: ${input.tier}`,
    "",
    "## Executive Summary",
    `- Coverage: attempted ${input.totalCoverage.attempted}, skipped ${input.totalCoverage.skipped}, failed ${input.totalCoverage.failed}.`,
    `- Insider activity in last ${input.activity.window.days} days: ${input.activity.rows.length}.`,
    `- Global government datasets: ${input.global.filter((item) => item.status === "ok").reduce((acc, item) => acc + item.rows.length, 0)} rows across congress/senate/house feeds.`,
    `- Tickers analyzed: ${input.ticker.length}.`,
  ]

  if (input.warnings.length > 0) {
    lines.push("", "## Warnings")
    input.warnings.forEach((item) => lines.push(`- ${item}`))
  }

  lines.push("", "## Global Government Trading")
  input.global.forEach((item) => lines.push(`- ${datasetLine(item)}`))

  lines.push(
    "",
    `## Recent Insider / Government Activity (${input.activity.window.start} to ${input.activity.window.end})`,
    ...activityLines(input.activity),
  )

  input.ticker.forEach((item) => {
    lines.push("", `## ${item.ticker}`)
    lines.push(`- Insider rows: ${item.insiders_rows}`)
    lines.push(`- Government rows: ${item.government_rows}`)
    item.datasets.forEach((dataset) => lines.push(`- ${datasetLine(dataset)}`))
  })

  return lines.join("\n") + "\n"
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
        limit,
        signal: ctx.abort,
      })

      const tickerSummary = await Promise.all(
        tickers.map(async (symbol) => {
          const [gov, alt, insiders] = await Promise.all([
            QuiverReport.fetchTickerGovTrading({
              apiKey: auth.key,
              tier: auth.tier,
              ticker: symbol,
              limit,
              signal: ctx.abort,
            }),
            QuiverReport.fetchTickerAlt({
              apiKey: auth.key,
              tier: auth.tier,
              ticker: symbol,
              limit,
              signal: ctx.abort,
            }),
            QuiverReport.fetchInsiders({
              apiKey: auth.key,
              tier: auth.tier,
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
