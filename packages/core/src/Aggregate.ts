import { Effect, Schema } from "effect"
import { Dimension, type SearchAnalyticsRow } from "./Domain.ts"
import { InvalidInput } from "./Errors.ts"

// Server-side grouping of Search Analytics rows: rewrite keys (URL patterns,
// versions or topics extracted from queries, weeks...) and add up the rows
// that end up with the same keys.

export const TimeGrain = Schema.Literals(["day", "week", "month"])
export type TimeGrain = typeof TimeGrain.Type

/** Buckets a YYYY-MM-DD date: weeks start on Monday, months are YYYY-MM. */
export const timeBucket = (date: string, grain: TimeGrain): string => {
  if (grain === "day") return date
  if (grain === "month") return date.slice(0, 7)
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

/** Key given to rows that a rewrite with `unmatched: "other"` does not match. */
export const OTHER_KEY = "(other)"

export const KeyRewrite = Schema.Struct({
  dimension: Dimension,
  pattern: Schema.String.annotate({
    description: "JavaScript regular expression tested against each key of the dimension."
  }),
  replacement: Schema.optional(Schema.String.annotate({
    description: "Replacement for the first match, with $1, $2... for groups (String.replace semantics). " +
      "Omit it to keep only the matched text."
  })),
  ignoreCase: Schema.optional(Schema.Boolean),
  unmatched: Schema.optional(Schema.Literals(["keep", "drop", "other"]).annotate({
    description: "What to do with keys the pattern does not match: keep them unchanged (default), " +
      `drop the rows, or group them as "${OTHER_KEY}".`
  }))
})
export type KeyRewrite = typeof KeyRewrite.Type

/** A rewrite of one key: the new key, or undefined to drop the row. */
export type KeyMapper = (key: string) => string | undefined

export const compileRewrite = (rewrite: KeyRewrite): Effect.Effect<KeyMapper, InvalidInput> =>
  Effect.try({
    try: () => new RegExp(rewrite.pattern, rewrite.ignoreCase ? "i" : ""),
    catch: (error) =>
      new InvalidInput({ message: `Invalid rewrite pattern ${JSON.stringify(rewrite.pattern)}: ${String(error)}` })
  }).pipe(Effect.map((regex): KeyMapper => (key) => {
    const match = regex.exec(key)
    if (match !== null) return rewrite.replacement === undefined ? match[0] : key.replace(regex, rewrite.replacement)
    return rewrite.unmatched === "drop" ? undefined : rewrite.unmatched === "other" ? OTHER_KEY : key
  }))

export interface AggregatedRow {
  readonly keys: ReadonlyArray<string>
  readonly clicks: number
  readonly impressions: number
  /** Average position weighted by impressions. */
  readonly position: number
  /** Number of source rows merged into this one. */
  readonly rows: number
}

export const toSearchRow = (row: AggregatedRow): SearchAnalyticsRow => ({
  keys: row.keys,
  clicks: row.clicks,
  impressions: row.impressions,
  ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
  position: row.position
})

export interface Aggregation {
  readonly groups: Array<AggregatedRow>
  /** Source rows dropped by rewrites. */
  readonly dropped: { readonly rows: number; readonly clicks: number; readonly impressions: number }
}

/**
 * Groups rows by the keys returned by `mapKeys` (undefined drops the row).
 * Clicks and impressions are added up and positions averaged by impressions.
 */
export const aggregateRows = (
  rows: ReadonlyArray<SearchAnalyticsRow>,
  mapKeys: (keys: ReadonlyArray<string>) => ReadonlyArray<string> | undefined
): Aggregation => {
  const groups = new Map<string, { keys: ReadonlyArray<string>; clicks: number; impressions: number; weighted: number; rows: number }>()
  const dropped = { rows: 0, clicks: 0, impressions: 0 }
  for (const row of rows) {
    const keys = mapKeys(row.keys ?? [])
    if (keys === undefined) {
      dropped.rows++
      dropped.clicks += row.clicks
      dropped.impressions += row.impressions
      continue
    }
    const id = keys.join("\u0000")
    const group = groups.get(id) ?? { keys, clicks: 0, impressions: 0, weighted: 0, rows: 0 }
    group.clicks += row.clicks
    group.impressions += row.impressions
    group.weighted += row.position * row.impressions
    group.rows++
    groups.set(id, group)
  }
  return {
    groups: [...groups.values()].map((group) => ({
      keys: group.keys,
      clicks: group.clicks,
      impressions: group.impressions,
      position: group.impressions > 0 ? group.weighted / group.impressions : 0,
      rows: group.rows
    })),
    dropped
  }
}
