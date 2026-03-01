import path from "path"
import z from "zod"
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib"
import { Tool } from "../tool"
import DESCRIPTION from "../report_pdf.txt"
import { assertExternalDirectory } from "../external-directory"
import { projectRoot } from "../_shared"
import { financialSearch } from "../../finance/orchestrator"

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 44
const HEADER_HEIGHT = 84
const TOP = PAGE_HEIGHT - HEADER_HEIGHT - 30
const BOTTOM = 56
const FOOTER_TEXT = "opencode.finance"
const FOOTER_URL = "https://opencode.finance"
const PDF_SUBCOMMAND = ["report", "government-trading", "darkpool-anomaly", "political-backtest"] as const
const PDF_SUBCOMMAND_SET = new Set<string>(PDF_SUBCOMMAND)
const PDF_SUBCOMMAND_LABEL = PDF_SUBCOMMAND.join(", ")

const THEME = {
  paper: hex("#F6F8FB"),
  navy: hex("#0B1F33"),
  navySoft: hex("#102A43"),
  sky: hex("#2F6FA3"),
  slate: hex("#334E68"),
  ink: hex("#102A43"),
  text: hex("#1F2933"),
  muted: hex("#52606D"),
  line: hex("#C7D1DC"),
  card: hex("#DFE6EE"),
  score: hex("#EDF2F7"),
  positive: hex("#0F5132"),
  positiveBg: hex("#DFF5E8"),
  risk: hex("#7F1D1D"),
  riskBg: hex("#FCE8E8"),
  neutral: hex("#1D4E89"),
  neutralBg: hex("#E1ECF7"),
  monoBg: hex("#EEF3F8"),
}

const subcommandSchema = z.string(`subcommand is required. Use one of: ${PDF_SUBCOMMAND_LABEL}`)

const parameters = z.object({
  subcommand: subcommandSchema.describe("Workflow profile for quality gates and artifact requirements."),
  outputRoot: z.string().describe("Report directory path, usually reports/<TICKER>/<YYYY-MM-DD>/"),
  filename: z.string().optional().describe("Optional PDF filename. Defaults to <TICKER>-<DATE>.pdf inside outputRoot."),
})

type Font = Awaited<ReturnType<PDFDocument["embedFont"]>>
type Image = Awaited<ReturnType<PDFDocument["embedPng"]>>
type PdfSubcommand = (typeof PDF_SUBCOMMAND)[number]

type FontSet = {
  regular: Font
  bold: Font
  mono: Font
  ui: Font
  uiBold: Font
}

type Tone = "positive" | "risk" | "neutral"

type Metric = {
  label: string
  value: string
  tone: Tone
}

type Cover = {
  title: string
  ticker: string
  date: string
  sector: string
  headquarters: string
  icon: string
  score: string
  band: string
  summary: string
  positive: string[]
  negative: string[]
  metrics: Metric[]
}

type SectionStyle = {
  mono?: boolean
  size?: number
  line?: number
}

type RootHints = {
  ticker: string
  date: string
}

type LoadedArtifacts = {
  report: string
  dashboard?: string
  assumptions?: string
  normalizedEventsJson?: string
  deltaEventsJson?: string
  dataJson?: string
  evidenceMarkdown?: string
  evidenceJson?: string
  aggregateJson?: string
  comparisonJson?: string
}

type PdfSection = {
  title: string
  content: string
  style?: SectionStyle
}

type PdfProfile = {
  buildCoverData: (input: { artifacts: LoadedArtifacts; hints: RootHints }) => Cover
  enrichCover: (input: { info: Cover; ctx: Tool.Context }) => Promise<Cover>
  renderCover: (input: { pdf: PDFDocument; info: Cover; font: FontSet; icon?: Image; artifacts: LoadedArtifacts }) => void
  sectionPlan: (artifacts: LoadedArtifacts) => PdfSection[]
  qualityGate: (input: { info: Cover; artifacts: LoadedArtifacts }) => string[]
}

type DarkpoolTransitionCounts = {
  new: number
  persisted: number
  severity_change: number
  resolved: number
}

type DarkpoolTopAnomaly = {
  ticker: string
  severity: string
  direction: string
  absZ: number
  state: string
}

type DarkpoolCoverData = {
  threshold: number
  lookbackDays: number
  minSamples: number
  transitions: DarkpoolTransitionCounts
  significantCount: number
  topAnomalies: DarkpoolTopAnomaly[]
}

type PoliticalBacktestAggregate = {
  anchorKind: "transaction" | "report"
  windowSessions: number
  benchmarkSymbol: string
  sampleSize: number
  hitRatePercent: number
  meanReturnPercent: number
  medianReturnPercent: number
  meanExcessReturnPercent: number
}

type PoliticalBacktestComparison = {
  firstRun: boolean
  eventCurrent: number
  eventBaseline: number
  newEvents: number
  removedEvents: number
  conclusionChanges: number
  baselineGeneratedAt: string
  baselineOutputRoot: string
}

type PoliticalBacktestCoverData = {
  scope: string
  mode: "ticker" | "portfolio" | "unknown"
  windowsLabel: string
  benchmarkCount: number
  eventCount: number
  bestAggregateLabel: string
  bestMeanExcess: number
  sampleDeltaLabel: string
  sampleDelta: number
  topSignals: string[]
  longitudinalHighlights: string[]
}

type Row =
  | {
      kind: "blank"
    }
  | {
      kind: "heading"
      text: string
      size: number
    }
  | {
      kind: "text"
      text: string
    }
  | {
      kind: "bullet"
      text: string
      marker: string
    }
  | {
      kind: "table"
      head: string[]
      rows: string[][]
    }

export const ReportPdfTool = Tool.define("report_pdf", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const subcommand = parsePdfSubcommand(params.subcommand)
    const profile = getPdfProfile(subcommand)
    const root = path.isAbsolute(params.outputRoot)
      ? path.normalize(params.outputRoot)
      : path.resolve(ctx.directory, params.outputRoot)
    const worktree = projectRoot(ctx)

    await assertExternalDirectory(ctx, root, { kind: "directory" })

    await ctx.ask({
      permission: "read",
      patterns: artifactReadPatterns(root, subcommand),
      always: ["*"],
      metadata: {
        outputRoot: root,
        subcommand,
      },
    })

    const artifacts = await loadArtifacts(root, subcommand)
    const hints = defaultRootHints(root, subcommand)

    let info = profile.buildCoverData({
      artifacts,
      hints,
    })
    info = await profile.enrichCover({
      info,
      ctx,
    })
    const quality = profile.qualityGate({
      info,
      artifacts,
    })

    if (quality.length) {
      throw new Error(
        ["PDF export blocked by institutional quality gate:", ...quality.map((item) => `- ${item}`)].join("\n"),
      )
    }

    const filename = name(params.filename, info.ticker, info.date)
    const output = path.join(root, filename)

    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(worktree, output)],
      always: ["*"],
      metadata: {
        filepath: output,
      },
    })

    const pdf = await PDFDocument.create()
    const font = {
      regular: await pdf.embedFont(StandardFonts.TimesRoman),
      bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
      mono: await pdf.embedFont(StandardFonts.Courier),
      ui: await pdf.embedFont(StandardFonts.Helvetica),
      uiBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    }
    const icon = await embedIcon(pdf, info.icon)

    profile.renderCover({
      pdf,
      info,
      font,
      icon,
      artifacts,
    })
    for (const item of profile.sectionPlan(artifacts)) {
      section(pdf, font, info, item.title, item.content, item.style)
    }

    const pages = pdf.getPages()
    pages.forEach((page, index) => {
      footer(page, font, info, index + 1, pages.length)
    })

    const bytes = await pdf.save()
    await Bun.write(output, bytes)

    return {
      title: path.relative(worktree, output),
      output: `Generated PDF report at ${output}`,
      metadata: {
        output,
        pages: pages.length,
        ticker: info.ticker,
        date: info.date,
      },
    }
  },
})

async function readOptional(filepath: string) {
  const file = Bun.file(filepath)
  const exists = await file.exists()
  if (!exists) return
  return file.text()
}

async function readRequired(filepath: string) {
  const out = await readOptional(filepath)
  if (out) return out
  throw new Error(`Missing required report artifact: ${filepath}`)
}

function parsePdfSubcommand(input: unknown): PdfSubcommand {
  if (input === undefined || input === null) {
    throw new Error(`subcommand is required. Use one of: ${PDF_SUBCOMMAND_LABEL}`)
  }
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`subcommand is required. Use one of: ${PDF_SUBCOMMAND_LABEL}`)
  }
  const value = input.trim()
  if (!PDF_SUBCOMMAND_SET.has(value)) {
    throw new Error(`subcommand must be one of: ${PDF_SUBCOMMAND_LABEL}`)
  }
  return value as PdfSubcommand
}

function sectionPlanForSubcommand(subcommand: PdfSubcommand, artifacts: LoadedArtifacts): PdfSection[] {
  return getPdfProfile(subcommand).sectionPlan(artifacts)
}

function getPdfProfile(subcommand: PdfSubcommand): PdfProfile {
  if (subcommand === "government-trading") {
    return {
      buildCoverData: ({ artifacts, hints }) => governmentTradingCoverData(artifacts.report, artifacts.dashboard, hints),
      enrichCover: async ({ info }) => info,
      renderCover: ({ pdf, info, font, icon }) => renderReportCover(pdf, info, font, icon),
      sectionPlan: (artifacts) => [
        {
          title: "Dashboard",
          content: textOrUnknown(artifacts.dashboard, "dashboard.md"),
        },
        {
          title: "Full Report",
          content: artifacts.report,
        },
        {
          title: "Assumptions",
          content: assumptionsMarkdown(artifacts.assumptions),
        },
        {
          title: "Delta Events",
          content: jsonArtifactContent(artifacts.deltaEventsJson, "delta-events.json"),
          style: { mono: true, size: 9, line: 12 },
        },
        {
          title: "Normalized Events",
          content: jsonArtifactContent(artifacts.normalizedEventsJson, "normalized-events.json"),
          style: { mono: true, size: 9, line: 12 },
        },
      ],
      qualityGate: ({ artifacts }) =>
        qualityIssuesGovernmentTrading({
          report: artifacts.report,
          dashboard: artifacts.dashboard,
          assumptions: artifacts.assumptions,
          normalizedEventsJson: artifacts.normalizedEventsJson,
          deltaEventsJson: artifacts.deltaEventsJson,
          dataJson: artifacts.dataJson,
        }),
    }
  }

  if (subcommand === "darkpool-anomaly") {
    return {
      buildCoverData: ({ artifacts, hints }) => darkpoolCoverData(artifacts.report, artifacts.dashboard, hints),
      enrichCover: async ({ info }) => info,
      renderCover: ({ pdf, info, font, icon, artifacts }) => renderDarkpoolCover(pdf, info, font, icon, artifacts),
      sectionPlan: (artifacts) => [
        {
          title: "Dashboard",
          content: textOrUnknown(artifacts.dashboard, "dashboard.md"),
        },
        {
          title: "Full Report",
          content: artifacts.report,
        },
        {
          title: "Evidence",
          content: textOrUnknown(artifacts.evidenceMarkdown, "evidence.md"),
        },
        {
          title: "Assumptions",
          content: assumptionsMarkdown(artifacts.assumptions),
        },
      ],
      qualityGate: ({ artifacts }) =>
        qualityIssuesDarkpool({
          report: artifacts.report,
          dashboard: artifacts.dashboard,
          assumptions: artifacts.assumptions,
          evidenceMarkdown: artifacts.evidenceMarkdown,
          evidenceJson: artifacts.evidenceJson,
        }),
    }
  }

  if (subcommand === "political-backtest") {
    return {
      buildCoverData: ({ artifacts, hints }) => politicalBacktestCoverData(artifacts, hints),
      enrichCover: async ({ info }) => info,
      renderCover: ({ pdf, info, font, icon }) => renderReportCover(pdf, info, font, icon),
      sectionPlan: (artifacts) => [
        {
          title: "Dashboard",
          content: textOrUnknown(artifacts.dashboard, "dashboard.md"),
        },
        {
          title: "Full Report",
          content: artifacts.report,
        },
        {
          title: "Aggregate Results",
          content: aggregateResultsMarkdown(artifacts.aggregateJson),
        },
        {
          title: "Longitudinal Comparison",
          content: comparisonMarkdown(artifacts.comparisonJson),
        },
        {
          title: "Assumptions",
          content: assumptionsMarkdown(artifacts.assumptions),
        },
      ],
      qualityGate: ({ artifacts }) =>
        qualityIssuesPoliticalBacktest({
          report: artifacts.report,
          dashboard: artifacts.dashboard,
          assumptions: artifacts.assumptions,
          aggregateJson: artifacts.aggregateJson,
          comparisonJson: artifacts.comparisonJson,
        }),
    }
  }

  return {
    buildCoverData: ({ artifacts, hints }) => reportCoverData(artifacts.report, artifacts.dashboard, hints),
    enrichCover: async ({ info, ctx }) => enrichCover(info, ctx),
    renderCover: ({ pdf, info, font, icon }) => renderReportCover(pdf, info, font, icon),
    sectionPlan: (artifacts) => [
      {
        title: "Full Report",
        content: artifacts.report,
      },
      {
        title: "Dashboard",
        content: textOrUnknown(artifacts.dashboard, "dashboard.md"),
      },
      {
        title: "Assumptions",
        content: assumptionsMarkdown(artifacts.assumptions),
      },
    ],
    qualityGate: ({ info, artifacts }) =>
      qualityIssuesReport(info, artifacts.report, artifacts.dashboard, artifacts.assumptions),
  }
}

