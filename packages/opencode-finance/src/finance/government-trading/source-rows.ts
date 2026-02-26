import type * as QuiverReport from "../providers/quiver-report"

export type GovernmentTradingTickerDatasets = Array<{
  ticker: string
  datasets: QuiverReport.QuiverReportDataset[]
}>

export type GovernmentTradingSourceRowInput = {
  datasetId: string
  datasetLabel: string
  row: Record<string, unknown>
  rowIndex: number
}

type CollectGovernmentTradingSourceRowsInput = {
  globalDatasets: QuiverReport.QuiverReportDataset[]
  tickerDatasets: GovernmentTradingTickerDatasets
  limitPerDataset: number
}

function normalizeLimitPerDataset(input: number) {
  if (!Number.isInteger(input) || input < 1) {
    throw new Error("limitPerDataset must be a positive integer")
  }
  return input
}

export function collectGovernmentTradingSourceRows(
  input: CollectGovernmentTradingSourceRowsInput,
): GovernmentTradingSourceRowInput[] {
  const limitPerDataset = normalizeLimitPerDataset(input.limitPerDataset)
  const rows: GovernmentTradingSourceRowInput[] = []

  for (const dataset of input.globalDatasets) {
    const bounded = dataset.rows.slice(0, limitPerDataset)
    bounded.forEach((row, rowIndex) => {
      rows.push({
        datasetId: dataset.id,
        datasetLabel: dataset.label,
        row,
        rowIndex,
      })
    })
  }

  for (const tickerItem of input.tickerDatasets) {
    for (const dataset of tickerItem.datasets) {
      const bounded = dataset.rows.slice(0, limitPerDataset)
      bounded.forEach((row, rowIndex) => {
        rows.push({
          datasetId: dataset.id,
          datasetLabel: `${dataset.label} (${tickerItem.ticker})`,
          row: {
            ...row,
            requested_ticker: tickerItem.ticker,
          },
          rowIndex,
        })
      })
    }
  }

  return rows
}
