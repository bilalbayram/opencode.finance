import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./portfolio.txt"
import { clearPortfolio, listPortfolio, removePortfolio, upsertPortfolio } from "../finance/portfolio"

const parameters = z.object({
  action: z
    .enum(["list", "upsert", "remove", "clear"])
    .default("list")
    .describe("Portfolio operation: list holdings, upsert one holding, remove one holding, or clear all holdings."),
  ticker: z.string().optional().describe("Ticker symbol, required for `upsert` and `remove`."),
  price_bought: z.number().positive().optional().describe("Buy price per share, required for `upsert`."),
  date_bought: z.string().optional().describe("Buy date in YYYY-MM-DD format, required for `upsert`."),
})

type PortfolioMetadata = {
  action: "list" | "upsert" | "remove" | "clear"
  ticker: string | null
  count: number
  created: boolean | null
  removed: boolean | null
}

export const PortfolioTool = Tool.define("portfolio", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      await ctx.ask({
        permission: "portfolio",
        patterns: [params.action, params.ticker ?? ""].filter(Boolean),
        always: ["*"],
        metadata: {
          action: params.action,
          ticker: params.ticker,
        },
      })

      if (params.action === "list") {
        const holdings = await listPortfolio()
        const metadata: PortfolioMetadata = {
          action: params.action,
          ticker: null,
          count: holdings.length,
          created: null,
          removed: null,
        }
        return {
          title: `portfolio: ${holdings.length} holdings`,
          metadata,
          output: JSON.stringify(
            {
              action: params.action,
              count: holdings.length,
              holdings,
            },
            null,
            2,
          ),
        }
      }

      if (params.action === "upsert") {
        if (!params.ticker?.trim()) throw new Error("ticker is required for action `upsert`")
        if (params.price_bought === undefined) throw new Error("price_bought is required for action `upsert`")
        if (!params.date_bought?.trim()) throw new Error("date_bought is required for action `upsert`")

        const result = await upsertPortfolio({
          ticker: params.ticker,
          price_bought: params.price_bought,
          date_bought: params.date_bought,
        })
        const metadata: PortfolioMetadata = {
          action: params.action,
          ticker: result.holding.ticker,
          count: result.holdings.length,
          created: result.created,
          removed: null,
        }

        return {
          title: `portfolio: ${result.created ? "added" : "updated"} ${result.holding.ticker}`,
          metadata,
          output: JSON.stringify(
            {
              action: params.action,
              created: result.created,
              holding: result.holding,
              count: result.holdings.length,
              holdings: result.holdings,
            },
            null,
            2,
          ),
        }
      }

      if (params.action === "remove") {
        if (!params.ticker?.trim()) throw new Error("ticker is required for action `remove`")
        const result = await removePortfolio(params.ticker)
        const metadata: PortfolioMetadata = {
          action: params.action,
          ticker: params.ticker.toUpperCase(),
          removed: result.removed,
          count: result.holdings.length,
          created: null,
        }
        return {
          title: `portfolio: ${result.removed ? "removed" : "not found"} ${params.ticker.toUpperCase()}`,
          metadata,
          output: JSON.stringify(
            {
              action: params.action,
              removed: result.removed,
              count: result.holdings.length,
              holdings: result.holdings,
            },
            null,
            2,
          ),
        }
      }

      const holdings = await clearPortfolio()
      const metadata: PortfolioMetadata = {
        action: params.action,
        ticker: null,
        count: holdings.length,
        created: null,
        removed: null,
      }
      return {
        title: "portfolio: cleared",
        metadata,
        output: JSON.stringify(
          {
            action: params.action,
            count: holdings.length,
            holdings,
          },
          null,
          2,
        ),
      }
    },
  }
})
