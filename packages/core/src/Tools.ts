import { Cache, Clock, Effect, Exit, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { AccountStore } from "./AccountStore.ts"
import {
  aggregateRows,
  compileRewrite,
  type KeyMapper,
  KeyRewrite,
  TimeGrain,
  timeBucket,
  toSearchRow
} from "./Aggregate.ts"
import {
  brandFromSite,
  brandMatcher,
  comparePeriods,
  detectCannibalization,
  findOpportunities,
  type PeriodDelta
} from "./Analysis.ts"
import { ComparisonMode, comparisonRange, type DateRange, RangePreset, resolveDateRange } from "./DateRange.ts"
import {
  DataState,
  Dimension,
  type DimensionFilter,
  type InspectionResult,
  type SearchAnalyticsRequest,
  type SearchAnalyticsRow,
  SearchType
} from "./Domain.ts"
import { GscError, InvalidInput } from "./Errors.ts"
import { Exporter, fileSlug } from "./Exporter.ts"
import {
  type Cell,
  compact,
  compileFilters,
  escapeRegex,
  FileFormat,
  FilterInput,
  fitItems,
  fitRows,
  METRIC_COLUMNS,
  metrics,
  normalizePage,
  originOf,
  OutputBudget,
  pct,
  pos,
  propertyOrigin,
  serializeTable,
  share,
  totalsOf,
  TruncatedOutput,
  truncatedOutput,
  type UrlDisplay,
  urlDisplay,
  withoutFragment
} from "./Format.ts"
import { GscClient } from "./GscClient.ts"
import { Progress, ProgressMcp } from "./Progress.ts"
import { PAGE_SIZE, SearchData } from "./SearchData.ts"
import { type ResolveOptions, SiteResolver } from "./SiteResolver.ts"

// Shared parameters ----------------------------------------------------------

const SiteParam = Schema.String.annotate({
  description: "Site to query: a domain (example.com), a URL (https://example.com/blog/) " +
    "or an exact Search Console property (sc-domain:example.com). Resolved to the best matching property."
})

const AccountParam = Schema.optional(Schema.String.annotate({
  description: "Account alias to use. Optional: by default the account with the highest permission on the site is used."
}))

/** Site, period and segment parameters shared by every analytics tool. */
const periodFields = {
  site: SiteParam,
  account: AccountParam,
  range: Schema.optional(RangePreset.annotate({
    description: "Relative period ending at the last day with finalized data. Defaults to last28d. " +
      "Do not combine with startDate/endDate."
  })),
  startDate: Schema.optional(Schema.String.annotate({ description: "Start date, YYYY-MM-DD." })),
  endDate: Schema.optional(Schema.String.annotate({
    description: "End date, YYYY-MM-DD. Defaults to the last day with finalized data."
  })),
  type: Schema.optional(SearchType.annotate({ description: "Search type. Defaults to web." })),
  filters: Schema.optional(Schema.Array(FilterInput).annotate({
    description: "Filters combined with AND, e.g. [{\"dimension\":\"page\",\"operator\":\"contains\",\"expression\":\"/blog/\"}] " +
      "or [{\"dimension\":\"query\",\"operator\":\"in\",\"values\":[\"seo\",\"seo tools\"]}]. " +
      "Page values may be paths relative to the site (\"/blog/x\", or \"^/blog/\" in regexes). " +
      "Regex operators use RE2 syntax."
  })),
  dataState: Schema.optional(DataState.annotate({
    description: "\"final\" (default) or \"all\" to include fresh, not yet finalized data."
  }))
}

const fullUrlsField = {
  fullUrls: Schema.optional(Schema.Boolean.annotate({
    description: "Return absolute page URLs. By default pages on the site's main origin are paths relative to `origin`."
  }))
}

const outputFields = {
  output: Schema.optional(Schema.Literals(["inline", "file"]).annotate({
    description: "\"inline\" (default) returns the rows in the response. \"file\" writes every row to a local file " +
      "and returns its path plus a 10-row preview: use it for bulk data to process with jq, awk or DuckDB."
  })),
  format: Schema.optional(FileFormat.annotate({ description: "File format for output \"file\". Defaults to csv." }))
}

const limitParam = (defaultValue: number, maximum: number) =>
  Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum })).annotate({
    description: `Maximum results to return (1-${maximum}). Defaults to ${defaultValue}.`
  }))

const MaxRowsParam = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 100_000 })).annotate({
  description: "Rows of raw data to analyze (1000-100000, sorted by clicks). Defaults to 25000, one API request. " +
    "Raise it only for very large sites; every 25000 rows is one more request."
}))

const MinImpressionsParam = (defaultValue: number | undefined) =>
  Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: defaultValue === undefined
      ? "Leave out results with fewer impressions than this."
      : `Ignore rows with fewer impressions than this. Defaults to ${defaultValue}; ` +
        "lower it for small sites or short periods."
  }))

const brandFields = {
  includeBranded: Schema.optional(Schema.Boolean.annotate({
    description: "Include branded queries. Defaults to false: they rank first with sitelinks and distort the analysis."
  })),
  brandTerms: Schema.optional(Schema.Array(Schema.String).annotate({
    description: "Extra brand terms (product names, common misspellings). The brand is also inferred from the domain."
  }))
}

const groupingFields = {
  rewrites: Schema.optional(Schema.Array(KeyRewrite).annotate({
    description: "Rewrite keys before grouping, applied in order. Examples: merge pagination with " +
      "{\"dimension\":\"page\",\"pattern\":\"page/\\\\d+/$\",\"replacement\":\"\"}; group pages by section with " +
      "{\"dimension\":\"page\",\"pattern\":\"^/[^/]+/\",\"unmatched\":\"other\"}; extract a version from queries with " +
      "{\"dimension\":\"query\",\"pattern\":\"\\\\d+\\\\.\\\\d+(\\\\.\\\\d+)?\",\"unmatched\":\"drop\"}. " +
      "Page rewrites see the same relative paths as the output."
  })),
  normalizePages: Schema.optional(Schema.Boolean.annotate({
    description: "Merge page variants: drop #fragments and ?query strings and treat http as https."
  }))
}

const Cell = Schema.Union([Schema.String, Schema.Number, Schema.Null])
const Table = {
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Cell))
}

const PeriodOutput = {
  site: Schema.String,
  account: Schema.String,
  startDate: Schema.String,
  endDate: Schema.String,
  origin: Schema.optional(Schema.String.annotate({ description: "Origin that relative page paths are based on." }))
}

const Totals = Schema.Struct({
  clicks: Schema.Number,
  impressions: Schema.Number,
  ctr_pct: Schema.Number,
  position: Schema.Number
})

