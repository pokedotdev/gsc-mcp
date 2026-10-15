import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { resolveDateRange } from "../src/index.ts"

const today = Date.UTC(2026, 9, 15, 12)

describe("resolveDateRange", () => {
  it.effect("defaults to the last 28 days with finalized data", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(today)
      assert.deepStrictEqual(yield* resolveDateRange({}), { startDate: "2026-09-15", endDate: "2026-10-12" })
    }))

  it.effect("supports presets", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(today)
      assert.deepStrictEqual(yield* resolveDateRange({ range: "last7d" }), {
        startDate: "2026-10-06",
        endDate: "2026-10-12"
      })
    }))

  it.effect("accepts explicit dates", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(today)
      assert.deepStrictEqual(yield* resolveDateRange({ startDate: "2026-01-01" }), {
        startDate: "2026-01-01",
        endDate: "2026-10-12"
      })
    }))

  it.effect("rejects invalid input", () =>
    Effect.gen(function*() {
      const mixed = yield* resolveDateRange({ range: "last7d", startDate: "2026-01-01" }).pipe(Effect.flip)
      assert.strictEqual(mixed._tag, "InvalidInput")
      const reversed = yield* resolveDateRange({ startDate: "2026-02-01", endDate: "2026-01-01" }).pipe(Effect.flip)
      assert.strictEqual(reversed._tag, "InvalidInput")
      const malformed = yield* resolveDateRange({ startDate: "01/02/2026" }).pipe(Effect.flip)
      assert.strictEqual(malformed._tag, "InvalidInput")
    }))
})
