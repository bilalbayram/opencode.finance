# OpenCode Finance Plugin

This repository contains only the `opencode-finance` plugin package for OpenCode.

## Setup

1. Install OpenCode.

```bash
curl -fsSL https://opencode.ai/install.sh | bash
```

2. Enable the plugin in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-finance"]
}
```

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
- Publishes `opencode-finance` to npm using Bun.
- Creates Git tag `v<version>` and a GitHub release if missing.

Required repository secret:
- `NPM_TOKEN` with publish access to the `opencode-finance` package.

To trigger a new release, bump `packages/opencode-finance/package.json` version and push to `main`.