const Coverage = Schema.Struct({ clicks_pct: Schema.Number, impressions_pct: Schema.Number })

const FileOutput = Schema.Struct({
  path: Schema.String,
  format: FileFormat,
  rows: Schema.Number,
  bytes: Schema.Number
})

const readOnly = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true) as T

// Tools ----------------------------------------------------------------------

export const ListAccounts = readOnly(Tool.make("list_accounts", {
  description: "List the Google accounts connected to this server.",
  success: Schema.Struct({
    accounts: Schema.Array(Schema.Struct({ alias: Schema.String, email: Schema.String }))
  }),
  failure: GscError
}))

export const ListSites = readOnly(Tool.make("list_sites", {
  description: "List every Search Console property reachable through the connected accounts, " +
    "with the permission level of each account. Call this first to discover available sites.",
  parameters: Schema.Struct({ account: AccountParam }),
  success: Schema.Struct({
    sites: Schema.Array(Schema.Struct({
      siteUrl: Schema.String,
      access: Schema.Array(Schema.Struct({ account: Schema.String, permission: Schema.String }))
    })),
    failures: Schema.Array(Schema.Struct({ account: Schema.String, message: Schema.String }))
  }),
  failure: GscError
}))

export const SearchAnalytics = readOnly(Tool.make("search_analytics", {
  description: "Query raw Search Console performance data (clicks, impressions, CTR, average position), " +
    "grouped by the given dimensions and sorted by clicks. Data covers the last 16 months and is finalized " +
    "with a delay of about 3 days. Without dimensions, returns the totals for the period. " +
    "Rows with the query dimension never include anonymized (rare) queries, so they add up to less than the totals. " +
    "For bulk analysis use aggregate (groups rows server-side) or output \"file\"; prefer the specialized tools " +
    "(compare_periods, find_opportunities, detect_cannibalization, page_report, query_report) when they fit.",
  parameters: Schema.Struct({
    ...periodFields,
    dimensions: Schema.optional(Schema.Array(Dimension).annotate({
      description: "Dimensions to group by, e.g. [\"query\"] or [\"page\", \"query\"]. Empty means totals."
    })),
    limit: limitParam(100, 100_000),
    startRow: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Zero-based row offset for pagination. Defaults to 0."
    })),
    ...fullUrlsField,
    ...outputFields
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    ...Table,
    hasMore: Schema.Boolean,
    coverage: Schema.optional(Coverage.annotate({
      description: "When hasMore is true: share of the period's clicks and impressions in the returned rows."
    })),
    warning: Schema.optional(Schema.String),
    truncated: Schema.optional(TruncatedOutput),
    file: Schema.optional(FileOutput)
  }),
  failure: GscError
}))

export const Aggregate = readOnly(Tool.make("aggregate", {
  description: "Group Search Console rows server-side and return a small table: merge URL variants, bucket pages " +
    "by section or pattern, extract tokens (versions, topics) from queries, roll dates up to weeks or months, " +
    "and add up clicks and impressions (position is averaged by impressions). Use it instead of downloading " +
    "thousands of rows. Fetches up to maxRows raw rows sorted by clicks and reports how much traffic they cover.",
  parameters: Schema.Struct({
    ...periodFields,
    dimensions: Schema.Array(Dimension).check(Schema.isMinLength(1)).annotate({
      description: "Dimensions of the raw rows, e.g. [\"page\"], [\"query\", \"page\"] or [\"date\"]."
    }),
    ...groupingFields,
    timeGrain: Schema.optional(TimeGrain.annotate({
      description: "Roll the date dimension up to days (default), weeks starting on Monday or months."
    })),
    minImpressions: MinImpressionsParam(undefined),
    sortBy: Schema.optional(Schema.Literals(["clicks", "impressions", "ctr", "position", "key"]).annotate({
      description: "Defaults to key (chronological) when grouping by date, clicks otherwise."
    })),
    order: Schema.optional(Schema.Literals(["asc", "desc"]).annotate({
      description: "Defaults to asc for key and position, desc for the rest."
    })),
    limit: limitParam(100, 10_000),
    maxRows: MaxRowsParam,
    ...fullUrlsField,
    ...outputFields
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    source: Schema.Struct({
      rows: Schema.Number,
      complete: Schema.Boolean,
      droppedRows: Schema.Number,
      clicks_coverage_pct: Schema.Number
    }).annotate({
      description: "Raw rows analyzed, whether they were all the rows available, rows dropped by rewrites and " +
        "share of the period's clicks they contain (query rows never include anonymized queries)."
    }),
    groups: Schema.Number.annotate({ description: "Number of groups before applying limit." }),
    ...Table,
    warning: Schema.optional(Schema.String),
    truncated: Schema.optional(TruncatedOutput),
    file: Schema.optional(FileOutput)
  }),
  failure: GscError
}))

export const ComparePeriods = readOnly(Tool.make("compare_periods", {
  description: "Compare a period against the previous period or the same period a year earlier. " +
    "Returns accurate totals for both periods and, if a dimension is given, the items that changed the most " +
    "(including new and lost ones). position_delta < 0 means the ranking improved. " +
    "Use it to explain traffic changes and find winners and losers; with rewrites it compares groups " +
    "(sections of the site, query topics) instead of single items.",
  parameters: Schema.Struct({
    ...periodFields,
    compareTo: Schema.optional(ComparisonMode.annotate({
      description: "\"previous\" (default): the same number of days right before. " +
        "\"yearOverYear\": the same dates one year earlier (needs data older than 12 months)."
    })),
    dimension: Schema.optional(Schema.Literals(["query", "page", "country", "device", "searchAppearance"]).annotate({
      description: "Break the change down by this dimension. Omit to get only totals."
    })),
    ...groupingFields,
    sortBy: Schema.optional(Schema.Literals(["clicks", "impressions", "position"]).annotate({
      description: "Metric whose change ranks the items. Defaults to clicks."
    })),
    direction: Schema.optional(Schema.Literals(["losses", "gains", "both"]).annotate({
      description: "\"losses\" (biggest drops first), \"gains\" or \"both\" (largest absolute change). Defaults to both."
    })),
    limit: limitParam(25, 500),
    maxRows: MaxRowsParam,
    ...fullUrlsField
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    previousStartDate: Schema.String,
    previousEndDate: Schema.String,
    totals: Schema.Struct({ current: Totals, previous: Totals }),
    changes: Schema.optional(Schema.Struct(Table)),
    truncated: Schema.optional(TruncatedOutput)
  }),
  failure: GscError
}))

