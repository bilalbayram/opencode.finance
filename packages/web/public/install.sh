#!/usr/bin/env bash
set -euo pipefail

readonly OPENCODE_INSTALL_URL="https://opencode.ai/install"
readonly OPENCODE_SCHEMA_URL="https://opencode.ai/config.json"
readonly OPENCODE_PLUGIN="opencode-finance"

readonly XDG_CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}"
readonly XDG_DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}"
readonly OPENCODE_CONFIG_DIR="${XDG_CONFIG_ROOT}/opencode"
readonly OPENCODE_DATA_DIR="${XDG_DATA_ROOT}/opencode"

readonly OPENCODE_CONFIG_JSON="${OPENCODE_CONFIG_DIR}/opencode.json"
readonly OPENCODE_CONFIG_JSONC="${OPENCODE_CONFIG_DIR}/opencode.jsonc"
readonly OPENCODE_AUTH_PATH="${OPENCODE_DATA_DIR}/auth.json"

require_binary() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "error: missing required binary '$name'" >&2
    exit 1
  fi
}

if [[ ! -c /dev/tty ]]; then
  echo "error: interactive terminal is required for installer prompts" >&2
  exit 1
fi

require_binary curl
require_binary python3

if ! command -v opencode >/dev/null 2>&1; then
  echo "[opencode-finance] OpenCode not found. Installing from ${OPENCODE_INSTALL_URL} ..."
  curl -fsSL "${OPENCODE_INSTALL_URL}" | bash
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: 'opencode' command is still unavailable after installation" >&2
  echo "Ensure your shell PATH includes the OpenCode install location, then rerun this installer." >&2
  exit 1
fi

export OPENCODE_SCHEMA_URL
export OPENCODE_PLUGIN
export OPENCODE_CONFIG_DIR
export OPENCODE_DATA_DIR
export OPENCODE_CONFIG_JSON
export OPENCODE_CONFIG_JSONC
export OPENCODE_AUTH_PATH

python3 <<'PY'
import getpass
import json
import os
import sys
from pathlib import Path


class InstallError(RuntimeError):
    pass


def strip_jsonc_comments(source):
    out = []
    in_string = False
    escaped = False
    in_line_comment = False
    in_block_comment = False
    i = 0

    while i < len(source):
        char = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

        if in_line_comment:
            if char == "\n":
                in_line_comment = False
                out.append(char)
            i += 1
            continue

        if in_block_comment:
            if char == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            if char == "\n":
                out.append(char)
            i += 1
            continue

        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
            continue

        if char == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue

        if char == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue

        if char == '"':
            in_string = True

        out.append(char)
        i += 1

    return "".join(out)


def strip_jsonc_trailing_commas(source):
    out = []
    in_string = False
    escaped = False
    i = 0

    while i < len(source):
        char = source[i]

        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
            continue

        if char == '"':
            in_string = True
            out.append(char)
            i += 1
            continue

        if char == ",":
            j = i + 1
            while j < len(source) and source[j].isspace():
                j += 1
            if j < len(source) and source[j] in ("}", "]"):
                i += 1
                continue

        out.append(char)
        i += 1

    return "".join(out)


def load_json_object(path):
    if not path.exists():
        return {}

    raw = path.read_text(encoding="utf-8")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as json_err:
        try:
            sanitized = strip_jsonc_trailing_commas(strip_jsonc_comments(raw))
            parsed = json.loads(sanitized)
        except json.JSONDecodeError as fallback_err:
            raise InstallError(
                "failed to parse {}: {}; jsonc fallback failed: {}".format(path, json_err.msg, fallback_err.msg)
            )

    if not isinstance(parsed, dict):
        raise InstallError("expected JSON object in {}".format(path))

    return parsed


def ensure_string_list(config, key):
    value = config.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise InstallError("expected '{}' to be an array in config".format(key))

    out = []
    for item in value:
        if not isinstance(item, str):
            raise InstallError("expected '{}' values to be strings".format(key))
        out.append(item)
    return out


