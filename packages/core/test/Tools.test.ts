import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  AccountStore,
  GscApiError,
  GscToolkit,
  GscToolkitHandlers,
  OutputBudget,
  ResultCache,
  type SearchAnalyticsRequest,
  type SearchAnalyticsRow,
  SearchData,
  SiteResolver
} from "../src/index.ts"
import { fakeGsc, makeAccount, memoryExporter } from "./fixtures.ts"

const calls: Array<{ account: string; siteUrl: string; request: SearchAnalyticsRequest }> = []
const inspected: Array<{ siteUrl: string; url: string }> = []
const files = new Map<string, string>()

const row = (keys: ReadonlyArray<string>, clicks: number, impressions: number, position: number): SearchAnalyticsRow => ({
  keys,
  clicks,
  impressions,
  ctr: clicks / impressions,
  position
})

const PAGES = [
  row(["https://example.com/blog/a/"], 10, 100, 2),
  row(["https://example.com/blog/a/?ref=x"], 2, 20, 3),
  row(["https://example.com/blog/page/2/"], 3, 60, 8),
  row(["http://example.com/old/"], 1, 10, 9)
]

const searchAnalytics = (request: SearchAnalyticsRequest) => {
  const previous = request.startDate < "2026-09-15"
  const dimensions = request.dimensions.join()
  if (dimensions === "") return [{ clicks: previous ? 10 : 17, impressions: 430, ctr: 0.04, position: 5.5 }]
  if (dimensions === "page") return PAGES
  if (dimensions === "device") return [row(["DESKTOP"], 5, 50, 3), row(["MOBILE"], 2, 30, 4)]
  if (dimensions === "date") {
    return [row(["2026-10-11"], 1, 10, 5), row(["2026-10-12"], 2, 10, 5), row(["2026-10-13"], 3, 30, 1)]
  }
  if (dimensions === "query,page") {
    return [
      row(["seo tools", "https://example.com/a"], 6, 200, 6),
      row(["seo tools", "https://example.com/b"], 4, 150, 8)
    ]
  }
  if (previous) return [row(["seo tools"], 20, 300, 4)]
  return [
    { keys: ["seo tools"], clicks: 12, impressions: 340, ctr: 0.035294, position: 6.4321 },
    { keys: ["seo audit"], clicks: 5, impressions: 90, ctr: 0.05555, position: 3.06 }
  ]
}

const layer = GscToolkitHandlers.pipe(
  Layer.provideMerge(Layer.mergeAll(SiteResolver.layer, SearchData.layer)),
  Layer.provide(ResultCache.layerNone),
  Layer.provide(memoryExporter(files)),
  Layer.provideMerge(fakeGsc(
    {
      personal: [
        { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        { siteUrl: "https://example.com/", permissionLevel: "siteOwner" }
      ]
    },
    {
      searchAnalytics: (account, siteUrl, request) => {
        calls.push({ account, siteUrl, request })
        // Respect pagination like the API does.
        const rows = searchAnalytics(request).slice(request.startRow, request.startRow + request.rowLimit)
        return Effect.succeed({ rows })
      },
      inspectUrl: (_account, siteUrl, url) => {
        inspected.push({ siteUrl, url })
        if (url.endsWith("/missing/")) return Effect.fail(new GscApiError({ status: 400, message: "URL not in property" }))
        if (url.endsWith("/noindex/")) {
          return Effect.succeed({
            indexStatusResult: {
              verdict: "NEUTRAL",
              coverageState: "Excluded by 'noindex' tag",
              indexingState: "BLOCKED_BY_META_TAG",
              lastCrawlTime: "2026-10-01T10:00:00Z"
            }
          })
        }
        return Effect.succeed({
          indexStatusResult: {
            verdict: "PASS",
            coverageState: "Submitted and indexed",
            indexingState: "INDEXING_ALLOWED",
            lastCrawlTime: "2026-10-10T10:00:00Z",
            googleCanonical: url,
            userCanonical: url
          }
        })
      },
      listSitemaps: () =>
        Effect.succeed([{
          path: "https://example.com/sitemap.xml",
          type: "sitemap",
          isSitemapsIndex: true,
          isPending: false,
          lastSubmitted: "2026-10-01T00:00:00Z",
          warnings: "1",
          errors: "0",
          contents: [{ type: "web", submitted: "120" }, { type: "image", submitted: "30" }]
        }])
    }
  )),
  Layer.provideMerge(AccountStore.layerMemory([makeAccount("personal")]))
)

const call = (name: keyof typeof GscToolkit.tools, params: unknown) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(Date.UTC(2026, 9, 15))
    const toolkit = yield* GscToolkit
    const result = yield* toolkit.handle(name, params as never).pipe(Stream.unwrap, Stream.runLast)
    return result._tag === "Some" ? result.value : undefined
  })

