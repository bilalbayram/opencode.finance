# AGENTS.md

## Project Scope
- This repository is an **OpenCode plugin package repository** with runtime source in `packages/opencode-finance`.
- Plugin work is scoped to `packages/opencode-finance`.

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
- Keep `AGENTS.md` and `README.md` aligned when changing plugin usage, setup, or auth requirements.
