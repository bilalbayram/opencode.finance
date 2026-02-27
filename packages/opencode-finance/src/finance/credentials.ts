import { Auth } from "../auth"
import { Env } from "../env"
import { type FinanceAuthProviderID, FINANCE_AUTH_PROVIDER } from "./auth-provider"
import { resolveQuiverTierFromAuth, type QuiverTier } from "./quiver-tier"

type ResolveKeyOptions = {
  trim?: boolean
}

type CredentialState = {
  envKey: string | undefined
  authInfo: Awaited<ReturnType<typeof Auth.get>>
}

function resolveKeyFromState(input: CredentialState, options: ResolveKeyOptions = {}) {
  if (options.trim) {
    const env = input.envKey?.trim()
    if (env) return env
    if (input.authInfo?.type !== "api") return undefined
    const key = input.authInfo.key?.trim()
    if (key) return key
    return undefined
  }

  if (input.envKey) return input.envKey
  if (input.authInfo?.type === "api") return input.authInfo.key
  return undefined
}

export async function readProviderCredential(providerID: FinanceAuthProviderID): Promise<CredentialState> {
  const envKey = FINANCE_AUTH_PROVIDER[providerID].env.map((key) => Env.get(key)).find(Boolean)
  const authInfo = await Auth.get(providerID)
  return {
    envKey,
    authInfo,
  }
}

export async function resolveProviderApiKey(
  providerID: FinanceAuthProviderID,
  options: ResolveKeyOptions = {},
): Promise<string | undefined> {
  const state = await readProviderCredential(providerID)
  return resolveKeyFromState(state, options)
}

export async function readQuiverCredential() {
  return readProviderCredential("quiver-quant")
}

export async function resolveQuiverProviderCredential(
  options: ResolveKeyOptions = {},
): Promise<{ key: string; tier: QuiverTier } | undefined> {
  const state = await readQuiverCredential()
  const key = resolveKeyFromState(state, options)
  if (!key) return undefined
  const tier = resolveQuiverTierFromAuth(state.authInfo).tier
  return {
    key,
    tier,
  }
}
