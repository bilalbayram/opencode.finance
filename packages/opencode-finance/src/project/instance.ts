import path from "path"

type State = {
  directory: string
  worktree: string
}

const current: State = {
  directory: process.cwd(),
  worktree: process.cwd(),
}

function normalize(input: string) {
  return path.normalize(path.resolve(input))
}

export namespace Instance {
  export let directory = current.directory
  export let worktree = current.worktree

  export function set(input: { directory: string; worktree: string }) {
    current.directory = normalize(input.directory)
    current.worktree = normalize(input.worktree)
    directory = current.directory
    worktree = current.worktree
  }

  export const project = {
    vcs: "git" as const,
  }

  export const state = async <T>(body: () => Promise<T> | T) => {
    return body()
  }

  export const provide = async <T>(input: { directory: string; fn: () => Promise<T> }) => {
    const prev = { ...current }
    const prevExport = { directory, worktree }
    current.directory = normalize(input.directory)
    current.worktree = normalize(input.directory)
    directory = current.directory
    worktree = current.worktree
    try {
      return await input.fn()
    } finally {
      current.directory = prev.directory
      current.worktree = prev.worktree
      directory = prevExport.directory
      worktree = prevExport.worktree
    }
  }

  export function containsPath(target: string) {
    const absolute = normalize(target)
    if (current.worktree === path.parse(current.worktree).root) return false
    const relative = path.relative(current.worktree, absolute)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

}