export const FindOpportunities = readOnly(Tool.make("find_opportunities", {
  description: "Find query/page pairs with the most untapped clicks. " +
    "\"striking_distance\": ranking just below the top 3 (positions 4-20 by default), where moving up pays off most. " +
    "\"low_ctr\": ranking in the top positions but with a CTR far below what is expected for that position, " +
    "usually fixed by improving the title and meta description. " +
    "Expected CTR is estimated from the site's own data. Branded queries and secondary listings (sitelinks) are " +
    "excluded. Results are sorted by estimated extra clicks for the period.",
  parameters: Schema.Struct({
    ...periodFields,
    kinds: Schema.optional(Schema.Array(Schema.Literals(["striking_distance", "low_ctr"])).annotate({
      description: "Opportunity types to include. Defaults to both."
    })),
    minPosition: Schema.optional(Schema.Number.annotate({
      description: "Lowest average position (best ranking) considered striking distance. Defaults to 4."
    })),
    maxPosition: Schema.optional(Schema.Number.annotate({
      description: "Highest average position considered striking distance. Defaults to 20."
    })),
    minImpressions: MinImpressionsParam(50),
    ...brandFields,
    limit: limitParam(30, 500),
    maxRows: MaxRowsParam,
    ...fullUrlsField
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    excludedBrandTerms: Schema.Array(Schema.String),
    expectedCtrByPosition: Schema.Array(Schema.Number).annotate({
      description: "Expected CTR (%) for positions 1-10 estimated from this site."
    }),
    ...Table,
    truncated: Schema.optional(TruncatedOutput)
  }),
  failure: GscError
}))

export const DetectCannibalization = readOnly(Tool.make("detect_cannibalization", {
  description: "Find queries for which several pages of the site compete in Google, splitting impressions and " +
    "clicks. Sorted by the impressions not going to the strongest page. Jump links (#fragments) are merged " +
    "into their page and branded queries (often sitelinks, not real cannibalization) are excluded by default. " +
    "Typical fixes: consolidate content, adjust internal linking or differentiate intent. " +
    "Use query_report to see every page ranking for one query.",
  parameters: Schema.Struct({
    ...periodFields,
    minImpressions: MinImpressionsParam(100),
    minShare: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 0.5 })).annotate({
      description: "Minimum share of the query's impressions (0.01-0.5) for a page to count as competing. " +
        "Defaults to 0.1."
    })),
    ...brandFields,
    limit: limitParam(20, 200),
    maxRows: MaxRowsParam,
    ...fullUrlsField
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    excludedBrandTerms: Schema.Array(Schema.String),
    queries: Schema.Array(Schema.Struct({
      query: Schema.String,
      clicks: Schema.Number,
      impressions: Schema.Number,
      split_pct: Schema.Number,
      pages: Schema.Struct(Table)
    })),
    truncated: Schema.optional(TruncatedOutput)
  }),
  failure: GscError
}))

const PageMatch = Schema.Literals(["exact", "prefix", "regex"])

export const PageReport = readOnly(Tool.make("page_report", {
  description: "Performance report for a URL, or for a group of URLs with match \"prefix\" or \"regex\": " +
    "totals against the previous period, split by device, the queries it ranks for and, for groups, its top pages. " +
    "Google leaves anonymized queries out of per-page device and query breakdowns; breakdownCoverage tells how " +
    "much of the totals they cover.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({
      description: "URL of the page as reported by Search Console, or a path relative to `site` (\"/blog/x/\"). " +
        "With match \"prefix\", the start of the URLs; with match \"regex\", an RE2 regex (\"^/blog/\" is relative)."
    }),
    match: Schema.optional(PageMatch.annotate({ description: "How `url` selects pages. Defaults to exact." })),
    site: Schema.optional(SiteParam.annotate({
      description: "Site of the page. Required when `url` is a path or a regex; otherwise inferred from the URL."
    })),
    account: AccountParam,
    range: periodFields.range,
    startDate: periodFields.startDate,
    endDate: periodFields.endDate,
    type: periodFields.type,
    filters: periodFields.filters,
    dataState: periodFields.dataState,
    limit: limitParam(50, 1000),
    ...fullUrlsField
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    url: Schema.String,
    match: PageMatch,
    totals: Schema.Struct({ current: Totals, previous: Totals }),
    devices: Schema.Struct(Table),
    queries: Schema.Struct({ ...Table, hasMore: Schema.Boolean }),
    pages: Schema.optional(Schema.Struct({ ...Table, hasMore: Schema.Boolean })),
    breakdownCoverage: Schema.optional(Coverage),
    note: Schema.optional(Schema.String)
  }),
  failure: GscError
}))

const QueryMatch = Schema.Literals(["exact", "contains", "regex"])

export const QueryReport = readOnly(Tool.make("query_report", {
  description: "Which pages of the site rank for a query and how its clicks and impressions are split among them, " +
    "with totals against the previous period. With match \"contains\" or \"regex\" it covers a family of queries " +
    "(e.g. every query mentioning a product) and also lists the top matching queries.",
  parameters: Schema.Struct({
    ...periodFields,
    query: Schema.String.annotate({ description: "The query, a substring of queries or an RE2 regex, per `match`." }),
    match: Schema.optional(QueryMatch.annotate({ description: "How `query` selects queries. Defaults to exact." })),
    limit: limitParam(20, 500),
    ...fullUrlsField
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    query: Schema.String,
    match: QueryMatch,
    totals: Schema.Struct({ current: Totals, previous: Totals }),
    pages: Schema.Struct({ ...Table, hasMore: Schema.Boolean }),
    queries: Schema.optional(Schema.Struct({ ...Table, hasMore: Schema.Boolean }))
  }),
  failure: GscError
}))

const InspectionFields = {
  verdict: Schema.optional(Schema.String),
  coverageState: Schema.optional(Schema.String),
  indexingState: Schema.optional(Schema.String),
  robotsTxtState: Schema.optional(Schema.String),
  pageFetchState: Schema.optional(Schema.String),
  lastCrawlTime: Schema.optional(Schema.String),
  crawledAs: Schema.optional(Schema.String),
  googleCanonical: Schema.optional(Schema.String),
  userCanonical: Schema.optional(Schema.String),
  sitemaps: Schema.optional(Schema.Array(Schema.String)),
  referringUrls: Schema.optional(Schema.Array(Schema.String)),
  mobileUsability: Schema.optional(Schema.String),
  richResults: Schema.optional(Schema.String),
  richResultTypes: Schema.optional(Schema.Array(Schema.String)),
  inspectionLink: Schema.optional(Schema.String)
}

