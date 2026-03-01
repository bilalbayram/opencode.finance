import fs from "fs/promises"
import path from "path"
import type { Tool } from "../tool"
import { assertExternalDirectory } from "../external-directory"
import { projectRoot } from "./project-root"

type WriteToolArtifactsInput = {
  ctx: Tool.Context
  outputRoot: string
  files: Record<string, string>
  archivePaths?: string[]
}

function stampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

async function archiveExistingArtifacts(outputRoot: string, paths: string[]) {
  if (paths.length === 0) return

  const existing: string[] = []
  for (const filepath of paths) {
    if (await Bun.file(filepath).exists()) {
      existing.push(filepath)
    }
  }

  if (existing.length === 0) return

  const historyRoot = path.join(outputRoot, "history", stampForPath())
  await fs.mkdir(historyRoot, { recursive: true })
  await Promise.all(existing.map((filepath) => fs.rename(filepath, path.join(historyRoot, path.basename(filepath)))))
}

export async function writeToolArtifacts(input: WriteToolArtifactsInput): Promise<Record<string, string>> {
  await assertExternalDirectory(input.ctx, input.outputRoot, { kind: "directory" })

  const filePaths = Object.fromEntries(
    Object.entries(input.files).map(([filename, content]) => [
      filename,
      {
        path: path.join(input.outputRoot, filename),
        content,
      },
    ]),
  )

  const worktree = projectRoot(input.ctx)
  const editPatterns = Object.values(filePaths).map((entry) => path.relative(worktree, entry.path))

  if (input.archivePaths && input.archivePaths.length > 0) {
    editPatterns.push(path.relative(worktree, path.join(input.outputRoot, "history", "*")))
  }

  await input.ctx.ask({
    permission: "edit",
    patterns: editPatterns,
    always: ["*"],
    metadata: {
      output_root: input.outputRoot,
      files: Object.fromEntries(Object.entries(filePaths).map(([name, value]) => [name, value.path])),
    },
  })

  await fs.mkdir(input.outputRoot, { recursive: true })
  await archiveExistingArtifacts(input.outputRoot, input.archivePaths ?? [])

  try {
    await Promise.all(Object.values(filePaths).map((entry) => Bun.write(entry.path, entry.content)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed writing artifacts to ${input.outputRoot}: ${message}`)
  }

  return Object.fromEntries(Object.entries(filePaths).map(([name, value]) => [name, value.path]))
}
