import { Context, Effect, Schema } from "effect"
import { type DimensionFilter, FilterDimension, FilterOperator, type SearchAnalyticsRow } from "./Domain.ts"
import { InvalidInput } from "./Errors.ts"

// Output formatting shared by the tools: compact numbers, table size limits,
// site-relative URLs and filter shorthands.

export type Cell = string | number | null

// MCP structured content must be plain JSON, so absent fields are dropped
// instead of being sent as `undefined`.
export const compact = <A extends Record<string, unknown>>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as A

export const round = (value: number, digits: number) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export const pct = (ctr: number) => round(ctr * 100, 2)
export const pos = (position: number) => round(position, 1)
export const share = (part: number, whole: number) => whole > 0 ? round((part / whole) * 100, 1) : 0

export const METRIC_COLUMNS = ["clicks", "impressions", "ctr_pct", "position"]

export const metrics = (row: SearchAnalyticsRow): Array<Cell> => [
  row.clicks,
  row.impressions,
  pct(row.ctr),
  pos(row.position)
]

const EMPTY_ROW: SearchAnalyticsRow = { clicks: 0, impressions: 0, ctr: 0, position: 0 }

/** Totals from a dimensionless request, which returns at most one row. */
export const totalsOf = (rows: ReadonlyArray<SearchAnalyticsRow>) => {
  const row = rows[0] ?? EMPTY_ROW
  return { clicks: row.clicks, impressions: row.impressions, ctr_pct: pct(row.ctr), position: pos(row.position) }
}

// Response size ---------------------------------------------------------------

/**
 * Maximum characters of table rows in a single tool response. Clients such as
 * Claude Code reject responses above roughly 25k tokens; tables are cut
 * before reaching that point and the response says what was left out.
 */
export const OutputBudget = Context.Reference<number>("gsc-mcp/OutputBudget", {
  defaultValue: () => 40_000
})

export interface Omitted {
  readonly rows: number
  readonly clicks: number
  readonly impressions: number
}

/**
 * Keeps the leading items that fit in `budget` characters of JSON. When items
 * are cut, reports how many and how much traffic they carried.
 */
export const fitItems = <A>(
  items: ReadonlyArray<A>,
  budget: number,
  traffic: (item: A) => readonly [clicks: number, impressions: number]
): { readonly items: ReadonlyArray<A>; readonly omitted: Omitted | undefined } => {
  let used = 0
  let kept = 0
  for (; kept < items.length; kept++) {
    used += JSON.stringify(items[kept]).length + 1
    if (used > budget) break
  }
  if (kept === items.length) return { items, omitted: undefined }
  let clicks = 0
  let impressions = 0
  for (const item of items.slice(kept)) {
    const [c, i] = traffic(item)
    clicks += c
    impressions += i
  }
  return { items: items.slice(0, kept), omitted: { rows: items.length - kept, clicks, impressions } }
}

/** fitItems for table rows, reading traffic from the given column indexes. */
export const fitRows = (
  rows: ReadonlyArray<ReadonlyArray<Cell>>,
  budget: number,
  columns: { readonly clicks: number; readonly impressions: number }
) => {
  const { items, omitted } = fitItems(rows, budget, (row) => [
    Number(row[columns.clicks] ?? 0),
    Number(row[columns.impressions] ?? 0)
  ])
  return { rows: items, omitted }
}

export const TruncatedOutput = Schema.Struct({
  rows: Schema.Number,
  clicks: Schema.Number,
  impressions: Schema.Number,
  hint: Schema.String
}).annotate({
  description: "Present when rows were left out to keep the response small: what was omitted and how to get it."
})

export const truncatedOutput = (omitted: Omitted | undefined, hint: string) =>
  omitted === undefined ? undefined : { ...omitted, hint }

// URLs -----------------------------------------------------------------------

/**
 * Shows page URLs relative to the main origin of the site, which saves a
 * large share of the tokens of page tables. URLs on other origins (http://,
 * subdomains) stay absolute.
 */
export interface UrlDisplay {
  /** Origin that relative paths are based on, or undefined when showing full URLs. */
  readonly origin: string | undefined
  show(url: string): string
  /** Turns a path relative to the origin into a full URL; full URLs are returned as is. */
  expand(url: string): string
}

export const urlDisplay = (origin: string, fullUrls: boolean): UrlDisplay => ({
  origin: fullUrls ? undefined : origin,
  show: (url) => !fullUrls && url.startsWith(`${origin}/`) ? url.slice(origin.length) : url,
  expand: (url) => url.startsWith("/") ? `${origin}${url}` : url
})