function artifactReadPatterns(root: string, subcommand: PdfSubcommand) {
  const report = path.join(root, "report.md")
  const dashboard = path.join(root, "dashboard.md")
  const assumptions = path.join(root, "assumptions.json")
  if (subcommand === "report") {
    return [report, dashboard, assumptions]
  }
  if (subcommand === "political-backtest") {
    return [report, dashboard, assumptions, path.join(root, "aggregate-results.json"), path.join(root, "comparison.json")]
  }
  if (subcommand === "government-trading") {
    return [
      report,
      dashboard,
      assumptions,
      path.join(root, "normalized-events.json"),
      path.join(root, "delta-events.json"),
      path.join(root, "data.json"),
    ]
  }
  return [report, dashboard, assumptions, path.join(root, "evidence.md"), path.join(root, "evidence.json")]
}

async function loadArtifacts(root: string, subcommand: PdfSubcommand): Promise<LoadedArtifacts> {
  const report = path.join(root, "report.md")
  const dashboard = path.join(root, "dashboard.md")
  const assumptions = path.join(root, "assumptions.json")

  if (subcommand === "report") {
    return {
      report: await readRequired(report),
      dashboard: await readOptional(dashboard),
      assumptions: await readOptional(assumptions),
    }
  }

  if (subcommand === "government-trading") {
    return {
      report: await readRequired(report),
      dashboard: await readRequired(dashboard),
      assumptions: await readRequired(assumptions),
      normalizedEventsJson: await readRequired(path.join(root, "normalized-events.json")),
      deltaEventsJson: await readRequired(path.join(root, "delta-events.json")),
      dataJson: await readRequired(path.join(root, "data.json")),
    }
  }

  if (subcommand === "political-backtest") {
    return {
      report: await readRequired(report),
      dashboard: await readRequired(dashboard),
      assumptions: await readRequired(assumptions),
      aggregateJson: await readRequired(path.join(root, "aggregate-results.json")),
      comparisonJson: await readRequired(path.join(root, "comparison.json")),
    }
  }

  return {
    report: await readRequired(report),
    dashboard: await readRequired(dashboard),
    assumptions: await readRequired(assumptions),
    evidenceMarkdown: await readRequired(path.join(root, "evidence.md")),
    evidenceJson: await readRequired(path.join(root, "evidence.json")),
  }
}

function defaultRootHints(root: string, subcommand: PdfSubcommand): RootHints {
  if (subcommand === "report" || subcommand === "political-backtest") {
    return {
      ticker: tickerLabel(path.basename(path.dirname(root))),
      date: path.basename(root),
    }
  }

  if (path.basename(root) === "darkpool-anomaly") {
    const dateRoot = path.dirname(root)
    return {
      ticker: tickerLabel(path.basename(path.dirname(dateRoot))),
      date: path.basename(dateRoot),
    }
  }

  return {
    ticker: tickerLabel(path.basename(path.dirname(root))),
    date: path.basename(root),
  }
}

function reportCoverData(report: string, dashboard: string | undefined, hints: RootHints): Cover {
  const title =
    report
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? `${hints.ticker} Research Report`
  const tickerLine = field(report, "Ticker")
  const dateLine = field(report, "Report Date")
  const ticker = tickerLabel(tickerLine ?? hints.ticker)
  const date = dateLine ?? hints.date
  const sector = field(report, "Sector") ?? tableRow(report, "Sector")?.[1] ?? tableRow(dashboard, "Sector")?.[1] ?? "unknown"
  const headquarters =
    field(report, "Headquarters") ??
    tableRow(report, "Headquarters")?.[1] ??
    tableRow(dashboard, "Headquarters")?.[1] ??
    "unknown"
  const website = field(report, "Website") ?? field(report, "Company Website") ?? tableRow(report, "Website")?.[1] ?? ""
  const icon = iconUrl(field(report, "Icon URL") ?? field(report, "Icon") ?? tableRow(report, "Icon URL")?.[1], website)
  const score = directionalScore(report)
  const summary = trim(plainText(executiveSummary(report)), 1400)
  const positive =
    pickList(report, [/top positive drivers/i, /top observed positives/i, /upside/i]) ??
    listUnder(report, /top positive drivers/i)
  const negative =
    pickList(report, [/top negative drivers/i, /^key risks$/i, /top observed risks/i, /downside/i]) ??
    listUnder(report, /top negative drivers/i)

  const stock = tableRow(dashboard, "Stock Price")
  const daily = tableRow(dashboard, "Daily Change")
  const dailyPercent = tableRow(dashboard, "Daily Change Percent")
  const ytd = tableRow(dashboard, "YTD Return")
  const high = tableRow(dashboard, "52W High")
  const low = tableRow(dashboard, "52W Low")
  const rangeRow = tableRow(dashboard, "52W Range")
  const analyst = tableRow(dashboard, "Analyst Consensus")
  const stockValue = metricValue(dashboard, [/^stock price$/i]) ?? stock?.[1] ?? "unknown"
  const dailyValue =
    metricValue(dashboard, [/^daily change$/i]) ??
    daily?.[1] ??
    metricValue(dashboard, [/^daily change percent$/i]) ??
    dailyPercent?.[1] ??
    "unknown"
  const ytdValue = metricValue(dashboard, [/^ytd return$/i]) ?? ytd?.[1] ?? "unknown"
  const highValue = metricValue(dashboard, [/^52w high$/i]) ?? high?.[1]
  const lowValue = metricValue(dashboard, [/^52w low$/i]) ?? low?.[1]
  const range =
    metricValue(dashboard, [/^52w range$/i]) ??
    rangeRow?.[1] ??
    (highValue && lowValue ? `${lowValue} to ${highValue}` : "unknown")
  const analystValue = metricValue(dashboard, [/^analyst consensus$/i]) ?? analyst?.[1] ?? "unknown"
  const metrics = [
    metric("Stock Price", stockValue),
    metric("Daily Change", dailyValue),
    metric("YTD Return", ytdValue),
    metric("52W Range", range),
    metric("Analyst Consensus", analystValue),
    metric("Sector", sector),
  ]

  return {
    title,
    ticker,
    date,
    sector,
    headquarters,
    icon,
    score: score.value,
    band: score.band,
    summary,
    positive: pick(positive, ["unknown"]),
    negative: pick(negative, ["unknown"]),
    metrics,
  }
}

function governmentTradingCoverData(report: string, dashboard: string | undefined, hints: RootHints): Cover {
  const title =
    report
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? "Government Trading Report"

  const scope = report.match(/^-+\s*scope:\s*(.+)$/im)?.[1]?.trim() ?? hints.ticker
  const generatedAt = report.match(/^-+\s*generated_at:\s*([^\n]+)/im)?.[1]?.trim() ?? hints.date
  const runId = report.match(/^-+\s*run_id:\s*([^\n]+)/im)?.[1]?.trim() ?? hints.date
  const mode = report.match(/^-+\s*mode:\s*(.+)$/im)?.[1]?.trim() ?? "unknown"

  const summary = trim(plainText(executiveSummary(report)), 1400)
  const ticker = tickerLabel(scope)
  const date = generatedAt
  const metrics = [
    metric("Mode", mode),
    metric("Scope", scope),
    metric("Current Events", metricValue(dashboard, [/^current_events$/i]) ?? "unknown"),
    metric("New Events", metricValue(dashboard, [/^new_events$/i]) ?? "unknown"),
    metric("Updated Events", metricValue(dashboard, [/^updated_events$/i]) ?? "unknown"),
    metric("Run ID", runId),
  ]

  return {
    title,
    ticker,
    date,
    sector: "government trading",
    headquarters: "unknown",
    icon: "",
    score: "DELTA",
    band: "NEUTRAL",
    summary: summary || "Government trading delta report.",
    positive: pick(listUnder(report, /persistence trends/i), ["Review persistence trends in report artifacts."]),
    negative: pick(listUnder(report, /delta preview/i), ["Review delta preview and no-longer-present events."]),
    metrics,
  }
}

function darkpoolCoverData(report: string, dashboard: string | undefined, hints: RootHints): Cover {
  const title =
    report
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? `${hints.ticker} Darkpool Anomaly Report`

  const tickerLine = field(report, "Ticker")
  const dateLine = field(report, "Report Date")
  const ticker = tickerLabel(tickerLine ?? hints.ticker)
  const date = dateLine ?? hints.date

  const summary = trim(plainText(executiveSummary(report)), 1400)
  const positive = pickList(report, [/top anomalies/i, /findings/i]) ?? []
  const negative = pickList(report, [/change log/i, /resolved/i]) ?? []

  const mode =
    report.match(/^\s*Mode:\s*(ticker|portfolio)\s*$/im)?.[1] ??
    metricValue(dashboard, [/^mode$/i]) ??
    "unknown"
  const threshold =
    report.match(/Significance threshold \(\|z\|\):\s*([-+]?\d+(?:\.\d+)?)/i)?.[1] ??
    metricValue(dashboard, [/^significance threshold/i]) ??
    "unknown"

  const metrics = [
    metric("Mode", mode),
    metric("Threshold |z|", threshold),
    metric("Signal", "darkpool anomaly"),
    metric("Coverage", "off-exchange"),
    metric("Ticker", ticker),
    metric("Report Date", date),
  ]

  return {
    title,
    ticker,
    date,
    sector: "darkpool",
    headquarters: "unknown",
    icon: "",
    score: "ANOM",
    band: "NEUTRAL",
    summary,
    positive: pick(positive, ["See top anomalies table for ranked signals."]),
    negative: pick(negative, ["Resolved and degraded signals are listed in transitions."]),
    metrics,
  }
}

