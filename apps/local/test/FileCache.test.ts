import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Exporter, ResultCache } from "@gsc-mcp/core"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"
import { statSync, utimesSync } from "node:fs"
import { clearCache, FileExporter, FileResultCache, pruneCache } from "../src/FileCache.ts"
import { CacheDir } from "../src/Paths.ts"

const withCacheDir = (dir: string, env: Record<string, string> = {}) =>
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GSC_MCP_CACHE_DIR: `${dir}/gsc-mcp`, ...env })))

const row = { keys: ["seo"], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }

describe("FileCache", () => {
  it.effect("exports files readable only by the user and prunes old ones", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const layer = FileExporter.pipe(Layer.provideMerge(CacheDir.layer), withCacheDir(dir))
      yield* Effect.gen(function*() {
        const file = yield* (yield* Exporter).write({ name: "../escape.csv", content: "a,b\n" })
        const { exportsDir } = yield* CacheDir
        // Names cannot leave the exports directory.
        assert.strictEqual(file.path, `${exportsDir}/escape.csv`)
        assert.strictEqual(file.bytes, 4)
        assert.strictEqual(statSync(file.path).mode & 0o777, 0o600)

        yield* TestClock.setTime(Date.now())
        const old = Date.now() / 1000 - 8 * 86_400
        utimesSync(file.path, old, old)
        assert.deepStrictEqual(yield* pruneCache, { results: 0, exports: 1 })
        assert.isFalse(yield* fs.exists(file.path))
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("persists results in files and can be disabled or cleared", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const enabled = FileResultCache.pipe(Layer.provideMerge(CacheDir.layer), withCacheDir(dir))
      yield* Effect.gen(function*() {
        yield* (yield* ResultCache).set("key", [row], 60_000)
      }).pipe(Effect.provide(enabled))
      // A new instance reads what the previous one stored.
      const stored = yield* Effect.gen(function*() {
        return yield* (yield* ResultCache).get("key")
      }).pipe(Effect.provide(enabled))
      assert.deepStrictEqual(stored, [row])

      const disabled = FileResultCache.pipe(Layer.provideMerge(CacheDir.layer), withCacheDir(dir, { GSC_MCP_DISK_CACHE: "off" }))
      const missing = yield* Effect.gen(function*() {
        return yield* (yield* ResultCache).get("key")
      }).pipe(Effect.provide(disabled))
      assert.isUndefined(missing)

      const cleared = yield* clearCache.pipe(Effect.provide(CacheDir.layer.pipe(withCacheDir(dir))))
      assert.isFalse(yield* fs.exists(cleared))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
