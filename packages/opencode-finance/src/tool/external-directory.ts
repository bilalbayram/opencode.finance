import path from "path"
import type { Tool } from "./tool"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

function projectWorktree(context: Pick<Tool.Context, "directory" | "worktree">) {
  return context.worktree === "/" ? context.directory : context.worktree
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  const worktree = projectWorktree(ctx)
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