function politicalBacktestCoverData(artifacts: LoadedArtifacts, hints: RootHints): Cover {
  const headingScope =
    artifacts.report.match(/^#\s+Political Event Backtest:\s*([^\n]+)$/im)?.[1]?.trim() ??
    artifacts.dashboard?.match(/^#\s+Political Backtest Dashboard:\s*([^\n]+)$/im)?.[1]?.trim()
  const title =
    artifacts.report
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? `Political Event Backtest: ${headingScope ?? hints.ticker}`
  const scope = tickerLabel(headingScope ?? hints.ticker)
  const date = lineValue(artifacts.report, "Generated at") ?? hints.date
  const details = extractPoliticalBacktestCoverData({
    report: artifacts.report,
    dashboard: artifacts.dashboard,
    aggregateJson: artifacts.aggregateJson,
    comparisonJson: artifacts.comparisonJson,
  })

  const summary = trim(
    plainText(executiveSummary(artifacts.report)) || "Political-trading event-study results from markdown and raw aggregate artifacts.",
    1400,
  )
  const metrics = [
    metric("Mode / Scope", `${details.mode} / ${details.scope}`),
    metric("Events Analyzed", formatNumber(details.eventCount, 0)),
    metric("Benchmarks", formatNumber(details.benchmarkCount, 0)),
    metric("Windows", details.windowsLabel),
    metric("Best Mean Excess", `${signed(details.bestMeanExcess, 3)}%`),
    metric("Sample Delta", details.sampleDeltaLabel),
  ]

  return {
    title,
    ticker: scope,
    date,
    sector: "political backtest",
    headquarters: "unknown",
    icon: "",
    score: "BKT",
    band: "NEUTRAL",
    summary,
    positive: pick(details.topSignals, ["No aggregate signals parsed from aggregate-results.json."]),
    negative: pick(details.longitudinalHighlights, ["Longitudinal comparison details unavailable."]),
    metrics,
  }
}

function extractPoliticalBacktestCoverData(input: {
  report: string
  dashboard?: string
  aggregateJson?: string
  comparisonJson?: string
}): PoliticalBacktestCoverData {
  const reportScope = input.report.match(/^#\s+Political Event Backtest:\s*([^\n]+)$/im)?.[1]?.trim()
  const dashboardScope = input.dashboard?.match(/^#\s+Political Backtest Dashboard:\s*([^\n]+)$/im)?.[1]?.trim()
  const scope = tickerLabel(reportScope ?? dashboardScope ?? "unknown")
  const rawMode = (lineValue(input.report, "Mode") ?? lineValue(input.dashboard, "Mode") ?? "unknown").toLowerCase()
  const mode: PoliticalBacktestCoverData["mode"] = rawMode === "ticker" ? "ticker" : rawMode === "portfolio" ? "portfolio" : "unknown"
  const windowsLabel = lineValue(input.report, "Windows (sessions)") ?? "unknown"
  const benchmarkLine = lineValue(input.report, "Benchmarks") ?? lineValue(input.dashboard, "Benchmarks") ?? ""
  const benchmarkCount = [
    ...new Set(
      benchmarkLine
        .split(",")
        .map((item) => tickerLabel(item))
        .filter((item) => !isUnknown(item)),
    ),
  ].length
  const eventLabel = lineValue(input.report, "Political events analyzed") ?? lineValue(input.dashboard, "Events")
  const eventCountRaw = firstNumber(eventLabel)
  const eventCount = Number.isFinite(eventCountRaw) ? Math.max(0, Math.round(eventCountRaw)) : 0

  const aggregates = parsePoliticalBacktestAggregates(input.aggregateJson)
  const ranked = aggregates.toSorted((a, b) => {
    if (b.meanExcessReturnPercent !== a.meanExcessReturnPercent) return b.meanExcessReturnPercent - a.meanExcessReturnPercent
    return b.sampleSize - a.sampleSize
  })
  const best = ranked[0]
  const bestMeanExcess = best?.meanExcessReturnPercent ?? Number.NaN
  const bestAggregateLabel = best
    ? `${best.anchorKind} ${best.windowSessions}D vs ${best.benchmarkSymbol} (${signed(best.meanExcessReturnPercent, 3)}%)`
    : "unknown"
  const topSignals = ranked.slice(0, 3).map((item) => {
    return `${item.anchorKind} ${item.windowSessions}D vs ${item.benchmarkSymbol}: mean excess ${signed(item.meanExcessReturnPercent, 3)}% (hit ${formatNumber(item.hitRatePercent, 2)}%, n=${formatNumber(item.sampleSize, 0)})`
  })

  const comparison = parsePoliticalBacktestComparison(input.comparisonJson)
  const sampleDelta = comparison
    ? comparison.firstRun
      ? comparison.eventCurrent
      : comparison.eventCurrent - comparison.eventBaseline
    : Number.NaN
  const sampleDeltaLabel = comparison
    ? comparison.firstRun
      ? `+${formatNumber(comparison.eventCurrent, 0)} (first run)`
      : `${signed(sampleDelta, 0)} (current ${formatNumber(comparison.eventCurrent, 0)} vs baseline ${formatNumber(comparison.eventBaseline, 0)})`
    : "unknown"
  const longitudinalHighlights = comparison
    ? comparison.firstRun
      ? [
          "First run baseline: none.",
          `Events in scope: ${formatNumber(comparison.eventCurrent, 0)}.`,
          `New events: ${formatNumber(comparison.newEvents, 0)}.`,
        ]
      : [
          `Baseline: ${comparison.baselineGeneratedAt} (${comparison.baselineOutputRoot}).`,
          `New events: ${formatNumber(comparison.newEvents, 0)}, removed events: ${formatNumber(comparison.removedEvents, 0)}.`,
          `Conclusion changes: ${formatNumber(comparison.conclusionChanges, 0)}.`,
        ]
    : ["Longitudinal comparison payload could not be parsed."]

  return {
    scope,
    mode,
    windowsLabel,
    benchmarkCount,
    eventCount,
    bestAggregateLabel,
    bestMeanExcess,
    sampleDeltaLabel,
    sampleDelta,
    topSignals,
    longitudinalHighlights,
  }
}

function parsePoliticalBacktestAggregates(input: string | undefined): PoliticalBacktestAggregate[] {
  if (!input) return []
  const parsed = parseJson(input)
  if (!Array.isArray(parsed)) return []

  return parsed
    .map((item) => asRecord(item))
    .flatMap((row) => {
      if (!row) return []
      const anchor = asOptionalText(row.anchor_kind)?.toLowerCase()
      const benchmark = asOptionalText(row.benchmark_symbol)
      const windowSessions = toFiniteNumber(row.window_sessions)
      const sampleSize = toFiniteNumber(row.sample_size)
      const hitRatePercent = toFiniteNumber(row.hit_rate_percent)
      const meanReturnPercent = toFiniteNumber(row.mean_return_percent)
      const medianReturnPercent = toFiniteNumber(row.median_return_percent)
      const meanExcessReturnPercent = toFiniteNumber(row.mean_excess_return_percent)

      if ((anchor !== "transaction" && anchor !== "report") || !benchmark) return []
      if (
        !Number.isFinite(windowSessions) ||
        !Number.isFinite(sampleSize) ||
        !Number.isFinite(hitRatePercent) ||
        !Number.isFinite(meanReturnPercent) ||
        !Number.isFinite(medianReturnPercent) ||
        !Number.isFinite(meanExcessReturnPercent)
      ) {
        return []
      }

      return [
        {
          anchorKind: anchor,
          windowSessions: Math.round(windowSessions),
          benchmarkSymbol: tickerLabel(benchmark),
          sampleSize,
          hitRatePercent,
          meanReturnPercent,
          medianReturnPercent,
          meanExcessReturnPercent,
        },
      ]
    })
}

function parsePoliticalBacktestComparison(input: string | undefined): PoliticalBacktestComparison | null {
  if (!input) return null
  const root = asRecord(parseJson(input))
  if (!root) return null
  if (typeof root.first_run !== "boolean") return null
  const eventSample = asRecord(root.event_sample)
  if (!eventSample) return null

  const eventCurrent = toFiniteNumber(eventSample.current)
  const eventBaseline = toFiniteNumber(eventSample.baseline)
  if (!Number.isFinite(eventCurrent) || !Number.isFinite(eventBaseline)) return null

  const newEvents = Array.isArray(eventSample.new_events) ? eventSample.new_events.length : Number.NaN
  const removedEvents = Array.isArray(eventSample.removed_events) ? eventSample.removed_events.length : Number.NaN
  if (!Number.isFinite(newEvents) || !Number.isFinite(removedEvents)) return null

  const baseline = asRecord(root.baseline)
  if (!root.first_run && !baseline) return null
  const baselineGeneratedAt = baseline ? (asOptionalText(baseline.generated_at) ?? "unknown") : "none"
  const baselineOutputRoot = baseline ? (asOptionalText(baseline.output_root) ?? "unknown") : "none"
  const conclusionChanges = Array.isArray(root.conclusion_changes) ? root.conclusion_changes.length : 0

  return {
    firstRun: root.first_run,
    eventCurrent,
    eventBaseline,
    newEvents,
    removedEvents,
    conclusionChanges,
    baselineGeneratedAt,
    baselineOutputRoot,
  }
}

function aggregateResultsMarkdown(input: string | undefined) {
  if (!input) return textOrUnknown(input, "aggregate-results.json")
  const rows = parsePoliticalBacktestAggregates(input)
  if (!rows.length) return input

  const best = rows.toSorted((a, b) => b.meanExcessReturnPercent - a.meanExcessReturnPercent)[0]
  const totalSamples = rows.reduce((acc, row) => acc + row.sampleSize, 0)
  const lines = [
    "## Aggregate Results (aggregate-results.json)",
    "",
    `- Aggregate rows: ${formatNumber(rows.length, 0)}`,
    `- Combined sample size: ${formatNumber(totalSamples, 0)}`,
    `- Best mean excess row: ${best ? `${best.anchorKind} ${best.windowSessions}D vs ${best.benchmarkSymbol} (${signed(best.meanExcessReturnPercent, 3)}%)` : "unknown"}`,
    "",
    "| Anchor | Window | Benchmark | Sample | Hit Rate % | Median Return % | Mean Return % | Mean Excess % |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => {
      return `| ${row.anchorKind} | ${row.windowSessions} | ${row.benchmarkSymbol} | ${formatNumber(row.sampleSize, 0)} | ${formatNumber(row.hitRatePercent, 2)} | ${formatNumber(row.medianReturnPercent, 3)} | ${formatNumber(row.meanReturnPercent, 3)} | ${formatNumber(row.meanExcessReturnPercent, 3)} |`
    }),
  ]
  return lines.join("\n")
}

function comparisonMarkdown(input: string | undefined) {
  if (!input) return textOrUnknown(input, "comparison.json")
  const parsed = asRecord(parseJson(input))
  if (!parsed) return input
  const comparison = parsePoliticalBacktestComparison(input)
  if (!comparison) return input

  const lines = [
    "## Longitudinal Comparison (comparison.json)",
    "",
    `- First run: ${comparison.firstRun ? "yes" : "no"}`,
    `- Event sample: current ${formatNumber(comparison.eventCurrent, 0)}, baseline ${formatNumber(comparison.eventBaseline, 0)}, new ${formatNumber(comparison.newEvents, 0)}, removed ${formatNumber(comparison.removedEvents, 0)}.`,
  ]

  if (!comparison.firstRun) {
    lines.push(`- Baseline generated at: ${comparison.baselineGeneratedAt}`)
    lines.push(`- Baseline output root: ${comparison.baselineOutputRoot}`)
    lines.push(`- Sample delta: ${signed(comparison.eventCurrent - comparison.eventBaseline, 0)}`)
  }

  const driftRows = Array.isArray(parsed.aggregate_drift)
    ? parsed.aggregate_drift
        .map((item) => asRecord(item))
        .flatMap((row) => {
          if (!row) return []
          const anchorKind = asOptionalText(row.anchor_kind)
          const benchmarkSymbol = asOptionalText(row.benchmark_symbol)
          const windowSessions = toFiniteNumber(row.window_sessions)
          const sampleDelta = toFiniteNumber(row.sample_delta)
          const hitRateDelta = toFiniteNumber(row.hit_rate_delta)
          const meanExcessDelta = toFiniteNumber(row.mean_excess_delta)
          if (!anchorKind || !benchmarkSymbol) return []
          if (
            !Number.isFinite(windowSessions) ||
            !Number.isFinite(sampleDelta) ||
            !Number.isFinite(hitRateDelta) ||
            !Number.isFinite(meanExcessDelta)
          ) {
            return []
          }
          return [{ anchorKind, benchmarkSymbol, windowSessions, sampleDelta, hitRateDelta, meanExcessDelta }]
        })
    : []
  if (driftRows.length) {
    lines.push("")
    lines.push("| Anchor | Window | Benchmark | Sample Delta | Hit Rate Delta | Mean Excess Delta |")
    lines.push("| --- | ---: | --- | ---: | ---: | ---: |")
    driftRows.forEach((row) => {
      lines.push(
        `| ${row.anchorKind} | ${formatNumber(row.windowSessions, 0)} | ${row.benchmarkSymbol} | ${signed(row.sampleDelta, 0)} | ${signed(row.hitRateDelta, 3)} | ${signed(row.meanExcessDelta, 3)} |`,
      )
    })
  }

  return lines.join("\n")
}

function lineValue(markdown: string | undefined, label: string) {
  if (!markdown) return
  const pattern = new RegExp(`^\\s*(?:[-*]\\s+)?${escape(label)}:\\s*([^\\n]+)$`, "im")
  const hit = markdown.match(pattern)?.[1]
  if (!hit) return
  return cleanInline(hit).trim()
}

function firstNumber(input: string | undefined) {
  if (!input) return Number.NaN
  const hit = input.match(/[-+]?\d+(?:\.\d+)?/)?.[0]
  if (!hit) return Number.NaN
  return toFiniteNumber(hit)
}

function signed(input: number, digits = 3) {
  if (!Number.isFinite(input)) return "unknown"
  if (input === 0) return "0"
  const sign = input > 0 ? "+" : "-"
  return `${sign}${formatNumber(Math.abs(input), digits)}`
}

async function enrichCover(info: Cover, ctx: Tool.Context): Promise<Cover> {
  if (info.icon.trim() && !isUnknown(info.icon)) return info
  if (!info.ticker.trim() || isUnknown(info.ticker)) return info

  try {
    await ctx.ask({
      permission: "financial_search",
      patterns: [info.ticker, "fundamentals", "icon"],
      always: ["*"],
      metadata: {
        ticker: info.ticker,
        intent: "fundamentals",
        source: "report_pdf_icon_fallback",
      },
    })
    const result = await financialSearch(
      {
        query: `${info.ticker} fundamentals`,
        intent: "fundamentals",
        ticker: info.ticker,
        coverage: "comprehensive",
        source: "report_pdf_icon_fallback",
      },
      {
        signal: ctx.abort,
      },
    )

    const data = result.data
    if (!data || typeof data !== "object" || !("metrics" in data)) return info
    const enriched = data as {
      iconUrl?: string | null
      website?: string | null
      sector?: string | null
      headquarters?: string | null
    }
    const icon = iconUrl(enriched.iconUrl ?? "", enriched.website ?? "")
    const sector = info.sector
    const headquarters = info.headquarters
    return {
      ...info,
      icon: icon || info.icon,
      sector: isUnknown(sector) ? (enriched.sector ?? sector) : sector,
      headquarters: isUnknown(headquarters) ? (enriched.headquarters ?? headquarters) : headquarters,
    }
  } catch {
    return info
  }
}

function metric(label: string, value: string): Metric {
  const normalized = value.toLowerCase()
  if (normalized.startsWith("+")) return { label, value, tone: "positive" }
  if (normalized.startsWith("-")) return { label, value, tone: "risk" }
  if (/(bull|buy|opportunity|positive|up)/i.test(normalized)) return { label, value, tone: "positive" }
  if (/(bear|sell|risk|warning|decline|down|negative)/i.test(normalized)) return { label, value, tone: "risk" }
  return { label, value, tone: "neutral" }
}

function pick(input: string[], fallback: string[]) {
  if (input.length) return input.slice(0, 3)
  return fallback
}

function pickList(report: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const rows = listUnder(report, pattern)
    if (rows.length) return rows
  }
  return
}

function name(raw: string | undefined, ticker: string, date: string) {
  const base = raw?.trim() ? path.basename(raw.trim()) : `${ticker}-${date}.pdf`
  const cleaned = base.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`
  return withExt || `${ticker}-${date}.pdf`
}

function formatNumber(input: number, digits = 3) {
  if (!Number.isFinite(input)) return "unknown"
  return input.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  })
}

function tickerLabel(input: string) {
  const first = input.trim().match(/[A-Za-z0-9.-]+/)?.[0] ?? "REPORT"
  return first.toUpperCase()
}

function trim(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max - 3)}...`
}

function textOrUnknown(input: string | undefined, file: string) {
  if (input) return input
  return `unknown\n\nThe artifact \`${file}\` was not found in outputRoot.`
}

function jsonArtifactContent(input: string | undefined, file: string) {
  if (!input) return textOrUnknown(input, file)
  const parsed = parseJson(input)
  if (!parsed) return input
  return JSON.stringify(parsed, null, 2)
}

function iconUrl(raw: string | undefined, website: string) {
  if (raw && !isUnknown(raw)) return raw.trim()
  const host = website
    .trim()
    .match(/^(?:https?:\/\/)?([^/\s?#]+)/i)?.[1]
  if (!host) return ""
  const cleaned = host.replace(/^www\./i, "")
  if (!cleaned) return ""
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(cleaned)}&sz=128`
}

function assumptionsMarkdown(input: string | undefined) {
  if (!input) return textOrUnknown(input, "assumptions.json")
  const parsed = parseJson(input)
  if (!parsed) return input

  const rows = flatten(parsed)
  const limit = rows.slice(0, 260)
  const clipped = rows.length > limit.length
  const table = limit.map((entry) => `| ${cell(entry.path)} | ${cell(entry.value)} |`)
  const out = [
    "## Assumptions Ledger",
    "",
    "| Path | Value |",
    "| --- | --- |",
    ...table,
  ]
  if (clipped) {
    out.push("| _truncated_ | Additional rows were omitted for PDF readability. |")
  }
  return out.join("\n")
}

function parseJson(input: string) {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return
  }
}

function flatten(input: unknown, prefix = "root"): { path: string; value: string }[] {
  if (input === null) return [{ path: prefix, value: "null" }]
  if (typeof input === "string") return [{ path: prefix, value: input || "unknown" }]
  if (typeof input === "number" || typeof input === "boolean") return [{ path: prefix, value: `${input}` }]

  if (Array.isArray(input)) {
    if (!input.length) return [{ path: prefix, value: "[]" }]
    return input.flatMap((item, index) => flatten(item, `${prefix}[${index}]`))
  }

  if (typeof input !== "object") return [{ path: prefix, value: `${input}` }]
  const keys = Object.keys(input)
  if (!keys.length) return [{ path: prefix, value: "{}" }]

  return keys.flatMap((key) => flatten((input as Record<string, unknown>)[key], `${prefix}.${key}`))
}

function cell(input: string) {
  return cleanInline(input).replace(/\|/g, "\\|").replace(/\n/g, "<br/>")
}

function qualityIssuesBySubcommand(input: {
  subcommand: PdfSubcommand
  info: Cover
  report: string
  dashboard?: string
  assumptions?: string
  normalizedEventsJson?: string
  deltaEventsJson?: string
  dataJson?: string
  evidenceMarkdown?: string
  evidenceJson?: string
  aggregateJson?: string
  comparisonJson?: string
}) {
  if (input.subcommand === "government-trading") {
    return qualityIssuesGovernmentTrading({
      report: input.report,
      dashboard: input.dashboard,
      assumptions: input.assumptions,
      normalizedEventsJson: input.normalizedEventsJson,
      deltaEventsJson: input.deltaEventsJson,
      dataJson: input.dataJson,
    })
  }

  if (input.subcommand === "darkpool-anomaly") {
    return qualityIssuesDarkpool({
      report: input.report,
      dashboard: input.dashboard,
      assumptions: input.assumptions,
      evidenceMarkdown: input.evidenceMarkdown,
      evidenceJson: input.evidenceJson,
    })
  }

  if (input.subcommand === "political-backtest") {
    return qualityIssuesPoliticalBacktest({
      report: input.report,
      dashboard: input.dashboard,
      assumptions: input.assumptions,
      aggregateJson: input.aggregateJson,
      comparisonJson: input.comparisonJson,
    })
  }

  return qualityIssuesReport(input.info, input.report, input.dashboard, input.assumptions)
}

function qualityIssuesGovernmentTrading(input: {
  report: string
  dashboard?: string
  assumptions?: string
  normalizedEventsJson?: string
  deltaEventsJson?: string
  dataJson?: string
}) {
  const issues: string[] = []
  if (!/^#\s+government trading report\b/im.test(input.report)) {
    issues.push("Government-trading PDF export requires `report.md` to start with `# Government Trading Report`.")
  }

  if (!input.dashboard) {
    issues.push("Government-trading PDF export requires `dashboard.md`.")
  } else if (!/^#\s+government trading dashboard\b/im.test(input.dashboard)) {
    issues.push("Government-trading PDF export requires `dashboard.md` to start with `# Government Trading Dashboard`.")
  }

  const requiredRunMetadataKeys = ["mode", "scope", "generated_at", "run_id"] as const
  for (const key of requiredRunMetadataKeys) {
    const matcher = new RegExp(`^-\\s*${key}\\s*:`, "im")
    if (!matcher.test(input.report)) {
      issues.push(`Government-trading report metadata is missing \`${key}\` in \`report.md\`.`)
    }
  }

  const requiredDeltaMetrics = [
    "current_events",
    "new_events",
    "updated_events",
    "unchanged_events",
    "no_longer_present_events",
  ] as const
  for (const metric of requiredDeltaMetrics) {
    const matcher = new RegExp(`\\|\\s*${metric}\\s*\\|`, "i")
    if (!matcher.test(input.dashboard ?? "")) {
      issues.push(`Government-trading dashboard is missing delta metric \`${metric}\` in \`dashboard.md\`.`)
    }
  }

  if (!input.assumptions) {
    issues.push("Missing required government-trading artifact `assumptions.json`.")
  } else {
    const parsed = parseJson(input.assumptions)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push("`assumptions.json` must be a valid JSON object.")
    }
  }

  if (!input.normalizedEventsJson) {
    issues.push("Missing required government-trading artifact `normalized-events.json`.")
  } else {
    const parsed = parseJson(input.normalizedEventsJson)
    if (!Array.isArray(parsed)) {
      issues.push("`normalized-events.json` must be a valid JSON array.")
    }
  }

  if (!input.deltaEventsJson) {
    issues.push("Missing required government-trading artifact `delta-events.json`.")
  } else {
    const parsed = parseJson(input.deltaEventsJson)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push("`delta-events.json` must be a valid JSON object.")
    }
  }

  if (!input.dataJson) {
    issues.push("Missing required government-trading artifact `data.json`.")
  } else {
    const parsed = parseJson(input.dataJson)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push("`data.json` must be a valid JSON object.")
    }
  }

  return issues
}

