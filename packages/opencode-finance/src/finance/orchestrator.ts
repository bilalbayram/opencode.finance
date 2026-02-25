import { Auth } from "../auth"
import { Env } from "../env"
import { FinanceCache } from "./cache"
import { AlphaVantageProvider } from "./providers/alpha-vantage"
import { YFinanceProvider } from "./providers/yfinance"
import { FinnhubProvider } from "./providers/finnhub"
import { FinancialModelingPrepProvider } from "./providers/financial-modeling-prep"
import { PolygonProvider } from "./providers/polygon"
import { QuartrProvider } from "./providers/quartr"
import { QuiverQuantProvider } from "./providers/quiver-quant"
import { SecEdgarProvider } from "./providers/sec-edgar"
import { resolveQuiverTierFromAuth } from "./quiver-tier"
import {
  type FinanceCoverage,
  type FinanceIntent,
  type FinanceProviderData,
  type FinanceProviderRequest,
  type FinanceResult,
} from "./types"
import { parseFinanceQuery } from "./parser"
import { executeFinanceQuery, type FinanceProvider, type FinanceProviderOptions } from "./provider"
import { FINANCE_AUTH_PROVIDER, type FinanceAuthProviderID } from "./auth-provider"

interface OrchestratorProviderInput {
  providers?: FinanceProvider[]
}

export interface FinancialSearchOptions
  extends Omit<FinanceProviderOptions, "providers" | "refresh">,
    OrchestratorProviderInput {
  refresh?: boolean
  source?: string
}

async function credential(providerID: FinanceAuthProviderID): Promise<string | undefined> {
  const env = FINANCE_AUTH_PROVIDER[providerID].env.map((key) => Env.get(key)).find(Boolean)
  if (env) return env
  const auth = await Auth.get(providerID)
  if (auth?.type === "api") return auth.key
  return undefined
}

async function quiverCredential() {
  const env = FINANCE_AUTH_PROVIDER["quiver-quant"].env.map((key) => Env.get(key)).find(Boolean)
  const auth = await Auth.get("quiver-quant")
  const key = env ?? (auth?.type === "api" ? auth.key : undefined)
  if (!key) return
  const tier = resolveQuiverTierFromAuth(auth).tier
  return {
    key,
    tier,
  }
}

export async function createFinanceProviderChain(): Promise<FinanceProvider[]> {
  const providers: FinanceProvider[] = []
  providers.push(new YFinanceProvider())

  const alphavantage = await credential("alphavantage")
  if (alphavantage) providers.push(new AlphaVantageProvider({ apiKey: alphavantage }))

  const finnhub = await credential("finnhub")
  if (finnhub) providers.push(new FinnhubProvider({ apiKey: finnhub }))

  const fmp = await credential("financial-modeling-prep")
  if (fmp) providers.push(new FinancialModelingPrepProvider({ apiKey: fmp }))

  const polygon = await credential("polygon")
  if (polygon) providers.push(new PolygonProvider({ apiKey: polygon }))

  const quartr = await credential("quartr")
  if (quartr) providers.push(new QuartrProvider({ apiKey: quartr }))

  const quiver = await quiverCredential()
  if (quiver) providers.push(new QuiverQuantProvider({ apiKey: quiver.key, tier: quiver.tier }))

  const secIdentity = await credential("sec-edgar")
  if (secIdentity) providers.push(new SecEdgarProvider({ identity: secIdentity }))

  return providers
}

export async function financialSearch(
  input: {
    query: string
    intent?: FinanceIntent
    ticker?: string
    form?: string
    coverage?: FinanceCoverage
    limit?: number
    source?: string
  },
  options: FinancialSearchOptions = {},
): Promise<FinanceResult<FinanceProviderData>> {
  const parsed = parseFinanceQuery(input)
  const providers = options.providers ?? (await createFinanceProviderChain())

  const request: FinanceProviderRequest = {
    query: parsed.query,
    intent: parsed.intent,
    ticker: parsed.ticker,
    form: parsed.form,
    coverage: parsed.coverage,
    limit: parsed.limit,
    source: options.source ?? parsed.source,
    refresh: options.refresh,
  }

  return executeFinanceQuery(request, {
    ...options,
    providers,
    cache: options.cache,
  })
}
