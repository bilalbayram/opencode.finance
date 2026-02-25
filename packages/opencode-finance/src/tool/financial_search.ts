import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./financial_search.txt"
import { financialSearch } from "../finance/orchestrator"
import { parseFinanceTicker } from "../finance/parser"

const parameters = z.object({
  query: z.string().describe("User query describing the finance question"),
  intent: z
    .enum(["quote", "fundamentals", "filings", "insider", "news"])
    .optional()
    .describe("Optional intent override for finance data type selection"),
  ticker: z
    .string()
    .optional()
    .describe("Ticker symbol, e.g. AAPL, TSLA, MSFT"),
  form: z
    .string()
    .optional()
    .describe("SEC filing form filter, used when intent is filings"),
  coverage: z
    .enum(["default", "comprehensive"])
    .optional()
    .describe("Coverage mode. `comprehensive` merges across providers to fill missing fields."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of items for list-like data"),
  refresh: z.boolean().optional().describe("Set true to bypass cache"),
})

export const FinancialSearchTool = Tool.define("financial_search", async () => {
  return {
    parameters,
    description: DESCRIPTION,
    async execute(params, ctx) {
      const ticker = parseFinanceTicker(params.ticker ?? params.query)
      await ctx.ask({
        permission: "financial_search",
        patterns: [params.query, params.ticker ?? "", params.intent ?? ""].filter(Boolean),
        always: ["*"],
        metadata: {
          query: params.query,
          intent: params.intent,
          ticker: params.ticker,
          form: params.form,
          coverage: params.coverage,
          limit: params.limit,
          refresh: params.refresh,
        },
      })

      const result = await financialSearch(
        {
          query: params.query,
          intent: params.intent,
          ticker,
          form: params.form,
          coverage: params.coverage,
          limit: params.limit,
          source: "financial_search_tool",
        },
        {
          refresh: params.refresh,
          signal: ctx.abort,
        },
      )

      return {
        title: `financial_search: ${ticker ?? params.query}`,
        metadata: {
          source: result.source,
          timestamp: result.timestamp,
          attribution: result.attribution,
          errors: result.errors,
        },
        output: JSON.stringify(result, null, 2),
      }
    },
  }
})