function qualityIssuesPoliticalBacktest(input: {
  report: string
  dashboard?: string
  assumptions?: string
  aggregateJson?: string
  comparisonJson?: string
}) {
  const issues: string[] = []
  if (!/^#\s+Political Event Backtest:\s*[^\n]+$/im.test(input.report)) {
    issues.push("`report.md` must include heading `# Political Event Backtest: <scope>`.")
  }

  const requiredReportMetadata = ["Generated at", "Mode", "Tickers", "Anchor Mode", "Windows (sessions)", "Benchmarks"] as const
  for (const label of requiredReportMetadata) {
    if (!lineValue(input.report, label)) {
      issues.push(`\`report.md\` is missing metadata line \`${label}: ...\`.`)
    }
  }

  if (!input.dashboard) {
    issues.push("Missing required political-backtest artifact `dashboard.md`.")
  } else {
    const tables = tableBlocks(input.dashboard)
    const hasAggregateTable = tables.some((table) => {
      const head = table.head.map((cell) => normalize(cell))
      const required = ["anchor", "window", "benchmark", "sample", "hit rate", "median return", "mean return", "mean excess"]
      return required.every((item) => head.some((cell) => cell.includes(item)))
    })
    if (!hasAggregateTable) {
      issues.push(
        "`dashboard.md` must include aggregate table headers: Anchor, Window, Benchmark, Sample, Hit Rate %, Median Return %, Mean Return %, Mean Excess %.",
      )
    }
  }

  if (!input.assumptions) {
    issues.push("Missing required political-backtest artifact `assumptions.json`.")
  } else {
    const assumptions = asRecord(parseJson(input.assumptions))
    if (!assumptions) {
      issues.push("`assumptions.json` must be valid JSON object.")
    } else if (assumptions.workflow !== "financial_political_backtest") {
      issues.push("`assumptions.json.workflow` must equal `financial_political_backtest`.")
    }
  }

  if (!input.aggregateJson) {
    issues.push("Missing required political-backtest artifact `aggregate-results.json`.")
  } else {
    const payload = parseJson(input.aggregateJson)
    if (!Array.isArray(payload) || payload.length === 0) {
      issues.push("`aggregate-results.json` must be a non-empty JSON array.")
    } else {
      const invalid = payload.find((item) => {
        const row = asRecord(item)
        if (!row) return true
        const anchor = asOptionalText(row.anchor_kind)?.toLowerCase()
        const benchmark = asOptionalText(row.benchmark_symbol)
        const numericKeys = [
          "window_sessions",
          "sample_size",
          "hit_rate_percent",
          "mean_return_percent",
          "median_return_percent",
          "mean_excess_return_percent",
        ] as const
        if ((anchor !== "transaction" && anchor !== "report") || !benchmark) return true
        return numericKeys.some((key) => !Number.isFinite(toFiniteNumber(row[key])))
      })
      if (invalid) {
        issues.push(
          "`aggregate-results.json` rows must include valid anchor_kind, benchmark_symbol, window_sessions, sample_size, and numeric hit/return/excess metrics.",
        )
      }
    }
  }

  if (!input.comparisonJson) {
    issues.push("Missing required political-backtest artifact `comparison.json`.")
  } else {
    const root = asRecord(parseJson(input.comparisonJson))
    if (!root) {
      issues.push("`comparison.json` must be a valid JSON object.")
    } else {
      if (typeof root.first_run !== "boolean") {
        issues.push("`comparison.json` must include boolean `first_run`.")
      }
      const eventSample = asRecord(root.event_sample)
      if (!eventSample) {
        issues.push("`comparison.json` must include object `event_sample`.")
      } else {
        if (!Number.isFinite(toFiniteNumber(eventSample.current))) {
          issues.push("`comparison.json.event_sample.current` must be numeric.")
        }
        if (!Number.isFinite(toFiniteNumber(eventSample.baseline))) {
          issues.push("`comparison.json.event_sample.baseline` must be numeric.")
        }
        if (!Array.isArray(eventSample.new_events)) {
          issues.push("`comparison.json.event_sample.new_events` must be an array.")
        }
        if (!Array.isArray(eventSample.removed_events)) {
          issues.push("`comparison.json.event_sample.removed_events` must be an array.")
        }
      }
      if (root.first_run === false) {
        const baseline = asRecord(root.baseline)
        if (!baseline) {
          issues.push("`comparison.json.baseline` must exist when `first_run` is false.")
        } else {
          if (!asOptionalText(baseline.output_root)) {
            issues.push("`comparison.json.baseline.output_root` is required when `first_run` is false.")
          }
          if (!asOptionalText(baseline.generated_at)) {
            issues.push("`comparison.json.baseline.generated_at` is required when `first_run` is false.")
          }
        }
      }
    }
  }

  return issues
}

