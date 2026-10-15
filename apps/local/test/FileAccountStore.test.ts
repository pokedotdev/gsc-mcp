import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Account, AccountStore } from "@gsc-mcp/core"
import { ConfigProvider, Effect, FileSystem, Layer, Redacted } from "effect"
import { statSync } from "node:fs"
import { FileAccountStore } from "../src/FileAccountStore.ts"
import { ConfigDir } from "../src/Paths.ts"

const account = new Account({
  alias: "personal",
  email: "me@example.com",
  refreshToken: Redacted.make("secret-refresh-token"),
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  createdAt: "2026-10-15T00:00:00.000Z"
})

describe("FileAccountStore", () => {
  it.effect("round-trips accounts through a private JSON file", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const layer = FileAccountStore.pipe(
        Layer.provideMerge(ConfigDir.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GSC_MCP_CONFIG_DIR: `${dir}/gsc-mcp` })))
      )
      yield* Effect.gen(function*() {
        const store = yield* AccountStore
        const { accountsFile } = yield* ConfigDir
        assert.deepStrictEqual(yield* store.list, [])

        yield* store.upsert(account)
        const loaded = yield* store.get("personal")
        assert.strictEqual(loaded.email, "me@example.com")
        assert.strictEqual(Redacted.value(loaded.refreshToken), "secret-refresh-token")
        assert.strictEqual(statSync(accountsFile).mode & 0o777, 0o600)

        yield* store.remove("personal")
        assert.deepStrictEqual(yield* store.list, [])
        const error = yield* store.remove("personal").pipe(Effect.flip)
        assert.strictEqual(error._tag, "AccountNotFound")
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
