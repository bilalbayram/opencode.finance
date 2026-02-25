export namespace Env {
  export function get(key: string) {
    return process.env[key]
  }

  export function all() {
    return process.env
  }
}
