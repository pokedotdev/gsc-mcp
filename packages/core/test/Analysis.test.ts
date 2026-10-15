import { assert, describe, it } from "@effect/vitest"
import {
  brandFromSite,
  brandMatcher,
  comparePeriods,
  ctrCurve,
  detectCannibalization,
  findOpportunities,
  type SearchAnalyticsRow
} from "../src/index.ts"

const row = (keys: ReadonlyArray<string>, clicks: number, impressions: number, position: number): SearchAnalyticsRow => ({
  keys,
  clicks,
  impressions,
  ctr: impressions === 0 ? 0 : clicks / impressions,
  position
})

describe("comparePeriods", () => {
  it("joins rows by keys, including new and lost items", () => {
    const deltas = comparePeriods(
      [row(["a"], 10, 100, 3), row(["new"], 5, 50, 8)],
      [row(["a"], 4, 80, 5), row(["lost"], 7, 70, 6)]
    )
    const byKey = Object.fromEntries(deltas.map((d) => [d.keys[0], d]))
    assert.strictEqual(byKey.a!.clicksDelta, 6)
    assert.strictEqual(byKey.a!.positionDelta, -2)
    assert.strictEqual(byKey.new!.clicksDelta, 5)
    assert.isUndefined(byKey.new!.positionDelta)
    assert.strictEqual(byKey.lost!.clicksDelta, -7)
    assert.isUndefined(byKey.lost!.current)
  })
})

describe("ctrCurve", () => {
  it("falls back to the benchmark and never increases with position", () => {
    const curve = ctrCurve([], 10)
    assert.strictEqual(curve.length, 20)
    for (let i = 1; i < curve.length; i++) assert.isAtMost(curve[i]!, curve[i - 1]!)
  })

  it("uses the median CTR of the site when a position has enough rows", () => {
    const rows = [0.5, 0.4, 0.3, 0.2, 0.9].map((ctr, i) => ({ keys: [`q${i}`], clicks: ctr * 100, impressions: 100, ctr, position: 1.2 }))
    assert.strictEqual(ctrCurve(rows, 10)[0], 0.4)
  })
})

describe("findOpportunities", () => {
  const rows = [
    row(["striking", "/a"], 2, 1000, 7), // below top 3: opportunity
    row(["fine", "/b"], 280, 1000, 1), // top position with normal CTR
    row(["low ctr", "/c"], 10, 1000, 1.4), // top position, CTR far below expected
    row(["tiny", "/d"], 0, 5, 6), // below minImpressions
    row(["far", "/e"], 0, 1000, 45) // beyond striking distance
  ]

  it("finds striking distance and low CTR rows, best first", () => {
    const { opportunities } = findOpportunities(rows, {
      kinds: ["striking_distance", "low_ctr"],
      minImpressions: 50,
      strikingRange: [4, 20]
    })
    assert.deepStrictEqual(opportunities.map((o) => [o.kind, o.row.keys?.[0]]), [
      ["low_ctr", "low ctr"],
      ["striking_distance", "striking"]
    ])
    for (const o of opportunities) assert.isAbove(o.potentialClicks, 0)
  })

  it("filters by kind", () => {
    const { opportunities } = findOpportunities(rows, { kinds: ["low_ctr"], minImpressions: 50, strikingRange: [4, 20] })
    assert.deepStrictEqual(opportunities.map((o) => o.kind), ["low_ctr"])
  })
})

describe("detectCannibalization", () => {
  it("reports queries split across pages and merges jump links", () => {
    const issues = detectCannibalization([
      row(["shoes", "https://x.com/a"], 10, 600, 4),
      row(["shoes", "https://x.com/b"], 5, 400, 6),
      row(["shoes", "https://x.com/b#reviews"], 0, 100, 6),
      row(["hats", "https://x.com/h"], 50, 900, 2),
      row(["hats", "https://x.com/h#faq"], 1, 100, 3),
      row(["socks", "https://x.com/s"], 1, 980, 3),
      row(["socks", "https://x.com/t"], 0, 20, 30)
    ], { minImpressions: 100, minShare: 0.1 })
    assert.strictEqual(issues.length, 1)
    const shoes = issues[0]!
    assert.strictEqual(shoes.query, "shoes")
    assert.strictEqual(shoes.impressions, 1100)
    assert.deepStrictEqual(shoes.pages.map((p) => [p.page, p.impressions]), [
      ["https://x.com/a", 600],
      ["https://x.com/b", 500]
    ])
    assert.closeTo(shoes.split, 500 / 1100, 1e-9)
  })
})

describe("brand detection", () => {
  it("infers the brand from the property", () => {
    assert.strictEqual(brandFromSite("sc-domain:zonacraft.net"), "zonacraft")
    assert.strictEqual(brandFromSite("https://www.zona-craft.com.mx/"), "zonacraft")
    assert.strictEqual(brandFromSite("https://blog.example.co.uk/"), "example")
  })

  it("matches brand terms ignoring spaces and punctuation", () => {
    const isBranded = brandMatcher(["zonacraft", "zc"])
    assert.isTrue(isBranded("zona craft shaders"))
    assert.isTrue(isBranded("ZonaCraft"))
    // Terms shorter than 3 characters are ignored to avoid false positives.
    assert.isFalse(isBranded("zc mods"))
    assert.isFalse(isBranded("minecraft shaders"))
  })
})

describe("findOpportunities with sitelinks", () => {
  it("skips branded queries and pages that another page already wins", () => {
    const { opportunities } = findOpportunities([
      row(["acme", "https://acme.com/"], 900, 1000, 1),
      row(["acme", "https://acme.com/shop/"], 5, 1000, 1),
      row(["blue widgets", "https://acme.com/widgets/"], 300, 1000, 1),
      row(["blue widgets", "https://acme.com/blog/widgets/"], 1, 800, 1.2),
      row(["red widgets", "https://acme.com/red/"], 2, 1000, 1)
    ], {
      kinds: ["low_ctr"],
      minImpressions: 50,
      strikingRange: [4, 20],
      isBranded: brandMatcher(["acme"])
    })
    assert.deepStrictEqual(opportunities.map((o) => o.row.keys), [["red widgets", "https://acme.com/red/"]])
  })
})
