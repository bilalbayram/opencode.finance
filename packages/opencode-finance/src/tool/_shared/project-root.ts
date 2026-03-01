import type { Tool } from "../tool"

export function projectRoot(context: Pick<Tool.Context, "directory" | "worktree">) {
  return context.worktree === "/" ? context.directory : context.worktree
}
