import { describe, expect, test } from "bun:test"
import { ReportPdfInternal } from "../../src/tool/pdf"

describe("extractSourcesSection broadened matching", () => {
    test("matches ## Source Register", () => {
        const input = "# Report\n\nContent\n\n## Source Register\n- S1: Yahoo Finance\n"
        const result = ReportPdfInternal.extractSourcesSection(input)
        expect(result.body).not.toContain("Source Register")
        expect(result.sources).toContain("S1: Yahoo Finance")
    })

    test("matches ## References", () => {
        const input = "# Report\n\nContent\n\n## References\n[1] Source One\n"
        const result = ReportPdfInternal.extractSourcesSection(input)
        expect(result.body).not.toContain("References")
        expect(result.sources).toContain("[1] Source One")
    })

    test("matches ## Bibliography", () => {
        const input = "# Report\n\nContent\n\n## Bibliography\n[1] Source One\n"
        const result = ReportPdfInternal.extractSourcesSection(input)
        expect(result.body).not.toContain("Bibliography")
        expect(result.sources).toContain("[1] Source One")
    })
})

describe("stripMetadataLines", () => {
    test("removes Sector, HQ, Website, Icon URL lines", () => {
        const input = [
            "# Report Title",
            "",
            "Sector: CONSUMER CYCLICAL",
            "Headquarters: 1 TESLA ROAD, AUSTIN, TX, UNITED STATES, 78725",
            "Website: https://tesla.com",
            "Icon URL: https://example.com/icon.png",
            "",
            "## Technical Analysis",
            "Content here.",
        ].join("\n")

        const result = ReportPdfInternal.stripMetadataLines(input)
        expect(result).not.toContain("Sector:")
        expect(result).not.toContain("Headquarters:")
        expect(result).not.toContain("Website:")
        expect(result).not.toContain("Icon URL:")
        expect(result).toContain("## Technical Analysis")
        expect(result).toContain("Content here.")
    })

    test("removes Generated on and Ticker lines", () => {
        const input = "Generated on: 2026-03-02T02:50:30+03:00\nTicker: TSLA\n\n## Analysis\nData"
        const result = ReportPdfInternal.stripMetadataLines(input)
        expect(result).not.toContain("Generated on:")
        expect(result).not.toContain("Ticker:")
        expect(result).toContain("## Analysis")
    })

    test("preserves non-metadata lines", () => {
        const input = "## Analysis\nThe sector outlook is positive.\nHeadquarters are in Austin."
        const result = ReportPdfInternal.stripMetadataLines(input)
        expect(result).toContain("The sector outlook is positive.")
        expect(result).toContain("Headquarters are in Austin.")
    })
})

describe("titleCase", () => {
    test("converts CONSUMER CYCLICAL to Consumer Cyclical", () => {
        expect(ReportPdfInternal.titleCase("CONSUMER CYCLICAL")).toBe("Consumer Cyclical")
    })

    test("converts TECHNOLOGY to Technology", () => {
        expect(ReportPdfInternal.titleCase("TECHNOLOGY")).toBe("Technology")
    })

    test("preserves unknown", () => {
        expect(ReportPdfInternal.titleCase("unknown")).toBe("unknown")
    })

    test("handles already title-cased input", () => {
        expect(ReportPdfInternal.titleCase("Automotive")).toBe("Automotive")
    })
})

describe("shortenHeadquarters", () => {
    test("shortens full address to City, State, Country", () => {
        const result = ReportPdfInternal.shortenHeadquarters(
            "1 TESLA ROAD, AUSTIN, TX, UNITED STATES, 78725",
        )
        expect(result).toBe("AUSTIN, TX, UNITED STATES")
    })

    test("preserves short addresses (3 parts or fewer)", () => {
        expect(ReportPdfInternal.shortenHeadquarters("Austin, TX, USA")).toBe("Austin, TX, USA")
    })

    test("preserves unknown", () => {
        expect(ReportPdfInternal.shortenHeadquarters("unknown")).toBe("unknown")
    })
})

describe("formatDate", () => {
    test("extracts YYYY-MM-DD from ISO timestamp", () => {
        expect(ReportPdfInternal.formatDate("2026-03-02T02:50:30+03:00")).toBe("2026-03-02")
    })

    test("preserves plain YYYY-MM-DD", () => {
        expect(ReportPdfInternal.formatDate("2026-03-01")).toBe("2026-03-01")
    })

    test("returns non-date strings as-is", () => {
        expect(ReportPdfInternal.formatDate("unknown")).toBe("unknown")
    })
})

describe("formatPercent", () => {
    test("rounds to 2 decimals and adds sign", () => {
        expect(ReportPdfInternal.formatPercent("-8.117426%")).toBe("-8.12%")
    })

    test("adds + sign for positive values", () => {
        expect(ReportPdfInternal.formatPercent("+42.759354%")).toBe("+42.76%")
    })

    test("preserves unknown", () => {
        expect(ReportPdfInternal.formatPercent("unknown")).toBe("unknown")
    })

    test("handles no percent sign gracefully", () => {
        expect(ReportPdfInternal.formatPercent("some text")).toBe("some text")
    })
})

describe("formatAnalystConsensus", () => {
    test("formats full analyst breakdown", () => {
        const result = ReportPdfInternal.formatAnalystConsensus(
            "strong buy 4, buy 17, hold 18, sell 6, strong sell 2",
        )
        expect(result).toBe("Buy-leaning (21B / 18H / 8S)")
    })

    test("identifies hold-leaning", () => {
        const result = ReportPdfInternal.formatAnalystConsensus(
            "buy 5, hold 20, sell 3",
        )
        expect(result).toBe("Hold-leaning (5B / 20H / 3S)")
    })

    test("preserves unknown", () => {
        expect(ReportPdfInternal.formatAnalystConsensus("unknown")).toBe("unknown")
    })

    test("preserves unrecognized format", () => {
        expect(ReportPdfInternal.formatAnalystConsensus("Outperform")).toBe("Outperform")
    })
})
