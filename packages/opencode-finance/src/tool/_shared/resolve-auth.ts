import { readQuiverCredential } from "../../finance/credentials"
import {
  endpointMinimumPlan,
  quiverPlanLabel,
  resolveQuiverTierFromAuth,
  tierAllows,
  type QuiverEndpointTier,
  type QuiverTier,
} from "../../finance/quiver-tier"

const LOGIN_HINT =
  "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

export type ResolveQuiverAuthOptions = {
  requiredEndpointTier?: QuiverEndpointTier
  capabilityLabel?: string
}

export type ResolvedQuiverAuth = {
  key: string
  tier: QuiverTier
  inferred: boolean
  warning: string | undefined
}

export async function resolveQuiverAuth(options: ResolveQuiverAuthOptions = {}): Promise<ResolvedQuiverAuth> {
  const state = await readQuiverCredential()
  const authInfo = state.authInfo
  const envKey = state.envKey?.trim()

  if (!authInfo || authInfo.type !== "api") {
    if (envKey) {
      if (options.requiredEndpointTier) {
        throw new Error(`Quiver plan metadata is missing. Run \`${LOGIN_HINT}\` to store key + plan.`)
      }

      return {
        key: envKey,
        tier: "tier_1",
        inferred: true,
        warning:
          "Quiver plan metadata was not found in saved credentials. Defaulting to Public (Tier 0). Re-run `opencode auth login` and select `quiver-quant` to set the correct plan.",
      }
    }

    throw new Error(`Quiver Quant is required for this report. Run \`${LOGIN_HINT}\`.`)
  }

  const key = envKey || authInfo.key?.trim()
  if (!key) {
    throw new Error(`Quiver Quant API key is missing. Run \`${LOGIN_HINT}\`.`)
  }

  const tier = resolveQuiverTierFromAuth(authInfo)

  if (options.requiredEndpointTier) {
    const capabilityLabel = options.capabilityLabel ?? `${options.requiredEndpointTier} datasets required by this report`

    if (tier.inferred) {
      throw new Error(
        `Quiver plan metadata is missing or invalid for ${capabilityLabel}. Re-run \`${LOGIN_HINT}\` to refresh stored plan metadata before retrying.`,
      )
    }

    if (!tierAllows(options.requiredEndpointTier, tier.tier)) {
      throw new Error(
        `Quiver plan ${quiverPlanLabel(tier.tier)} cannot access ${capabilityLabel}. Minimum required plan is ${endpointMinimumPlan(options.requiredEndpointTier)}. If your key was upgraded recently, re-run \`${LOGIN_HINT}\` to refresh stored plan metadata.`,
      )
    }
  }

  return {
    key,
    tier: tier.tier,
    inferred: tier.inferred,
    warning: tier.warning,
  }
}
