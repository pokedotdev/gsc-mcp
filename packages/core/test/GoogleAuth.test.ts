import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { AccountStore, GoogleAuth } from "../src/index.ts"
import { fakeOAuth, makeAccount } from "./fixtures.ts"

describe("GoogleAuth", () => {
  const setup = () => {
    const refreshes = { count: 0 }
    const layer = GoogleAuth.layer.pipe(
      Layer.provide([fakeOAuth(refreshes), AccountStore.layerMemory([makeAccount("personal")])])
    )
    return { refreshes, layer }
  }

  it.effect("caches access tokens until shortly before they expire", () => {
    const { layer, refreshes } = setup()
    return Effect.gen(function*() {
      const auth = yield* GoogleAuth
      const first = yield* auth.accessToken("personal")
      const second = yield* auth.accessToken("personal")
      assert.strictEqual(Redacted.value(first), Redacted.value(second))
      assert.strictEqual(refreshes.count, 1)

      yield* TestClock.adjust("3570 seconds")
      yield* auth.accessToken("personal")
      assert.strictEqual(refreshes.count, 2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refreshes concurrent requests only once", () => {
    const { layer, refreshes } = setup()
    return Effect.gen(function*() {
      const auth = yield* GoogleAuth
      yield* Effect.all(Array.from({ length: 5 }, () => auth.accessToken("personal")), { concurrency: "unbounded" })
      assert.strictEqual(refreshes.count, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refreshes again after invalidation", () => {
    const { layer, refreshes } = setup()
    return Effect.gen(function*() {
      const auth = yield* GoogleAuth
      yield* auth.accessToken("personal")
      yield* auth.invalidate("personal")
      yield* auth.accessToken("personal")
      assert.strictEqual(refreshes.count, 2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails for unknown accounts", () => {
    const { layer } = setup()
    return Effect.gen(function*() {
      const error = yield* (yield* GoogleAuth).accessToken("nope").pipe(Effect.flip)
      assert.strictEqual(error._tag, "AccountNotFound")
    }).pipe(Effect.provide(layer))
  })
})