export const InspectUrl = readOnly(Tool.make("inspect_url", {
  description: "Inspect how Google indexes a URL: index verdict, coverage, canonical URLs, last crawl, " +
    "robots.txt and rich results. Quota: about 2000 inspections per site per day; results are cached for " +
    "30 minutes. Use inspect_urls for several URLs.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({ description: "Fully qualified URL, or a path relative to `site`." }),
    site: Schema.optional(SiteParam),
    account: AccountParam
  }),
  success: Schema.Struct({
    site: Schema.String,
    account: Schema.String,
    url: Schema.String,
    ...InspectionFields
  }),
  failure: GscError
}))

export const InspectUrls = readOnly(Tool.make("inspect_urls", {
  description: "Inspect up to 100 URLs of one site in a single call and get a compact table of their index " +
    "status, with an `issues` column flagging what needs attention (not indexed, noindex, blocked by robots.txt, " +
    "fetch errors, a canonical chosen by Google that differs from the declared one). Each URL uses one " +
    "inspection of the daily quota (about 2000 per site); results are cached for 30 minutes.",
  parameters: Schema.Struct({
    urls: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
      description: "Fully qualified URLs, or paths relative to `site`."
    }),
    site: Schema.optional(SiteParam.annotate({
      description: "Site of the URLs. Required when they are paths; otherwise inferred from the first URL."
    })),
    account: AccountParam,
    ...fullUrlsField
  }),
  success: Schema.Struct({
    site: Schema.String,
    account: Schema.String,
    origin: Schema.optional(Schema.String),
    summary: Schema.Record(Schema.String, Schema.Number).annotate({
      description: "Number of URLs per coverage state."
    }),
    ...Table,
    failures: Schema.Array(Schema.Struct({ url: Schema.String, message: Schema.String }))
  }),
  failure: GscError
}))

export const ListSitemaps = readOnly(Tool.make("list_sitemaps", {
  description: "List the sitemaps submitted for a site with their type, last submission and download, " +
    "number of URLs submitted, and warnings and errors reported by Google.",
  parameters: Schema.Struct({ site: SiteParam, account: AccountParam, ...fullUrlsField }),
  success: Schema.Struct({
    site: Schema.String,
    account: Schema.String,
    origin: Schema.optional(Schema.String),
    ...Table
  }),
  failure: GscError
}))

export const GscToolkit = Toolkit.make(
  ListAccounts,
  ListSites,
  SearchAnalytics,
  Aggregate,
  ComparePeriods,
  FindOpportunities,
  DetectCannibalization,
  PageReport,
  QueryReport,
  InspectUrl,
  InspectUrls,
  ListSitemaps
)

// Helpers --------------------------------------------------------------------

/** Rows shown as a preview of an exported file. */
const PREVIEW_ROWS = 10

const TRUNCATED_HINT = "Rows were left out to keep the response small. Group them with aggregate, " +
  "export them with output \"file\", or lower limit."

const deltaRank = (sortBy: "clicks" | "impressions" | "position") => (delta: PeriodDelta) =>
  sortBy === "clicks"
    ? delta.clicksDelta
    : sortBy === "impressions"
    ? delta.impressionsDelta
    // A lower position is better, so an improvement counts as a gain.
    : -(delta.positionDelta ?? 0)

/** Brand terms to exclude, or none when branded queries are requested. */
const brandTermsFor = (
  siteUrl: string,
  params: { readonly includeBranded?: boolean | undefined; readonly brandTerms?: ReadonlyArray<string> | undefined }
): ReadonlyArray<string> => {
  if (params.includeBranded) return []
  const inferred = brandFromSite(siteUrl)
  return [...new Set([...(inferred ? [inferred] : []), ...(params.brandTerms ?? [])])]
}

/** Shows the keys of a row, with pages relative to the site. */
const showKeys = (dimensions: ReadonlyArray<string>, keys: ReadonlyArray<string> | undefined, display: UrlDisplay) =>
  (keys ?? []).map((key, i) => dimensions[i] === "page" ? display.show(key) : key)

const sumTraffic = (rows: ReadonlyArray<SearchAnalyticsRow>) => {
  let clicks = 0
  let impressions = 0
  for (const row of rows) {
    clicks += row.clicks
    impressions += row.impressions
  }
  return { clicks, impressions }
}

const coverageOf = (
  part: { readonly clicks: number; readonly impressions: number },
  whole: { readonly clicks: number; readonly impressions: number }
) => ({
  // Rows grouped by page can count an impression once per page, so cap at 100.
  clicks_pct: Math.min(100, share(part.clicks, whole.clicks)),
  impressions_pct: Math.min(100, share(part.impressions, whole.impressions))
})

/**
 * Builds the key transformation of grouping tools: relative pages, merged
 * variants, time buckets and the agent's rewrites, per dimension.
 */
const keyMapper = Effect.fnUntraced(function*(
  dimensions: ReadonlyArray<string>,
  options: {
    readonly display: UrlDisplay
    readonly rewrites?: ReadonlyArray<KeyRewrite> | undefined
    readonly normalizePages?: boolean | undefined
    readonly timeGrain?: TimeGrain | undefined
  }
) {
  const mappers: Array<Array<KeyMapper>> = dimensions.map(() => [])
  for (const rewrite of options.rewrites ?? []) {
    const index = dimensions.indexOf(rewrite.dimension)
    if (index === -1) {
      return yield* new InvalidInput({
        message: `Rewrite on "${rewrite.dimension}", which is not one of the dimensions (${dimensions.join(", ")}).`
      })
    }
    mappers[index]!.push(yield* compileRewrite(rewrite))
  }
  if (options.timeGrain !== undefined && !dimensions.includes("date")) {
    return yield* new InvalidInput({ message: "timeGrain needs the date dimension." })
  }
  return (keys: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
    const result: Array<string> = []
    for (let i = 0; i < dimensions.length; i++) {
      let key: string | undefined = keys[i] ?? ""
      if (dimensions[i] === "page") key = options.display.show(options.normalizePages ? normalizePage(key) : key)
      else if (dimensions[i] === "date" && options.timeGrain !== undefined) key = timeBucket(key, options.timeGrain)
      for (const map of mappers[i]!) {
        key = map(key)
        if (key === undefined) return undefined
      }
      result.push(key)
    }
    return result
  }
})

/** States Google reports for URLs it knows nothing about, which carry no information. */
const isKnown = (state: string | undefined): state is string => state !== undefined && !state.endsWith("_UNSPECIFIED")

