import { Config, Context, Effect, Layer, Path } from "effect"
import { homedir } from "node:os"

/** Location of the local configuration directory (XDG aware). */
export class ConfigDir extends Context.Service<ConfigDir, {
  readonly dir: string
  readonly accountsFile: string
  readonly clientFile: string
}>()("gsc-mcp/local/ConfigDir") {
  static readonly layer = Layer.effect(
    ConfigDir,
    Effect.gen(function*() {
      const path = yield* Path.Path
      const override = yield* Config.option(Config.String("GSC_MCP_CONFIG_DIR"))
      const xdg = yield* Config.option(Config.String("XDG_CONFIG_HOME"))
      const dir = override._tag === "Some"
        ? override.value
        : path.join(xdg._tag === "Some" ? xdg.value : path.join(homedir(), ".config"), "gsc-mcp")
      return ConfigDir.of({
        dir,
        accountsFile: path.join(dir, "accounts.json"),
        clientFile: path.join(dir, "client.json")
      })
    })
  )
}

/** Location of cached Search Console results and exported files (XDG aware). */
export class CacheDir extends Context.Service<CacheDir, {
  readonly dir: string
  readonly resultsDir: string
  readonly exportsDir: string
}>()("gsc-mcp/local/CacheDir") {
  static readonly layer = Layer.effect(
    CacheDir,
    Effect.gen(function*() {
      const path = yield* Path.Path
      const override = yield* Config.option(Config.String("GSC_MCP_CACHE_DIR"))
      const xdg = yield* Config.option(Config.String("XDG_CACHE_HOME"))
      const dir = override._tag === "Some"
        ? override.value
        : path.join(xdg._tag === "Some" ? xdg.value : path.join(homedir(), ".cache"), "gsc-mcp")
      return CacheDir.of({
        dir,
        resultsDir: path.join(dir, "results"),
        exportsDir: path.join(dir, "exports")
      })
    })
  )
}
