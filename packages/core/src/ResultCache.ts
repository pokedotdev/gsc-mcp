import { Clock, Context, Effect, Layer } from "effect"
import { KeyValueStore } from "effect/persistence"
import type { SearchAnalyticsRow } from "./Domain.ts"

/**
 * Durable cache of Search Analytics results, shared across server restarts.
 * Best effort: storage failures behave like cache misses.
 */
export class ResultCache extends Context.Service<ResultCache, {
  get(key: string): Effect.Effect<ReadonlyArray<SearchAnalyticsRow> | undefined>
  set(key: string, rows: ReadonlyArray<SearchAnalyticsRow>, timeToLiveMillis: number): Effect.Effect<void>
}>()("gsc-mcp/ResultCache") {
  /** No durable cache: every miss of the in-memory cache goes to Google. */
  static readonly layerNone = Layer.succeed(ResultCache)(ResultCache.of({
    get: () => Effect.undefined,
    set: () => Effect.void
  }))

  /** Stores results in any KeyValueStore (files locally, KV on Workers). */
  static readonly layerKeyValueStore = Layer.effect(
    ResultCache,
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      const storeKey = (key: string) => sha256(key).pipe(Effect.map((hash) => `sa-v1-${hash}`))

      const get = (key: string) =>
        Effect.gen(function*() {
          const id = yield* storeKey(key)
          const raw = yield* store.get(id)
          if (raw === undefined) return undefined
          const entry = JSON.parse(raw) as Entry
          if (entry.expiresAt <= (yield* Clock.currentTimeMillis)) {
            yield* store.remove(id)
            return undefined
          }
          return entry.rows.map(decodeRow)
        }).pipe(Effect.catchCause(() => Effect.undefined))

      const set = (key: string, rows: ReadonlyArray<SearchAnalyticsRow>, timeToLiveMillis: number) =>
        Effect.gen(function*() {
          const expiresAt = (yield* Clock.currentTimeMillis) + timeToLiveMillis
          const entry: Entry = { expiresAt, rows: rows.map(encodeRow) }
          yield* store.set(yield* storeKey(key), JSON.stringify(entry))
        }).pipe(Effect.catchCause(() => Effect.void))

      return ResultCache.of({ get, set })
    })
  )
}

// Rows are stored as tuples, which is about half the size of the API objects.
type StoredRow = readonly [ReadonlyArray<string> | null, number, number, number, number]

interface Entry {
  readonly expiresAt: number
  readonly rows: ReadonlyArray<StoredRow>
}

const encodeRow = (row: SearchAnalyticsRow): StoredRow => [
  row.keys ?? null,
  row.clicks,
  row.impressions,
  row.ctr,
  row.position
]

const decodeRow = ([keys, clicks, impressions, ctr, position]: StoredRow): SearchAnalyticsRow =>
  keys === null ? { clicks, impressions, ctr, position } : { keys, clicks, impressions, ctr, position }

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
  )
