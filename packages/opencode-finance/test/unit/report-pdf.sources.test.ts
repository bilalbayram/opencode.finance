import { describe, expect, test } from "bun:test"
import { ReportPdfInternal } from "../../src/tool/pdf"

describe("extractSourcesSection", () => {
    test("extracts trailing ## Sources block", () => {
        const input = [
            "# Report Title",
            "",
            "## Executive Summary",
            "Some analysis with citation [1].",
            "",
            "## Sources",
            "[1] Yahoo Finance, \"AAPL Quote,\" https://finance.yahoo.com/quote/AAPL. Retrieved 2026-03-01.",
            "[2] SEC EDGAR, \"10-K Filing,\" https://sec.gov/filing/123. Retrieved 2026-03-01.",
        ].join("\n")

        const result = ReportPdfInternal.extractSourcesSection(input)

        expect(result.body).not.toContain("## Sources")
        expect(result.body).toContain("## Executive Summary")
        expect(result.body).toContain("Some analysis with citation [1].")
        expect(result.sources).toContain("[1] Yahoo Finance")
        expect(result.sources).toContain("[2] SEC EDGAR")
    })

    test("returns empty sources when no Sources heading exists", () => {
        const input = [
            "# Report Title",
            "",
            "## Executive Summary",
            "Some analysis.",
        ].join("\n")

        const result = ReportPdfInternal.extractSourcesSection(input)

        expect(result.body).toBe(input)
        expect(result.sources).toBe("")
    })

    test("handles # Sources (h1 level)", () => {
        const input = [
            "# Report Title",
            "",
            "Content here.",
            "",
            "# Sources",
            "[1] Alpha Vantage, \"Fundamentals,\" https://alphavantage.co. Retrieved 2026-03-01.",
        ].join("\n")

        const result = ReportPdfInternal.extractSourcesSection(input)

        expect(result.body).not.toContain("# Sources")
        expect(result.body).toContain("Content here.")
        expect(result.sources).toContain("[1] Alpha Vantage")
    })

    test("preserves content before and after sources when mid-document", () => {
        const input = [
            "# Report",
            "",
            "## Analysis",
            "Data here.",
            "",
            "## Sources",
            "[1] Yahoo Finance, \"Quote,\" https://yahoo.com. Retrieved 2026-03-01.",
            "",
            "## Appendix",
            "Extra content.",
        ].join("\n")

        const result = ReportPdfInternal.extractSourcesSection(input)

        expect(result.body).toContain("## Analysis")
        expect(result.body).toContain("## Appendix")
        expect(result.body).not.toContain("## Sources")
        expect(result.sources).toContain("[1] Yahoo Finance")
    })

    test("handles empty Sources section", () => {
        const input = [
            "# Report",
            "",
            "## Analysis",
            "Some data.",
            "",
            "## Sources",
            "",
        ].join("\n")

        const result = ReportPdfInternal.extractSourcesSection(input)

        expect(result.body).toContain("## Analysis")
        expect(result.sources).toBe("")
    })
})

describe("section plan with sources", () => {
    test("report section plan appends Sources when present", () => {
        const plan = ReportPdfInternal.sectionPlanForSubcommand("report", {
            report: "# Report\n\nContent\n\n## Sources\n[1] Yahoo Finance\n",
            dashboard: "# Dashboard\n",
            assumptions: "{}",
        })

        const titles = plan.map((item) => item.title)
        expect(titles[titles.length - 1]).toBe("Sources")
    })

    test("report section plan omits Sources when not present", () => {
        const plan = ReportPdfInternal.sectionPlanForSubcommand("report", {
            report: "# Report\n",
            dashboard: "# Dashboard\n",
            assumptions: "{}",
        })

        expect(plan.map((item) => item.title)).toEqual(["Full Report", "Dashboard", "Assumptions"])
    })

    test("government-trading section plan appends Sources when present", () => {
        const plan = ReportPdfInternal.sectionPlanForSubcommand("government-trading", {
            report: "# Gov Report\n\nContent\n\n## Sources\n[1] Quiver Quant\n",
            dashboard: "# Dashboard\n",
            assumptions: "{}",
            normalizedEventsJson: "[]",
            deltaEventsJson: "{}",
            dataJson: "{}",
        })

        const titles = plan.map((item) => item.title)
        expect(titles[titles.length - 1]).toBe("Sources")
    })

    test("darkpool section plan appends Sources when present", () => {
        const plan = ReportPdfInternal.sectionPlanForSubcommand("darkpool-anomaly", {
            report: "# Darkpool Report\n\nContent\n\n## Sources\n[1] Quiver Quant\n",
            dashboard: "# Dashboard\n",
            assumptions: "{}",
            evidenceMarkdown: "# Evidence\n",
            evidenceJson: "{}",
        })

        const titles = plan.map((item) => item.title)
        expect(titles[titles.length - 1]).toBe("Sources")
    })

    test("political-backtest section plan appends Sources when present", () => {
        const plan = ReportPdfInternal.sectionPlanForSubcommand("political-backtest", {
            report: "# Political Backtest\n\nContent\n\n## Sources\n[1] SEC EDGAR\n",
            dashboard: "# Dashboard\n",
            assumptions: "{}",
            aggregateJson: "[]",
            comparisonJson: "{}",
        })

        const titles = plan.map((item) => item.title)
        expect(titles[titles.length - 1]).toBe("Sources")
    })
})
