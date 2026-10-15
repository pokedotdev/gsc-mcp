import { Cache, Context, Effect, Exit, Layer } from "effect"
import type { SearchAnalyticsRequest, SearchAnalyticsRow } from "./Domain.ts"
import { GscClient, type GscClientError } from "./GscClient.ts"

/** Maximum rows the Search Analytics API returns per request. */
export const PAGE_SIZE = 25_000

export interface SearchQuery {
  readonly account: string
  readonly siteUrl: string
  readonly request: SearchAnalyticsRequest
}

/**
 * Search Analytics access for tools: identical queries are served from an
 * in-memory cache and large result sets are paginated transparently.
 */
export class SearchData extends Context.Service<SearchData, {
  query(query: SearchQuery): Effect.Effect<ReadonlyArray<SearchAnalyticsRow>, GscClientError>
  /** Fetches up to `maxRows` rows, requesting pages of PAGE_SIZE sequentially. */
  queryAll(
    query: Omit<SearchQuery, "request"> & {
      readonly request: Omit<SearchAnalyticsRequest, "rowLimit" | "startRow">
    },
    maxRows: number
  ): Effect.Effect<ReadonlyArray<SearchAnalyticsRow>, GscClientError>
}>()("gsc-mcp/SearchData") {
  static readonly layer = Layer.effect(
    SearchData,
    Effect.gen(function*() {
      const gsc = yield* GscClient
      // Keys are serialized queries; failures are not cached.
      const cache = yield* Cache.makeWith(
        (key: string) => {
          const { account, siteUrl, request } = JSON.parse(key) as SearchQuery
          return gsc.searchAnalytics(account, siteUrl, request).pipe(Effect.map((response) => response.rows ?? []))
        },
        {
          capacity: 500,
          timeToLive: (exit) => Exit.isSuccess(exit) ? "15 minutes" : 0
        }
      )

      const query = (query: SearchQuery) =>
        Cache.get(cache, JSON.stringify({ account: query.account, siteUrl: query.siteUrl, request: query.request }))

      const queryAll = Effect.fn("SearchData.queryAll")(function*(
        base: Omit<SearchQuery, "request"> & {
          readonly request: Omit<SearchAnalyticsRequest, "rowLimit" | "startRow">
        },
        maxRows: number
      ) {
        const rows: Array<SearchAnalyticsRow> = []
        while (rows.length < maxRows) {
          const rowLimit = Math.min(PAGE_SIZE, maxRows - rows.length)
          const page = yield* query({ ...base, request: { ...base.request, rowLimit, startRow: rows.length } })
          rows.push(...page)
          if (page.length < rowLimit) break
        }
        return rows
      })

      return SearchData.of({ query, queryAll })
    })
  )
}