/** Problems worth attention in an inspection result, as short phrases. */
const inspectionIssues = (url: string, result: InspectionResult): string => {
  const index = result.indexStatusResult
  if (index === undefined) return "no index data"
  const issues: Array<string> = []
  if (index.verdict !== undefined && index.verdict !== "PASS") issues.push(index.coverageState ?? index.verdict)
  if (isKnown(index.indexingState) && index.indexingState !== "INDEXING_ALLOWED") {
    issues.push(`noindex (${index.indexingState})`)
  }
  if (index.robotsTxtState === "DISALLOWED") issues.push("blocked by robots.txt")
  if (isKnown(index.pageFetchState) && index.pageFetchState !== "SUCCESSFUL") {
    issues.push(`fetch ${index.pageFetchState}`)
  }
  if (index.googleCanonical !== undefined && index.googleCanonical !== (index.userCanonical ?? url)) {
    issues.push("Google chose a different canonical")
  }
  if (index.lastCrawlTime === undefined && index.verdict === "PASS") issues.push("not crawled")
  return issues.join("; ")
}

// Handlers -------------------------------------------------------------------

interface SiteParams {
  readonly site: string
  readonly account?: string | undefined
  readonly fullUrls?: boolean | undefined
  readonly filters?: ReadonlyArray<FilterInput> | undefined
}

interface PeriodParams extends SiteParams {
  readonly range?: RangePreset | undefined
  readonly startDate?: string | undefined
  readonly endDate?: string | undefined
  readonly type?: SearchAnalyticsRequest["type"] | undefined
  readonly dataState?: SearchAnalyticsRequest["dataState"] | undefined
}

type Dimensions = SearchAnalyticsRequest["dimensions"]

