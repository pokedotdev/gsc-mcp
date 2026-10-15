import { Clock, DateTime, Effect, Schema } from "effect"
import { InvalidInput } from "./Errors.ts"

export const RangePreset = Schema.Literals(["last7d", "last28d", "last3m", "last6m", "last12m", "last16m"])
export type RangePreset = typeof RangePreset.Type

const PRESET_DAYS: Record<RangePreset, number> = {
  last7d: 7,
  last28d: 28,
  last3m: 90,
  last6m: 180,
  last12m: 365,
  last16m: 486
}

/** Search Console finalizes data with a delay of about two to three days. */
export const DATA_DELAY_DAYS = 3

export interface DateRange {
  readonly startDate: string
  readonly endDate: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const formatDate = (date: DateTime.Utc) => DateTime.formatIso(date).slice(0, 10)

/**
 * Resolves either a preset or explicit dates into a concrete range. Presets
 * end at the last day with finalized data.
 */
export const resolveDateRange = Effect.fnUntraced(function*(options: {
  readonly range?: RangePreset | undefined
  readonly startDate?: string | undefined
  readonly endDate?: string | undefined
}): Effect.fn.Return<DateRange, InvalidInput> {
  const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
  const lastFinal = DateTime.subtract(now, { days: DATA_DELAY_DAYS })

  if (options.startDate !== undefined || options.endDate !== undefined) {
    if (options.range !== undefined) {
      return yield* new InvalidInput({ message: "Use either `range` or `startDate`/`endDate`, not both." })
    }
    if (options.startDate === undefined || !ISO_DATE.test(options.startDate)) {
      return yield* new InvalidInput({ message: "`startDate` is required and must be YYYY-MM-DD." })
    }
    const endDate = options.endDate ?? formatDate(lastFinal)
    if (!ISO_DATE.test(endDate)) {
      return yield* new InvalidInput({ message: "`endDate` must be YYYY-MM-DD." })
    }
    if (options.startDate > endDate) {
      return yield* new InvalidInput({ message: "`startDate` must be on or before `endDate`." })
    }
    return { startDate: options.startDate, endDate }
  }

  const days = PRESET_DAYS[options.range ?? "last28d"]
  return {
    startDate: formatDate(DateTime.subtract(lastFinal, { days: days - 1 })),
    endDate: formatDate(lastFinal)
  }
})

export const ComparisonMode = Schema.Literals(["previous", "yearOverYear"])
export type ComparisonMode = typeof ComparisonMode.Type

const parseDate = (date: string) => DateTime.makeUnsafe(`${date}T00:00:00Z`)

/** The period to compare a range against: the one right before it, or the same dates a year earlier. */
export const comparisonRange = (range: DateRange, mode: ComparisonMode): DateRange => {
  const start = parseDate(range.startDate)
  const end = parseDate(range.endDate)
  if (mode === "yearOverYear") {
    return {
      startDate: formatDate(DateTime.subtract(start, { years: 1 })),
      endDate: formatDate(DateTime.subtract(end, { years: 1 }))
    }
  }
  const days = Math.round((DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / 86_400_000) + 1
  const previousEnd = DateTime.subtract(start, { days: 1 })
  return {
    startDate: formatDate(DateTime.subtract(previousEnd, { days: days - 1 })),
    endDate: formatDate(previousEnd)
  }
}
