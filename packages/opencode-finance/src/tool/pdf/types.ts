import type { PDFDocument } from "pdf-lib"
import type { Tool } from "../tool"
import { PDF_SUBCOMMAND } from "./constants"

export type PdfSubcommand = (typeof PDF_SUBCOMMAND)[number]
export type Font = Awaited<ReturnType<PDFDocument["embedFont"]>>
export type Image = Awaited<ReturnType<PDFDocument["embedPng"]>>

export type RootHints = {
  ticker: string
  date: string
}

export type LoadedArtifacts = {
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

export type PdfSection = {
  title: string
  content: string
  style?: {
    mono?: boolean
    size?: number
    line?: number
  }
}

export type PdfProfile = {
  buildCoverData: (input: { artifacts: LoadedArtifacts; hints: RootHints }) => any
  enrichCover: (input: { info: any; ctx: Tool.Context }) => Promise<any>
  renderCover: (input: { pdf: PDFDocument; info: any; font: any; icon?: Image; artifacts: LoadedArtifacts }) => void
  sectionPlan: (artifacts: LoadedArtifacts) => PdfSection[]
  qualityGate: (input: { info: any; artifacts: LoadedArtifacts }) => string[]
}
