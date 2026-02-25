import fs from "fs/promises"
import os from "os"
import path from "path"
import { xdgConfig, xdgData } from "xdg-basedir"

const LEGACY_APP = "opencode-finance"
const APP = "opencode"
const LEGACY_DOT = ".opencode-finance"
const DOT = ".opencode"
const PLUGIN = "opencode-finance"
const REPORT_SKILL = "finance-comprehensive-report"

const dataRoot = xdgData ?? path.join(os.homedir(), ".local", "share")
const configRoot = xdgConfig ?? path.join(os.homedir(), ".config")

const legacyData = path.join(dataRoot, LEGACY_APP)
const data = path.join(dataRoot, APP)
const legacyConfig = path.join(configRoot, LEGACY_APP)
const config = path.join(configRoot, APP)
const legacyHome = path.join(os.homedir(), LEGACY_DOT)
const home = path.join(os.homedir(), DOT)

async function exists(filepath: string) {
  return Bun.file(filepath).exists()
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected JSON object`)
  }
  return value as Record<string, unknown>
}

function stripJSONCComments(source: string) {
  let out = ""
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        out += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        i++
      } else if (char === "\n") {
        out += char
      }
      continue
    }

    if (inString) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      i++
      continue
    }

    if (char === "/" && next === "*") {
      inBlockComment = true
      i++
      continue
    }

    if (char === "\"") inString = true
    out += char
  }

  return out
}

function stripJSONCTrailingCommas(source: string) {
  let out = ""
  let inString = false
  let escaped = false

  for (let i = 0; i < source.length; i++) {
    const char = source[i]

    if (inString) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }

    if (char === "\"") {
      inString = true
      out += char
      continue
    }

    if (char === ",") {
      let j = i + 1
      while (j < source.length && /\s/.test(source[j])) j++
      if (source[j] === "}" || source[j] === "]") continue
    }

    out += char
  }

  return out
}

async function readJSON(filepath: string) {
  const source = await Bun.file(filepath).text()
  try {
    return object(JSON.parse(source))
  } catch (error) {
    const parseLegacyJSON = (value: string) => {
      const withoutComments = stripJSONCComments(value)
      const sanitized = stripJSONCTrailingCommas(withoutComments)
      return JSON.parse(sanitized)
    }
    try {
      return object(parseLegacyJSON(source))
    } catch (fallbackError) {
      const base = error instanceof Error ? error.message : String(error)
      const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new Error(`Failed to parse config ${filepath}: ${base}; JSONC fallback failed: ${fallback}`)
    }
  }
}

type Holding = {
  ticker: string
  price_bought: number
  date_bought: string
  updated_at: string
}

function isHolding(value: unknown): value is Holding {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  if (typeof item.ticker !== "string") return false
  if (typeof item.price_bought !== "number") return false
  if (typeof item.date_bought !== "string") return false
  if (typeof item.updated_at !== "string") return false
  return true
}

function holdings(value: unknown): Holding[] {
  if (!Array.isArray(value)) throw new Error("Expected holdings array")
  return value.filter(isHolding)
}

async function migrateAuth() {
  const source = path.join(legacyData, "auth.json")
  const target = path.join(data, "auth.json")
  if (!(await exists(source))) return { copied: 0, path: target }
  const from = await readJSON(source)
  const current = (await exists(target)) ? await readJSON(target) : {}
  const merged = { ...from, ...current }
  const copied = Object.keys(from).filter((key) => !(key in current)).length
  if (copied === 0 && (await exists(target))) return { copied, path: target }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
  return { copied, path: target }
}

async function migratePortfolio() {
  const source = path.join(legacyData, "storage", "finance", "portfolio", "holdings.json")
  const target = path.join(data, "storage", "finance", "portfolio", "holdings.json")
  if (!(await exists(source))) return { copied: 0, path: target }
  const from = holdings(await Bun.file(source).json())
  const current = (await exists(target)) ? holdings(await Bun.file(target).json()) : []
  const seen = new Set(current.map((item) => item.ticker))
  const copied = from.filter((item) => !seen.has(item.ticker)).length
  if (copied === 0 && (await exists(target))) return { copied, path: target }
  const merged = [...from, ...current]
    .reduce(
      (acc, item) => {
        acc.set(item.ticker, item)
        return acc
      },
      new Map<string, Holding>(),
    )
  const ordered = Array.from(merged.values()).toSorted((a, b) => a.ticker.localeCompare(b.ticker))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, JSON.stringify(ordered, null, 2) + "\n", { mode: 0o600 })
  return { copied, path: target }
}

async function migrateSkill() {
  const source = path.join(legacyHome, "skills", REPORT_SKILL, "SKILL.md")
  const target = path.join(home, "skills", REPORT_SKILL, "SKILL.md")
  if (!(await exists(source))) return { copied: false, path: target }
  if (await exists(target)) return { copied: false, path: target }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
  return { copied: true, path: target }
}

async function migrateConfig() {
  const targetJSONC = path.join(config, "opencode.jsonc")
  if (await exists(targetJSONC)) {
    return { added: false, skipped: `Found ${targetJSONC}; update plugin list manually.` }
  }
  const sourceJSON = path.join(legacyConfig, "opencode-finance.json")
  const sourceJSONC = path.join(legacyConfig, "opencode-finance.jsonc")
  const source =
    (await exists(sourceJSON))
      ? sourceJSON
      : (await exists(sourceJSONC))
        ? sourceJSONC
        : undefined
  const target = path.join(config, "opencode.json")
  const current = (await exists(target)) ? await readJSON(target) : {}
  if (source) {
    const legacy = await readJSON(source)
    if (!("theme" in current) && "theme" in legacy) current.theme = legacy.theme
    if (!("model" in current) && "model" in legacy) current.model = legacy.model
    if (!("provider" in current) && "provider" in legacy) current.provider = legacy.provider
  }
  const plugin = Array.isArray(current.plugin) ? current.plugin.filter((item) => typeof item === "string") : []
  if (plugin.includes(PLUGIN)) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await Bun.write(target, JSON.stringify(current, null, 2) + "\n")
    return { added: false, skipped: "" }
  }
  const next: Record<string, unknown> = { ...current, plugin: [...plugin, PLUGIN] }
  if (!("$schema" in next)) next.$schema = "https://opencode.ai/config.json"
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, JSON.stringify(next, null, 2) + "\n")
  return { added: true, skipped: "" }
}

export async function migrateFinanceForkToPlugin() {
  const auth = await migrateAuth()
  const portfolio = await migratePortfolio()
  const skill = await migrateSkill()
  const plugin = await migrateConfig()
  return { auth, portfolio, skill, plugin }
}

async function main() {
  const result = await migrateFinanceForkToPlugin()
  console.log("Finance plugin migration complete.")
  console.log(`- auth credentials imported: ${result.auth.copied} -> ${result.auth.path}`)
  console.log(`- portfolio holdings imported: ${result.portfolio.copied} -> ${result.portfolio.path}`)
  console.log(`- report skill copied: ${result.skill.copied ? "yes" : "no"} -> ${result.skill.path}`)
  if (result.plugin.skipped) console.log(`- plugin config: ${result.plugin.skipped}`)
  if (!result.plugin.skipped) {
    console.log(`- plugin added to opencode config: ${result.plugin.added ? "yes" : "no"}`)
  }
}

if (import.meta.main) {
  await main()
}
