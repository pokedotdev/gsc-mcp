import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AccountStore, GscToolkit, GscToolkitHandlers, type SearchAnalyticsRequest, SearchData, SiteResolver } from "../src/index.ts"
import { fakeGsc, makeAccount } from "./fixtures.ts"

const calls: Array<{ account: string; siteUrl: string; request: SearchAnalyticsRequest }> = []

const layer = GscToolkitHandlers.pipe(
  Layer.provideMerge(Layer.mergeAll(SiteResolver.layer, SearchData.layer)),
  Layer.provideMerge(fakeGsc(
    { personal: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
    {
      searchAnalytics: (account, siteUrl, request) => {
        calls.push({ account, siteUrl, request })
        if (request.dimensions.length === 0) {
          const previous = request.startDate < "2026-09-15"
          return Effect.succeed({ rows: [{ clicks: previous ? 10 : 17, impressions: 430, ctr: 0.04, position: 5.5 }] })
        }
        if (request.dimensions.join() === "query,page") {
          return Effect.succeed({
            rows: [
              { keys: ["seo tools", "https://example.com/a"], clicks: 6, impressions: 200, ctr: 0.03, position: 6 },
              { keys: ["seo tools", "https://example.com/b"], clicks: 4, impressions: 150, ctr: 0.027, position: 8 }
            ]
          })
        }
        if (request.startDate < "2026-09-15") {
          return Effect.succeed({ rows: [{ keys: ["seo tools"], clicks: 20, impressions: 300, ctr: 0.0667, position: 4 }] })
        }
        return Effect.succeed({
          rows: [
            { keys: ["seo tools"], clicks: 12, impressions: 340, ctr: 0.035294, position: 6.4321 },
            { keys: ["seo audit"], clicks: 5, impressions: 90, ctr: 0.05555, position: 3.06 }
          ]
        })
      },
      inspectUrl: () => Effect.succeed({ indexStatusResult: { verdict: "PASS" } })
    }
  )),
  Layer.provideMerge(AccountStore.layerMemory([makeAccount("personal")]))
)

const call = (name: keyof typeof GscToolkit.tools, params: unknown) =>
  Effect.gen(function*() {
    const toolkit = yield* GscToolkit
    const result = yield* toolkit.handle(name, params as never).pipe(Stream.unwrap, Stream.runLast)
    return result._tag === "Some" ? result.value : undefined
  })

describe("GscToolkit", () => {
  it.effect("search_analytics resolves the site and returns compact rows", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.UTC(2026, 9, 15))
      const result = yield* call("search_analytics", { site: "https://example.com/", dimensions: ["query"], limit: 2 })
      assert.isFalse(result?.isFailure)
      assert.deepStrictEqual(result?.result, {
        site: "sc-domain:example.com",
        account: "personal",
        startDate: "2026-09-15",
        endDate: "2026-10-12",
        columns: ["query", "clicks", "impressions", "ctr_pct", "position"],
        rows: [["seo tools", 12, 340, 3.53, 6.4], ["seo audit", 5, 90, 5.56, 3.1]],
        hasMore: true
      })
      assert.strictEqual(calls.at(-1)?.request.rowLimit, 2)
      assert.strictEqual(calls.at(-1)?.request.type, "web")
    }).pipe(Effect.provide(layer)))

  it.effect("list_sites groups access by property", () =>
    Effect.gen(function*() {
      const result = yield* call("list_sites", {})
      assert.deepStrictEqual(result?.result, {
        sites: [{ siteUrl: "sc-domain:example.com", access: [{ account: "personal", permission: "siteOwner" }] }],
        failures: []
      })
    }).pipe(Effect.provide(layer)))

  it.effect("returns domain errors as tool failures", () =>
    Effect.gen(function*() {
      const result = yield* call("search_analytics", { site: "unknown.com" }).pipe(Effect.flip)
      assert.strictEqual((result as { _tag: string })._tag, "SiteNotFound")
    }).pipe(Effect.provide(layer)))

  it.effect("inspect_url omits fields Google did not return", () =>
    Effect.gen(function*() {
      const result = yield* call("inspect_url", { url: "https://example.com/page" })
      assert.deepStrictEqual(result?.encodedResult, {
        site: "sc-domain:example.com",
        account: "personal",
        url: "https://example.com/page",
        verdict: "PASS"
      })
    }).pipe(Effect.provide(layer)))

  it.effect("compare_periods returns totals and the biggest changes", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.UTC(2026, 9, 15))
      const result = yield* call("compare_periods", { site: "example.com", dimension: "query", limit: 1 })
      const output = result?.encodedResult as any
      assert.deepStrictEqual(output.totals, {
        current: { clicks: 17, impressions: 430, ctr_pct: 4, position: 5.5 },
        previous: { clicks: 10, impressions: 430, ctr_pct: 4, position: 5.5 }
      })
      assert.strictEqual(output.previousEndDate, "2026-09-14")
      // "seo tools" lost 8 clicks, larger than the 5 clicks of the new "seo audit".
      assert.deepStrictEqual(output.changes.rows, [["seo tools", 12, 20, -8, 340, 300, 3.53, 6.67, 6.4, 4, 2.4]])
    }).pipe(Effect.provide(layer)))

  it.effect("detect_cannibalization groups competing pages per query", () =>
    Effect.gen(function*() {
      const result = yield* call("detect_cannibalization", { site: "example.com" })
      const output = result?.encodedResult as any
      assert.strictEqual(output.queries.length, 1)
      assert.strictEqual(output.queries[0].query, "seo tools")
      assert.deepStrictEqual(output.queries[0].pages.rows.map((r: Array<unknown>) => r[0]), [
        "https://example.com/a",
        "https://example.com/b"
      ])
    }).pipe(Effect.provide(layer)))
})
