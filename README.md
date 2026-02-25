# OpenCode Finance

Repository: https://github.com/bilalbayram/opencode.finance

This repository contains:
- `packages/opencode-finance`: OpenCode finance plugin package.
- `packages/web`: standalone marketing page deployed on Vercel.

## Setup

Run the one-shot installer:

```bash
curl -fsSL https://opencode.finance/install.sh | bash
```

It will:
- Install OpenCode if missing.
- Ensure `opencode-finance` is present in your OpenCode config `plugin` list.
- Migrate legacy `plugins` config key to canonical `plugin`.
- Prompt for finance credentials and write them to `~/.local/share/opencode/auth.json`.
- Install or update `finance-comprehensive-report` at `~/.opencode/skills/finance-comprehensive-report/SKILL.md`.

When `enabled_providers` is set in OpenCode config, `opencode-finance` auto-includes its finance auth provider IDs at runtime so they appear in `opencode auth login`. Explicit `disabled_providers` entries still hide them.

## Migration from a legacy fork

If this used to be the full `opencode-finance` fork, run:

```bash
bun run --cwd packages/opencode-finance migrate
```

It migrates auth credentials, portfolio holdings, and the `finance-comprehensive-report` skill.

## Development

```bash
bun install
bun run typecheck
bun run build
```

## Web marketing page

```bash
bun run --cwd packages/web dev
bun run --cwd packages/web build
bun run --cwd packages/web preview
```

## Plugin checks

```bash
bun run --cwd packages/opencode-finance typecheck
bun run --cwd packages/opencode-finance build
bun run --cwd packages/opencode-finance migrate
```

## Automated release

`main` pushes run `.github/workflows/release.yml`.

Release behavior:
- Publishes only when `packages/opencode-finance/package.json` version changes.
- Runs `bun install --frozen-lockfile`, `typecheck`, and `build` before publishing.
- Publishes `opencode-finance` to npm with trusted publishing (GitHub OIDC) and provenance.
- Creates Git tag `v<version>` and a GitHub release if missing.

Required npm setup:
- Configure npm trusted publishing for this repository/workflow in npm package settings.
- No `NPM_TOKEN` repository secret is used.

To trigger a new release, bump `packages/opencode-finance/package.json` version and push to `main`.
