import { Exporter, ExportError, ResultCache } from "@gsc-mcp/core"
import { Config, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import { KeyValueStore } from "effect/persistence"
import { CacheDir } from "./Paths.ts"

/** Exported files are deleted after a week. */
const EXPORT_MAX_AGE_MILLIS = 7 * 86_400_000
/** Longest time-to-live of cached results, plus a day of margin. */
const RESULT_MAX_AGE_MILLIS = 8 * 86_400_000

/** Writes exported tables to the cache directory, readable only by the user. */
export const FileExporter = Layer.effect(
  Exporter,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { exportsDir } = yield* CacheDir
    return Exporter.of({
      write: ({ name, content }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(exportsDir, { recursive: true, mode: 0o700 })
          const file = path.join(exportsDir, path.basename(name))
          yield* fs.writeFileString(file, content, { mode: 0o600 })
          return { path: file, bytes: new TextEncoder().encode(content).byteLength }
        }).pipe(Effect.mapError((error) => new ExportError({ message: `Could not write ${name}: ${error.message}` })))
    })
  })
)

/**
 * Durable result cache in files under the cache directory. Disabled with
 * GSC_MCP_DISK_CACHE=off.
 */
export const FileResultCache = Layer.unwrap(Effect.gen(function*() {
  const enabled = yield* Config.String("GSC_MCP_DISK_CACHE").pipe(Config.withDefault("on"))
  if (enabled === "off" || enabled === "false" || enabled === "0") return ResultCache.layerNone
  const fs = yield* FileSystem.FileSystem
  const { resultsDir } = yield* CacheDir
  yield* fs.makeDirectory(resultsDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore)
  return ResultCache.layerKeyValueStore.pipe(
    Layer.provide(KeyValueStore.layerFileSystem(resultsDir)),
    // A cache that cannot be opened must not stop the server.
    Layer.catch(() => ResultCache.layerNone)
  )
}))

/** Deletes files older than `maxAge` in a directory, ignoring errors. */
const pruneDirectory = (dir: string, maxAgeMillis: number) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (!(yield* fs.exists(dir))) return 0
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    let removed = 0
    for (const name of yield* fs.readDirectory(dir)) {
      const file = path.join(dir, name)
      const info = yield* fs.stat(file)
      const modified = Option.getOrUndefined(info.mtime)?.getTime() ?? now
      if (info.type === "File" && now - modified > maxAgeMillis) {
        yield* fs.remove(file)
        removed++
      }
    }
    return removed
  }).pipe(Effect.catch(() => Effect.succeed(0)))

/** Removes expired cache entries and old exports. */
export const pruneCache = Effect.gen(function*() {
  const { resultsDir, exportsDir } = yield* CacheDir
  const results = yield* pruneDirectory(resultsDir, RESULT_MAX_AGE_MILLIS)
  const exports = yield* pruneDirectory(exportsDir, EXPORT_MAX_AGE_MILLIS)
  return { results, exports }
})

/** Removes every cached result and exported file. */
export const clearCache = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const { dir } = yield* CacheDir
  if (yield* fs.exists(dir)) yield* fs.remove(dir, { recursive: true })
  return dir
})
