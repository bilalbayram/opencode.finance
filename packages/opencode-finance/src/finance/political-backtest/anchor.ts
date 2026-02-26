import { EventStudyError } from "./error"
import type { EventAnchor, EventAnchorMode, PoliticalEvent } from "./types"

function assertDate(value: string, eventID: string, kind: "transaction" | "report") {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    throw new EventStudyError(`Invalid ${kind} date for event ${eventID}: ${value}`, "INVALID_EVENT_DATE", {
      event_id: eventID,
      anchor_kind: kind,
      value,
    })
  }
}

export function resolveAnchors(events: PoliticalEvent[], mode: EventAnchorMode): EventAnchor[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw new EventStudyError("Cannot resolve anchors for an empty event set.", "EMPTY_EVENT_SET")
  }

  const anchors: EventAnchor[] = []
  for (const event of events) {
    if (mode === "transaction" || mode === "both") {
      if (!event.transaction_date) {
        throw new EventStudyError(
          `Missing transaction date for event ${event.event_id} while anchor mode is ${mode}.`,
          "MISSING_REQUIRED_ANCHOR_DATE",
          {
            event_id: event.event_id,
            mode,
            required: "transaction_date",
          },
        )
      }
      assertDate(event.transaction_date, event.event_id, "transaction")
      anchors.push({
        event_id: event.event_id,
        ticker: event.ticker,
        anchor_kind: "transaction",
        anchor_date: event.transaction_date,
      })
    }

    if (mode === "report" || mode === "both") {
      if (!event.report_date) {
        throw new EventStudyError(
          `Missing report date for event ${event.event_id} while anchor mode is ${mode}.`,
          "MISSING_REQUIRED_ANCHOR_DATE",
          {
            event_id: event.event_id,
            mode,
            required: "report_date",
          },
        )
      }
      assertDate(event.report_date, event.event_id, "report")
      anchors.push({
        event_id: event.event_id,
        ticker: event.ticker,
        anchor_kind: "report",
        anchor_date: event.report_date,
      })
    }
  }

  return anchors.toSorted((a, b) => a.anchor_date.localeCompare(b.anchor_date))
}

export function splitAnchorCohorts(anchors: EventAnchor[]) {
  return {
    transaction: anchors.filter((item) => item.anchor_kind === "transaction"),
    report: anchors.filter((item) => item.anchor_kind === "report"),
  }
}
