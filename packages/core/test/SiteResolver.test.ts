import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AccountStore, GscApiError, resolveSite, type SiteAccess, siteCandidates, SiteResolver } from "../src/index.ts"
import { fakeGsc, makeAccount } from "./fixtures.ts"

describe("siteCandidates", () => {
  it("keeps explicit domain properties", () => {
    assert.deepStrictEqual(siteCandidates("SC-DOMAIN:Example.com"), ["sc-domain:example.com"])
  })

  it("expands a bare domain into domain and URL-prefix properties", () => {
    assert.deepStrictEqual(siteCandidates("www.example.com/"), [
      "sc-domain:example.com",
      "https://example.com/",
      "https://www.example.com/",
      "http://example.com/",
      "http://www.example.com/"
    ])
  })

  it("lists every containing URL-prefix for a URL, longest first", () => {
    assert.deepStrictEqual(siteCandidates("https://www.example.com/blog/post"), [
      "https://www.example.com/blog/post/",
      "https://www.example.com/blog/",
      "https://www.example.com/",
      "sc-domain:example.com"
    ])
  })

  it("tries the domain property first for page URLs with preferDomain", () => {
    assert.deepStrictEqual(siteCandidates("https://www.example.com/blog/", { preferDomain: true }), [
      "sc-domain:example.com",
      "https://www.example.com/blog/",
      "https://www.example.com/"
    ])
  })
})

describe("resolveSite", () => {
  const index: ReadonlyArray<SiteAccess> = [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser", account: "agency" },
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner", account: "personal" },
    { siteUrl: "https://example.com/blog/", permissionLevel: "siteFullUser", account: "agency" },
    { siteUrl: "sc-domain:unverified.com", permissionLevel: "siteUnverifiedUser", account: "personal" }
  ]

  it("prefers the account with the highest permission", () => {
    assert.deepStrictEqual(resolveSite(index, "example.com"), { siteUrl: "sc-domain:example.com", account: "personal" })
  })

  it("respects an explicit account", () => {
    assert.deepStrictEqual(resolveSite(index, "example.com", "agency"), {
      siteUrl: "sc-domain:example.com",
      account: "agency"
    })
  })

  it("prefers the most specific URL-prefix property for URLs", () => {
    assert.deepStrictEqual(resolveSite(index, "https://example.com/blog/post"), {
      siteUrl: "https://example.com/blog/",
      account: "agency"
    })
  })

  it("ignores unverified properties", () => {
    assert.isUndefined(resolveSite(index, "unverified.com"))
  })
})

describe("SiteResolver", () => {
  const layer = SiteResolver.layer.pipe(
    Layer.provide(fakeGsc({
      personal: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }],
      broken: new GscApiError({ message: "boom" })
    })),
    Layer.provide(AccountStore.layerMemory([makeAccount("personal"), makeAccount("broken")]))
  )

  it.effect("indexes sites and reports failing accounts without failing", () =>
    Effect.gen(function*() {
      const index = yield* (yield* SiteResolver).index
      assert.deepStrictEqual(index.sites, [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner", account: "personal" }])
      assert.deepStrictEqual(index.failures, [{ account: "broken", message: "boom" }])
    }).pipe(Effect.provide(layer)))

  it.effect("fails with the available properties when nothing matches", () =>
    Effect.gen(function*() {
      const error = yield* (yield* SiteResolver).resolve("other.com").pipe(Effect.flip)
      assert.strictEqual(error._tag, "SiteNotFound")
      assert.include(error.message, "sc-domain:example.com")
    }).pipe(Effect.provide(layer)))

  it.effect("fails on unknown accounts", () =>
    Effect.gen(function*() {
      const error = yield* (yield* SiteResolver).resolve("example.com", "nope").pipe(Effect.flip)
      assert.strictEqual(error._tag, "AccountNotFound")
    }).pipe(Effect.provide(layer)))
})
