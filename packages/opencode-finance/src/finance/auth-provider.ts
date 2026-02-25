export const FINANCE_AUTH_PROVIDER_ID = [
  "yfinance",
  "alphavantage",
  "finnhub",
  "financial-modeling-prep",
  "polygon",
  "quartr",
  "quiver-quant",
  "sec-edgar",
] as const

export type FinanceAuthProviderID = (typeof FINANCE_AUTH_PROVIDER_ID)[number]

export type FinanceCredentialType = "none" | "api" | "identity"

export interface FinanceAuthProvider {
  id: FinanceAuthProviderID
  name: string
  hint?: string
  credential: FinanceCredentialType
  env: string[]
}

export const FINANCE_AUTH_PROVIDERS: FinanceAuthProvider[] = [
  {
    id: "yfinance",
    name: "Yahoo Finance",
    hint: "public finance data",
    credential: "none",
    env: [],
  },
  {
    id: "alphavantage",
    name: "Alpha Vantage",
    hint: "quote/fundamentals/news",
    credential: "api",
    env: ["ALPHAVANTAGE_API_KEY", "ALPHAVANTAGE_KEY"],
  },
  {
    id: "finnhub",
    name: "Finnhub",
    hint: "quote/fundamentals/insider/news",
    credential: "api",
    env: ["FINNHUB_API_KEY", "FINNHUB_KEY"],
  },
  {
    id: "financial-modeling-prep",
    name: "Financial Modeling Prep",
    hint: "quote/fundamentals/news",
    credential: "api",
    env: ["FMP_API_KEY", "FINANCIAL_MODELING_PREP_API_KEY"],
  },
  {
    id: "polygon",
    name: "Polygon",
    hint: "market/reference/news",
    credential: "api",
    env: ["POLYGON_API_KEY", "POLYGON_KEY"],
  },
  {
    id: "quartr",
    name: "Quartr",
    hint: "reports/events/news",
    credential: "api",
    env: ["QUARTR_API_KEY"],
  },
  {
    id: "quiver-quant",
    name: "Quiver Quant",
    hint: "insider data",
    credential: "api",
    env: ["QUIVER_QUANT_API_KEY", "QUIVERQUANT_API_KEY"],
  },
  {
    id: "sec-edgar",
    name: "SEC EDGAR",
    hint: "official filings",
    credential: "identity",
    env: ["SEC_EDGAR_IDENTITY", "SEC_API_USER_AGENT"],
  },
]

export const FINANCE_AUTH_PROVIDER = Object.fromEntries(FINANCE_AUTH_PROVIDERS.map((item) => [item.id, item])) as Record<
  FinanceAuthProviderID,
  FinanceAuthProvider
>

export function isFinanceAuthProviderID(value: string): value is FinanceAuthProviderID {
  return FINANCE_AUTH_PROVIDER_ID.includes(value as FinanceAuthProviderID)
}
