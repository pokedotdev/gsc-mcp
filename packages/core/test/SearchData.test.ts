import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { PAGE_SIZE, type SearchAnalyticsRequest, SearchData } from "../src/index.ts"
import { fakeGsc } from "./fixtures.ts"

const setup = (totalRows: number) => {
  const requests: Array<SearchAnalyticsRequest> = []
  const layer = SearchData.layer.pipe(Layer.provide(fakeGsc({}, {
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

  it.effect("paginates until the API runs out of rows", () => {
    const { layer, requests } = setup(PAGE_SIZE + 10)
    return Effect.gen(function*() {
      const rows = yield* (yield* SearchData).queryAll(base, 100_000)
      assert.strictEqual(rows.length, PAGE_SIZE + 10)
      assert.deepStrictEqual(requests.map((r) => r.startRow), [0, PAGE_SIZE])
    }).pipe(Effect.provide(layer))
  })

  it.effect("stops at maxRows", () => {
    const { layer, requests } = setup(100_000)
    return Effect.gen(function*() {
      const rows = yield* (yield* SearchData).queryAll(base, 30_000)
      assert.strictEqual(rows.length, 30_000)
      assert.deepStrictEqual(requests.map((r) => [r.startRow, r.rowLimit]), [[0, PAGE_SIZE], [PAGE_SIZE, 5_000]])
    }).pipe(Effect.provide(layer))
  })
})
