import { afterEach, describe, expect, it } from "bun:test"
import { Auth } from "../auth"
import { Env } from "../env"
import {
  readProviderCredential,
  readQuiverCredential,
  resolveProviderApiKey,
  resolveQuiverProviderCredential,
} from "./credentials"

type AuthGet = typeof Auth.get
type EnvGet = typeof Env.get
type StoredAuth = Awaited<ReturnType<typeof Auth.get>>

const originalAuthGet: AuthGet = Auth.get
const originalEnvGet: EnvGet = Env.get

function setCredentialState(input: {
  env?: Record<string, string | undefined>
  authByProvider?: Record<string, StoredAuth | undefined>
}) {
  ;(Env as any).get = ((key: string) => input.env?.[key]) as EnvGet
  ;(Auth as any).get = (async (providerID: string) => input.authByProvider?.[providerID]) as AuthGet
}

afterEach(() => {
  ;(Env as any).get = originalEnvGet
  ;(Auth as any).get = originalAuthGet
})

describe("credentials", () => {
  it("returns env key before stored auth key for provider api key resolution", async () => {
    setCredentialState({
      env: {
        ALPHAVANTAGE_API_KEY: "env-key",
      },
      authByProvider: {
        alphavantage: {
          type: "api",
          key: "auth-key",
        },
      },
    })

    expect(await resolveProviderApiKey("alphavantage")).toBe("env-key")
  })

  it("uses stored auth key when env key is missing", async () => {
    setCredentialState({
      authByProvider: {
        alphavantage: {
          type: "api",
          key: "auth-key",
        },
      },
    })

    expect(await resolveProviderApiKey("alphavantage")).toBe("auth-key")
  })

  it("does not resolve api key from non-api auth state", async () => {
    setCredentialState({
      authByProvider: {
        alphavantage: {
          type: "oauth",
          refresh: "refresh-token",
          access: "access-token",
          expires: Date.now() + 60_000,
        },
      },
    })

    expect(await resolveProviderApiKey("alphavantage")).toBeUndefined()
  })

  it("preserves raw whitespace when trim=false", async () => {
    setCredentialState({
      env: {
        ALPHAVANTAGE_API_KEY: "  env-key  ",
      },
    })

    expect(await resolveProviderApiKey("alphavantage")).toBe("  env-key  ")
  })

  it("trims and rejects whitespace-only keys when trim=true", async () => {
    setCredentialState({
      env: {
        ALPHAVANTAGE_API_KEY: "   ",
      },
      authByProvider: {
        alphavantage: {
          type: "api",
          key: "  auth-key  ",
        },
      },
    })

    expect(await resolveProviderApiKey("alphavantage", { trim: true })).toBe("auth-key")

    setCredentialState({
      env: {
        ALPHAVANTAGE_API_KEY: "   ",
      },
      authByProvider: {
        alphavantage: {
          type: "api",
          key: "   ",
        },
      },
    })

    expect(await resolveProviderApiKey("alphavantage", { trim: true })).toBeUndefined()
  })

  it("returns raw provider credential state without trimming", async () => {
    const authInfo: StoredAuth = {
      type: "api",
      key: " stored-key ",
    }

    setCredentialState({
      env: {
        FINNHUB_API_KEY: " env-key ",
      },
      authByProvider: {
        finnhub: authInfo,
      },
    })

    await expect(readProviderCredential("finnhub")).resolves.toEqual({
      envKey: " env-key ",
      authInfo,
    })
  })

  it("resolves quiver provider credential with tier from auth metadata", async () => {
    setCredentialState({
      authByProvider: {
        "quiver-quant": {
          type: "api",
          key: "auth-key",
          provider_tier: "tier_3",
          provider_tag: "quiver-quant",
        },
      },
    })

    await expect(resolveQuiverProviderCredential()).resolves.toEqual({
      key: "auth-key",
      tier: "tier_3",
    })
  })

  it("returns undefined quiver provider credential when no key is available", async () => {
    setCredentialState({
      authByProvider: {
        "quiver-quant": undefined,
      },
    })

    await expect(resolveQuiverProviderCredential()).resolves.toBeUndefined()
  })

  it("reads raw quiver credential state", async () => {
    const authInfo: StoredAuth = {
      type: "api",
      key: "stored-key",
      provider_tier: "tier_2",
      provider_tag: "quiver-quant",
    }
    setCredentialState({
      env: {
        QUIVER_QUANT_API_KEY: "env-key",
      },
      authByProvider: {
        "quiver-quant": authInfo,
      },
    })

    await expect(readQuiverCredential()).resolves.toEqual({
      envKey: "env-key",
      authInfo,
    })
  })
})
