import path from "path"
import fs from "fs/promises"
import { Global } from "../global"

export namespace Storage {
  export class NotFoundError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "NotFoundError"
    }
  }

  const root = path.join(Global.Path.data, "storage")

  function target(key: string[]) {
    return path.join(root, ...key) + ".json"
  }

  async function ensure(filepath: string) {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
  }

  export async function read<T>(key: string[]) {
    const filepath = target(key)
    return Bun.file(filepath)
      .json()
      .then((value) => value as T)
      .catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new NotFoundError(`Resource not found: ${filepath}`)
        }
        throw error
      })
  }

  export async function write<T>(key: string[], value: T) {
    const filepath = target(key)
    await ensure(filepath)
    await Bun.write(filepath, JSON.stringify(value, null, 2))
  }

  export async function remove(key: string[]) {
    const filepath = target(key)
    await fs.rm(filepath, { force: true })
  }
}
