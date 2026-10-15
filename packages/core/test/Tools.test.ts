import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AccountStore, GscToolkit, GscToolkitHandlers, type SearchAnalyticsRequest, SiteResolver } from "../src/index.ts"
import { fakeGsc, makeAccount } from "./fixtures.ts"

const calls: Array<{ account: string; siteUrl: string; request: SearchAnalyticsRequest }> = []

const layer = GscToolkitHandlers.pipe(
  Layer.provideMerge(SiteResolver.layer),
  Layer.provideMerge(fakeGsc(
    { personal: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
    {
      searchAnalytics: (account, siteUrl, request) => {
        calls.push({ account, siteUrl, request })
        return Effect.succeed({
          rows: [
            { keys: ["seo tools"], clicks: 12, impressions: 340, ctr: 0.035294, position: 6.4321 },
            { keys: ["seo audit"], clicks: 5, impressions: 90, ctr: 0.05555, position: 3.06 }
          ]
        })
      }
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
})
