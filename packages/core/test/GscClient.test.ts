import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { AccountStore, GoogleAuth, GscClient } from "../src/index.ts"
import { fakeOAuth, makeAccount } from "./fixtures.ts"

const respond = (handler: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) => {
    requests.push(request)
    return Effect.succeed(HttpClientResponse.fromWeb(request, handler(request)))
  }))
  return { requests, layer }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const makeLayer = (http: Layer.Layer<HttpClient.HttpClient>) =>
  GscClient.layer.pipe(
    Layer.provide(GoogleAuth.layer),
    Layer.provide([http, fakeOAuth({ count: 0 }), AccountStore.layerMemory([makeAccount("personal")])])
  )

const request = {
  startDate: "2026-01-01",
  endDate: "2026-01-31",
  dimensions: ["query"],
  type: "web",
  filters: [{ dimension: "page", operator: "contains", expression: "/blog/" }],
  rowLimit: 10,
  startRow: 0,
  dataState: "final"
} as const

describe("GscClient", () => {
  it.effect("queries search analytics with bearer auth and an encoded site", () => {
    const http = respond(() => json({ rows: [{ keys: ["seo"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }] }))
    return Effect.gen(function*() {
      const response = yield* (yield* GscClient).searchAnalytics("personal", "sc-domain:example.com", request)
      assert.deepStrictEqual(response.rows?.[0]?.keys, ["seo"])
      const sent = http.requests[0]!
      assert.strictEqual(
        sent.url,
        "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"
      )
      assert.strictEqual(sent.headers["authorization"], "Bearer access-personal-1")
      const body = JSON.parse(new TextDecoder().decode((sent.body as { body: Uint8Array }).body))
      assert.deepStrictEqual(body.dimensionFilterGroups, [{ groupType: "and", filters: request.filters }])
    }).pipe(Effect.provide(makeLayer(http.layer)))
  })

  it.effect("maps permission errors with Google's message", () => {
    const http = respond(() => json({ error: { message: "User does not have sufficient permission" } }, 403))
    return Effect.gen(function*() {
      const error = yield* (yield* GscClient).listSites("personal").pipe(Effect.flip)
      assert.strictEqual(error._tag, "GscApiError")
      assert.include(error.message, "sufficient permission")
    }).pipe(Effect.provide(makeLayer(http.layer)))
  })

  it.effect("maps 401 to AuthError", () => {
    const http = respond(() => json({ error: { message: "Invalid Credentials" } }, 401))
    return Effect.gen(function*() {
      const error = yield* (yield* GscClient).listSites("personal").pipe(Effect.flip)
      assert.strictEqual(error._tag, "AuthError")
    }).pipe(Effect.provide(makeLayer(http.layer)))
  })

  it.effect("treats a missing siteEntry as no sites", () => {
    const http = respond(() => json({}))
    return Effect.gen(function*() {
      assert.deepStrictEqual(yield* (yield* GscClient).listSites("personal"), [])
    }).pipe(Effect.provide(makeLayer(http.layer)))
  })
})