def uniq(values):
    seen = set()
    out = []
    for item in values:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def write_json(path, payload, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    if mode is not None:
        os.chmod(path, mode)


def existing_api_key(auth, provider_id):
    value = auth.get(provider_id)
    if not isinstance(value, dict):
        return ""
    if value.get("type") != "api":
        return ""
    key = value.get("key")
    return key.strip() if isinstance(key, str) else ""


def canonical_quiver_plan(input_value):
    if not isinstance(input_value, str):
        return None
    value = input_value.strip().lower().replace("-", "_").replace(" ", "_")
    if not value:
        return None

    mapping = {
        "public": "public",
        "tier0": "public",
        "tier_0": "public",
        "tier1": "public",
        "tier_1": "public",
        "1": "public",
        "t1": "public",
        "hobbyist": "hobbyist",
        "tier2": "hobbyist",
        "tier_2": "hobbyist",
        "2": "hobbyist",
        "t2": "hobbyist",
        "trader": "trader",
        "tier3": "trader",
        "tier_3": "trader",
        "3": "trader",
        "t3": "trader",
        "enterprise": "enterprise",
        "tier4": "enterprise",
        "tier_4": "enterprise",
        "4": "enterprise",
        "t4": "enterprise",
    }
    return mapping.get(value)


QUIVER_PLANS = {
    "public": {
        "label": "Public (Tier 0)",
        "provider_tier": "tier_1",
    },
    "hobbyist": {
        "label": "Hobbyist (Tier 0 + Tier 1)",
        "provider_tier": "tier_2",
    },
    "trader": {
        "label": "Trader (Tier 0 + Tier 1 + Tier 2)",
        "provider_tier": "tier_3",
    },
    "enterprise": {
        "label": "Enterprise (Tier 0 + Tier 1 + Tier 2)",
        "provider_tier": "enterprise",
    },
}

SKILL_NAME = "finance-comprehensive-report"
SKILL_MANAGED_BY = "opencode-finance"
SKILL_DIR_CANDIDATES = [
    Path.home() / ".agents" / "skills",
    Path.home() / ".opencode" / "skills",
]

FINANCE_SKILL_CONTENT = """---
name: finance-comprehensive-report
description: Build a comprehensive, audit-traceable public-company financial report using technical, fundamental, risk, portfolio-fit, and market-intelligence analysis plus scenario valuation and non-advice directional conviction scoring.
managed_by: opencode-finance
workflow_version: 5
---

# Finance Comprehensive Report

## Input Requirements
- `ticker` (required): public company symbol, for example `AAPL`.
- `focus` (optional): emphasis area such as `forensic`, `valuation`, `governance`, or `credit`.
- `report_date` (optional): date override in `YYYY-MM-DD`; default to today.
- `output_root` (optional): base output directory; default `reports/<ticker>/<report_date>/`.
- `portfolio_context` (optional): existing positions, weights, mandate, and risk budget for portfolio-fit analysis.
- `benchmark` (optional): market or sector benchmark symbol, for example `SPY`, `QQQ`, or a sector ETF.

## Workflow
1. Resolve and normalize the ticker symbol.
2. Retrieve quote, fundamentals, filings, insider, and news context with `financial_search` first, using `coverage: "comprehensive"` for numeric claims.
3. Build a data ledger that separates observed values, modeled assumptions, and analytical inference.
4. Run the technical analysis module:
   - trend regime and momentum context
   - volatility and drawdown profile
   - support and resistance zones with source coverage notes
5. Run the fundamental analysis module:
   - profitability, valuation, liquidity, and cash flow quality review
   - normalization adjustments with explicit rationale in `adjustment-log.md`
6. Run the risk assessment module:
   - business model, balance sheet, valuation, and event risks
   - downside pathways and break-the-thesis thresholds
7. Run the portfolio-fit module:
   - estimate diversification or concentration impact relative to `portfolio_context` and `benchmark` when provided
   - if not provided, render `Not evaluated: missing portfolio holdings, benchmark, and mandate`
8. Run the market-intelligence module:
   - sector and macro context
   - catalyst calendar and monitoring triggers
9. Run scenario-based forecast and valuation:
   - base/bull/bear assumptions with probabilities
   - sensitivity and value-attribution summary
10. Compute directional conviction output:
   - produce `directional_conviction_score` in `0-100`
   - map score bands to `bearish` (0-39), `neutral` (40-59), or `bullish` (60-100)
   - provide top positive and negative drivers with weighting rationale
11. Produce deliverables and reproducibility metadata.
12. After writing all report artifacts, call `report_pdf`:
   - `outputRoot`: `reports/<ticker>/<report_date>/`
   - `filename`: `<ticker>-<report_date>.pdf`
   - do not ask a PDF question and do not skip PDF generation.

## Output Requirements
- Return a concise in-chat executive summary with:
  - thesis, top risks, catalysts, monitoring triggers, and directional conviction output.
- Write markdown-first artifacts to `reports/<ticker>/<report_date>/`:
  - `report.md`: full comprehensive report
  - `dashboard.md`: one-page KPI, threshold, and catalyst dashboard
  - `assumptions.json`: scenario assumptions, probabilities, and key drivers
  - `adjustment-log.md`: normalization entries and rationale
- Always write PDF artifact via `report_pdf`:
  - `<ticker>-<report_date>.pdf`
  - first page: summary of ticker report
  - remaining pages: report information from `report.md`, `dashboard.md`, and `assumptions.json` (exclude `adjustment-log.md`)
  - footer on every page: display `opencode.finance`, linked to `https://opencode.finance`
- Ensure `report.md` includes dedicated sections for:
  - technical analysis
  - fundamental analysis
  - risk assessment
  - portfolio fit
  - market intelligence
  - scenario valuation
  - directional conviction score and monitoring triggers
- Ensure `report.md` includes explicit metadata lines:
  - `Sector: <value>`
  - `Headquarters: <value>`
  - `Website: <value>`
  - `Icon URL: <value>`
- Ensure `report.md` includes explicit driver headings:
  - `Top Positive Drivers`
  - `Top Negative Drivers`
- Ensure insider analysis uses `financial_search` with `intent: "insider"` and `coverage: "comprehensive"` and references returned `ownershipChange` when available.
- Ensure KPI rows include separate entries for:
  - Stock price
  - Previous close
  - Daily change
  - Daily change percent
  - 52W high/low or 52W range
  - YTD return
  - Market cap
  - Analyst consensus
  - Revenue
  - Net income
  - Free cash flow
  - Debt-to-equity
- Ensure KPI source labels and source URLs are coherent (for example, Yahoo chart label must use Yahoo chart URL).
- Use period-aware metric labels in KPI/ledger rows (`TTM`, `FY`, or `Q`) based on `metricPeriods`; do not force `(TTM)` when period differs.
- Ensure `assumptions.json` includes:
  - `scenario_assumptions`
  - `score_inputs`
  - `factor_weights`
  - `uncertainty_flags`

## Data and Citation Rules
- Use `financial_search` as the primary source for finance data, with `coverage: "comprehensive"` for numeric claims.
- Use Exa (`websearch`) only for qualitative market and catalyst context, never for numeric financial metrics.
- Include publisher/domain `source`, canonical URL, and retrieval `timestamp` for every factual claim.
- Never use generic source labels (`websearch`, `exa`, `search`, `internet`) in output artifacts.
- If tool outputs are incomplete or errors are present:
  - mark unresolved fields as `unknown`
  - never use `N/A` in artifacts
  - keep uncertainty explicit
  - do not invent missing values.
- Clearly separate:
  - observed data
  - model assumptions
  - analytical inference.

## Failure Modes
- Missing or invalid ticker:
  - stop and request a valid symbol.
- Insufficient data to support a section:
  - keep section with `unknown` placeholders and list specific gaps.
- Missing `portfolio_context` or `benchmark`:
  - continue and render portfolio fit as `Not evaluated: missing portfolio holdings, benchmark, and mandate`.
- Conflicting data across providers:
  - prefer most recent timestamped source and record discrepancy in `adjustment-log.md`.
- Tool/provider failure:
  - return partial report with explicit `known_unknowns` and next retrieval steps.

## Completion Criteria
- Deliver all four artifacts under the default output path unless user overrides output root.
- Ensure each major section has at least one cited source or an explicit `unknown` note.
- Include `directional_conviction_score`, score band, weighted drivers, and explicit non-advice disclaimer.
- End with a non-advice decision framework:
  - what must be true
  - what breaks the thesis
  - how to detect breaks early.
"""


def open_tty_handles():
    try:
        tty_in = open("/dev/tty", "r", encoding="utf-8")
        tty_out = open("/dev/tty", "w", encoding="utf-8")
    except OSError:
        raise InstallError("interactive terminal is required for installer prompts")
    return tty_in, tty_out


def ask_line(tty_in, tty_out, prompt):
    tty_out.write(prompt)
    tty_out.flush()
    line = tty_in.readline()
    if line == "":
        raise InstallError("terminal input closed")
    return line.rstrip("\n")


def prompt_value(tty_in, tty_out, label, existing, required, secret, placeholder=""):
    while True:
        suffix = ""
        if existing:
            suffix = " [press Enter to keep existing value]"
        elif placeholder:
            suffix = " [{}]".format(placeholder)

        prompt = "{}{}: ".format(label, suffix)
        if secret:
            value = getpass.getpass(prompt, stream=tty_out)
        else:
            value = ask_line(tty_in, tty_out, prompt)

        value = value.strip()
        if value:
            return value
        if existing:
            return existing
        if not required:
            return ""

        print("{} is required.".format(label), file=tty_out)


def prompt_quiver_plan(tty_in, tty_out, existing_plan):
    current = existing_plan if existing_plan in QUIVER_PLANS else None

    print("\nQuiver Quant plan:", file=tty_out)
    print("1) Public (Tier 0)", file=tty_out)
    print("2) Hobbyist (Tier 0 + Tier 1)", file=tty_out)
    print("3) Trader (Tier 0 + Tier 1 + Tier 2)", file=tty_out)
    print("4) Enterprise (Tier 0 + Tier 1 + Tier 2)", file=tty_out)

    while True:
        keep = " [press Enter to keep {}]".format(current) if current else ""
        choice = ask_line(tty_in, tty_out, "Select Quiver plan [1-4]{}: ".format(keep)).strip()
        if not choice:
            if current:
                return current
            print("Quiver plan is required when Quiver key is set.", file=tty_out)
            continue

        lowered = choice.lower()
        if lowered in {"1", "public"}:
            return "public"
        if lowered in {"2", "hobbyist"}:
            return "hobbyist"
        if lowered in {"3", "trader"}:
            return "trader"
        if lowered in {"4", "enterprise"}:
            return "enterprise"

        parsed = canonical_quiver_plan(choice)
        if parsed:
            return parsed

        print("Invalid plan selection. Enter 1, 2, 3, or 4.", file=tty_out)


def select_config_path(config_json, config_jsonc):
    if config_json.exists():
        return config_json
    if config_jsonc.exists():
        return config_jsonc
    return config_json


def parse_frontmatter_managed_by(text):
    lines = text.splitlines()
    if len(lines) < 3:
        return None
    if lines[0].strip() != "---":
        return None

    closing = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            closing = idx
            break
    if closing is None:
        return None

    for line in lines[1:closing]:
        raw = line.strip()
        if not raw or ":" not in raw:
            continue
        key, value = raw.split(":", 1)
        if key.strip() != "managed_by":
            continue
        parsed = value.strip()
        if len(parsed) >= 2 and parsed[0] == parsed[-1] and parsed[0] in ("'", '"'):
            parsed = parsed[1:-1]
        return parsed or None
    return None


def install_finance_skill():
    target = None
    for base in SKILL_DIR_CANDIDATES:
        candidate = base / SKILL_NAME / "SKILL.md"
        if candidate.exists():
            target = candidate
            break

    if target is None:
        target = SKILL_DIR_CANDIDATES[0] / SKILL_NAME / "SKILL.md"

    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(FINANCE_SKILL_CONTENT, encoding="utf-8")
        return {
            "status": "installed",
            "path": str(target),
        }

    current = target.read_text(encoding="utf-8")
    managed_by = parse_frontmatter_managed_by(current)
    if managed_by != SKILL_MANAGED_BY:
        owner = managed_by if managed_by else "unmanaged"
        raise InstallError(
            "existing skill at {} is managed_by '{}'. refusing to overwrite. remove it manually or set managed_by: {}.".format(
                target,
                owner,
                SKILL_MANAGED_BY,
            )
        )

    if current == FINANCE_SKILL_CONTENT:
        return {
            "status": "unchanged",
            "path": str(target),
        }

    target.write_text(FINANCE_SKILL_CONTENT, encoding="utf-8")
    return {
        "status": "updated",
        "path": str(target),
    }


def main():
    config_dir = Path(os.environ["OPENCODE_CONFIG_DIR"])
    data_dir = Path(os.environ["OPENCODE_DATA_DIR"])
    config_json = Path(os.environ["OPENCODE_CONFIG_JSON"])
    config_jsonc = Path(os.environ["OPENCODE_CONFIG_JSONC"])
    auth_path = Path(os.environ["OPENCODE_AUTH_PATH"])
    schema_url = os.environ["OPENCODE_SCHEMA_URL"]
    plugin_id = os.environ["OPENCODE_PLUGIN"]

    config_target = select_config_path(config_json, config_jsonc)
    config = load_json_object(config_target)

    plugin = ensure_string_list(config, "plugin")
    legacy_plugins = ensure_string_list(config, "plugins")
    merged_plugins = uniq(plugin + legacy_plugins)
    if plugin_id not in merged_plugins:
        merged_plugins.append(plugin_id)

    next_config = dict(config)
    next_config.pop("plugins", None)
    next_config["plugin"] = merged_plugins
    if "$schema" not in next_config:
        next_config["$schema"] = schema_url

    auth = load_json_object(auth_path)

    tty_in, tty_out = open_tty_handles()
    try:
        print("[opencode-finance] OpenCode finance setup", file=tty_out)
        print("- config: {}".format(config_target), file=tty_out)
        print("- auth:   {}".format(auth_path), file=tty_out)
        skill = install_finance_skill()
        print("- skill:  {} ({})".format(skill["path"], skill["status"]), file=tty_out)
        print("", file=tty_out)

        sec_edgar = prompt_value(
            tty_in,
            tty_out,
            label="SEC EDGAR identity",
            existing=existing_api_key(auth, "sec-edgar"),
            required=True,
            secret=False,
            placeholder="MyCompany dev@mycompany.com",
        )
        finnhub = prompt_value(
            tty_in,
            tty_out,
            label="Finnhub API key",
            existing=existing_api_key(auth, "finnhub"),
            required=True,
            secret=True,
        )
        polygon = prompt_value(
            tty_in,
            tty_out,
            label="Polygon API key",
            existing=existing_api_key(auth, "polygon"),
            required=True,
            secret=True,
        )
        fmp = prompt_value(
            tty_in,
            tty_out,
            label="Financial Modeling Prep API key",
            existing=existing_api_key(auth, "financial-modeling-prep"),
            required=True,
            secret=True,
        )

        alphavantage = prompt_value(
            tty_in,
            tty_out,
            label="Alpha Vantage API key (optional)",
            existing=existing_api_key(auth, "alphavantage"),
            required=False,
            secret=True,
        )
        quartr = prompt_value(
            tty_in,
            tty_out,
            label="Quartr API key (optional)",
            existing=existing_api_key(auth, "quartr"),
            required=False,
            secret=True,
        )

        existing_quiver = auth.get("quiver-quant")
        existing_quiver_key = existing_api_key(auth, "quiver-quant")
        existing_quiver_plan = None
        if isinstance(existing_quiver, dict):
            existing_quiver_plan = canonical_quiver_plan(existing_quiver.get("provider_tier"))

        quiver_key = prompt_value(
            tty_in,
            tty_out,
            label="Quiver Quant API key (optional)",
            existing=existing_quiver_key,
            required=False,
            secret=True,
        )

        quiver_plan = None
        if quiver_key:
            quiver_plan = prompt_quiver_plan(tty_in, tty_out, existing_quiver_plan)

        next_auth = dict(auth)
        next_auth["sec-edgar"] = {"type": "api", "key": sec_edgar}
        next_auth["finnhub"] = {"type": "api", "key": finnhub}
        next_auth["polygon"] = {"type": "api", "key": polygon}
        next_auth["financial-modeling-prep"] = {"type": "api", "key": fmp}

        if alphavantage:
            next_auth["alphavantage"] = {"type": "api", "key": alphavantage}
        if quartr:
            next_auth["quartr"] = {"type": "api", "key": quartr}
        if quiver_key:
            if quiver_plan is None:
                raise InstallError("quiver plan is required when quiver key is set")
            next_auth["quiver-quant"] = {
                "type": "api",
                "key": quiver_key,
                "provider_tier": QUIVER_PLANS[quiver_plan]["provider_tier"],
                "provider_tag": "quiver-quant",
            }

        config_dir.mkdir(parents=True, exist_ok=True)
        data_dir.mkdir(parents=True, exist_ok=True)

        write_json(config_target, next_config)
        write_json(auth_path, next_auth, mode=0o600)

        optional_configured = []
        if alphavantage:
            optional_configured.append("alphavantage")
        if quartr:
            optional_configured.append("quartr")
        if quiver_key:
            optional_configured.append("quiver-quant ({})".format(quiver_plan))

        print("", file=tty_out)
        print("Setup complete.", file=tty_out)
        print("- ensured plugin in config: {}".format(plugin_id), file=tty_out)
        print("- finance-comprehensive-report skill: {} ({})".format(skill["path"], skill["status"]), file=tty_out)
        print("- configured required providers: sec-edgar, finnhub, polygon, financial-modeling-prep", file=tty_out)
        if optional_configured:
            print("- configured optional providers: {}".format(", ".join(optional_configured)), file=tty_out)
        else:
            print("- configured optional providers: none", file=tty_out)
        print("", file=tty_out)
        print("Next step: run `opencode` and execute `/onboard`.", file=tty_out)
    finally:
        tty_in.close()
        tty_out.close()

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InstallError as error:
        print("error: {}".format(error), file=sys.stderr)
        raise SystemExit(1)
PY
