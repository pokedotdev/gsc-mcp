import { Context, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import {
  type InspectionResult,
  type SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  SiteEntry,
  type Sitemap,
  SitemapsResponse,
  UrlInspectionResponse
} from "./Domain.ts"
import { type AccountNotFound, type AccountStoreError, AuthError, GscApiError, QuotaExceeded } from "./Errors.ts"
import { GoogleAuth } from "./GoogleAuth.ts"

const WEBMASTERS_URL = "https://www.googleapis.com/webmasters/v3"
const INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"

const SitesResponse = Schema.Struct({
  siteEntry: Schema.optional(Schema.Array(SiteEntry))
})

const GoogleErrorBody = Schema.Struct({
  error: Schema.Struct({ message: Schema.optional(Schema.String) })
})

export type GscClientError = AccountNotFound | AccountStoreError | AuthError | QuotaExceeded | GscApiError

/** Thin typed client over the Search Console REST API. */
export class GscClient extends Context.Service<GscClient, {
  listSites(account: string): Effect.Effect<ReadonlyArray<SiteEntry>, GscClientError>
  searchAnalytics(
    account: string,
    siteUrl: string,
    request: SearchAnalyticsRequest
  ): Effect.Effect<SearchAnalyticsResponse, GscClientError>
  inspectUrl(account: string, siteUrl: string, url: string): Effect.Effect<InspectionResult, GscClientError>
  listSitemaps(account: string, siteUrl: string): Effect.Effect<ReadonlyArray<Sitemap>, GscClientError>
}>()("gsc-mcp/GscClient") {
  static readonly layer = Layer.effect(
    GscClient,
    Effect.gen(function*() {
      const auth = yield* GoogleAuth
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
        // Retries network errors, 429 and 5xx, honoring Retry-After.
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
          times: 3
        })
      )

      const send = Effect.fnUntraced(function*<S extends Schema.Constraint>(
        account: string,
        request: HttpClientRequest.HttpClientRequest,
        schema: S
      ): Effect.fn.Return<S["Type"], GscClientError, S["DecodingServices"]> {
        const token = yield* auth.accessToken(account)
        const response = yield* client.execute(
          HttpClientRequest.bearerToken(request, Redacted.value(token) as string)
        ).pipe(
          Effect.mapError((cause) => new GscApiError({ message: `Request to Search Console failed: ${cause.message}` }))
        )
        if (response.status >= 400) {
          const body = yield* HttpClientResponse.schemaBodyJson(GoogleErrorBody)(response).pipe(Effect.option)
          const detail = body._tag === "Some" ? body.value.error.message : undefined
          if (response.status === 401) {
            yield* auth.invalidate(account)
            return yield* new AuthError({
              account,
              message: `Google rejected the access token of account "${account}". ` +
                `If this persists, run \`gsc-mcp auth add ${account}\` again.`
            })
          }
          if (response.status === 429) {
            return yield* new QuotaExceeded({
              account,
              message: `Search Console quota exceeded for account "${account}"${detail ? `: ${detail}` : ""}. Try again later.`
            })
          }
          return yield* new GscApiError({
            status: response.status,
            message: `Search Console API error (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
          })
        }
        return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError((error) =>
            new GscApiError({ message: `Unexpected response from Search Console: ${error.message}` })
          )
        )
      })

      const listSites = Effect.fn("GscClient.listSites")(function*(account: string) {
        const body = yield* send(account, HttpClientRequest.get(`${WEBMASTERS_URL}/sites`), SitesResponse)
        return body.siteEntry ?? []
      })

      const searchAnalytics = Effect.fn("GscClient.searchAnalytics")(function*(
        account: string,
        siteUrl: string,
        request: SearchAnalyticsRequest
      ) {
        yield* Effect.annotateCurrentSpan({ account, siteUrl })
        return yield* send(
          account,
          HttpClientRequest.post(
            `${WEBMASTERS_URL}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`
          ).pipe(HttpClientRequest.bodyJsonUnsafe({
            startDate: request.startDate,
            endDate: request.endDate,
            dimensions: request.dimensions,
            type: request.type,
            dataState: request.dataState,
            rowLimit: request.rowLimit,
            startRow: request.startRow,
            ...(request.filters.length > 0
              ? { dimensionFilterGroups: [{ groupType: "and", filters: request.filters }] }
              : {})
          })),
          SearchAnalyticsResponse
        )
      })

      const inspectUrl = Effect.fn("GscClient.inspectUrl")(function*(account: string, siteUrl: string, url: string) {
        yield* Effect.annotateCurrentSpan({ account, siteUrl, url })
        const body = yield* send(
          account,
          HttpClientRequest.post(INSPECTION_URL).pipe(
            HttpClientRequest.bodyJsonUnsafe({ inspectionUrl: url, siteUrl })
          ),
          UrlInspectionResponse
        )
        return body.inspectionResult
      })

      const listSitemaps = Effect.fn("GscClient.listSitemaps")(function*(account: string, siteUrl: string) {
        yield* Effect.annotateCurrentSpan({ account, siteUrl })
        const body = yield* send(
          account,
          HttpClientRequest.get(`${WEBMASTERS_URL}/sites/${encodeURIComponent(siteUrl)}/sitemaps`),
          SitemapsResponse
        )
        return body.sitemap ?? []
      })

      return GscClient.of({ listSites, searchAnalytics, inspectUrl, listSitemaps })
    })
  )
}

