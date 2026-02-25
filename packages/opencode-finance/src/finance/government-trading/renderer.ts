import type {
  GovernmentTradingRenderInput,
  GovernmentTradingRenderOutput,
  GovernmentTradingUpdatedEvent,
} from "./types"

const MAX_SECTION_EVENTS = 25

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return input.trim()
}

function requireObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`)
  }
  return input as Record<string, unknown>
}

function eventLabel(identityFields: Record<string, string>): string {
  const actor = identityFields.actor || "unknown actor"
  const ticker = identityFields.ticker || "unknown ticker"
  const date = identityFields.transaction_date || "unknown date"
  const action = identityFields.transaction_type || "unknown action"
  const amount = identityFields.amount || "unknown amount"
  return `${date} | ${actor} | ${ticker} | ${action} | ${amount}`
}

function fieldChangeCounts(updatedEvents: GovernmentTradingUpdatedEvent[]) {
  const counts = new Map<string, number>()
  for (const updated of updatedEvents) {
    for (const field of updated.changedFields) {
      counts.set(field, (counts.get(field) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en-US"))
}

function appendEventSection(
  lines: string[],
  heading: string,
  events: { label: string; suffix?: string }[],
  emptyMessage: string,
) {
  lines.push("", `## ${heading}`)
  if (events.length === 0) {
    lines.push(`- ${emptyMessage}`)
    return
  }

  for (const event of events.slice(0, MAX_SECTION_EVENTS)) {
    lines.push(`- ${event.label}${event.suffix ? ` (${event.suffix})` : ""}`)
  }
  if (events.length > MAX_SECTION_EVENTS) {
    lines.push(`- ...and ${events.length - MAX_SECTION_EVENTS} more`)
  }
}

export function renderGovernmentTradingArtifacts(input: GovernmentTradingRenderInput): GovernmentTradingRenderOutput {
  const generatedAt = requireNonEmptyString(input.generatedAt, "generatedAt")
  const title = input.title?.trim() || "Government Trading Report"
  const assumptions = requireObject(input.assumptions, "assumptions")

  if (!Array.isArray(input.currentEvents)) throw new Error("currentEvents must be an array")
  if (!Array.isArray(input.historyRuns)) throw new Error("historyRuns must be an array")
  if (!input.delta || typeof input.delta !== "object") throw new Error("delta is required")

  const summary = {
    current_events: input.currentEvents.length,
    new_events: input.delta.newEvents.length,
    updated_events: input.delta.updatedEvents.length,
    unchanged_events: input.delta.unchangedEvents.length,
    no_longer_present_events: input.delta.noLongerPresentEvents.length,
    historical_runs: input.historyRuns.length,
  }

  const reportLines = [
    `# ${title}`,
    "",
    `Generated at: ${generatedAt}`,
    "",
    "## Summary",
    `- Current normalized events: ${summary.current_events}`,
    `- Delta new: ${summary.new_events}`,
    `- Delta updated: ${summary.updated_events}`,
    `- Delta unchanged: ${summary.unchanged_events}`,
    `- Delta no longer present: ${summary.no_longer_present_events}`,
    `- Historical runs loaded: ${summary.historical_runs}`,
  ]

  appendEventSection(
    reportLines,
    "New Events",
    input.delta.newEvents.map((event) => ({
      label: eventLabel(event.identityFields),
    })),
    "No newly observed events",
  )

  appendEventSection(
    reportLines,
    "Updated Events",
    input.delta.updatedEvents.map((event) => ({
      label: eventLabel(event.current.identityFields),
      suffix: `changed fields: ${event.changedFields.join(", ")}`,
    })),
    "No updated events",
  )

  appendEventSection(
    reportLines,
    "Unchanged Events",
    input.delta.unchangedEvents.map((event) => ({
      label: eventLabel(event.identityFields),
    })),
    "No unchanged events",
  )

  appendEventSection(
    reportLines,
    "No Longer Present Events",
    input.delta.noLongerPresentEvents.map((event) => ({
      label: eventLabel(event.identityFields),
    })),
    "No rows dropped from the latest run",
  )

  const changedFieldRows = fieldChangeCounts(input.delta.updatedEvents)
  const dashboardLines = [
    "# Government Trading Dashboard",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Current normalized events | ${summary.current_events} |`,
    `| New events | ${summary.new_events} |`,
    `| Updated events | ${summary.updated_events} |`,
    `| Unchanged events | ${summary.unchanged_events} |`,
    `| No longer present events | ${summary.no_longer_present_events} |`,
    `| Historical runs loaded | ${summary.historical_runs} |`,
  ]

  if (changedFieldRows.length > 0) {
    dashboardLines.push("", "## Updated Field Frequency", "", "| Field | Count |", "| --- | --- |")
    for (const [field, count] of changedFieldRows) {
      dashboardLines.push(`| ${field} | ${count} |`)
    }
  }

  const rawArtifactPayload = {
    generated_at: generatedAt,
    title,
    summary,
    assumptions,
    current_events: input.currentEvents,
    delta: {
      new_events: input.delta.newEvents,
      updated_events: input.delta.updatedEvents,
      unchanged_events: input.delta.unchangedEvents,
      no_longer_present_events: input.delta.noLongerPresentEvents,
    },
    history: input.historyRuns.map((run) => ({
      run_id: run.runId,
      directory: run.directory,
      normalized_events_path: run.normalizedEventsPath,
      assumptions_path: run.assumptionsPath,
      normalized_event_count: run.normalizedEvents.length,
      assumptions: run.assumptions,
    })),
  }

  return {
    reportMarkdown: `${reportLines.join("\n")}\n`,
    dashboardMarkdown: `${dashboardLines.join("\n")}\n`,
    assumptionsJson: `${JSON.stringify(assumptions, null, 2)}\n`,
    rawArtifactPayload,
  }
}