function qualityIssuesReport(info: Cover, report: string, dashboard: string | undefined, assumptions: string | undefined) {
  const issues: string[] = []
  const critical = ["Stock Price", "YTD Return", "52W Range", "Analyst Consensus"]
  critical.forEach((label) => {
    const value = info.metrics.find((item) => item.label === label)?.value ?? "unknown"
    if (isUnknown(value)) {
      if (label === "52W Range") {
        issues.push(
          "Critical cover metric `52W Range` resolved to `unknown`; fill either `52W Range` or both `52W Low` and `52W High` in `dashboard.md`.",
        )
        return
      }
      issues.push(`Critical cover metric \`${label}\` resolved to \`unknown\`; fill ${label} in \`dashboard.md\`.`)
    }
  })

  if (isUnknown(info.score) || isUnknown(info.band)) {
    issues.push(
      "Directional conviction score/band is `unknown`; ensure `report.md` includes `Score: <0-100> | Band: <bearish|neutral|bullish>` (or `Score: <0-100>/100` with an explicit band).",
    )
  }

  const sourceBody = [report, dashboard, assumptions]
    .filter((item): item is string => Boolean(item))
    .join("\n")
  if (/\b(websearch_exa|websearch|exa)\b/i.test(sourceBody)) {
    issues.push("Generic source labels (`websearch`/`exa`) detected; cite the original publisher/domain and URL instead.")
  }

  const core = [
    { label: "Revenue", patterns: [/^revenue(?:\b|\s*\()/i] },
    { label: "Net income", patterns: [/^net income(?:\b|\s*\()/i, /^netincome(?:\b|\s*\()/i] },
    { label: "Free cash flow", patterns: [/^free cash flow(?:\b|\s*\()/i, /^freecashflow(?:\b|\s*\()/i] },
    { label: "Debt-to-equity", patterns: [/^debt[\s-]*to[\s-]*equity(?:\b|\s*\()/i, /^debtequity(?:\b|\s*\()/i] },
  ]
  core.forEach((item) => {
    const value = metricValue(dashboard, item.patterns) ?? metricValue(report, item.patterns)
    if (!value || isUnknown(value)) {
      issues.push(`Core fundamental \`${item.label}\` is unresolved; include a sourced value or regenerate data before PDF export.`)
    }
  })

  issues.push(...dashboardSourceIssues(dashboard))

  return issues
}

function qualityIssuesDarkpool(input: {
  report: string
  dashboard?: string
  assumptions?: string
  evidenceMarkdown?: string
  evidenceJson?: string
}) {
  const issues: string[] = []
  if (!/^#\s+Darkpool Anomaly Report\b/im.test(input.report)) {
    issues.push("`report.md` must start with `# Darkpool Anomaly Report`.")
  }
  if (!/^\s*Mode:\s*(ticker|portfolio)\s*$/im.test(input.report)) {
    issues.push("`report.md` must include `Mode: ticker|portfolio`.")
  }
  if (!/Significance threshold \(\|z\|\):\s*[-+]?\d+(?:\.\d+)?/i.test(input.report)) {
    issues.push("`report.md` is missing a numeric `Significance threshold (|z|)` line.")
  }

  if (!input.dashboard) {
    issues.push("Missing required darkpool artifact `dashboard.md`.")
  } else if (!hasDarkpoolAnomalyTable(input.dashboard)) {
    issues.push(
      "`dashboard.md` must include an anomaly table with columns: Ticker, Date, Metric, Current, Baseline, |z|, Severity, Direction, State.",
    )
  }

  if (!input.assumptions) {
    issues.push("Missing required darkpool artifact `assumptions.json`.")
  } else {
    const parsed = parseJson(input.assumptions)
    const root = asRecord(parsed)
    const detection = asRecord(root?.detection_parameters)
    if (!root || !detection) {
      issues.push("`assumptions.json` must be valid JSON and include `detection_parameters`.")
    } else {
      if (!Number.isFinite(toFiniteNumber(detection.lookback_days))) {
        issues.push("`assumptions.json` is missing numeric `detection_parameters.lookback_days`.")
      }
      if (!Number.isFinite(toFiniteNumber(detection.min_samples))) {
        issues.push("`assumptions.json` is missing numeric `detection_parameters.min_samples`.")
      }
      if (!Number.isFinite(toFiniteNumber(detection.significance_threshold))) {
        issues.push("`assumptions.json` is missing numeric `detection_parameters.significance_threshold`.")
      }
    }
  }

  if (!input.evidenceMarkdown) {
    issues.push("Missing required darkpool artifact `evidence.md`.")
  }

  if (!input.evidenceJson) {
    issues.push("Missing required darkpool artifact `evidence.json`.")
  } else {
    const parsed = parseJson(input.evidenceJson)
    const root = asRecord(parsed)
    if (!root) {
      issues.push("`evidence.json` must be valid JSON object output from `report_darkpool_anomaly`.")
    } else {
      if (!Array.isArray(root.tickers)) {
        issues.push("`evidence.json` must include `tickers` array.")
      }
      if (!Array.isArray(root.anomalies)) {
        issues.push("`evidence.json` must include `anomalies` array.")
      }
      if (!Array.isArray(root.transitions)) {
        issues.push("`evidence.json` must include `transitions` array.")
      } else {
        const validState = new Set(["new", "persisted", "severity_change", "resolved"])
        if (!root.transitions.every((item) => asRecord(item) && validState.has(String(asRecord(item)?.state ?? "").trim()))) {
          issues.push("`evidence.json.transitions` entries must include valid `state` values.")
        }
      }
      if (Array.isArray(root.anomalies)) {
        const validAnomalyShape = root.anomalies.every((item) => {
          const row = asRecord(item)
          if (!row) return false
          const ticker = asOptionalText(row.ticker)
          const severity = asOptionalText(row.severity)
          const direction = asOptionalText(row.direction)
          const absZ = toFiniteNumber(row.abs_z_score)
          return Boolean(ticker && severity && direction && Number.isFinite(absZ))
        })
        if (!validAnomalyShape) {
          issues.push("`evidence.json.anomalies` entries must include ticker, severity, direction, and numeric abs_z_score.")
        }
      }
    }
  }

  return issues
}

function hasDarkpoolAnomalyTable(input: string) {
  const required = ["ticker", "date", "metric", "current", "baseline", "z", "severity", "direction", "state"]
  return tableBlocks(input).some((table) => {
    const normalized = table.head.map((cell) => normalize(cell))
    return required.every((item) => normalized.some((cell) => cell.includes(item)))
  })
}

function asRecord(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function asRecordArray(input: unknown, error: string) {
  if (!Array.isArray(input)) {
    throw new Error(error)
  }
  return input
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
}

function asOptionalText(input: unknown) {
  if (input === null || input === undefined) return
  const text = String(input).trim()
  if (!text) return
  return text
}

function toFiniteNumber(input: unknown) {
  if (typeof input === "number") return Number.isFinite(input) ? input : Number.NaN
  if (typeof input === "string") {
    const text = input.trim()
    if (!text) return Number.NaN
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

function severityRank(value: string) {
  if (value === "high") return 3
  if (value === "medium") return 2
  if (value === "low") return 1
  return 0
}

function isUnknown(value: string) {
  const text = value.trim()
  if (!text) return true
  if (/\bunknown\b/i.test(text)) return true
  return /^(n\/?a|-|none)$/i.test(text)
}

function dashboardSourceIssues(dashboard: string | undefined) {
  if (!dashboard) return []
  const issues: string[] = []
  const tables = tableBlocks(dashboard)
  tables.forEach((table) => {
    const head = table.head.map((cell) => normalize(cell))
    const source = head.findIndex((cell) => cell === "source" || cell === "data source" || cell.endsWith(" source"))
    const sourceUrl = head.findIndex((cell) => cell.includes("url"))
    const retrieval = head.findIndex(
      (cell) => cell.includes("retrieval") || cell.includes("timestamp") || cell === "time" || cell.endsWith(" time"),
    )
    if (source === -1 && sourceUrl === -1 && retrieval === -1) return

    const value = valueColumnIndex(head)
    table.rows.forEach((row) => {
      const label = cleanInline(row[0] ?? "").trim()
      if (!label || normalize(label) === "metric" || normalize(label) === "kpi") return
      const observed = cleanInline(row[value] ?? row[1] ?? "").trim()
      if (!hasNumeric(observed)) return

      const sourceCell = cleanInline(row[source] ?? "").trim()
      if (!sourceCell) {
        issues.push(`Numeric metric \`${label}\` is missing source attribution in \`dashboard.md\`.`)
      } else {
        if (/\b(websearch_exa|websearch|exa|search|internet)\b/i.test(sourceCell)) {
          issues.push(`Numeric metric \`${label}\` uses a generic source label; cite the original publisher/domain.`)
        }
        if (!isFinancePublisher(sourceCell)) {
          issues.push(
            `Numeric metric \`${label}\` source \`${sourceCell}\` is not a supported financial provider (alphavantage, yfinance, finnhub, financial-modeling-prep, polygon, sec-edgar, quiver-quant, quartr).`,
          )
        }
      }

      if (sourceUrl !== -1) {
        const urlCell = cleanInline(row[sourceUrl] ?? "").trim()
        if (!urlCell) {
          issues.push(`Numeric metric \`${label}\` is missing source URL in \`dashboard.md\`.`)
        } else if (!sourceUrlMatches(sourceCell, urlCell)) {
          issues.push(`Numeric metric \`${label}\` source label \`${sourceCell}\` does not match source URL \`${urlCell}\`.`)
        }
      }

      if (retrieval === -1) return
      const retrievalCell = cleanInline(row[retrieval] ?? "").trim()
      if (!retrievalCell) {
        issues.push(`Numeric metric \`${label}\` is missing retrieval timestamp in \`dashboard.md\`.`)
        return
      }
      if (!isTimestamp(retrievalCell)) {
        issues.push(`Numeric metric \`${label}\` retrieval value \`${retrievalCell}\` is not a valid timestamp.`)
      }
    })
  })
  return issues
}

function tableBlocks(input: string) {
  const rows = input.replace(/\r/g, "").split("\n")
  const out: { head: string[]; rows: string[][] }[] = []
  for (let i = 0; i < rows.length; i++) {
    const table = markdownTable(rows, i)
    if (!table) continue
    out.push({
      head: table.head,
      rows: table.rows,
    })
    i = table.next - 1
  }
  return out
}

function valueColumnIndex(head: string[]) {
  const fields = ["current", "value", "latest value", "latest", "observed", "amount"]
  const match = fields
    .map((field) => head.findIndex((cell) => cell === field))
    .find((index) => typeof index === "number" && index >= 0)
  if (typeof match === "number" && match >= 0) return match
  return 1
}

function metricValue(markdown: string | undefined, patterns: RegExp[]) {
  if (!markdown) return
  const tables = tableBlocks(markdown)
  for (const table of tables) {
    const head = table.head.map((cell) => normalize(cell))
    const value = valueColumnIndex(head)
    for (const row of table.rows) {
      const label = cleanInline(row[0] ?? "").trim()
      if (!label) continue
      if (!patterns.some((pattern) => pattern.test(label))) continue
      const output = cleanInline(row[value] ?? row[1] ?? "").trim()
      if (!output) continue
      return output
    }
  }
  return
}

function hasNumeric(value: string) {
  return /[-+]?\d/.test(value)
}

function isFinancePublisher(value: string) {
  return /\b(alpha[\s-]?vantage|alphavantage|yfinance|yahoo finance|sec(?:\s+edgar)?|sec-edgar|quiver(?:\s+quant)?|quiver-quant|quartr|finnhub|financial[\s-]+modeling[\s-]+prep|fmp|polygon)\b/i.test(
    value,
  )
}

function sourceDomains(source: string) {
  const text = source.toLowerCase()
  const out: string[] = []
  if (/alpha[\s-]?vantage/.test(text)) out.push("alphavantage.co")
  if (/yfinance|yahoo finance/.test(text)) out.push("query1.finance.yahoo.com", "finance.yahoo.com")
  if (/finnhub/.test(text)) out.push("finnhub.io")
  if (/financial[\s-]+modeling[\s-]+prep|\bfmp\b/.test(text)) out.push("financialmodelingprep.com")
  if (/polygon/.test(text)) out.push("polygon.io", "api.polygon.io")
  if (/sec(?:\s+edgar)?|sec-edgar/.test(text)) out.push("sec.gov", "data.sec.gov")
  if (/quiver(?:\s+quant)?|quiver-quant/.test(text)) out.push("quiverquant.com", "api.quiverquant.com")
  if (/quartr/.test(text)) out.push("quartr.com")
  return out
}

function sourceUrlMatches(source: string, url: string) {
  if (!source.trim()) return true
  const domains = sourceDomains(source)
  if (!domains.length) return true
  const target = url.toLowerCase()
  return domains.some((domain) => target.includes(domain))
}

function isTimestamp(value: string) {
  const iso = /^\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[zZ]|[+-]\d{2}:\d{2})?)?$/
  if (iso.test(value)) return true
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
}

async function embedIcon(pdf: PDFDocument, url: string): Promise<Image | undefined> {
  const target = url.trim()
  if (!target || isUnknown(target)) return

  const response = await fetch(target, {
    headers: {
      Accept: "image/*",
      "User-Agent": "opencode-finance/1.0",
    },
  }).catch(() => undefined)
  if (!response?.ok) return

  const bytes = await response.arrayBuffer().catch(() => undefined)
  if (!bytes) return
  const body = new Uint8Array(bytes)
  if (!body.length) return

  const type = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (type.includes("png")) return pdf.embedPng(body).catch(() => undefined)
  if (type.includes("jpeg") || type.includes("jpg")) return pdf.embedJpg(body).catch(() => undefined)

  const isPng = body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
  if (isPng) return pdf.embedPng(body).catch(() => undefined)
  return pdf.embedJpg(body).catch(() => undefined)
}

function renderReportCover(pdf: PDFDocument, info: Cover, font: FontSet, icon?: Image) {
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    color: THEME.paper,
  })

  const hero = 228
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - hero,
    width: PAGE_WIDTH,
    height: hero,
    color: THEME.navy,
  })
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - hero - 6,
    width: PAGE_WIDTH,
    height: 6,
    color: THEME.sky,
  })

  tickerBadge(page, font, PAGE_WIDTH - MARGIN - 44, PAGE_HEIGHT - 28, 38, info.ticker)

  page.drawText("OpenCode Finance", {
    x: MARGIN,
    y: PAGE_HEIGHT - 42,
    size: 12,
    font: font.uiBold,
    color: THEME.paper,
  })
  page.drawText("Institutional Research Brief", {
    x: MARGIN,
    y: PAGE_HEIGHT - 59,
    size: 9.6,
    font: font.ui,
    color: hex("#BFDBFE"),
  })

  const scoreW = 162
  const scoreH = 128
  const scoreX = PAGE_WIDTH - MARGIN - scoreW
  const scoreY = PAGE_HEIGHT - hero + 58
  page.drawRectangle({
    x: scoreX,
    y: scoreY,
    width: scoreW,
    height: scoreH,
    color: THEME.score,
    borderColor: THEME.line,
    borderWidth: 1,
  })
  page.drawText("Directional Conviction", {
    x: scoreX + 12,
    y: scoreY + scoreH - 22,
    size: 9,
    font: font.uiBold,
    color: THEME.muted,
  })
  page.drawText(info.score, {
    x: scoreX + 12,
    y: scoreY + 57,
    size: 36,
    font: font.uiBold,
    color: THEME.ink,
  })
  bandChip(page, font, scoreX + 12, scoreY + 20, info.band)
  if (icon) {
    const size = 40
    const x = scoreX + scoreW - size - 12
    const y = scoreY + scoreH - size - 26
    page.drawRectangle({
      x: x - 2,
      y: y - 2,
      width: size + 4,
      height: size + 4,
      color: THEME.paper,
      borderColor: THEME.line,
      borderWidth: 1,
    })
    page.drawImage(icon, {
      x,
      y,
      width: size,
      height: size,
    })
  }

  const titleWidth = scoreX - MARGIN - 20
  const titleLines = wrap(info.title, titleWidth, font.bold, 24)
  const title = pick(titleLines, [info.title]).slice(0, 2)
  let titleY = PAGE_HEIGHT - 104
  title.forEach((line) => {
    page.drawText(line, {
      x: MARGIN,
      y: titleY,
      size: 24,
      font: font.bold,
      color: THEME.paper,
    })
    titleY -= 28
  })

  page.drawText(`Ticker: ${info.ticker}   Report Date: ${info.date}`, {
    x: MARGIN,
    y: PAGE_HEIGHT - 171,
    size: 9.6,
    font: font.ui,
    color: hex("#DBEAFE"),
  })
  page.drawText(`Sector: ${info.sector}   Headquarters: ${info.headquarters}`, {
    x: MARGIN,
    y: PAGE_HEIGHT - 186,
    size: 9.6,
    font: font.ui,
    color: hex("#BFDBFE"),
  })

  const gap = 10
  const chipH = 56
  const chipW = (PAGE_WIDTH - MARGIN * 2 - gap * 2) / 3
  const chipsTop = PAGE_HEIGHT - hero - 26
  info.metrics.forEach((item, index) => {
    const col = index % 3
    const row = Math.floor(index / 3)
    const x = MARGIN + col * (chipW + gap)
    const y = chipsTop - row * (chipH + gap) - chipH
    chip(page, font, x, y, chipW, chipH, item)
  })

  const driverTop = chipsTop - chipH * 2 - gap - 26
  const boxH = 130
  const colW = (PAGE_WIDTH - MARGIN * 2 - gap) / 2
  driverBox(page, font, MARGIN, driverTop, colW, boxH, "Top Positive Drivers", info.positive, "positive")
  driverBox(page, font, MARGIN + colW + gap, driverTop, colW, boxH, "Key Risks", info.negative, "risk")

  const summaryTop = driverTop - boxH - 22
  page.drawText("Executive Summary", {
    x: MARGIN,
    y: summaryTop,
    size: 14,
    font: font.uiBold,
    color: THEME.ink,
  })

  const maxHeight = summaryTop - 74
  const lines = wrap(info.summary || "Summary unavailable.", PAGE_WIDTH - MARGIN * 2, font.regular, 10.4)
  let y = summaryTop - 18
  for (const line of lines) {
    if (y < maxHeight) break
    if (!line) {
      y -= 7
      continue
    }
    page.drawText(line, {
      x: MARGIN,
      y,
      size: 10.4,
      font: font.regular,
      color: THEME.text,
    })
    y -= 13
  }
}

function renderDarkpoolCover(
  pdf: PDFDocument,
  info: Cover,
  font: FontSet,
  icon: Image | undefined,
  artifacts: LoadedArtifacts,
) {
  const snapshot = extractDarkpoolCoverData(artifacts)
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    color: THEME.paper,
  })

  const hero = 220
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - hero,
    width: PAGE_WIDTH,
    height: hero,
    color: THEME.navy,
  })
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - hero - 6,
    width: PAGE_WIDTH,
    height: 6,
    color: THEME.sky,
  })

  tickerBadge(page, font, PAGE_WIDTH - MARGIN - 44, PAGE_HEIGHT - 28, 38, info.ticker)

  page.drawText("OpenCode Finance", {
    x: MARGIN,
    y: PAGE_HEIGHT - 42,
    size: 12,
    font: font.uiBold,
    color: THEME.paper,
  })
  page.drawText("Darkpool Anomaly Brief", {
    x: MARGIN,
    y: PAGE_HEIGHT - 59,
    size: 9.6,
    font: font.ui,
    color: hex("#BFDBFE"),
  })

  const title = pick(wrap(info.title, PAGE_WIDTH - MARGIN * 2 - 60, font.bold, 22), [info.title]).slice(0, 2)
  let titleY = PAGE_HEIGHT - 104
  title.forEach((line) => {
    page.drawText(line, {
      x: MARGIN,
      y: titleY,
      size: 22,
      font: font.bold,
      color: THEME.paper,
    })
    titleY -= 25
  })

  page.drawText(`Ticker: ${info.ticker}   Report Date: ${info.date}`, {
    x: MARGIN,
    y: PAGE_HEIGHT - 170,
    size: 9.6,
    font: font.ui,
    color: hex("#DBEAFE"),
  })
  page.drawText(
    `Threshold |z|: ${formatNumber(snapshot.threshold, 3)}   Lookback: ${snapshot.lookbackDays}   Min samples: ${snapshot.minSamples}`,
    {
      x: MARGIN,
      y: PAGE_HEIGHT - 185,
      size: 9.6,
      font: font.ui,
      color: hex("#BFDBFE"),
    },
  )

  const gap = 10
  const chipH = 56
  const chipW = (PAGE_WIDTH - MARGIN * 2 - gap * 2) / 3
  const chipsTop = PAGE_HEIGHT - hero - 26
  const metrics: Metric[] = [
    { label: "Significant", value: String(snapshot.significantCount), tone: snapshot.significantCount > 0 ? "risk" : "neutral" },
    { label: "New", value: String(snapshot.transitions.new), tone: snapshot.transitions.new > 0 ? "risk" : "neutral" },
    { label: "Persisted", value: String(snapshot.transitions.persisted), tone: snapshot.transitions.persisted > 0 ? "risk" : "neutral" },
    {
      label: "Severity Changed",
      value: String(snapshot.transitions.severity_change),
      tone: snapshot.transitions.severity_change > 0 ? "risk" : "neutral",
    },
    { label: "Resolved", value: String(snapshot.transitions.resolved), tone: snapshot.transitions.resolved > 0 ? "positive" : "neutral" },
    { label: "Signal Type", value: "Off-exchange", tone: "neutral" },
  ]
  metrics.forEach((item, index) => {
    const col = index % 3
    const row = Math.floor(index / 3)
    const x = MARGIN + col * (chipW + gap)
    const y = chipsTop - row * (chipH + gap) - chipH
    chip(page, font, x, y, chipW, chipH, item)
  })

  const tableTop = chipsTop - chipH * 2 - gap - 16
  const tableBottom = drawDarkpoolTopTable(page, font, MARGIN, tableTop, PAGE_WIDTH - MARGIN * 2, snapshot.topAnomalies.slice(0, 5))

  const summaryTop = tableBottom - 22
  page.drawText("Anomaly Summary", {
    x: MARGIN,
    y: summaryTop,
    size: 14,
    font: font.uiBold,
    color: THEME.ink,
  })

  const maxHeight = 64
  const lines = wrap(info.summary || "Summary unavailable.", PAGE_WIDTH - MARGIN * 2, font.regular, 10.4)
  let y = summaryTop - 18
  for (const line of lines) {
    if (y < maxHeight) break
    if (!line) {
      y -= 7
      continue
    }
    page.drawText(line, {
      x: MARGIN,
      y,
      size: 10.4,
      font: font.regular,
      color: THEME.text,
    })
    y -= 13
  }

  if (icon) {
    const size = 30
    const x = PAGE_WIDTH - MARGIN - size
    const y = 70
    page.drawRectangle({
      x: x - 2,
      y: y - 2,
      width: size + 4,
      height: size + 4,
      color: THEME.paper,
      borderColor: THEME.line,
      borderWidth: 1,
    })
    page.drawImage(icon, {
      x,
      y,
      width: size,
      height: size,
    })
  }
}

