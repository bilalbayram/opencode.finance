import type { Auth } from "../auth"

export const QUIVER_TIER = ["tier_1", "tier_2", "tier_3", "enterprise"] as const
export type QuiverTier = (typeof QUIVER_TIER)[number]
export type QuiverEndpointTier = Exclude<QuiverTier, "enterprise">

const USER_RANK: Record<QuiverTier, number> = {
  tier_1: 1,
  tier_2: 2,
  tier_3: 3,
  enterprise: 4,
}

const ENDPOINT_MIN_USER_RANK: Record<QuiverEndpointTier, number> = {
  tier_1: USER_RANK.tier_2,
  tier_2: USER_RANK.tier_3,
  tier_3: USER_RANK.enterprise,
}

const PLAN_NAME: Record<QuiverTier, string> = {
  tier_1: "Public",
  tier_2: "Hobbyist",
  tier_3: "Trader",
  enterprise: "Enterprise",
}

const PLAN_COVERAGE: Record<QuiverTier, string> = {
  tier_1: "Tier 0",
  tier_2: "Tier 0 + Tier 1",
  tier_3: "Tier 0 + Tier 1 + Tier 2",
  enterprise: "Tier 0 + Tier 1 + Tier 2",
}

export const QUIVER_TIER_FALLBACK_WARNING =
  "Quiver plan metadata was not found in saved credentials. Defaulting to Public (Tier 0). Re-run `opencode auth login` and select `quiver-quant` to set the correct plan."

export function quiverPlanLabel(tier: QuiverTier): string {
  return `${PLAN_NAME[tier]} (${PLAN_COVERAGE[tier]})`
}

export function endpointMinimumPlan(endpointTier: QuiverEndpointTier): string {
  if (endpointTier === "tier_1") return "Hobbyist (Tier 0 + Tier 1)"
  if (endpointTier === "tier_2") return "Trader (Tier 0 + Tier 1 + Tier 2)"
  return "Enterprise"
}

export function normalizeQuiverTier(input: unknown): QuiverTier | undefined {
  if (typeof input !== "string") return
  const value = input.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!value) return

  if (value === "public" || value === "tier0" || value === "tier_0" || value === "tier1" || value === "tier_1" || value === "1" || value === "t1") return "tier_1"
  if (value === "hobbyist" || value === "tier2" || value === "tier_2" || value === "2" || value === "t2") return "tier_2"
  if (value === "trader" || value === "tier3" || value === "tier_3" || value === "3" || value === "t3") return "tier_3"
  if (value === "enterprise" || value === "4" || value === "tier_4" || value === "tier4" || value === "t4") return "enterprise"
}

export function tierAllows(endpointTier: QuiverEndpointTier, userTier: QuiverTier): boolean {
  return USER_RANK[userTier] >= ENDPOINT_MIN_USER_RANK[endpointTier]
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
