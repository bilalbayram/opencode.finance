import { FinanceCache } from "./cache"
import { AlphaVantageProvider } from "./providers/alpha-vantage"
import { YFinanceProvider } from "./providers/yfinance"
import { FinnhubProvider } from "./providers/finnhub"
import { FinancialModelingPrepProvider } from "./providers/financial-modeling-prep"
import { PolygonProvider } from "./providers/polygon"
import { QuartrProvider } from "./providers/quartr"
import { QuiverQuantProvider } from "./providers/quiver-quant"
import { SecEdgarProvider } from "./providers/sec-edgar"
import {
  type FinanceCoverage,
  type FinanceIntent,
  type FinanceProviderData,
  type FinanceProviderRequest,
  type FinanceResult,
} from "./types"
import { parseFinanceQuery } from "./parser"
import { executeFinanceQuery, type FinanceProvider, type FinanceProviderOptions } from "./provider"
import { resolveProviderApiKey, resolveQuiverProviderCredential } from "./credentials"

interface OrchestratorProviderInput {
  providers?: FinanceProvider[]
}

export interface FinancialSearchOptions
  extends Omit<FinanceProviderOptions, "providers" | "refresh">,
    OrchestratorProviderInput {
  refresh?: boolean
  source?: string
}

export async function createFinanceProviderChain(): Promise<FinanceProvider[]> {
  const providers: FinanceProvider[] = []
  providers.push(new YFinanceProvider())

  const alphavantage = await resolveProviderApiKey("alphavantage")
  if (alphavantage) providers.push(new AlphaVantageProvider({ apiKey: alphavantage }))

  const finnhub = await resolveProviderApiKey("finnhub")
  if (finnhub) providers.push(new FinnhubProvider({ apiKey: finnhub }))

  const fmp = await resolveProviderApiKey("financial-modeling-prep")
  if (fmp) providers.push(new FinancialModelingPrepProvider({ apiKey: fmp }))

  const polygon = await resolveProviderApiKey("polygon")
  if (polygon) providers.push(new PolygonProvider({ apiKey: polygon }))

  const quartr = await resolveProviderApiKey("quartr")
  if (quartr) providers.push(new QuartrProvider({ apiKey: quartr }))

  const quiver = await resolveQuiverProviderCredential()
  if (quiver) providers.push(new QuiverQuantProvider({ apiKey: quiver.key, tier: quiver.tier }))

  const secIdentity = await resolveProviderApiKey("sec-edgar")
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
