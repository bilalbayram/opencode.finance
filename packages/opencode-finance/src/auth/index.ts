import path from "path"
import z from "zod"
import { Global } from "../global"

export namespace Auth {
  export const Oauth = z.object({
    type: z.literal("oauth"),
    refresh: z.string(),
    access: z.string(),
    expires: z.number(),
    accountId: z.string().optional(),
    enterpriseUrl: z.string().optional(),
  })

  export const Api = z.object({
    type: z.literal("api"),
    key: z.string(),
    provider_tier: z.enum(["tier_1", "tier_2", "tier_3", "enterprise"]).optional(),
    provider_tag: z.literal("quiver-quant").optional(),
  })

  export const WellKnown = z.object({
    type: z.literal("wellknown"),
    key: z.string(),
    token: z.string(),
  })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown])
  export type Info = z.infer<typeof Info>

  const filepath = path.join(Global.Path.data, "auth.json")

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    const data = await Bun.file(filepath)
      .json()
      .catch(() => ({} as Record<string, unknown>))

    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(providerID: string, info: Info) {
    const data = await all()
    await Bun.write(filepath, JSON.stringify({ ...data, [providerID]: info }, null, 2), { mode: 0o600 })
  }

  export async function remove(providerID: string) {
    const data = await all()
    delete data[providerID]
    await Bun.write(filepath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }
}
