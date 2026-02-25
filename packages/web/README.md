# @opencode-ai/web

Static marketing site for opencode-finance.

Installer script is served from `public/install.sh` as:

```bash
curl -fsSL https://opencode.finance/install.sh | bash
```

It installs OpenCode when missing, configures `opencode-finance`, stores auth credentials, and installs/updates `finance-comprehensive-report` in `~/.opencode/skills`.

## Commands

```bash
bun run --cwd packages/web dev
bun run --cwd packages/web build
bun run --cwd packages/web preview
```
