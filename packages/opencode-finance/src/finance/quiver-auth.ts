import type { Auth } from "../auth"
import {
  endpointMinimumPlan,
  quiverPlanLabel,
  resolveQuiverTierFromAuth,
  tierAllows,
  type QuiverEndpointTier,
  type QuiverTier,
} from "./quiver-tier"

export type StrictQuiverAuthInput = {
  authInfo: Auth.Info | undefined
  envKey: string | undefined
  loginHint: string
  requiredEndpointTier: QuiverEndpointTier
  capabilityLabel: string
}

export type StrictQuiverAuth = {
  key: string
  tier: QuiverTier
  inferred: false
  warning: undefined
}

export function resolveStrictQuiverAuth(input: StrictQuiverAuthInput): StrictQuiverAuth {
  const envKey = input.envKey?.trim()

  if (!input.authInfo || input.authInfo.type !== "api") {
    if (envKey) {
      throw new Error(`Quiver plan metadata is missing. Run \`${input.loginHint}\` to store key + plan.`)
    }
    throw new Error(`Quiver Quant is required for this report. Run \`${input.loginHint}\`.`)
  }

  const key = envKey || input.authInfo.key?.trim()
  if (!key) {
    throw new Error(`Quiver Quant API key is missing. Run \`${input.loginHint}\`.`)
  }

  const tier = resolveQuiverTierFromAuth(input.authInfo)
  if (tier.inferred) {
    throw new Error(
      `Quiver plan metadata is missing or invalid for ${input.capabilityLabel}. Re-run \`${input.loginHint}\` to refresh stored plan metadata before retrying.`,
    )
  }

  if (!tierAllows(input.requiredEndpointTier, tier.tier)) {
    throw new Error(
      `Quiver plan ${quiverPlanLabel(tier.tier)} cannot access ${input.capabilityLabel}. Minimum required plan is ${endpointMinimumPlan(input.requiredEndpointTier)}. If your key was upgraded recently, re-run \`${input.loginHint}\` to refresh stored plan metadata.`,
    )
  }

  return {
    key,
    tier: tier.tier,
    inferred: false,
    warning: undefined,
  }
}