/** Default origin of a property: the URL-prefix origin or https:// plus the domain. */
export const propertyOrigin = (siteUrl: string): string => {
  if (siteUrl.startsWith("sc-domain:")) return `https://${siteUrl.slice("sc-domain:".length)}`
  try {
    return new URL(siteUrl).origin
  } catch {
    return siteUrl.replace(/\/+$/, "")
  }
}

/** Origin of a URL, or undefined if it is not a valid absolute URL. */
export const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** Drops #fragments (jump links) and ?query strings, and unifies http with https. */
export const normalizePage = (url: string): string => {
  const end = url.search(/[?#]/)
  const base = end === -1 ? url : url.slice(0, end)
  return base.startsWith("http://") ? `https://${base.slice("http://".length)}` : base
}

/** Drops #fragments only: Google reports jump links as separate pages. */
export const withoutFragment = (url: string): string => {
  const hash = url.indexOf("#")
  return hash === -1 ? url : url.slice(0, hash)
}

// Filters --------------------------------------------------------------------

/** Escapes text to match it literally in an RE2 regular expression. */
export const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")

export const FilterInput = Schema.Struct({
  dimension: FilterDimension,
  operator: Schema.Union([FilterOperator, Schema.Literals(["in", "notIn"])]),
  expression: Schema.optional(Schema.String.annotate({
    description: "Value or regular expression to compare with. Required except for in/notIn."
  })),
  values: Schema.optional(Schema.Array(Schema.String).annotate({
    description: "Exact values for the in/notIn operators."
  }))
})
export type FilterInput = typeof FilterInput.Type

/**
 * Translates filters as agents write them into API filters: in/notIn become
 * anchored regexes, and page paths relative to the site ("/blog/x") become
 * full URLs, also at the start of regexes ("^/blog/").
 */
export const compileFilters = (
  filters: ReadonlyArray<FilterInput>,
  display: UrlDisplay,
  origin: string
): Effect.Effect<Array<DimensionFilter>, InvalidInput> =>
  Effect.forEach(filters, (filter) => {
    const isPage = filter.dimension === "page"
    if (filter.operator === "in" || filter.operator === "notIn") {
      const values = filter.values ?? []
      if (values.length === 0) {
        return Effect.fail(new InvalidInput({ message: `The ${filter.operator} operator needs a non-empty "values" list.` }))
      }
      const alternatives = values.map((value) => escapeRegex(isPage ? display.expand(value) : value))
      return Effect.succeed<DimensionFilter>({
        dimension: filter.dimension,
        operator: filter.operator === "in" ? "includingRegex" : "excludingRegex",
        expression: `^(?:${alternatives.join("|")})$`
      })
    }
    const expression = filter.expression
    if (expression === undefined) {
      return Effect.fail(new InvalidInput({ message: `The ${filter.operator} operator needs an "expression".` }))
    }
    if (!isPage) return Effect.succeed<DimensionFilter>({ ...filter, operator: filter.operator, expression })
    const isRegex = filter.operator === "includingRegex" || filter.operator === "excludingRegex"
    const isExact = filter.operator === "equals" || filter.operator === "notEquals"
    return Effect.succeed<DimensionFilter>({
      dimension: filter.dimension,
      operator: filter.operator,
      expression: isExact
        ? display.expand(expression)
        : isRegex && expression.startsWith("^/")
        ? `^${escapeRegex(origin)}${expression.slice(1)}`
        : expression
    })
  })

// Files ----------------------------------------------------------------------

export const FileFormat = Schema.Literals(["csv", "tsv", "jsonl"])
export type FileFormat = typeof FileFormat.Type

const csvCell = (cell: Cell) => {
  if (cell === null) return ""
  const text = String(cell)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text
}

const tsvCell = (cell: Cell) => cell === null ? "" : String(cell).replace(/[\t\n\r]/g, " ")

/** Serializes a table with a header row (csv, tsv) or as one JSON object per line. */
export const serializeTable = (
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<Cell>>,
  format: FileFormat
): string => {
  if (format === "jsonl") {
    return rows.map((row) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null])))).join("\n") +
      "\n"
  }
  const cell = format === "csv" ? csvCell : tsvCell
  const separator = format === "csv" ? "," : "\t"
  return [columns, ...rows].map((row) => row.map(cell).join(separator)).join("\n") + "\n"
}
