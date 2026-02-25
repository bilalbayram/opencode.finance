import fs from "fs/promises"
import path from "path"
import os from "os"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"

const app = "opencode"
const dot = ".opencode"
const files = ["opencode.jsonc", "opencode.json"] as const

const dataRoot = xdgData ?? path.join(os.homedir(), ".local", "share")
const cacheRoot = xdgCache ?? path.join(os.homedir(), ".cache")
const configRoot = xdgConfig ?? path.join(os.homedir(), ".config")
const stateRoot = xdgState ?? path.join(os.homedir(), ".local", "state")

const data = path.join(dataRoot, app)
const cache = path.join(cacheRoot, app)
const config = path.join(configRoot, app)
const state = path.join(stateRoot, app)

export namespace Global {
  export const App = {
    name: app,
    dot,
    files,
  }

  export const Path = {
    get home() {
      return os.homedir()
    },
    data,
    bin: path.join(data, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
  }
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.cache, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])
