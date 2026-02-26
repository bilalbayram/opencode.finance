export type QuiverRow = Record<string, unknown>

export interface GovernmentTradingSourceRow {
  datasetId: string
  datasetLabel: string
  row: QuiverRow
  rowIndex?: number
}

export interface GovernmentTradingNormalizedEvent {
  identityKey: string
  materialFingerprint: string
  datasetId: string
  datasetLabel: string
  rowIndex: number
  identityFields: Record<string, string>
  materialFields: Record<string, string>
  canonicalRow: Record<string, string>
  rawRow: QuiverRow
}

export interface GovernmentTradingUpdatedEvent {
  previous: GovernmentTradingNormalizedEvent
  current: GovernmentTradingNormalizedEvent
  changedFields: string[]
}

export interface GovernmentTradingDeltaResult {
  newEvents: GovernmentTradingNormalizedEvent[]
  updatedEvents: GovernmentTradingUpdatedEvent[]
  unchangedEvents: GovernmentTradingNormalizedEvent[]
  noLongerPresentEvents: GovernmentTradingNormalizedEvent[]
}

export interface GovernmentTradingDeltaOptions {
  includeNoLongerPresent?: boolean
}

export type GovernmentTradingAssumptionsMetadata = Record<string, unknown>

export interface GovernmentTradingHistoryRun {
  runId: string
  directory: string
  normalizedEventsPath: string
  assumptionsPath: string
  normalizedEvents: GovernmentTradingNormalizedEvent[]
  assumptions: GovernmentTradingAssumptionsMetadata
}

export interface GovernmentTradingHistoryLoadOptions {
  historyRoot: string
  maxRuns?: number
  normalizedEventsFilename?: string
  assumptionsFilename?: string
}

export interface GovernmentTradingRenderInput {
  generatedAt: string
  title?: string
  assumptions: GovernmentTradingAssumptionsMetadata
  currentEvents: GovernmentTradingNormalizedEvent[]
  delta: GovernmentTradingDeltaResult
  historyRuns: GovernmentTradingHistoryRun[]
}

export interface GovernmentTradingRawArtifactPayload {
  generated_at: string
  title: string
  summary: {
    current_events: number
    new_events: number
    updated_events: number
    unchanged_events: number
    no_longer_present_events: number
    historical_runs: number
  }
  assumptions: GovernmentTradingAssumptionsMetadata
  current_events: GovernmentTradingNormalizedEvent[]
  delta: {
    new_events: GovernmentTradingNormalizedEvent[]
    updated_events: GovernmentTradingUpdatedEvent[]
    unchanged_events: GovernmentTradingNormalizedEvent[]
    no_longer_present_events: GovernmentTradingNormalizedEvent[]
  }
  history: Array<{
    run_id: string
    directory: string
    normalized_events_path: string
    assumptions_path: string
    normalized_event_count: number
    assumptions: GovernmentTradingAssumptionsMetadata
  }>
}

export interface GovernmentTradingRenderOutput {
  reportMarkdown: string
  dashboardMarkdown: string
  assumptionsJson: string
  rawArtifactPayload: GovernmentTradingRawArtifactPayload
}
