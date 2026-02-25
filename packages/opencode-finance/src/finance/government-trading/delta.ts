import type {
  GovernmentTradingDeltaOptions,
  GovernmentTradingDeltaResult,
  GovernmentTradingNormalizedEvent,
  GovernmentTradingUpdatedEvent,
} from "./types"

function indexByIdentity(events: GovernmentTradingNormalizedEvent[], label: string) {
  const out = new Map<string, GovernmentTradingNormalizedEvent>()
  for (const event of events) {
    if (out.has(event.identityKey)) {
      throw new Error(`Duplicate identity key in ${label}: ${event.identityKey}`)
    }
    out.set(event.identityKey, event)
  }
  return out
}

function changedMaterialFields(
  previous: GovernmentTradingNormalizedEvent,
  current: GovernmentTradingNormalizedEvent,
): string[] {
  const allKeys = [...new Set([...Object.keys(previous.materialFields), ...Object.keys(current.materialFields)])].sort()
  return allKeys.filter((key) => (previous.materialFields[key] ?? "") !== (current.materialFields[key] ?? ""))
}

export function computeGovernmentTradingDelta(
  currentEvents: GovernmentTradingNormalizedEvent[],
  previousEvents: GovernmentTradingNormalizedEvent[],
  options: GovernmentTradingDeltaOptions = {},
): GovernmentTradingDeltaResult {
  const currentByIdentity = indexByIdentity(currentEvents, "current events")
  const previousByIdentity = indexByIdentity(previousEvents, "previous events")

  const newEvents: GovernmentTradingNormalizedEvent[] = []
  const updatedEvents: GovernmentTradingUpdatedEvent[] = []
  const unchangedEvents: GovernmentTradingNormalizedEvent[] = []

  for (const current of currentEvents) {
    const previous = previousByIdentity.get(current.identityKey)
    if (!previous) {
      newEvents.push(current)
      continue
    }

    if (previous.materialFingerprint === current.materialFingerprint) {
      unchangedEvents.push(current)
      continue
    }

    const changedFields = changedMaterialFields(previous, current)
    if (changedFields.length === 0) {
      throw new Error(
        `Fingerprint mismatch for identity ${current.identityKey} without detectable material field changes`,
      )
    }

    updatedEvents.push({
      previous,
      current,
      changedFields,
    })
  }

  const noLongerPresentEvents =
    options.includeNoLongerPresent === true
      ? previousEvents.filter((previous) => !currentByIdentity.has(previous.identityKey))
      : []

  return {
    newEvents,
    updatedEvents,
    unchangedEvents,
    noLongerPresentEvents,
  }
}
