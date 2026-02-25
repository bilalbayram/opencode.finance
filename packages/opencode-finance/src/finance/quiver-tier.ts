import type { Auth } from "../auth"

export const QUIVER_TIER = ["tier_1", "tier_2", "tier_3", "enterprise"] as const
export type QuiverTier = (typeof QUIVER_TIER)[number]
export type QuiverEndpointTier = Exclude<QuiverTier, "enterprise">

const RANK: Record<QuiverTier, number> = {
  tier_1: 1,
  tier_2: 2,
  tier_3: 3,
  enterprise: 4,
}

export const QUIVER_TIER_FALLBACK_WARNING =
  "Quiver tier was not found in saved credentials. Defaulting to tier_1. Re-run `opencode auth login --provider quiver-quant` (or `opencode auth login` then select `quiver-quant`) to set the correct tier."

export function normalizeQuiverTier(input: unknown): QuiverTier | undefined {
  if (typeof input !== "string") return
  const value = input.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!value) return
  if (value === "enterprise" || value === "4" || value === "tier_4" || value === "tier4") return "enterprise"
  if (value === "tier_1" || value === "tier1" || value === "1" || value === "t1") return "tier_1"
  if (value === "tier_2" || value === "tier2" || value === "2" || value === "t2") return "tier_2"
  if (value === "tier_3" || value === "tier3" || value === "3" || value === "t3") return "tier_3"
}

export function tierAllows(endpointTier: QuiverEndpointTier, userTier: QuiverTier): boolean {
  return RANK[userTier] >= RANK[endpointTier]
}

export function resolveQuiverTierFromAuth(authInfo: Auth.Info | undefined) {
  if (!authInfo || authInfo.type !== "api") {
    return {
      tier: "tier_1" as const,
      inferred: true,
      warning: QUIVER_TIER_FALLBACK_WARNING,
    }
  }

  const tier = normalizeQuiverTier(authInfo.provider_tier)
  if (tier) {
    return {
      tier,
      inferred: false,
      warning: undefined as string | undefined,
    }
  }

  return {
    tier: "tier_1" as const,
    inferred: true,
    warning: QUIVER_TIER_FALLBACK_WARNING,
  }
}