function drawDarkpoolTopTable(
  page: Awaited<ReturnType<PDFDocument["addPage"]>>,
  font: FontSet,
  x: number,
  top: number,
  width: number,
  rows: DarkpoolTopAnomaly[],
) {
  page.drawText("Top Anomalies", {
    x,
    y: top,
    size: 12,
    font: font.uiBold,
    color: THEME.ink,
  })

  const headers = ["Ticker", "Severity", "Direction", "|z|", "State"]
  const ratios = [0.2, 0.2, 0.2, 0.16, 0.24]
  const rowHeight = 18
  const tableTop = top - 10
  const fillRows = rows.length
    ? rows
    : [
        {
          ticker: "none",
          severity: "none",
          direction: "none",
          absZ: 0,
          state: "none",
        },
      ]

  const drawRow = (cells: string[], y: number, header = false) => {
    let cursor = x
    cells.forEach((cell, index) => {
      const w = width * ratios[index]
      page.drawRectangle({
        x: cursor,
        y: y - rowHeight,
        width: w,
        height: rowHeight,
        color: header ? THEME.card : THEME.paper,
        borderColor: THEME.line,
        borderWidth: 0.8,
      })
      page.drawText(cell, {
        x: cursor + 4,
        y: y - 12,
        size: 8.4,
        font: header ? font.uiBold : font.regular,
        color: THEME.text,
      })
      cursor += w
    })
  }

  drawRow(headers, tableTop, true)
  fillRows.forEach((row, index) => {
    drawRow(
      [row.ticker, row.severity, row.direction, formatNumber(row.absZ, 3), row.state],
      tableTop - rowHeight * (index + 1),
      false,
    )
  })

  return tableTop - rowHeight * (fillRows.length + 1)
}

