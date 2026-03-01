export const PDF_SUBCOMMAND = ["report", "government-trading", "darkpool-anomaly", "political-backtest"] as const
export const PDF_SUBCOMMAND_SET = new Set<string>(PDF_SUBCOMMAND)
export const PDF_SUBCOMMAND_LABEL = PDF_SUBCOMMAND.join(", ")