const output = (name: keyof typeof GscToolkit.tools, params: unknown) =>
  call(name, params).pipe(Effect.map((result) => result?.encodedResult as any))

describe("GscToolkit", () => {
  it.effect("search_analytics resolves the site and returns compact rows", () =>
    Effect.gen(function*() {
      const result = yield* call("search_analytics", { site: "example.com", dimensions: ["query"], limit: 2 })
      assert.isFalse(result?.isFailure)
      const out = result?.encodedResult as any
      assert.strictEqual(out.site, "sc-domain:example.com")
      assert.strictEqual(out.startDate, "2026-09-15")
      assert.strictEqual(out.endDate, "2026-10-12")
      assert.strictEqual(out.origin, "https://example.com")
      assert.deepStrictEqual(out.columns, ["query", "clicks", "impressions", "ctr_pct", "position"])
      assert.deepStrictEqual(out.rows, [["seo tools", 12, 340, 3.53, 6.4], ["seo audit", 5, 90, 5.56, 3.1]])
      // A full page may hide more rows: the response says how much traffic it holds.
      assert.isTrue(out.hasMore)
      assert.deepStrictEqual(out.coverage, { clicks_pct: 100, impressions_pct: 100 })
      assert.include(out.warning, "aggregate")
    }).pipe(Effect.provide(layer)))

  it.effect("search_analytics shows pages relative to the origin and accepts paths in filters", () =>
    Effect.gen(function*() {
      const out = yield* output("search_analytics", {
        site: "example.com",
        dimensions: ["page"],
        filters: [{ dimension: "page", operator: "equals", expression: "/blog/a/" }]
      })
      assert.deepStrictEqual(out.rows.map((r: Array<unknown>) => r[0]), [
        "/blog/a/",
        "/blog/a/?ref=x",
        "/blog/page/2/",
        "http://example.com/old/"
      ])
      assert.deepStrictEqual(calls.at(-1)?.request.filters, [
        { dimension: "page", operator: "equals", expression: "https://example.com/blog/a/" }
      ])
      assert.isFalse(out.hasMore)
      assert.isUndefined(out.coverage)

      const full = yield* output("search_analytics", { site: "example.com", dimensions: ["page"], fullUrls: true })
      assert.isUndefined(full.origin)
      assert.strictEqual(full.rows[0][0], "https://example.com/blog/a/")
    }).pipe(Effect.provide(layer)))

  it.effect("search_analytics cuts tables that exceed the output budget", () =>
    Effect.gen(function*() {
      const out = yield* output("search_analytics", { site: "example.com", dimensions: ["page"] }).pipe(
        Effect.provideService(OutputBudget, 40)
      )
      assert.strictEqual(out.rows.length, 1)
      assert.deepStrictEqual(
        { rows: out.truncated.rows, clicks: out.truncated.clicks, impressions: out.truncated.impressions },
        { rows: 3, clicks: 6, impressions: 90 }
      )
    }).pipe(Effect.provide(layer)))

  it.effect("search_analytics exports every row to a file with output file", () =>
    Effect.gen(function*() {
      const out = yield* output("search_analytics", {
        site: "example.com",
        dimensions: ["page"],
        output: "file",
        format: "tsv"
      })
      assert.strictEqual(out.file.rows, 4)
      assert.strictEqual(out.file.format, "tsv")
      const content = files.get(out.file.path.replace("/exports/", ""))!
      assert.strictEqual(content.split("\n")[0], "page\tclicks\timpressions\tctr_pct\tposition")
      assert.strictEqual(content.split("\n")[1], "/blog/a/\t10\t100\t10\t2")
    }).pipe(Effect.provide(layer)))

  it.effect("list_sites groups access by property", () =>
    Effect.gen(function*() {
      const result = yield* call("list_sites", {})
      assert.deepStrictEqual(result?.result, {
        sites: [
          { siteUrl: "https://example.com/", access: [{ account: "personal", permission: "siteOwner" }] },
          { siteUrl: "sc-domain:example.com", access: [{ account: "personal", permission: "siteOwner" }] }
        ],
        failures: []
      })
    }).pipe(Effect.provide(layer)))

  it.effect("returns domain errors as tool failures", () =>
    Effect.gen(function*() {
      const result = yield* call("search_analytics", { site: "unknown.com" }).pipe(Effect.flip)
      assert.strictEqual((result as { _tag: string })._tag, "SiteNotFound")
    }).pipe(Effect.provide(layer)))

  it.effect("aggregate groups pages with rewrites and reports coverage", () =>
    Effect.gen(function*() {
      const out = yield* output("aggregate", {
        site: "example.com",
        dimensions: ["page"],
        normalizePages: true,
        rewrites: [{ dimension: "page", pattern: "page/\\d+/$", replacement: "" }]
      })
      assert.deepStrictEqual(out.columns, ["page", "clicks", "impressions", "ctr_pct", "position", "rows"])
      // http:// is merged into https:// and therefore shown relative.
      assert.deepStrictEqual(out.rows, [
        ["/blog/", 3, 60, 5, 8, 1],
        ["/blog/a/", 12, 120, 10, 2.2, 2],
        ["/old/", 1, 10, 10, 9, 1]
      ].sort((a, b) => (b[1] as number) - (a[1] as number)))
      assert.deepStrictEqual(out.source, { rows: 4, complete: true, droppedRows: 0, clicks_coverage_pct: 94.1 })
      assert.strictEqual(out.groups, 3)
    }).pipe(Effect.provide(layer)))

  it.effect("aggregate rolls dates up and validates its options", () =>
    Effect.gen(function*() {
      const out = yield* output("aggregate", { site: "example.com", dimensions: ["date"], timeGrain: "week" })
      assert.deepStrictEqual(out.rows.map((r: Array<unknown>) => r.slice(0, 3)), [["2026-10-05", 1, 10], [
        "2026-10-12",
        5,
        40
      ]])
      const error = yield* call("aggregate", { site: "example.com", dimensions: ["page"], timeGrain: "week" }).pipe(
        Effect.flip
      )
      assert.strictEqual((error as { _tag: string })._tag, "InvalidInput")
    }).pipe(Effect.provide(layer)))

  it.effect("inspect_url omits fields Google did not return and prefers the domain property", () =>
    Effect.gen(function*() {
      const out = yield* output("inspect_url", { url: "https://example.com/page" })
      assert.strictEqual(out.site, "sc-domain:example.com")
      assert.strictEqual(out.verdict, "PASS")
      assert.notProperty(out, "sitemaps")
      const path = yield* output("inspect_url", { url: "/page", site: "example.com" })
      assert.strictEqual(path.url, "https://example.com/page")
    }).pipe(Effect.provide(layer)))

  it.effect("inspect_urls flags issues, reuses cached inspections and reports failures", () =>
    Effect.gen(function*() {
      const before = inspected.length
      const out = yield* output("inspect_urls", {
        site: "example.com",
        urls: ["/ok/", "/noindex/", "/missing/", "/ok/"]
      })
      assert.deepStrictEqual(out.summary, { "Submitted and indexed": 2, "Excluded by 'noindex' tag": 1 })
      assert.deepStrictEqual(out.rows[0], [
        "/ok/",
        "PASS",
        "Submitted and indexed",
        "INDEXING_ALLOWED",
        "2026-10-10",
        "=",
        "=",
        ""
      ])
      assert.strictEqual(out.rows[1][7], "Excluded by 'noindex' tag; noindex (BLOCKED_BY_META_TAG)")
      assert.deepStrictEqual(out.failures, [{ url: "/missing/", message: "URL not in property" }])
      // The repeated URL is inspected once.
      assert.strictEqual(inspected.length - before, 3)
    }).pipe(Effect.provide(layer)))

  it.effect("compare_periods returns totals and the biggest changes", () =>
    Effect.gen(function*() {
      const out = yield* output("compare_periods", { site: "example.com", dimension: "query", limit: 1 })
      assert.deepStrictEqual(out.totals, {
        current: { clicks: 17, impressions: 430, ctr_pct: 4, position: 5.5 },
        previous: { clicks: 10, impressions: 430, ctr_pct: 4, position: 5.5 }
      })
      assert.strictEqual(out.previousEndDate, "2026-09-14")
      // "seo tools" lost 8 clicks, larger than the 5 clicks of the new "seo audit".
      assert.deepStrictEqual(out.changes.rows, [["seo tools", 12, 20, -8, 340, 300, 3.53, 6.67, 6.4, 4, 2.4]])
    }).pipe(Effect.provide(layer)))

  it.effect("compare_periods compares groups built with rewrites", () =>
    Effect.gen(function*() {
      const out = yield* output("compare_periods", {
        site: "example.com",
        dimension: "query",
        rewrites: [{ dimension: "query", pattern: "^seo", unmatched: "other" }]
      })
      assert.deepStrictEqual(out.changes.rows.map((r: Array<unknown>) => r.slice(0, 4)), [["seo", 17, 20, -3]])
    }).pipe(Effect.provide(layer)))

  it.effect("detect_cannibalization groups competing pages per query", () =>
    Effect.gen(function*() {
      const out = yield* output("detect_cannibalization", { site: "example.com" })
      assert.strictEqual(out.queries.length, 1)
      assert.strictEqual(out.queries[0].query, "seo tools")
      assert.deepStrictEqual(out.queries[0].pages.rows.map((r: Array<unknown>) => r[0]), ["/a", "/b"])
    }).pipe(Effect.provide(layer)))

  it.effect("page_report explains breakdowns that miss anonymized queries", () =>
    Effect.gen(function*() {
      const out = yield* output("page_report", { url: "https://example.com/blog/a/" })
      assert.strictEqual(out.site, "sc-domain:example.com")
      assert.strictEqual(out.url, "/blog/a/")
      assert.deepStrictEqual(out.breakdownCoverage, { clicks_pct: 41.2, impressions_pct: 18.6 })
      assert.include(out.note, "anonymized")
      assert.isUndefined(out.pages)
    }).pipe(Effect.provide(layer)))

  it.effect("page_report covers a section with match prefix", () =>
    Effect.gen(function*() {
      const out = yield* output("page_report", { url: "/blog/", site: "example.com", match: "prefix", limit: 5 })
      assert.deepStrictEqual(calls.at(-1)?.request.filters, [
        { dimension: "page", operator: "includingRegex", expression: "^https://example\\.com/blog/" }
      ])
      assert.strictEqual(out.pages.rows.length, 4)
      const error = yield* call("page_report", { url: "/blog/" }).pipe(Effect.flip)
      assert.strictEqual((error as { _tag: string })._tag, "InvalidInput")
    }).pipe(Effect.provide(layer)))

  it.effect("query_report splits a query among pages", () =>
    Effect.gen(function*() {
      const out = yield* output("query_report", { site: "example.com", query: "seo tools" })
      assert.deepStrictEqual(calls.at(-1)?.request.filters, [
        { dimension: "query", operator: "equals", expression: "seo tools" }
      ])
      assert.deepStrictEqual(out.pages.columns.slice(-2), ["clicks_share_pct", "impressions_share_pct"])
      // Pages with ?ref=x stay separate; fragments would be merged.
      assert.deepStrictEqual(out.pages.rows[0], ["/blog/a/", 10, 100, 10, 2, 62.5, 52.6])
      assert.isUndefined(out.queries)
    }).pipe(Effect.provide(layer)))

  it.effect("list_sitemaps returns a compact table", () =>
    Effect.gen(function*() {
      const out = yield* output("list_sitemaps", { site: "example.com" })
      assert.deepStrictEqual(out.rows, [["/sitemap.xml", "sitemap", "true", "false", "2026-10-01", null, 150, 1, 0]])
    }).pipe(Effect.provide(layer)))
})
