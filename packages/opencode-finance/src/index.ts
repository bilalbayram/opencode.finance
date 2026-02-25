import fs from "fs/promises"
import path from "path"
import z from "zod"
import { type Plugin, tool as pluginTool, type Hooks } from "@opencode-ai/plugin"
import { Auth } from "./auth"
import { FINANCE_AUTH_PROVIDER, type FinanceAuthProviderID } from "./finance/auth-provider"
import { FINANCE_SLASH_COMMANDS } from "./command/finance"
import { FinancialSearchTool } from "./tool/financial_search"
import { PortfolioTool } from "./tool/portfolio"
import { PortfolioReportTool } from "./tool/portfolio_report"
import { ReportInsidersTool } from "./tool/report_insiders"
import { ReportGovernmentTradingTool } from "./tool/report_government_trading"
import { ReportDarkpoolAnomalyTool } from "./tool/report_darkpool_anomaly"
import { FinancialPoliticalBacktestTool } from "./tool/financial_political_backtest"
import { ReportPdfTool } from "./tool/report_pdf"
import { Env } from "./env"
import PROMPT_FINANCE from "./prompt/finance.txt"

const REQUIRED_PROVIDER = ["alphavantage", "sec-edgar"] as const
const RECOMMENDED_PROVIDER = ["finnhub", "financial-modeling-prep", "polygon", "quartr", "quiver-quant"] as const
const AUTH_LOGIN_PROVIDER = [
  "alphavantage",
  "finnhub",
  "financial-modeling-prep",
  "polygon",
  "quartr",
  "sec-edgar",
  "quiver-quant",
] as const satisfies readonly FinanceAuthProviderID[]
const REPORT_SKILL = "finance-comprehensive-report"
const REPORT_SKILL_GIST_ENV = "FINANCE_REPORT_SKILL_GIST_URL"
const BUNDLED_SKILL = path.resolve(import.meta.dir, "./skill/finance-comprehensive-report.SKILL.md")
const login = (id: string) =>
  `\`curl -fsSL https://opencode.finance/install.sh | bash\` (recommended) or run \`opencode auth login\` and select \`${id}\``

const ONBOARD_TEMPLATE = [
  "Run finance plugin onboarding for report workflows.",
  "",
  "Steps:",
  "1) Validate required auth credentials:",
  `- ${login("alphavantage")}`,
  `- ${login("sec-edgar")}`,
  "2) Validate optional providers for stronger coverage:",
  `- ${login("finnhub")}`,
  `- ${login("financial-modeling-prep")}`,
  `- ${login("polygon")}`,
  `- ${login("quartr")}`,
  `- ${login("quiver-quant")}`,
  "3) If required credentials are missing, stop and print exactly which command(s) the user must run.",
  `4) Confirm skill \`${REPORT_SKILL}\` is installed; if missing, instruct the user to run \`/report <ticker>\` again after setup.`,
  "5) End with one concise readiness summary and next actions.",
].join("\n")

function root(context: { directory: string; worktree: string }) {
  return context.worktree === "/" ? context.directory : context.worktree
}

function reportRoot(
  ticker: string,
  context: { directory: string; worktree: string },
  date = new Date().toISOString().slice(0, 10),
) {
  return path.join(root(context), "reports", ticker, date)
}