export const GscToolkitHandlers = GscToolkit.toLayer(Effect.gen(function*() {
  const store = yield* AccountStore
  const resolver = yield* SiteResolver
  const gsc = yield* GscClient
  const data = yield* SearchData
  const exporter = yield* Exporter

  // Main origin of each property, to show pages as relative paths. Domain
  // properties may live on www. or another host, so the top page decides.
  const origins = yield* Cache.makeWith(
    (key: string) => {
      const [account, siteUrl] = JSON.parse(key) as [string, string]
      const fallback = propertyOrigin(siteUrl)
      if (!siteUrl.startsWith("sc-domain:")) return Effect.succeed(fallback)
      return Effect.gen(function*() {
        const range = yield* resolveDateRange({ range: "last28d" })
        const rows = yield* data.query({
          account,
          siteUrl,
          request: { ...range, dimensions: ["page"], type: "web", filters: [], dataState: "final", rowLimit: 1, startRow: 0 }
        })
        const top = rows[0]?.keys?.[0]
        return (top === undefined ? undefined : originOf(top)) ?? fallback
      }).pipe(Effect.catch(() => Effect.succeed(fallback)))
    },
    { capacity: 200, timeToLive: () => "1 day" }
  )

  // Inspections are slow and have a daily quota, so recent results are reused.
  const inspections = yield* Cache.makeWith(
    (key: string) => {
      const { account, siteUrl, url } = JSON.parse(key) as { account: string; siteUrl: string; url: string }
      return gsc.inspectUrl(account, siteUrl, url)
    },
    { capacity: 2000, timeToLive: (exit) => Exit.isSuccess(exit) ? "30 minutes" : 0 }
  )
  const inspect = (account: string, siteUrl: string, url: string) =>
    Cache.get(inspections, JSON.stringify({ account, siteUrl, url }))

  /** Resolves site and account, the URL display and the filters. */
  const siteContext = Effect.fnUntraced(function*(params: SiteParams, options?: ResolveOptions) {
    const site = yield* resolver.resolve(params.site, params.account, options)
    const origin = yield* Cache.get(origins, JSON.stringify([site.account, site.siteUrl]))
    const display = urlDisplay(origin, params.fullUrls ?? false)
    const filters = yield* compileFilters(params.filters ?? [], display, origin)
    return { site, origin, display, filters }
  })

  /** Resolves site, account and dates into a request template. */
  const period = Effect.fnUntraced(function*(params: PeriodParams, options?: ResolveOptions) {
    const { site, origin, display, filters } = yield* siteContext(params, options)
    const range = yield* resolveDateRange(params)
    const segment = {
      type: params.type ?? "web",
      filters,
      dataState: params.dataState ?? "final"
    } as const
    const fetch = (
      dates: DateRange,
      dimensions: Dimensions,
      maxRows: number,
      extraFilters: ReadonlyArray<DimensionFilter> = []
    ) =>
      data.queryAll({
        account: site.account,
        siteUrl: site.siteUrl,
        request: { ...dates, ...segment, filters: [...filters, ...extraFilters], dimensions }
      }, maxRows)
    const base = {
      site: site.siteUrl,
      account: site.account,
      ...range,
      ...(display.origin === undefined ? {} : { origin: display.origin })
    }
    return { site, origin, range, segment, display, fetch, base }
  })

  const exportTable = Effect.fnUntraced(function*(
    tool: string,
    base: { readonly site: string; readonly startDate: string; readonly endDate: string },
    columns: ReadonlyArray<string>,
    rows: ReadonlyArray<ReadonlyArray<Cell>>,
    format: FileFormat
  ) {
    const stamp = (yield* Clock.currentTimeMillis).toString(36)
    const name = `${tool}-${fileSlug(base.site)}-${base.startDate}_${base.endDate}-${stamp}.${format}`
    const file = yield* exporter.write({ name, content: serializeTable(columns, rows, format) })
    return { path: file.path, format, rows: rows.length, bytes: file.bytes }
  })

  /** Returns a table inline within the output budget, or exports it to a file. */
  const deliverTable = Effect.fnUntraced(function*(
    tool: string,
    base: { readonly site: string; readonly startDate: string; readonly endDate: string },
    params: { readonly output?: "inline" | "file" | undefined; readonly format?: FileFormat | undefined },
    columns: ReadonlyArray<string>,
    rows: ReadonlyArray<ReadonlyArray<Cell>>
  ) {
    if (params.output === "file") {
      const file = yield* exportTable(tool, base, columns, rows, params.format ?? "csv")
      return { rows: rows.slice(0, PREVIEW_ROWS), file, truncated: undefined }
    }
    const fitted = fitRows(rows, yield* OutputBudget, {
      clicks: columns.indexOf("clicks"),
      impressions: columns.indexOf("impressions")
    })
    return { rows: fitted.rows, file: undefined, truncated: truncatedOutput(fitted.omitted, TRUNCATED_HINT) }
  })

  return GscToolkit.of({
    list_accounts: Effect.fn("list_accounts")(function*() {
      const accounts = yield* store.list
      return { accounts: accounts.map((a) => ({ alias: a.alias, email: a.email })) }
    }),

    list_sites: Effect.fn("list_sites")(function*({ account }) {
      if (account !== undefined) yield* store.get(account)
      const index = yield* resolver.index
      const bySite = new Map<string, Array<{ account: string; permission: string }>>()
      for (const site of index.sites) {
        if (account !== undefined && site.account !== account) continue
        const access = bySite.get(site.siteUrl) ?? []
        access.push({ account: site.account, permission: site.permissionLevel })
        bySite.set(site.siteUrl, access)
      }
      return {
        sites: [...bySite].sort(([a], [b]) => a.localeCompare(b)).map(([siteUrl, access]) => ({ siteUrl, access })),
        failures: index.failures.filter((f) => account === undefined || f.account === account)
      }
    }),

    search_analytics: Effect.fn("search_analytics")(function*(params) {
      const { site, range, segment, display, fetch, base } = yield* period(params)
      const dimensions = params.dimensions ?? []
      const limit = params.limit ?? 100
      const rows = yield* data.queryAll({
        account: site.account,
        siteUrl: site.siteUrl,
        request: { ...range, ...segment, dimensions }
      }, limit, params.startRow ?? 0)
      const hasMore = rows.length === limit && dimensions.length > 0

      let coverage: { clicks_pct: number; impressions_pct: number } | undefined
      let warning: string | undefined
      if (hasMore) {
        coverage = coverageOf(sumTraffic(rows), totalsOf(yield* fetch(range, [], 1)))
        warning = `More rows are available: these ${rows.length} rows hold ${coverage.clicks_pct}% of the clicks. ` +
          "Group rows server-side with aggregate, export up to 100000 rows with output \"file\", or page with startRow."
      }

      const columns = [...dimensions, ...METRIC_COLUMNS]
      const table = rows.map((row) => [...showKeys(dimensions, row.keys, display), ...metrics(row)])
      const delivered = yield* deliverTable("search_analytics", base, params, columns, table)
      return compact({ ...base, columns, ...delivered, hasMore, coverage, warning })
    }),

    aggregate: Effect.fn("aggregate")(function*(params) {
      const { range, display, fetch, base } = yield* period(params)
      const dimensions = params.dimensions
      const maxRows = params.maxRows ?? PAGE_SIZE
      const mapKeys = yield* keyMapper(dimensions, { ...params, display })
      const [rows, totals] = yield* Effect.all([fetch(range, dimensions, maxRows), fetch(range, [], 1)], {
        concurrency: "unbounded"
      })
      const { groups, dropped } = aggregateRows(rows, mapKeys)

      const sortBy = params.sortBy ?? (dimensions.includes("date") ? "key" : "clicks")
      const ascending = (params.order ?? (sortBy === "key" || sortBy === "position" ? "asc" : "desc")) === "asc"
      const value = (group: (typeof groups)[number]) =>
        sortBy === "clicks"
          ? group.clicks
          : sortBy === "impressions"
          ? group.impressions
          : sortBy === "ctr"
          ? (group.impressions > 0 ? group.clicks / group.impressions : 0)
          : group.position
      const selected = groups
        .filter((group) => group.impressions >= (params.minImpressions ?? 0))
        .sort((a, b) => {
          const order = sortBy === "key"
            ? a.keys.join("\u0000").localeCompare(b.keys.join("\u0000"))
            : value(a) - value(b)
          return ascending ? order : -order
        })

      const complete = rows.length < maxRows
      const columns = [...dimensions, ...METRIC_COLUMNS, "rows"]
      const table = selected.slice(0, params.limit ?? 100).map((group) => [
        ...group.keys,
        ...metrics(toSearchRow(group)),
        group.rows
      ])
      const delivered = yield* deliverTable("aggregate", base, params, columns, table)
      return compact({
        ...base,
        source: {
          rows: rows.length,
          complete,
          droppedRows: dropped.rows,
          clicks_coverage_pct: coverageOf(sumTraffic(rows), totalsOf(totals)).clicks_pct
        },
        groups: selected.length,
        columns,
        ...delivered,
        warning: complete
          ? undefined
          : `Only the top ${maxRows} rows by clicks were grouped; raise maxRows (up to 100000) for complete data.`
      })
    }),

    compare_periods: Effect.fn("compare_periods")(function*(params) {
      const { range, display, fetch, base: periodBase } = yield* period(params)
      const previous = comparisonRange(range, params.compareTo ?? "previous")
      const maxRows = params.maxRows ?? PAGE_SIZE
      const dimension = params.dimension

      // Totals come from dedicated requests: summing dimension rows misses anonymized queries.
      const [currentTotals, previousTotals, currentRows, previousRows] = yield* Effect.all([
        fetch(range, [], 1),
        fetch(previous, [], 1),
        dimension ? fetch(range, [dimension], maxRows) : Effect.succeed([]),
        dimension ? fetch(previous, [dimension], maxRows) : Effect.succeed([])
      ], { concurrency: "unbounded" })

      const base = {
        ...periodBase,
        previousStartDate: previous.startDate,
        previousEndDate: previous.endDate,
        totals: { current: totalsOf(currentTotals), previous: totalsOf(previousTotals) }
      }
      if (!dimension) return base

      const mapKeys = yield* keyMapper([dimension], { ...params, display })
      const group = (rows: ReadonlyArray<SearchAnalyticsRow>) => aggregateRows(rows, mapKeys).groups.map(toSearchRow)
      const rank = deltaRank(params.sortBy ?? "clicks")
      const direction = params.direction ?? "both"
      const changes = comparePeriods(group(currentRows), group(previousRows))
        .filter((d) => direction === "both" ? rank(d) !== 0 : direction === "gains" ? rank(d) > 0 : rank(d) < 0)
        .sort((a, b) =>
          direction === "losses"
            ? rank(a) - rank(b)
            : direction === "gains"
            ? rank(b) - rank(a)
            : Math.abs(rank(b)) - Math.abs(rank(a))
        )
        .slice(0, params.limit ?? 25)

      const rows = changes.map((d) => [
        d.keys[0] ?? "",
        d.current?.clicks ?? 0,
        d.previous?.clicks ?? 0,
        d.clicksDelta,
        d.current?.impressions ?? 0,
        d.previous?.impressions ?? 0,
        d.current ? pct(d.current.ctr) : null,
        d.previous ? pct(d.previous.ctr) : null,
        d.current ? pos(d.current.position) : null,
        d.previous ? pos(d.previous.position) : null,
        d.positionDelta === undefined ? null : pos(d.positionDelta)
      ])
      const fitted = fitRows(rows, yield* OutputBudget, { clicks: 1, impressions: 4 })
      return compact({
        ...base,
        changes: {
          columns: [
            dimension,
            "clicks",
            "clicks_prev",
            "clicks_delta",
            "impressions",
            "impressions_prev",
            "ctr_pct",
            "ctr_pct_prev",
            "position",
            "position_prev",
            "position_delta"
          ],
          rows: fitted.rows
        },
        truncated: truncatedOutput(fitted.omitted, "Lower limit to see fewer, larger changes.")
      })
    }),

    find_opportunities: Effect.fn("find_opportunities")(function*(params) {
      const { site, range, display, fetch, base } = yield* period(params)
      const rows = yield* fetch(range, ["query", "page"], params.maxRows ?? PAGE_SIZE)
      const brandTerms = brandTermsFor(site.siteUrl, params)
      const { curve, opportunities } = findOpportunities(rows, {
        kinds: params.kinds ?? ["striking_distance", "low_ctr"],
        minImpressions: params.minImpressions ?? 50,
        strikingRange: [params.minPosition ?? 4, params.maxPosition ?? 20],
        isBranded: brandTerms.length > 0 ? brandMatcher(brandTerms) : undefined
      })
      const table = opportunities.slice(0, params.limit ?? 30).map((o) => [
        o.kind,
        ...showKeys(["query", "page"], o.row.keys, display),
        ...metrics(o.row),
        pct(o.expectedCtr),
        Math.round(o.potentialClicks)
      ])
      const fitted = fitRows(table, yield* OutputBudget, { clicks: 3, impressions: 4 })
      return compact({
        ...base,
        excludedBrandTerms: brandTerms,
        expectedCtrByPosition: curve.slice(0, 10).map(pct),
        columns: ["kind", "query", "page", ...METRIC_COLUMNS, "expected_ctr_pct", "potential_clicks"],
        rows: fitted.rows,
        truncated: truncatedOutput(fitted.omitted, "Lower limit or raise minImpressions.")
      })
    }),

    detect_cannibalization: Effect.fn("detect_cannibalization")(function*(params) {
      const { site, range, display, fetch, base } = yield* period(params)
      const rows = yield* fetch(range, ["query", "page"], params.maxRows ?? PAGE_SIZE)
      const brandTerms = brandTermsFor(site.siteUrl, params)
      const issues = detectCannibalization(rows, {
        minImpressions: params.minImpressions ?? 100,
        minShare: params.minShare ?? 0.1,
        isBranded: brandTerms.length > 0 ? brandMatcher(brandTerms) : undefined
      })
      const queries = issues.slice(0, params.limit ?? 20).map((issue) => ({
        query: issue.query,
        clicks: issue.clicks,
        impressions: issue.impressions,
        split_pct: share(issue.split, 1),
        pages: {
          columns: ["page", "clicks", "impressions", "position"],
          rows: issue.pages.slice(0, 5).map((p) => [display.show(p.page), p.clicks, p.impressions, pos(p.position)])
        }
      }))
      const fitted = fitItems(queries, yield* OutputBudget, (q) => [q.clicks, q.impressions])
      return compact({
        ...base,
        excludedBrandTerms: brandTerms,
        queries: fitted.items,
        truncated: truncatedOutput(fitted.omitted, "Lower limit or raise minImpressions.")
      })
    }),

    page_report: Effect.fn("page_report")(function*(params) {
      const match = params.match ?? "exact"
      const isPattern = match === "regex" || params.url.startsWith("/")
      if (isPattern && params.site === undefined) {
        return yield* new InvalidInput({ message: "Pass `site` when `url` is a path or a regex." })
      }
      const { range, display, origin, fetch, base } = yield* period(
        { ...params, site: params.site ?? params.url },
        { preferDomain: params.site === undefined }
      )
      const target = match === "regex" ? params.url : display.expand(params.url)
      const [pageFilter] = yield* compileFilters([
        match === "exact"
          ? { dimension: "page", operator: "equals", expression: target }
          : { dimension: "page", operator: "includingRegex", expression: match === "prefix" ? `^${escapeRegex(target)}` : target }
      ], display, origin)
      const onPage = [pageFilter!]
      const previous = comparisonRange(range, "previous")
      const limit = params.limit ?? 50

      const [current, before, devices, queries, pages] = yield* Effect.all([
        fetch(range, [], 1, onPage),
        fetch(previous, [], 1, onPage),
        fetch(range, ["device"], 10, onPage),
        fetch(range, ["query"], limit, onPage),
        match === "exact" ? Effect.succeed(undefined) : fetch(range, ["page"], 25, onPage)
      ], { concurrency: "unbounded" })

      const totals = totalsOf(current)
      const breakdownCoverage = coverageOf(sumTraffic(devices), totals)
      return compact({
        ...base,
        url: match === "regex" ? params.url : display.show(target),
        match,
        totals: { current: totals, previous: totalsOf(before) },
        devices: {
          columns: ["device", ...METRIC_COLUMNS],
          rows: devices.map((row) => [...(row.keys ?? []), ...metrics(row)])
        },
        queries: {
          columns: ["query", ...METRIC_COLUMNS],
          rows: queries.map((row) => [...(row.keys ?? []), ...metrics(row)]),
          hasMore: queries.length === limit
        },
        pages: pages === undefined ? undefined : {
          columns: ["page", ...METRIC_COLUMNS],
          rows: pages.map((row) => [...showKeys(["page"], row.keys, display), ...metrics(row)]),
          hasMore: pages.length === 25
        },
        breakdownCoverage,
        note: breakdownCoverage.clicks_pct < 95 && totals.clicks > 0
          ? `Devices and queries cover ${breakdownCoverage.clicks_pct}% of the clicks: Google leaves anonymized ` +
            "queries out of per-page breakdowns. The totals include them."
          : undefined
      })
    }),

    query_report: Effect.fn("query_report")(function*(params) {
      const { range, display, fetch, base } = yield* period(params)
      const match = params.match ?? "exact"
      const onQuery: Array<DimensionFilter> = [{
        dimension: "query",
        operator: match === "exact" ? "equals" : match === "contains" ? "contains" : "includingRegex",
        expression: params.query
      }]
      const previous = comparisonRange(range, "previous")
      const limit = params.limit ?? 20

      const [current, before, pageRows, queries] = yield* Effect.all([
        fetch(range, [], 1, onQuery),
        fetch(previous, [], 1, onQuery),
        fetch(range, ["page"], 1000, onQuery),
        match === "exact" ? Effect.succeed(undefined) : fetch(range, ["query"], limit, onQuery)
      ], { concurrency: "unbounded" })

      const pages = aggregateRows(pageRows, ([page]) => [display.show(withoutFragment(page ?? ""))]).groups
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      const all = sumTraffic(pageRows)
      return compact({
        ...base,
        query: params.query,
        match,
        totals: { current: totalsOf(current), previous: totalsOf(before) },
        pages: {
          columns: ["page", ...METRIC_COLUMNS, "clicks_share_pct", "impressions_share_pct"],
          rows: pages.slice(0, limit).map((page) => [
            page.keys[0] ?? "",
            ...metrics(toSearchRow(page)),
            share(page.clicks, all.clicks),
            share(page.impressions, all.impressions)
          ]),
          hasMore: pages.length > limit
        },
        queries: queries === undefined ? undefined : {
          columns: ["query", ...METRIC_COLUMNS],
          rows: queries.map((row) => [...(row.keys ?? []), ...metrics(row)]),
          hasMore: queries.length === limit
        }
      })
    }),

    inspect_url: Effect.fn("inspect_url")(function*({ url, site, account }) {
      if (url.startsWith("/") && site === undefined) {
        return yield* new InvalidInput({ message: "Pass `site` when `url` is a path." })
      }
      const { site: resolved, display } = yield* siteContext(
        { site: site ?? url, account, fullUrls: true },
        { preferDomain: site === undefined }
      )
      const target = display.expand(url)
      const result = yield* inspect(resolved.account, resolved.siteUrl, target)
      const index = result.indexStatusResult
      const richResultTypes = result.richResultsResult?.detectedItems?.flatMap((item) =>
        item.richResultType ? [item.richResultType] : []
      )
      return compact({
        site: resolved.siteUrl,
        account: resolved.account,
        url: target,
        verdict: index?.verdict,
        coverageState: index?.coverageState,
        indexingState: index?.indexingState,
        robotsTxtState: index?.robotsTxtState,
        pageFetchState: index?.pageFetchState,
        lastCrawlTime: index?.lastCrawlTime,
        crawledAs: index?.crawledAs,
        googleCanonical: index?.googleCanonical,
        userCanonical: index?.userCanonical,
        sitemaps: index?.sitemap,
        referringUrls: index?.referringUrls?.slice(0, 10),
        mobileUsability: result.mobileUsabilityResult?.verdict,
        richResults: result.richResultsResult?.verdict,
        richResultTypes,
        inspectionLink: result.inspectionResultLink
      })
    }),

    inspect_urls: Effect.fn("inspect_urls")(function*(params) {
      const firstAbsolute = params.urls.find((url) => !url.startsWith("/"))
      const siteInput = params.site ?? firstAbsolute
      if (siteInput === undefined) {
        return yield* new InvalidInput({ message: "Pass `site` when the URLs are paths." })
      }
      const { site, display } = yield* siteContext(
        { site: siteInput, account: params.account, fullUrls: params.fullUrls },
        { preferDomain: params.site === undefined }
      )
      const progress = yield* Progress
      let done = 0
      const results = yield* Effect.forEach(params.urls, (url) => {
        const target = display.expand(url)
        return inspect(site.account, site.siteUrl, target).pipe(
          Effect.result,
          Effect.tap(() => progress.report(++done, params.urls.length, `Inspected ${done} of ${params.urls.length} URLs`)),
          Effect.map((result) => ({ url: target, result }))
        )
      }, { concurrency: 5 })

      const summary: Record<string, number> = {}
      const rows: Array<Array<Cell>> = []
      const failures: Array<{ url: string; message: string }> = []
      const canonical = (url: string, value: string | undefined) =>
        value === undefined ? null : value === url ? "=" : display.show(value)
      for (const { url, result } of results) {
        if (result._tag === "Failure") {
          failures.push({ url: display.show(url), message: result.failure.message })
          continue
        }
        const index = result.success.indexStatusResult
        const state = index?.coverageState ?? "Unknown"
        summary[state] = (summary[state] ?? 0) + 1
        rows.push([
          display.show(url),
          index?.verdict ?? null,
          index?.coverageState ?? null,
          index?.indexingState ?? null,
          index?.lastCrawlTime?.slice(0, 10) ?? null,
          canonical(url, index?.googleCanonical),
          canonical(url, index?.userCanonical),
          inspectionIssues(url, result.success)
        ])
      }
      return compact({
        site: site.siteUrl,
        account: site.account,
        origin: display.origin,
        summary,
        columns: [
          "url",
          "verdict",
          "coverage",
          "indexing",
          "last_crawl",
          "google_canonical",
          "user_canonical",
          "issues"
        ],
        rows,
        failures
      })
    }),

    list_sitemaps: Effect.fn("list_sitemaps")(function*(params) {
      const { site, display } = yield* siteContext(params)
      const sitemaps = yield* gsc.listSitemaps(site.account, site.siteUrl)
      const count = (value: string | number | undefined) => value === undefined ? 0 : Number(value)
      return compact({
        site: site.siteUrl,
        account: site.account,
        origin: display.origin,
        columns: ["path", "type", "is_index", "pending", "last_submitted", "last_downloaded", "submitted", "warnings", "errors"],
        rows: sitemaps.map((sitemap) => [
          display.show(sitemap.path),
          sitemap.type ?? null,
          sitemap.isSitemapsIndex === undefined ? null : String(sitemap.isSitemapsIndex),
          sitemap.isPending === undefined ? null : String(sitemap.isPending),
          sitemap.lastSubmitted?.slice(0, 10) ?? null,
          sitemap.lastDownloaded?.slice(0, 10) ?? null,
          (sitemap.contents ?? []).reduce((sum, content) => sum + count(content.submitted), 0),
          count(sitemap.warnings),
          count(sitemap.errors)
        ])
      })
    })
  })
}))

