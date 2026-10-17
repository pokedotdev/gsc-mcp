import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  aggregateRows,
  compileFilters,
  compileRewrite,
  fitRows,
  normalizePage,
  OTHER_KEY,
  serializeTable,
  timeBucket,
  urlDisplay
} from "../src/index.ts"

const display = urlDisplay("https://example.com", false)

describe("urlDisplay", () => {
  it("shows pages of the main origin as paths and keeps other origins absolute", () => {
    assert.strictEqual(display.show("https://example.com/blog/"), "/blog/")
    assert.strictEqual(display.show("http://example.com/blog/"), "http://example.com/blog/")
    assert.strictEqual(display.show("https://shop.example.com/"), "https://shop.example.com/")
    assert.strictEqual(display.expand("/blog/"), "https://example.com/blog/")
    assert.strictEqual(urlDisplay("https://example.com", true).show("https://example.com/a"), "https://example.com/a")
  })

  it("merges page variants", () => {
    assert.strictEqual(normalizePage("http://example.com/a/?utm=1#top"), "https://example.com/a/")
  })
})

describe("compileFilters", () => {
  it.effect("expands in, relative pages and regexes anchored at a path", () =>
    Effect.gen(function*() {
      const filters = yield* compileFilters([
        { dimension: "query", operator: "in", values: ["seo", "a.b"] },
        { dimension: "page", operator: "notIn", values: ["/x"] },
        { dimension: "page", operator: "equals", expression: "/blog/" },
        { dimension: "page", operator: "includingRegex", expression: "^/blog/[0-9]+" },
        { dimension: "page", operator: "contains", expression: "/blog/" }
      ], display, "https://example.com")
      assert.deepStrictEqual(filters, [
        { dimension: "query", operator: "includingRegex", expression: "^(?:seo|a\\.b)$" },
        { dimension: "page", operator: "excludingRegex", expression: "^(?:https://example\\.com/x)$" },
        { dimension: "page", operator: "equals", expression: "https://example.com/blog/" },
        { dimension: "page", operator: "includingRegex", expression: "^https://example\\.com/blog/[0-9]+" },
        { dimension: "page", operator: "contains", expression: "/blog/" }
      ])
    }))

  it.effect("rejects incomplete filters", () =>
    Effect.gen(function*() {
      const error = yield* compileFilters([{ dimension: "query", operator: "in" }], display, "https://example.com").pipe(
        Effect.flip
      )
      assert.strictEqual(error._tag, "InvalidInput")
    }))
})

describe("fitRows", () => {
  it("cuts rows beyond the budget and reports their traffic", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`/page-${i}`, 10, 100])
    const { rows: kept, omitted } = fitRows(rows, 60, { clicks: 1, impressions: 2 })
    assert.strictEqual(kept.length, 3)
    assert.deepStrictEqual(omitted, { rows: 7, clicks: 70, impressions: 700 })
    assert.isUndefined(fitRows(rows, 10_000, { clicks: 1, impressions: 2 }).omitted)
  })
})

describe("serializeTable", () => {
  it("writes csv with quoting, tsv and jsonl", () => {
    const rows = [["a, \"b\"", 1, null]]
    assert.strictEqual(serializeTable(["q", "clicks", "x"], rows, "csv"), "q,clicks,x\n\"a, \"\"b\"\"\",1,\n")
    assert.strictEqual(serializeTable(["q", "clicks", "x"], rows, "tsv"), "q\tclicks\tx\na, \"b\"\t1\t\n")
    assert.strictEqual(
      serializeTable(["q", "clicks", "x"], rows, "jsonl"),
      "{\"q\":\"a, \\\"b\\\"\",\"clicks\":1,\"x\":null}\n"
    )
  })
})

describe("aggregation", () => {
  it("buckets dates into weeks starting on Monday and months", () => {
    assert.strictEqual(timeBucket("2026-10-14", "week"), "2026-10-12")
    assert.strictEqual(timeBucket("2026-10-12", "week"), "2026-10-12")
    assert.strictEqual(timeBucket("2026-10-11", "week"), "2026-10-05")
    assert.strictEqual(timeBucket("2026-10-11", "month"), "2026-10")
  })

  it.effect("rewrites keys by extracting, replacing or bucketing", () =>
    Effect.gen(function*() {
      const extract = yield* compileRewrite({ dimension: "query", pattern: "\\d+\\.\\d+(\\.\\d+)?", unmatched: "drop" })
      assert.strictEqual(extract("texture pack 1.12.2 pvp"), "1.12.2")
      assert.isUndefined(extract("texture pack"))
      const replace = yield* compileRewrite({ dimension: "page", pattern: "page/\\d+/$", replacement: "" })
      assert.strictEqual(replace("/blog/page/3/"), "/blog/")
      assert.strictEqual(replace("/blog/"), "/blog/")
      const section = yield* compileRewrite({ dimension: "page", pattern: "^/[^/]+/", unmatched: "other" })
      assert.strictEqual(section("/blog/post/"), "/blog/")
      assert.strictEqual(section("/"), OTHER_KEY)
      const invalid = yield* compileRewrite({ dimension: "page", pattern: "(" }).pipe(Effect.flip)
      assert.strictEqual(invalid._tag, "InvalidInput")
    }))

  it("adds up rows and averages positions by impressions", () => {
    const { groups, dropped } = aggregateRows([
      { keys: ["/a/page/2/"], clicks: 1, impressions: 100, ctr: 0.01, position: 10 },
      { keys: ["/a/"], clicks: 9, impressions: 300, ctr: 0.03, position: 2 },
      { keys: ["/b/"], clicks: 5, impressions: 50, ctr: 0.1, position: 1 }
    ], ([page]) => page === "/b/" ? undefined : [page!.replace(/page\/\d+\/$/, "")])
    assert.deepStrictEqual(groups, [{ keys: ["/a/"], clicks: 10, impressions: 400, position: 4, rows: 2 }])
    assert.deepStrictEqual(dropped, { rows: 1, clicks: 5, impressions: 50 })
  })
})