function parseArgs(input: string) {
  const raw = input.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)/g) ?? []
  return raw.map((arg) => arg.replace(/^['"`]|['"`]$/g, ""))
}

async function credential(providerID: FinanceAuthProviderID): Promise<string | undefined> {
  const env = FINANCE_AUTH_PROVIDER[providerID].env
    .map((key) => Env.get(key)?.trim())
    .find(Boolean)
  if (env) return env
  const auth = await Auth.get(providerID)
  if (auth?.type === "api") return auth.key
  return undefined
}

async function missingRequired() {
  const checks = await Promise.all(REQUIRED_PROVIDER.map(async (id) => ({ id, ok: Boolean(await credential(id)) })))
  return checks.filter((item) => !item.ok).map((item) => item.id)
}

async function missingRecommended() {
  const checks = await Promise.all(RECOMMENDED_PROVIDER.map(async (id) => ({ id, ok: Boolean(await credential(id)) })))
  return checks.filter((item) => !item.ok).map((item) => item.id)
}

async function ensureSkill(context: { directory: string; worktree: string }) {
  const target = path.join(root(context), ".opencode", "skills", REPORT_SKILL, "SKILL.md")
  if (await Bun.file(target).exists()) return target

  const gist = (Env.get(REPORT_SKILL_GIST_ENV) ?? "").trim()
  const content = gist
    ? await fetch(gist).then(async (response) => {
        if (!response.ok) throw new Error(`failed to fetch ${REPORT_SKILL_GIST_ENV} (${response.status})`)
        return response.text()
      })
    : await Bun.file(BUNDLED_SKILL)
        .text()
        .catch(() => {
          throw new Error(`missing bundled skill: ${BUNDLED_SKILL}`)
        })

  if (!content.trim()) throw new Error(`empty skill content for ${REPORT_SKILL}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, content)
  return target
}

async function buildTools() {
  const list = [
    FinancialSearchTool,
    PortfolioTool,
    PortfolioReportTool,
    ReportInsidersTool,
    ReportGovernmentTradingTool,
    ReportDarkpoolAnomalyTool,
    FinancialPoliticalBacktestTool,
    ReportPdfTool,
  ]
  const out: Hooks["tool"] = {}
  for (const item of list) {
    const init = await item.init()
    if (!(init.parameters instanceof z.ZodObject)) {
      throw new Error(`finance plugin tool ${item.id} must declare a Zod object schema`)
    }
    out[item.id] = pluginTool({
      description: init.description,
      args: init.parameters.shape,
      async execute(args, context) {
        const result = await init.execute(args as any, context as any)
        context.metadata({
          title: result.title,
          metadata: result.metadata,
        })
        return result.output
      },
    })
  }
  return out
}

function commandTemplate() {
  const command = FINANCE_SLASH_COMMANDS.reduce(
    (acc, item) => {
      acc[item.name] = {
        description: item.description,
        template: item.template,
      }
      return acc
    },
    {} as Record<string, { description: string; template: string }>,
  )
  command.onboard = {
    description: "Run finance plugin setup checks",
    template: ONBOARD_TEMPLATE,
  }
  return command
}

function ensureAuthProviderVisibility(config: Parameters<NonNullable<Hooks["config"]>>[0]) {
  if (Array.isArray(config.enabled_providers)) {
    config.enabled_providers = Array.from(new Set([...config.enabled_providers, ...AUTH_LOGIN_PROVIDER]))
  }

  const provider = (config.provider ??= {})
  for (const id of AUTH_LOGIN_PROVIDER) {
    const current = provider[id]
    if (current?.name?.trim()) continue
    provider[id] = {
      ...(current ?? {}),
      name: FINANCE_AUTH_PROVIDER[id].name,
    }
  }
}

function authPlugin(input: {
  provider: FinanceAuthProviderID
  label: string
  prompts?: NonNullable<NonNullable<Hooks["auth"]>["methods"][number]["prompts"]>
  metadata?: (values: Record<string, string>) => Record<string, string | number | boolean> | undefined
}) {
  const plugin: Plugin = async () => ({
    auth: {
      provider: input.provider,
      methods: [
        {
          type: "api",
          label: input.label,
          prompts: input.prompts,
          async authorize(values) {
            const key = values?.key?.trim()
            if (!key) return { type: "failed" }
            return {
              type: "success",
              key,
              metadata: input.metadata?.(values ?? {}),
            }
          },
        },
      ],
    },
  })
  return plugin
}

const textPrompt = (message: string, placeholder?: string) =>
  ({
    type: "text" as const,
    key: "key",
    message,
    ...(placeholder ? { placeholder } : {}),
    validate(value: string) {
      if (!value.trim()) return "Required"
    },
  }) satisfies NonNullable<NonNullable<Hooks["auth"]>["methods"][number]["prompts"]>[number]

export const OpenCodeFinancePlugin: Plugin = async (input) => {
  const tools = await buildTools()

  return {
    tool: tools,
    async config(config) {
      ensureAuthProviderVisibility(config)
      config.command = {
        ...(config.command ?? {}),
        ...commandTemplate(),
      }
    },
    async "experimental.chat.system.transform"(_input, output) {
      output.system.push(PROMPT_FINANCE)
    },
    async "command.execute.before"(event, output) {
      if (event.command === "report") {
        const parts = parseArgs(event.arguments)
        const ticker = (parts[0] ?? "").trim().toUpperCase()
        if (!ticker) {
          throw new Error("Missing ticker for `/report`. Usage: `/report <ticker> [focus]`.\nRun `/onboard` first.")
        }

        await ensureSkill(input)
        const missing = await missingRequired()
        if (missing.length > 0) {
          throw new Error(
            [
              `Missing required dependencies for \`/report\`: ${missing.join(", ")}.`,
              ...missing.map((id) => `- ${login(id)}`),
              "Run `/onboard` to complete setup.",
            ].join("\n"),
          )
        }

        const recommended = await missingRecommended()
        if (recommended.length > 0) {
          await input.client.tui.showToast({
            body: {
              variant: "warning",
              message: `Optional providers missing: ${recommended.join(", ")}. Coverage may be reduced.`,
              duration: 9000,
            },
          })
        }

        const focus = parts.slice(1).join(" ").trim()
        output.parts.push({
          type: "text",
          text: [
            "Execution constraints for this `/report` run:",
            `- Write artifacts only under \`${reportRoot(ticker, input)}\`.`,
            ...(focus ? [`- Focus area for this run: \`${focus}\`.`] : []),
            "- Use `financial_search` with `coverage: \"comprehensive\"` for numeric claims.",
            "- If a numeric field cannot be sourced, set the value to `unknown` (never `N/A`).",
            `- If Quiver setup is missing, instruct: ${login("quiver-quant")}.`,
            "- After markdown artifacts, ask one PDF export question; if accepted, call `report_pdf`.",
          ].join("\n"),
        } as any)
        return
      }

      if (event.command !== "financial-political-backtest") return

      const parts = parseArgs(event.arguments)
      const first = (parts[0] ?? "").trim()
      const firstLower = first.toLowerCase()
      const tickerCandidate =
        first && firstLower !== "portfolio" && /^[a-z0-9.\-]+$/i.test(first) && !first.includes(",") ? first.toUpperCase() : ""
      const mode = tickerCandidate ? "ticker" : "portfolio"
      const date = new Date().toISOString().slice(0, 10)
      const scopeRoot = mode === "ticker" ? reportRoot(tickerCandidate, input, date) : path.join(root(input), "reports", "portfolio", date)

      const quiver = await credential("quiver-quant")
      if (!quiver) {
        throw new Error(
          [
            "Missing required dependency for `/financial-political-backtest`: quiver-quant.",
            `- ${login("quiver-quant")}`,
            "Run `/onboard` to complete setup.",
          ].join("\n"),
        )
      }

      output.parts.push({
        type: "text",
        text: [
          "Execution constraints for this `/financial-political-backtest` run:",
          `- Inferred mode: \`${mode}\`.`,
          `- Write artifacts under \`${scopeRoot}\`.`,
          "- Enforce strict failure for missing required datasets, windows, or benchmark series.",
          "- Keep outputs analytic and non-advisory.",
          "- After successful markdown artifacts, ask exactly one PDF question using `question`.",
          "- If user chooses `Yes (Recommended)`, call `report_pdf` with the tool-reported output root.",
          "- If user chooses `No`, skip PDF export.",
          "- If `report_pdf` fails, report the explicit error and treat the run as failed.",
        ].join("\n"),
      } as any)
    },
  }
}

