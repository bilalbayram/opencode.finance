import { CACHE_TTL_SECONDS, type FinanceIntent, type NormalizedFinanceQuery } from "./types"

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class FinanceCache {
  private readonly store = new Map<string, CacheEntry<unknown>>()

  getKey(input: NormalizedFinanceQuery): string {
    return `${input.ticker.toUpperCase()}:${input.intent}:${input.coverage ?? "default"}:${input.source ?? "auto"}:${input.form ?? ""}:${input.limit}`
  }

  get<T>(input: NormalizedFinanceQuery): T | null {
    const key = this.getKey(input)
    const value = this.store.get(key)
    if (!value || Date.now() > value.expiresAt) {
      if (value) this.store.delete(key)
      return null
    }
    return value.value as T
  }

  set<T>(input: NormalizedFinanceQuery, value: T, intent: FinanceIntent): void {
    this.store.set(this.getKey(input), {
      value,
      expiresAt: Date.now() + ttl(intent) * 1000,
    })
  }

  clear() {
    this.store.clear()
  }
}

function ttl(intent: FinanceIntent): number {
  return CACHE_TTL_SECONDS[intent] ?? 300
}