function extractDarkpoolCoverData(artifacts: LoadedArtifacts): DarkpoolCoverData {
  if (!artifacts.evidenceJson) {
    throw new Error("Missing required darkpool artifact `evidence.json`.")
  }
  if (!artifacts.assumptions) {
    throw new Error("Missing required darkpool artifact `assumptions.json`.")
  }

  const evidence = asRecord(parseJson(artifacts.evidenceJson))
  if (!evidence) {
    throw new Error("`evidence.json` must be a valid JSON object.")
  }
  const assumptions = asRecord(parseJson(artifacts.assumptions))
  if (!assumptions) {
    throw new Error("`assumptions.json` must be a valid JSON object.")
  }
  const detection = asRecord(assumptions.detection_parameters)
  if (!detection) {
    throw new Error("`assumptions.json` must include `detection_parameters`.")
  }

  const threshold = toFiniteNumber(detection.significance_threshold)
  const lookbackDays = toFiniteNumber(detection.lookback_days)
  const minSamples = toFiniteNumber(detection.min_samples)
  if (!Number.isFinite(threshold) || !Number.isFinite(lookbackDays) || !Number.isFinite(minSamples)) {
    throw new Error("`assumptions.json` detection parameters must include numeric threshold, lookback_days, and min_samples.")
  }

  const transitions = asRecordArray(evidence.transitions, "`evidence.json` must include `transitions` array.")
  const anomalies = asRecordArray(evidence.anomalies, "`evidence.json` must include `anomalies` array.")

  const transitionCounts: DarkpoolTransitionCounts = {
    new: 0,
    persisted: 0,
    severity_change: 0,
    resolved: 0,
  }
  const stateByKey = new Map<string, string>()

  for (const item of transitions) {
    const state = String(item.state ?? "").trim()
    if (state === "new" || state === "persisted" || state === "severity_change" || state === "resolved") {
      transitionCounts[state] += 1
    }
    const key = asOptionalText(item.key)
    const current = asRecord(item.current)
    const currentKey = asOptionalText(current?.key)
    if (key) stateByKey.set(key, state || "new")
    if (currentKey) stateByKey.set(currentKey, state || "new")
  }

  const topAnomalies = anomalies
    .map((item) => {
      const key = asOptionalText(item.key)
      const ticker = asOptionalText(item.ticker) ?? "unknown"
      const severity = asOptionalText(item.severity) ?? "unknown"
      const direction = asOptionalText(item.direction) ?? "unknown"
      const absZ = toFiniteNumber(item.abs_z_score)
      if (!Number.isFinite(absZ)) return
      return {
        ticker: ticker.toUpperCase(),
        severity: severity.toLowerCase(),
        direction: direction.toLowerCase(),
        absZ,
        state: key ? (stateByKey.get(key) ?? "new") : "new",
      } satisfies DarkpoolTopAnomaly
    })
    .filter((item): item is DarkpoolTopAnomaly => Boolean(item))
    .toSorted((a, b) => {
      const severityOrder = severityRank(b.severity) - severityRank(a.severity)
      if (severityOrder !== 0) return severityOrder
      return b.absZ - a.absZ
    })

  return {
    threshold,
    lookbackDays: Math.round(lookbackDays),
    minSamples: Math.round(minSamples),
    transitions: transitionCounts,
    significantCount: anomalies.length,
    topAnomalies,
  }
}

function tickerBadge(
  page: Awaited<ReturnType<PDFDocument["addPage"]>>,
  font: FontSet,
  x: number,
  y: number,
  size: number,
  ticker: string,
) {
  page.drawRectangle({
    x,
    y: y - size,
    width: size,
    height: size,
    color: THEME.navySoft,
    borderColor: hex("#7FB3E3"),
    borderWidth: 1.2,
  })
  page.drawRectangle({
    x: x + 1,
    y: y - 8,
    width: size - 2,
    height: 7,
    color: THEME.sky,
  })

  const label = ticker.slice(0, 4).toUpperCase()
  const mark = font.uiBold.widthOfTextAtSize(label, 11.5)
  page.drawText(label, {
    x: x + (size - mark) / 2,
    y: y - size / 2 - 3,
    size: 11.5,
    font: font.uiBold,
    color: THEME.paper,
  })
}

function chip(
  page: Awaited<ReturnType<PDFDocument["addPage"]>>,
  font: FontSet,
  x: number,
  y: number,
  w: number,
  h: number,
  item: Metric,
) {
  const color = item.tone === "positive" ? THEME.positiveBg : item.tone === "risk" ? THEME.riskBg : THEME.neutralBg
  const text = item.tone === "positive" ? THEME.positive : item.tone === "risk" ? THEME.risk : THEME.neutral
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    color,
    borderColor: THEME.line,
    borderWidth: 1,
  })
  page.drawText(item.label, {
    x: x + 10,
    y: y + h - 16,
    size: 8,
    font: font.uiBold,
    color: THEME.muted,
  })
  const lines = wrap(item.value, w - 20, font.bold, 12)
  const content = lines.length ? lines.slice(0, 2) : ["unknown"]
  content.forEach((line, index) => {
    page.drawText(line, {
      x: x + 10,
      y: y + 24 - index * 12,
      size: 11.2,
      font: font.bold,
      color: text,
    })
  })
}

function bandChip(
  page: Awaited<ReturnType<PDFDocument["addPage"]>>,
  font: FontSet,
  x: number,
  y: number,
  band: string,
) {
  const upper = band.toUpperCase()
  const style = bandStyle(upper)
  const width = font.uiBold.widthOfTextAtSize(upper, 9) + 18
  page.drawRectangle({
    x,
    y,
    width,
    height: 18,
    color: style.bg,
    borderColor: style.text,
    borderWidth: 1,
  })
  page.drawText(upper, {
    x: x + 9,
    y: y + 5,
    size: 9,
    font: font.uiBold,
    color: style.text,
  })
}

function bandStyle(band: string) {
  if (band === "BULLISH") return { bg: THEME.positiveBg, text: THEME.positive }
  if (band === "BEARISH") return { bg: THEME.riskBg, text: THEME.risk }
  return { bg: THEME.neutralBg, text: THEME.neutral }
}

function driverBox(
  page: Awaited<ReturnType<PDFDocument["addPage"]>>,
  font: FontSet,
  x: number,
  top: number,
  w: number,
  h: number,
  title: string,
  rows: string[],
  tone: Tone,
) {
  const bg = tone === "positive" ? THEME.positiveBg : tone === "risk" ? THEME.riskBg : THEME.neutralBg
  const text = tone === "positive" ? THEME.positive : tone === "risk" ? THEME.risk : THEME.neutral
  const y = top - h
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    color: bg,
    borderColor: THEME.line,
    borderWidth: 1,
  })
  page.drawText(title, {
    x: x + 10,
    y: y + h - 20,
    size: 10,
    font: font.uiBold,
    color: text,
  })

  let lineY = y + h - 36
  rows.slice(0, 3).forEach((row) => {
    const lines = wrap(row, w - 28, font.regular, 9.4).slice(0, 2)
    const visible = lines.length ? lines : ["unknown"]
    page.drawText("•", {
      x: x + 10,
      y: lineY,
      size: 10,
      font: font.uiBold,
      color: text,
    })
    visible.forEach((line, index) => {
      page.drawText(line, {
        x: x + 20,
        y: lineY - index * 10.8,
        size: 9.4,
        font: font.regular,
        color: THEME.text,
      })
    })
    lineY -= Math.max(24, visible.length * 10.8 + 8)
  })
}

function section(pdf: PDFDocument, font: FontSet, info: Cover, title: string, input: string, style?: SectionStyle) {
  const size = style?.size ?? 11
  const line = style?.line ?? 15
  const body = style?.mono ? monoRows(input) : markdownRows(input)
  const bodyFont = style?.mono ? font.mono : font.regular
  const width = PAGE_WIDTH - MARGIN * 2

  let page = header(pdf, font, info, title)
  let y = TOP

  const ensure = (space: number) => {
    if (y > BOTTOM + space) return false
    page = header(pdf, font, info, `${title} (cont.)`)
    y = TOP
    return true
  }

  body.forEach((row) => {
    if (row.kind === "blank") {
      y -= style?.mono ? line - 2 : line - 4
      return
    }

    if (row.kind === "heading") {
      const lines = wrap(row.text, width, font.bold, row.size)
      const need = lines.length * (row.size + 3) + 6
      ensure(need)
      lines.forEach((text) => {
        page.drawText(text, {
          x: MARGIN,
          y,
          size: row.size,
          font: font.bold,
          color: THEME.ink,
        })
        y -= row.size + 3
      })
      y -= 2
      return
    }

    if (row.kind === "bullet") {
      const indent = 14
      const lines = wrap(row.text, width - indent, bodyFont, size)
      const need = lines.length * line + 3
      ensure(need)
      page.drawText(row.marker, {
        x: MARGIN,
        y,
        size,
        font: style?.mono ? font.regular : font.bold,
        color: THEME.text,
      })
      lines.forEach((text, index) => {
        page.drawText(text, {
          x: MARGIN + indent,
          y: y - index * line,
          size,
          font: bodyFont,
          color: THEME.text,
        })
      })
      y -= lines.length * line
      return
    }

    if (row.kind === "table") {
      const cols = Math.max(1, row.head.length, ...row.rows.map((cells) => cells.length))
      const col = width / cols
      const pad = 4
      const text = Math.max(8.7, size - 1)
      const textLine = text + 2
      const normalize = (cells: string[]) => Array.from({ length: cols }, (_, index) => cells[index] ?? "unknown")
      const height = (cells: string[]) =>
        Math.max(
          ...normalize(cells).map((cell) => {
            const lines = wrap(cleanInline(cell), col - pad * 2, font.regular, text)
            return Math.max(1, lines.length)
          }),
        ) *
          textLine +
        pad * 2
      const draw = (cells: string[], head: boolean) => {
        const fill = head ? THEME.card : THEME.paper
        const face = head ? font.uiBold : font.regular
        const rowHeight = height(cells)
        normalize(cells).forEach((cell, index) => {
          const x = MARGIN + col * index
          page.drawRectangle({
            x,
            y: y - rowHeight,
            width: col,
            height: rowHeight,
            color: fill,
            borderColor: THEME.line,
            borderWidth: 0.8,
          })
          const lines = wrap(cleanInline(cell), col - pad * 2, face, text)
          lines.forEach((value, lineIndex) => {
            page.drawText(value, {
              x: x + pad,
              y: y - pad - text - lineIndex * textLine,
              size: text,
              font: face,
              color: THEME.text,
            })
          })
        })
        y -= rowHeight
      }

      const rows = [row.head, ...row.rows]
      rows.forEach((cells, index) => {
        const head = index === 0
        const rowHeight = height(cells)
        const split = ensure(rowHeight + 2)
        if (split && !head) {
          draw(row.head, true)
        }
        draw(cells, head)
      })
      y -= 6
      return
    }

    const lines = wrap(row.text, width, bodyFont, size)
    const need = lines.length * line + 2
    ensure(need)

    lines.forEach((text, index) => {
      const lineY = y - index * line
      if (style?.mono) {
        page.drawRectangle({
          x: MARGIN - 3,
          y: lineY - 2,
          width,
          height: line,
          color: THEME.monoBg,
        })
      }
      page.drawText(text, {
        x: MARGIN,
        y: lineY,
        size,
        font: bodyFont,
        color: THEME.text,
      })
    })

    y -= lines.length * line
  })
}