export const AlphaVantageAuthPlugin = authPlugin({
  provider: "alphavantage",
  label: "Alpha Vantage API key",
  prompts: [textPrompt("Enter your Alpha Vantage API key")],
})

export const FinnhubAuthPlugin = authPlugin({
  provider: "finnhub",
  label: "Finnhub API key",
  prompts: [textPrompt("Enter your Finnhub API key")],
})

export const FinancialModelingPrepAuthPlugin = authPlugin({
  provider: "financial-modeling-prep",
  label: "Financial Modeling Prep API key",
  prompts: [textPrompt("Enter your Financial Modeling Prep API key")],
})

export const PolygonAuthPlugin = authPlugin({
  provider: "polygon",
  label: "Polygon API key",
  prompts: [textPrompt("Enter your Polygon API key")],
})

export const QuartrAuthPlugin = authPlugin({
  provider: "quartr",
  label: "Quartr API key",
  prompts: [textPrompt("Enter your Quartr API key")],
})

export const SecEdgarAuthPlugin = authPlugin({
  provider: "sec-edgar",
  label: "SEC EDGAR identity",
  prompts: [textPrompt("Enter SEC EDGAR identity", "MyCompany dev@mycompany.com")],
})

export const QuiverQuantAuthPlugin = authPlugin({
  provider: "quiver-quant",
  label: "Quiver Quant API key",
  prompts: [
    textPrompt("Enter your Quiver Quant API key"),
    {
      type: "select",
      key: "tier",
      message: "Select your Quiver Quant plan tier",
      options: [
        { label: "Public (Tier 0)", value: "tier_1" },
        { label: "Hobbyist (Tier 0 + Tier 1)", value: "tier_2" },
        { label: "Trader (Tier 0 + Tier 1 + Tier 2)", value: "tier_3" },
        { label: "Enterprise (Tier 0 + Tier 1 + Tier 2)", value: "enterprise" },
      ],
    },
  ],
  metadata(values) {
    const tier = values.tier?.trim()
    if (!tier) return
    return {
      provider_tier: tier,
      provider_tag: "quiver-quant",
    }
  },
})

export default OpenCodeFinancePlugin
