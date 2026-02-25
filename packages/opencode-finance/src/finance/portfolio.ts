import z from "zod"
import { Storage } from "../storage/storage"
import { Global } from "../global"
import path from "path"
import fs from "fs/promises"
import { normalizeTicker } from "./parser"

const KEY = ["finance", "portfolio", "holdings"]
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DIR = path.join(Global.Path.data, "storage", "finance", "portfolio")

export const PortfolioHolding = z.object({
  ticker: z.string().min(1),
  price_bought: z.number().positive(),
  date_bought: z.string().min(1),
  updated_at: z.string().min(1),
})

export const PortfolioUpsert = z.object({
  ticker: z.string().min(1),
  price_bought: z.number().positive(),
  date_bought: z.string().min(1),
})

export type PortfolioHolding = z.infer<typeof PortfolioHolding>
export type PortfolioUpsert = z.infer<typeof PortfolioUpsert>

function stamp() {
  return new Date().toISOString()
}

function normalizeDate(input: string) {
  const value = input.trim()
  if (!DATE.test(value)) throw new Error("date_bought must use YYYY-MM-DD format")
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) throw new Error("date_bought must be a valid calendar date")
  const [year, month, day] = value.split("-").map(Number)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error("date_bought must be a valid calendar date")
  }
  return value
}

function normalize(input: PortfolioHolding[]) {
  return input
    .map((item) =>
      PortfolioHolding.parse({
        ticker: normalizeTicker(item.ticker),
        price_bought: item.price_bought,
        date_bought: normalizeDate(item.date_bought),
        updated_at: item.updated_at || stamp(),
      }),
    )
    .toSorted((a, b) => a.ticker.localeCompare(b.ticker) || b.date_bought.localeCompare(a.date_bought))
}

async function write(input: PortfolioHolding[]) {
  await fs.mkdir(DIR, { recursive: true })
  await Storage.write(KEY, input)
}

export async function listPortfolio(): Promise<PortfolioHolding[]> {
  return Storage.read<PortfolioHolding[]>(KEY)
    .then(normalize)
    .catch((error) => {
      if (error instanceof Storage.NotFoundError) return []
      throw error
    })
}

export async function upsertPortfolio(input: PortfolioUpsert) {
  const parsed = PortfolioUpsert.parse(input)
  const ticker = normalizeTicker(parsed.ticker)
  if (!ticker) throw new Error("ticker must contain at least one valid symbol character")
  const date_bought = normalizeDate(parsed.date_bought)
  const now = stamp()
  let created = false
  const next = await listPortfolio().then((items) => {
    const idx = items.findIndex((item) => item.ticker === ticker)
    created = idx < 0
    const holding = {
      ticker,
      price_bought: parsed.price_bought,
      date_bought,
      updated_at: now,
    }
    if (idx < 0) return normalize([...items, holding])
    return normalize(items.map((item, index) => (index === idx ? holding : item)))
  })
  await write(next)
  return {
    created,
    holdings: next,
    holding: next.find((item) => item.ticker === ticker)!,
  }
}

export async function removePortfolio(ticker: string) {
  const symbol = normalizeTicker(ticker)
  if (!symbol) throw new Error("ticker is required")
  const current = await listPortfolio()
  const holdings = normalize(current.filter((item) => item.ticker !== symbol))
  await write(holdings)
  return {
    removed: holdings.length < current.length,
    holdings,
  }
}

export async function clearPortfolio() {
  await write([])
  return []
}