export const SERVER_INSTRUCTIONS = [
  "Read-only access to Google Search Console data across several Google accounts.",
  "Start with list_sites to discover properties; pass a plain domain or URL as `site` and the server picks the property and account.",
  "For analysis prefer compare_periods (what changed), find_opportunities (what to optimize next), " +
  "detect_cannibalization (pages competing for the same query), page_report (one URL or a section) and " +
  "query_report (which pages rank for a query). For indexing use inspect_urls and list_sitemaps.",
  "For bulk or custom analysis use aggregate: it groups thousands of rows server-side with regex rewrites " +
  "(sections, URL variants, tokens extracted from queries) and time grains, and returns a small table. " +
  "If you need raw rows for your own scripts, use output \"file\" instead of large inline limits.",
  "Page URLs are shown relative to `origin` (\"/blog/x\"); filters and page parameters accept those paths.",
  "Performance data lags about 3 days and covers the last 16 months. Results are tables: read `columns` for " +
  "their meaning; ctr_pct is a percentage. Large tables are cut to fit the response and say so in `truncated`. " +
  "Results are cached, so repeating a query is cheap."
].join("\n")

/** Registers the toolkit on whatever MCP transport the application provides. */
export const GscMcpTools = McpServer.toolkit(GscToolkit).pipe(
  Layer.provide(GscToolkitHandlers.pipe(Layer.provide(ProgressMcp)))
)
