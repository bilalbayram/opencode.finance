import { describe, expect, it } from "bun:test"
import { resolveStrictQuiverAuth } from "./quiver-auth"

const LOGIN_HINT =
  "curl -fsSL https://opencode.finance/install.sh | bash (recommended) or run `opencode auth login` and select `quiver-quant`"

function run(input: {
  authInfo: any
  envKey?: string
  requiredEndpointTier?: "tier_1" | "tier_2" | "tier_3"
  capabilityLabel?: string
}) {
  return resolveStrictQuiverAuth({
    authInfo: input.authInfo,
    envKey: input.envKey,
    loginHint: LOGIN_HINT,
    requiredEndpointTier: input.requiredEndpointTier ?? "tier_1",
    capabilityLabel: input.capabilityLabel ?? "Tier 1 government-trading datasets required by this report",
  })
}

describe("resolveStrictQuiverAuth", () => {
  it("returns auth payload when plan metadata is valid and satisfies required endpoint tier", () => {
    const result = run({
      authInfo: {
        type: "api",
        key: "auth-key",
        provider_tier: "tier_2",
        provider_tag: "quiver-quant",
      },
      requiredEndpointTier: "tier_1",
    })

    expect(result).toEqual({
      key: "auth-key",
      tier: "tier_2",
      inferred: false,
      warning: undefined,
    })
  })

  it("fails loudly when provider tier metadata is missing", () => {
    expect(() =>
      run({
        authInfo: {
          type: "api",
          key: "auth-key",
        },
      }),
    ).toThrow(/plan metadata is missing or invalid/i)
  })

  it("fails loudly when provider tier metadata is invalid", () => {
    expect(() =>
      run({
        authInfo: {
          type: "api",
          key: "auth-key",
          provider_tier: "unexpected",
        },
      }),
    ).toThrow(/plan metadata is missing or invalid/i)
  })

  it("fails when stored plan does not satisfy required endpoint tier", () => {
    expect(() =>
      run({
        authInfo: {
          type: "api",
          key: "auth-key",
          provider_tier: "tier_1",
          provider_tag: "quiver-quant",
        },
        requiredEndpointTier: "tier_1",
      }),
    ).toThrow(/Public \(Tier 0\).*Minimum required plan is Hobbyist.*refresh stored plan metadata/i)
  })

  it("preserves existing required-auth error for missing credentials", () => {
    expect(() =>
      run({
        authInfo: undefined,
      }),
    ).toThrow(/Quiver Quant is required for this report/i)
  })

  it("preserves missing-metadata error when only env key is present", () => {
    expect(() =>
      run({
        authInfo: undefined,
        envKey: "env-key",
      }),
    ).toThrow(/plan metadata is missing/i)
  })

  it("preserves required-auth error for non-api credentials", () => {
    expect(() =>
      run({
        authInfo: {
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        },
      }),
    ).toThrow(/Quiver Quant is required for this report/i)
  })
})
