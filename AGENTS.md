# AGENTS.md

## Project Scope
- This repository contains:
- `packages/opencode-finance` as the OpenCode finance plugin package.
- `packages/web` as the standalone marketing page package.
- Plugin work is scoped to `packages/opencode-finance`.
- Web marketing page work is scoped to `packages/web`.

## Tooling
- Use **Bun** for dependency management, execution, and scripts.
- Install dependencies from the repo root with `bun install`.

## Commands
- `bun run --cwd packages/opencode-finance typecheck`
  Run strict TypeScript checks for the plugin.
- `bun run --cwd packages/opencode-finance build`
  Build the plugin output.
- `bun run --cwd packages/opencode-finance migrate`
  Run the finance migration helper for users moving from legacy forks.
- `bun run --cwd packages/web dev`
  Run the marketing page locally.
- `bun run --cwd packages/web build`
  Build the marketing page output.

## Coding Standards
- TypeScript uses ESM and strict options from `packages/opencode-finance/tsconfig.json`.
- Prefer explicit types for public APIs and plugin interfaces.
- Keep existing conventions for imports and exports in plugin code.
- Handle required runtime dependencies explicitly; do not add hidden fallback paths.
- Never implement silent recovery for missing required functionality: fail loudly with clear errors.
- Keep changes small and focused; prefer minimal public surface.

## Plugin Architecture Notes
- Primary entry: `packages/opencode-finance/src/index.ts`.
- Treat authentication providers, slash-command behavior, and report tooling as feature-critical paths.
- Run-throughs that generate artifacts must keep existing output folders and filenames stable (`reports/` under the project root/worktree).
- Plugin setup requirements must remain explicit in runtime errors/messages.

## Release/Validation
- Use `bun run --cwd packages/opencode-finance typecheck` before changes are considered complete.
- Use `bun run --cwd packages/web build` before changes are considered complete when web files are touched.
- Keep `AGENTS.md` and `README.md` aligned when changing plugin usage, setup, or auth requirements.
