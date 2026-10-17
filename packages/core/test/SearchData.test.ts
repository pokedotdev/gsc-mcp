import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/persistence"
import { TestClock } from "effect/testing"
import { durableTimeToLive, PAGE_SIZE, ResultCache, type SearchAnalyticsRequest, SearchData } from "../src/index.ts"
import { fakeGsc } from "./fixtures.ts"

const setup = <R = never>(
  totalRows: number,
  durable: Layer.Layer<ResultCache, never, R> = ResultCache.layerNone as Layer.Layer<ResultCache, never, R>
) => {
  const requests: Array<SearchAnalyticsRequest> = []
  const layer = SearchData.layer.pipe(Layer.provide(durable), Layer.provide(fakeGsc({}, {
    searchAnalytics: (_account, _siteUrl, request) => {
      requests.push(request)
      const count = Math.max(0, Math.min(request.rowLimit, totalRows - request.startRow))
      return Effect.succeed({
        rows: Array.from({ length: count }, (_, i) => ({
          keys: [`q${request.startRow + i}`],
          clicks: 1,
          impressions: 1,
          ctr: 1,
          position: 1
        }))
      })
    }
  })))
  return { requests, layer }
}

const base = {
  account: "personal",
  siteUrl: "sc-domain:example.com",
  request: {
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    dimensions: ["query"],
    type: "web",
    filters: [],
    dataState: "final"
  }
} as const

describe("SearchData", () => {
  it.effect("serves identical queries from the cache", () => {
    const { layer, requests } = setup(10)
    return Effect.gen(function*() {
      const data = yield* SearchData
      const query = { ...base, request: { ...base.request, rowLimit: 5, startRow: 0 } }
      yield* data.query(query)
      yield* data.query(query)
      assert.strictEqual(requests.length, 1)
      yield* data.query({ ...query, request: { ...query.request, rowLimit: 6 } })
      assert.strictEqual(requests.length, 2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("paginates until the API runs out of rows, requesting pages in parallel", () => {
    const { layer, requests } = setup(PAGE_SIZE + 10)
    return Effect.gen(function*() {
      const rows = yield* (yield* SearchData).queryAll(base, 100_000)
      assert.strictEqual(rows.length, PAGE_SIZE + 10)
      // After a full first page, the next batch of pages is requested at once.
      assert.deepStrictEqual(requests.map((r) => r.startRow), [0, PAGE_SIZE, 2 * PAGE_SIZE, 3 * PAGE_SIZE])
      assert.deepStrictEqual(rows.at(-1)?.keys, [`q${PAGE_SIZE + 9}`])
    }).pipe(Effect.provide(layer))
  })

  it.effect("starts at startRow", () => {
    const { layer, requests } = setup(100)
    return Effect.gen(function*() {
      const rows = yield* (yield* SearchData).queryAll(base, 10, 50)
      assert.deepStrictEqual(rows[0]?.keys, ["q50"])
      assert.deepStrictEqual(requests.map((r) => [r.startRow, r.rowLimit]), [[50, 10]])
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps finalized results in the durable cache across instances", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.UTC(2026, 2, 1))
      const query = { ...base, request: { ...base.request, rowLimit: 5, startRow: 0 } }
      const run = (layer: Layer.Layer<SearchData, never, KeyValueStore.KeyValueStore>) =>
        Effect.gen(function*() {
          return yield* (yield* SearchData).query(query)
        }).pipe(Effect.provide(layer))
      const first = setup(10, ResultCache.layerKeyValueStore)
      const rows = yield* run(first.layer)
      assert.strictEqual(first.requests.length, 1)
      // A new in-memory cache over the same store is served from storage.
      const second = setup(10, ResultCache.layerKeyValueStore)
      assert.deepStrictEqual(yield* run(second.layer), rows)
      assert.strictEqual(second.requests.length, 0)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))

  it.effect("stops at maxRows", () => {
    const { layer, requests } = setup(100_000)
    return Effect.gen(function*() {
      const rows = yield* (yield* SearchData).queryAll(base, 30_000)
      assert.strictEqual(rows.length, 30_000)
      assert.deepStrictEqual(requests.map((r) => [r.startRow, r.rowLimit]), [[0, PAGE_SIZE], [PAGE_SIZE, 5_000]])
    }).pipe(Effect.provide(layer))
  })

  it("only persists finalized data of past days", () => {
    const request = { ...base.request, rowLimit: 5, startRow: 0 }
    const now = Date.UTC(2026, 1, 20)
    assert.strictEqual(durableTimeToLive(request, now), 7 * 86_400_000)
    assert.strictEqual(durableTimeToLive({ ...request, endDate: "2026-02-16" }, now), 6 * 3_600_000)
    assert.strictEqual(durableTimeToLive({ ...request, endDate: "2026-02-19" }, now), undefined)
    assert.strictEqual(durableTimeToLive({ ...request, dataState: "all" }, now), undefined)
  })
})
