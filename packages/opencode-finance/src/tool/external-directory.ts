import path from "path"
import type { Tool } from "./tool"
import { projectRoot } from "./_shared/project-root"

type Kind = "file" | "directory"
type Options = {
  bypass?: boolean
  kind?: Kind
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  const worktree = projectRoot(ctx)
  const absolute = path.resolve(target)
  const relative = path.relative(worktree, absolute)

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return

  const kind = options?.kind ?? "file"
  const parentDir = kind === "directory" ? target : path.dirname(target)
  const glob = path.join(parentDir, "*")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: target,
      parentDir,
    },
  })
}