function header(pdf: PDFDocument, font: FontSet, info: Cover, title: string) {
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - HEADER_HEIGHT,
    width: PAGE_WIDTH,
    height: HEADER_HEIGHT,
    color: THEME.navy,
  })
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - HEADER_HEIGHT - 4,
    width: PAGE_WIDTH,
    height: 4,
    color: THEME.sky,
  })
  page.drawText("OpenCode Finance", {
    x: MARGIN,
    y: PAGE_HEIGHT - 30,
    size: 10,
    font: font.uiBold,
    color: THEME.paper,
  })
  page.drawText(`${info.ticker} • ${info.date}`, {
    x: MARGIN,
    y: PAGE_HEIGHT - 44,
    size: 9,
    font: font.ui,
    color: hex("#BFDBFE"),
  })
  page.drawText(title, {
    x: MARGIN,
    y: PAGE_HEIGHT - 63,
    size: 14,
    font: font.bold,
    color: THEME.paper,
  })
  tickerBadge(page, font, PAGE_WIDTH - MARGIN - 28, PAGE_HEIGHT - 22, 24, info.ticker)
  return page
}

function footer(
  page: Awaited<ReturnType<PDFDocument["addPage"]>>,
  font: FontSet,
  info: Cover,
  index: number,
  total: number,
) {
  page.drawLine({
    start: { x: MARGIN, y: 38 },
    end: { x: PAGE_WIDTH - MARGIN, y: 38 },
    thickness: 0.8,
    color: THEME.line,
  })

  const left = `${info.ticker} • ${info.date}`
  page.drawText(left, {
    x: MARGIN,
    y: 24,
    size: 8.5,
    font: font.ui,
    color: THEME.muted,
  })

  const linkSize = 9
  const linkWidth = font.ui.widthOfTextAtSize(FOOTER_TEXT, linkSize)
  const linkX = (PAGE_WIDTH - linkWidth) / 2
  page.drawText(FOOTER_TEXT, {
    x: linkX,
    y: 24,
    size: linkSize,
    font: font.ui,
    color: THEME.slate,
  })
  footerLink(page, linkX, 22, linkWidth, 12, FOOTER_URL)

  const pageLabel = `Page ${index}/${total}`
  page.drawText(pageLabel, {
    x: PAGE_WIDTH - MARGIN - font.ui.widthOfTextAtSize(pageLabel, 9),
    y: 24,
    size: 9,
    font: font.ui,
    color: THEME.muted,
  })
}

function footerLink(page: Awaited<ReturnType<PDFDocument["addPage"]>>, x: number, y: number, w: number, h: number, url: string) {
  const annotation = page.doc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: [x, y, x + w, y + h],
    Border: [0, 0, 0],
    A: {
      Type: PDFName.of("Action"),
      S: PDFName.of("URI"),
      URI: PDFString.of(url),
    },
  })
  const ref = page.doc.context.register(annotation)
  const annots = page.node.Annots()
  if (annots) {
    annots.push(ref)
    return
  }
  page.node.set(PDFName.of("Annots"), page.doc.context.obj([ref]))
}

function markdownRows(input: string): Row[] {
  const out: Row[] = []
  let code = false
  const lines = input.replace(/\r/g, "").split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd()
    if (/^```/.test(line.trim())) {
      code = !code
      continue
    }
    if (code) {
      out.push(line.trim() ? { kind: "text", text: line } : { kind: "blank" })
      continue
    }
    if (!line.trim()) {
      out.push({ kind: "blank" })
      continue
    }
    if (/^\s*---+\s*$/.test(line)) {
      out.push({ kind: "blank" })
      continue
    }

    const table = markdownTable(lines, i)
    if (table) {
      out.push({
        kind: "table",
        head: table.head,
        rows: table.rows,
      })
      i = table.next - 1
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const size = heading[1].length === 1 ? 16 : heading[1].length === 2 ? 13.5 : 12
      out.push({ kind: "heading", text: cleanInline(heading[2]), size })
      continue
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    if (bullet) {
      out.push({ kind: "bullet", marker: "•", text: cleanInline(bullet[1]) })
      continue
    }

    const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/)
    if (ordered) {
      out.push({ kind: "bullet", marker: `${ordered[1]}.`, text: cleanInline(ordered[2]) })
      continue
    }

    out.push({ kind: "text", text: cleanInline(line) })
  }

  return out
}

function markdownTable(lines: string[], start: number) {
  const headLine = lines[start]?.trim()
  const splitLine = lines[start + 1]?.trim()
  if (!headLine?.startsWith("|")) return
  if (!splitLine || !isTableDivider(splitLine)) return

  const head = tableCells(headLine)
  if (!head.length) return

  const rows: string[][] = []
  let next = start + 2
  while (next < lines.length) {
    const row = lines[next].trim()
    if (!row.startsWith("|")) break
    if (isTableDivider(row)) {
      next++
      continue
    }
    rows.push(tableCells(row))
    next++
  }

  return {
    head,
    rows,
    next,
  }
}

function tableCells(line: string) {
  return line
    .split("|")
    .slice(1, -1)
    .map((item) => cleanInline(item.trim()))
}

function isTableDivider(line: string) {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)
}

function monoRows(input: string): Row[] {
  return input
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      if (line.trim()) return { kind: "text", text: line } satisfies Row
      return { kind: "blank" } satisfies Row
    })
}

function cleanInline(input: string) {
  return input
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/^>\s?/, "")
}

function wrap(input: string, width: number, font: Font, size: number) {
  const out: string[] = []
  const rows = input.replace(/\r/g, "").split("\n")

  rows.forEach((row) => {
    const line = row.trimEnd()
    if (!line.trim()) {
      out.push("")
      return
    }

    const words = line.split(/\s+/)
    let current = ""

    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width) {
        current = next
        return
      }

      if (current) out.push(current)
      if (font.widthOfTextAtSize(word, size) <= width) {
        current = word
        return
      }

      const pieces = split(word, width, font, size)
      const head = pieces.slice(0, -1)
      const tail = pieces[pieces.length - 1]
      out.push(...head)
      current = tail
    })

    if (current) out.push(current)
  })

  return out
}

function split(word: string, width: number, font: Font, size: number) {
  const out: string[] = []
  let current = ""
  for (const char of word) {
    const next = `${current}${char}`
    if (font.widthOfTextAtSize(next, size) <= width) {
      current = next
      continue
    }
    if (current) out.push(current)
    current = char
  }
  if (current) out.push(current)
  return out
}

function executiveSummary(report: string) {
  const body = report.replace(/\r/g, "")
  const lines = body.split("\n")
  const start = lines.findIndex((line) => /^##\s+executive summary/i.test(line.trim()))
  const end = start === -1 ? -1 : lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()))
  if (start === -1) return lines.slice(0, 80).join("\n")
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n")
}

function plainText(input: string) {
  return cleanInline(input)
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\|/gm, "")
    .replace(/\|/g, " | ")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function directionalScore(report: string) {
  const value =
    readScore(report, /\*\*Score:\*\*\s*([0-9]{1,3})(?:\s*\/\s*100)?/i) ??
    readScore(report, /Score:\s*([0-9]{1,3})(?:\s*\/\s*100)?/i) ??
    readScore(report, /Directional conviction(?: score)?[:\s]*([0-9]{1,3})(?:\s*\/\s*100)?/i)
  if (!value) return { value: "unknown", band: "UNKNOWN" }

  const band =
    readBand(report, /\bBand:\s*(bearish|neutral|bullish)\b/i) ??
    readBand(report, /\((bearish|neutral|bullish)(?:\s+band)?\)/i) ??
    mapBand(value)
  return {
    value: `${value}`,
    band,
  }
}

function readScore(report: string, pattern: RegExp) {
  const hit = report.match(pattern)?.[1]
  if (!hit) return
  const score = Number.parseInt(hit, 10)
  if (!Number.isFinite(score)) return
  if (score < 0 || score > 100) return
  return score
}

function readBand(report: string, pattern: RegExp) {
  const hit = report.match(pattern)?.[1]
  if (!hit) return
  return hit.toUpperCase()
}

function mapBand(score: number) {
  if (score >= 60) return "BULLISH"
  if (score <= 39) return "BEARISH"
  return "NEUTRAL"
}

function listUnder(report: string, heading: RegExp) {
  const lines = report.replace(/\r/g, "").split("\n")
  const start = lines.findIndex((line) => heading.test(line.replace(/\*/g, "").trim()))
  if (start === -1) return []
  const seeded = seededList(lines[start], heading)
  if (seeded.length) return seeded

  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) {
      if (out.length) break
      continue
    }
    if (/top (positive|negative) drivers/i.test(line.replace(/\*/g, "").trim())) break
    if (/^##\s+/.test(line)) break
    const match = line.match(/^[-*]\s+(.+)$/) ?? line.match(/^\d+\.\s+(.+)$/)
    if (match?.[1]) {
      out.push(cleanInline(match[1]))
      continue
    }
    if (out.length) break
  }

  return out
}

function seededList(line: string, heading: RegExp) {
  const plain = cleanInline(line).replace(/^([-*]|\d+\.)\s+/, "").trim()
  const lead = plain.match(new RegExp(`^${heading.source}\\b`, heading.flags))
  if (!lead) return []
  const tail = plain.slice(lead[0].length).trim().replace(/^:\s*/, "")
  if (!tail) return []
  return tail
    .split(/\s*;\s*/)
    .map((item) => cleanInline(item).trim())
    .filter(Boolean)
}

function tableRow(markdown: string | undefined, label: string) {
  if (!markdown) return
  const target = normalize(label)
  const lines = markdown.replace(/\r/g, "").split("\n")
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith("|")) continue
    if (/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)) continue

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cleanInline(cell.trim()))

    if (!cells.length) continue
    if (normalize(cells[0]) !== target) continue
    return cells
  }
}

function normalize(input: string) {
  return input
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function field(report: string, label: string) {
  const strict = report.match(new RegExp(`\\*\\*${escape(label)}:\\*\\*\\s*([^\\n]+)`, "i"))?.[1]
  if (strict) return cleanInline(strict).trim()
  const loose = report.match(new RegExp(`^${escape(label)}:\\s*([^\\n]+)$`, "im"))?.[1]
  if (loose) return cleanInline(loose).trim()
  return
}

function escape(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hex(input: string) {
  const raw = input.replace("#", "")
  const r = Number.parseInt(raw.slice(0, 2), 16) / 255
  const g = Number.parseInt(raw.slice(2, 4), 16) / 255
  const b = Number.parseInt(raw.slice(4, 6), 16) / 255
  return rgb(r, g, b)
}

export const ReportPdfInternal = {
  parsePdfSubcommand,
  getPdfProfile,
  sectionPlanForSubcommand,
  coverData: reportCoverData,
  reportCoverData,
  governmentTradingCoverData,
  darkpoolCoverData,
  politicalBacktestCoverData,
  extractDarkpoolCoverData,
  extractPoliticalBacktestCoverData,
  defaultRootHints,
  directionalScore,
  listUnder,
  tableRow,
  field,
  assumptionsMarkdown,
  qualityIssuesBySubcommand,
  qualityIssuesReport,
  qualityIssuesGovernmentTrading,
  qualityIssuesDarkpool,
  qualityIssuesPoliticalBacktest,
}
