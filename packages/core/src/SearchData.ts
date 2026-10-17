import { Cache, Clock, Context, Effect, Exit, Layer } from "effect"
import { DATA_DELAY_DAYS } from "./DateRange.ts"
import type { SearchAnalyticsRequest, SearchAnalyticsRow } from "./Domain.ts"
import { GscClient, type GscClientError } from "./GscClient.ts"
import { Progress } from "./Progress.ts"
import { ResultCache } from "./ResultCache.ts"

/** Maximum rows the Search Analytics API returns per request. */
export const PAGE_SIZE = 25_000

/** Pages requested at the same time when paginating large result sets. */
export const PAGE_CONCURRENCY = 3

export interface SearchQuery {
  readonly account: string
  readonly siteUrl: string
  readonly request: SearchAnalyticsRequest
}

export type SearchQueryAll = Omit<SearchQuery, "request"> & {
  readonly request: Omit<SearchAnalyticsRequest, "rowLimit" | "startRow">
}

const DAY = 86_400_000

/**
 * How long a result may be kept in the durable cache. Finalized data of past
 * days does not change, except for occasional reprocessing by Google, so old
 * periods are kept for a week and recent ones for a few hours.
 */
export const durableTimeToLive = (request: SearchAnalyticsRequest, now: number): number | undefined => {
  if (request.dataState !== "final") return undefined
  const age = (now - Date.parse(`${request.endDate}T00:00:00Z`)) / DAY
  if (age >= 10) return 7 * DAY
  if (age >= DATA_DELAY_DAYS) return 6 * 3_600_000
  return undefined
}

/**
 * Search Analytics access for tools: identical queries are served from an
 * in-memory cache backed by a durable ResultCache, and large result sets are
 * paginated transparently.
 */
export class SearchData extends Context.Service<SearchData, {
  query(query: SearchQuery): Effect.Effect<ReadonlyArray<SearchAnalyticsRow>, GscClientError>
  /**
   * Fetches up to `maxRows` rows starting at `startRow`. After the first page,
   * the following pages are requested in parallel batches.
   */
  queryAll(
    query: SearchQueryAll,
    maxRows: number,
    startRow?: number
  ): Effect.Effect<ReadonlyArray<SearchAnalyticsRow>, GscClientError>
}>()("gsc-mcp/SearchData") {
  static readonly layer = Layer.effect(
    SearchData,
    Effect.gen(function*() {
      const gsc = yield* GscClient
      const durable = yield* ResultCache

      // Keys are serialized queries; failures are not cached.
      const cache = yield* Cache.makeWith(
        Effect.fnUntraced(function*(key: string) {
          const stored = yield* durable.get(key)
          if (stored !== undefined) return stored
          const { account, siteUrl, request } = JSON.parse(key) as SearchQuery
          const response = yield* gsc.searchAnalytics(account, siteUrl, request)
          const rows = response.rows ?? []
          const timeToLive = durableTimeToLive(request, yield* Clock.currentTimeMillis)
          if (timeToLive !== undefined) yield* durable.set(key, rows, timeToLive)
          return rows
        }),
        {
          capacity: 500,
          timeToLive: (exit) => Exit.isSuccess(exit) ? "15 minutes" : 0
        }
      )

      const query = (query: SearchQuery) =>
        Cache.get(cache, JSON.stringify({ account: query.account, siteUrl: query.siteUrl, request: query.request }))

      const queryAll = Effect.fn("SearchData.queryAll")(function*(
        base: SearchQueryAll,
        maxRows: number,
        startRow = 0
      ) {
        const page = (offset: number, rowLimit: number) =>
          query({ ...base, request: { ...base.request, rowLimit, startRow: startRow + offset } })

        const firstLimit = Math.min(PAGE_SIZE, maxRows)
        const rows: Array<SearchAnalyticsRow> = [...yield* page(0, firstLimit)]
        if (rows.length < firstLimit) return rows

        const progress = yield* Progress
        yield* progress.report(rows.length, maxRows, `Fetched ${rows.length} rows from Search Console`)
        while (rows.length < maxRows) {
          const batch: Array<{ offset: number; rowLimit: number }> = []
          for (let offset = rows.length; batch.length < PAGE_CONCURRENCY && offset < maxRows; offset += PAGE_SIZE) {
            batch.push({ offset, rowLimit: Math.min(PAGE_SIZE, maxRows - offset) })
          }
          let fetched = rows.length
          const pages = yield* Effect.forEach(
            batch,
            ({ offset, rowLimit }) =>
              page(offset, rowLimit).pipe(Effect.tap((result) => {
                fetched += result.length
                return progress.report(fetched, maxRows, `Fetched ${fetched} rows from Search Console`)
              })),
            { concurrency: PAGE_CONCURRENCY }
          )
          for (const [i, result] of pages.entries()) {
            rows.push(...result)
            if (result.length < batch[i]!.rowLimit) return rows
          }
        }
        return rows
      })

      return SearchData.of({ query, queryAll })
    })
  )
}
