import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./portfolio_report.txt"
import { listPortfolio } from "../finance/portfolio"
import { financialSearch } from "../finance/orchestrator"
import { createEmptyFinanceData, normalizeErrorText } from "../finance/parser"
import type { FinanceQuoteData } from "../finance/types"

const parameters = z.object({
  coverage: z
    .enum(["default", "comprehensive"])
    .optional()
    .describe("Quote coverage mode. Use `comprehensive` to fill missing quote fields."),
  refresh: z.boolean().optional().describe("Set true to bypass cache."),
})

function hasNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function round(value: number, digits = 2) {
  const power = 10 ** digits
  return Math.round(value * power) / power
}

function days(input: string) {
  const bought = new Date(`${input}T00:00:00Z`)
  if (!Number.isFinite(bought.getTime())) return null
  const value = Math.floor((Date.now() - bought.getTime()) / 86_400_000)
  if (!Number.isFinite(value)) return null
  if (value < 0) return 0
  return value
}

type Row = {
  ticker: string
  date_bought: string
  price_bought: number
  current_price: number | null
  per_share_pnl: number | null
  return_percent: number | null
  day_change_percent: number | null
  ytd_return_percent: number | null
  held_days: number | null
  source: string
  timestamp: string
  errors: string[]
}

type PortfolioReportMetadata = {
  count: number
  missing: number
  winners: number
  losers: number
}

function summarize(rows: Row[]) {
  const priced = rows.filter((row) => hasNumber(row.current_price) && hasNumber(row.return_percent))
  const winners = priced.filter((row) => (row.return_percent ?? 0) > 0)
  const losers = priced.filter((row) => (row.return_percent ?? 0) < 0)
  const avg_return_percent = priced.length
    ? round(priced.reduce((sum, row) => sum + (row.return_percent ?? 0), 0) / priced.length)
    : null
  const avg_day_change_percent = priced.length
    ? round(priced.reduce((sum, row) => sum + (row.day_change_percent ?? 0), 0) / priced.length)
    : null
  const best = priced.toSorted((a, b) => (b.return_percent ?? 0) - (a.return_percent ?? 0))[0] ?? null
  const worst = priced.toSorted((a, b) => (a.return_percent ?? 0) - (b.return_percent ?? 0))[0] ?? null
  const drawdown = priced.filter((row) => (row.return_percent ?? 0) <= -15).map((row) => row.ticker)
  const movers = rows.filter((row) => Math.abs(row.day_change_percent ?? 0) >= 5).map((row) => row.ticker)
  const missing = rows.filter((row) => !hasNumber(row.current_price)).map((row) => row.ticker)
  const insights = [
    `${winners.length}/${priced.length} priced holdings are above cost basis.`,
    best ? `Best performer by return: ${best.ticker} (${round(best.return_percent ?? 0)}%).` : "Best performer: unknown.",
    worst ? `Weakest performer by return: ${worst.ticker} (${round(worst.return_percent ?? 0)}%).` : "Weakest performer: unknown.",
    missing.length > 0
      ? `${missing.length} holding(s) missing live quote fields: ${missing.join(", ")}.`
      : "All holdings returned a live quote.",
  ]
  return {
    count: rows.length,
    priced: priced.length,
    missing: missing.length,
    winners: winners.length,
    losers: losers.length,
    avg_return_percent,
    avg_day_change_percent,
    best: best
      ? {
          ticker: best.ticker,
          return_percent: best.return_percent,
          per_share_pnl: best.per_share_pnl,
        }
      : null,
    worst: worst
      ? {
          ticker: worst.ticker,
          return_percent: worst.return_percent,
          per_share_pnl: worst.per_share_pnl,
        }
      : null,
    alerts: {
      drawdown,
      movers,
      missing,
    },
    insights,
  }
}

export const PortfolioReportTool = Tool.define("portfolio_report", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      await ctx.ask({
        permission: "portfolio",
        patterns: ["list", "report"],
        always: ["*"],
        metadata: {
          action: "report",
        },
      })

      const holdings = await listPortfolio()
      if (holdings.length === 0) {
        return {
          title: "portfolio_report: no holdings",
          metadata: {
            count: 0,
            missing: 0,
            winners: 0,
            losers: 0,
          },
          output: JSON.stringify(
            {
              generated_at: new Date().toISOString(),
              summary: {
                count: 0,
                message: "No holdings found. Add holdings with the `portfolio` tool first.",
              },
              holdings: [],
            },
            null,
            2,
          ),
        }
      }

      await ctx.ask({
        permission: "financial_search",
        patterns: holdings.map((item) => `${item.ticker} quote`),
        always: ["*"],
        metadata: {
          intent: "quote",
          coverage: params.coverage ?? "comprehensive",
          source: "portfolio_report_tool",
        },
      })

      const rows = await Promise.all(
        holdings.map(async (holding) => {
          const result = await financialSearch(
            {
              query: `${holding.ticker} quote`,
              intent: "quote",
              ticker: holding.ticker,
              coverage: params.coverage ?? "comprehensive",
              source: "portfolio_report_tool",
            },
            {
              refresh: params.refresh,
              signal: ctx.abort,
            },
          ).catch((error) => ({
            source: "none",
            timestamp: new Date().toISOString(),
            attribution: [],
            data: createEmptyFinanceData("quote", holding.ticker),
            errors: [normalizeErrorText(error)],
          }))

          const quote = result.data as FinanceQuoteData
          const current_price = hasNumber(quote.price) ? quote.price : null
          const per_share_pnl = hasNumber(current_price) ? round(current_price - holding.price_bought) : null
          const return_percent =
            hasNumber(current_price) && holding.price_bought > 0
              ? round(((current_price - holding.price_bought) / holding.price_bought) * 100)
              : null

          return {
            ticker: holding.ticker,
            date_bought: holding.date_bought,
            price_bought: holding.price_bought,
            current_price,
            per_share_pnl,
            return_percent,
            day_change_percent: hasNumber(quote.changePercent) ? round(quote.changePercent) : null,
            ytd_return_percent: hasNumber(quote.ytdReturnPercent) ? round(quote.ytdReturnPercent) : null,
            held_days: days(holding.date_bought),
            source: result.source,
            timestamp: result.timestamp,
            errors: result.errors ?? [],
          } satisfies Row
        }),
      )

      const summary = summarize(rows)
      const metadata: PortfolioReportMetadata = {
        count: summary.count,
        missing: summary.missing,
        winners: summary.winners,
        losers: summary.losers,
      }
      return {
        title: `portfolio_report: ${rows.length} holdings`,
        metadata,
        output: JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            summary,
            holdings: rows,
          },
          null,
          2,
        ),
      }
    },
  }
})
