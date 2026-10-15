import { Effect, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { AccountStore } from "./AccountStore.ts"
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
  DimensionFilter,
  type SearchAnalyticsRequest,
  type SearchAnalyticsRow,
  SearchType
} from "./Domain.ts"
import { GscError } from "./Errors.ts"
import { GscClient } from "./GscClient.ts"
import { PAGE_SIZE, SearchData } from "./SearchData.ts"
import { SiteResolver } from "./SiteResolver.ts"

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
  filters: Schema.optional(Schema.Array(DimensionFilter).annotate({
    description: "Filters combined with AND, e.g. [{\"dimension\":\"page\",\"operator\":\"contains\",\"expression\":\"/blog/\"}]. " +
      "Regex operators use RE2 syntax."
  })),
  dataState: Schema.optional(DataState.annotate({
    description: "\"final\" (default) or \"all\" to include fresh, not yet finalized data."
  }))
}

const limitParam = (defaultValue: number, maximum: number) =>
  Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum })).annotate({
    description: `Maximum results to return (1-${maximum}). Defaults to ${defaultValue}.`
  }))

const MaxRowsParam = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 100_000 })).annotate({
  description: "Rows of raw data to analyze (1000-100000, sorted by clicks). Defaults to 25000, one API request. " +
    "Raise it only for very large sites; every 25000 rows is one more request."
}))

const MinImpressionsParam = (defaultValue: number) =>
  Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: `Ignore rows with fewer impressions than this. Defaults to ${defaultValue}; ` +
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

const Cell = Schema.Union([Schema.String, Schema.Number, Schema.Null])
const Table = {
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Cell))
}

const PeriodOutput = {
  site: Schema.String,
  account: Schema.String,
  startDate: Schema.String,
  endDate: Schema.String
}

const Totals = Schema.Struct({
  clicks: Schema.Number,
  impressions: Schema.Number,
  ctr_pct: Schema.Number,
  position: Schema.Number
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
    "Prefer the specialized tools (compare_periods, find_opportunities, detect_cannibalization, page_report) " +
    "for analysis: they aggregate server-side and return far fewer rows.",
  parameters: Schema.Struct({
    ...periodFields,
    dimensions: Schema.optional(Schema.Array(Dimension).annotate({
      description: "Dimensions to group by, e.g. [\"query\"] or [\"page\", \"query\"]. Empty means totals."
    })),
    limit: limitParam(100, PAGE_SIZE),
    startRow: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Zero-based row offset for pagination. Defaults to 0."
    }))
  }),
  success: Schema.Struct({ ...PeriodOutput, ...Table, hasMore: Schema.Boolean }),
  failure: GscError
}))

export const ComparePeriods = readOnly(Tool.make("compare_periods", {
  description: "Compare a period against the previous period or the same period a year earlier. " +
    "Returns accurate totals for both periods and, if a dimension is given, the items that changed the most " +
    "(including new and lost ones). position_delta < 0 means the ranking improved. " +
    "Use it to explain traffic changes and find winners and losers.",
  parameters: Schema.Struct({
    ...periodFields,
    compareTo: Schema.optional(ComparisonMode.annotate({
      description: "\"previous\" (default): the same number of days right before. " +
        "\"yearOverYear\": the same dates one year earlier (needs data older than 12 months)."
    })),
    dimension: Schema.optional(Schema.Literals(["query", "page", "country", "device", "searchAppearance"]).annotate({
      description: "Break the change down by this dimension. Omit to get only totals."
    })),
    sortBy: Schema.optional(Schema.Literals(["clicks", "impressions", "position"]).annotate({
      description: "Metric whose change ranks the items. Defaults to clicks."
    })),
    direction: Schema.optional(Schema.Literals(["losses", "gains", "both"]).annotate({
      description: "\"losses\" (biggest drops first), \"gains\" or \"both\" (largest absolute change). Defaults to both."
    })),
    limit: limitParam(25, 500),
    maxRows: MaxRowsParam
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    previousStartDate: Schema.String,
    previousEndDate: Schema.String,
    totals: Schema.Struct({ current: Totals, previous: Totals }),
    changes: Schema.optional(Schema.Struct(Table))
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
    maxRows: MaxRowsParam
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    excludedBrandTerms: Schema.Array(Schema.String),
    expectedCtrByPosition: Schema.Array(Schema.Number).annotate({
      description: "Expected CTR (%) for positions 1-10 estimated from this site."
    }),
    ...Table
  }),
  failure: GscError
}))

export const DetectCannibalization = readOnly(Tool.make("detect_cannibalization", {
  description: "Find queries for which several pages of the site compete in Google, splitting impressions and " +
    "clicks. Sorted by the impressions not going to the strongest page. Jump links (#fragments) are merged " +
    "into their page and branded queries (often sitelinks, not real cannibalization) are excluded by default. " +
    "Typical fixes: consolidate content, adjust internal linking or differentiate intent.",
  parameters: Schema.Struct({
    ...periodFields,
    minImpressions: MinImpressionsParam(100),
    minShare: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 0.5 })).annotate({
      description: "Minimum share of the query's impressions (0.01-0.5) for a page to count as competing. " +
        "Defaults to 0.1."
    })),
    ...brandFields,
    limit: limitParam(20, 200),
    maxRows: MaxRowsParam
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
    }))
  }),
  failure: GscError
}))

export const PageReport = readOnly(Tool.make("page_report", {
  description: "Performance report for a single URL: totals against the previous period, " +
    "split by device, and the queries it ranks for.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({ description: "Exact URL of the page, as reported by Search Console." }),
    site: Schema.optional(SiteParam),
    account: AccountParam,
    range: periodFields.range,
    startDate: periodFields.startDate,
    endDate: periodFields.endDate,
    type: periodFields.type,
    dataState: periodFields.dataState,
    limit: limitParam(50, 1000)
  }),
  success: Schema.Struct({
    ...PeriodOutput,
    url: Schema.String,
    totals: Schema.Struct({ current: Totals, previous: Totals }),
    devices: Schema.Struct(Table),
    queries: Schema.Struct({ ...Table, hasMore: Schema.Boolean })
  }),
  failure: GscError
}))

export const InspectUrl = readOnly(Tool.make("inspect_url", {
  description: "Inspect how Google indexes a URL: index verdict, coverage, canonical URLs, last crawl, " +
    "robots.txt and rich results. Quota: about 2000 inspections per site per day.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({ description: "Fully qualified URL to inspect." }),
    site: Schema.optional(SiteParam),
    account: AccountParam
  }),
  success: Schema.Struct({
    site: Schema.String,
    account: Schema.String,
    url: Schema.String,
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
  }),
  failure: GscError
}))

export const GscToolkit = Toolkit.make(
  ListAccounts,
  ListSites,
  SearchAnalytics,
  ComparePeriods,
  FindOpportunities,
  DetectCannibalization,
  PageReport,
  InspectUrl
)

// Formatting -----------------------------------------------------------------

// MCP structured content must be plain JSON, so absent fields are dropped
// instead of being sent as `undefined`.
const compact = <A extends Record<string, unknown>>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as A

const round = (value: number, digits: number) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const pct = (ctr: number) => round(ctr * 100, 2)
const pos = (position: number) => round(position, 1)

const metrics = (row: SearchAnalyticsRow) => [row.clicks, row.impressions, pct(row.ctr), pos(row.position)]

const METRIC_COLUMNS = ["clicks", "impressions", "ctr_pct", "position"]

const EMPTY_ROW: SearchAnalyticsRow = { clicks: 0, impressions: 0, ctr: 0, position: 0 }

const totals = (rows: ReadonlyArray<SearchAnalyticsRow>) => {
  const row = rows[0] ?? EMPTY_ROW
  return { clicks: row.clicks, impressions: row.impressions, ctr_pct: pct(row.ctr), position: pos(row.position) }
}

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

// Handlers -------------------------------------------------------------------

interface PeriodParams {
  readonly site: string
  readonly account?: string | undefined
  readonly range?: RangePreset | undefined
  readonly startDate?: string | undefined
  readonly endDate?: string | undefined
  readonly type?: SearchAnalyticsRequest["type"] | undefined
  readonly filters?: SearchAnalyticsRequest["filters"] | undefined
  readonly dataState?: SearchAnalyticsRequest["dataState"] | undefined
}

export const GscToolkitHandlers = GscToolkit.toLayer(Effect.gen(function*() {
  const store = yield* AccountStore
  const resolver = yield* SiteResolver
  const gsc = yield* GscClient
  const data = yield* SearchData

  /** Resolves site, account and dates into a request template. */
  const period = Effect.fnUntraced(function*(params: PeriodParams) {
    const site = yield* resolver.resolve(params.site, params.account)
    const range = yield* resolveDateRange(params)
    const segment = {
      type: params.type ?? "web",
      filters: params.filters ?? [],
      dataState: params.dataState ?? "final"
    } as const
    const fetch = (dates: DateRange, dimensions: ReadonlyArray<SearchAnalyticsRequest["dimensions"][number]>, maxRows: number) =>
      data.queryAll({ account: site.account, siteUrl: site.siteUrl, request: { ...dates, ...segment, dimensions } }, maxRows)
    return { site, range, segment, fetch }
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
      const { site, range, segment } = yield* period(params)
      const dimensions = params.dimensions ?? []
      const limit = params.limit ?? 100
      const rows = yield* data.query({
        account: site.account,
        siteUrl: site.siteUrl,
        request: { ...range, ...segment, dimensions, rowLimit: limit, startRow: params.startRow ?? 0 }
      })
      return {
        site: site.siteUrl,
        account: site.account,
        ...range,
        columns: [...dimensions, ...METRIC_COLUMNS],
        rows: rows.map((row) => [...(row.keys ?? []), ...metrics(row)]),
        hasMore: rows.length === limit
      }
    }),

    compare_periods: Effect.fn("compare_periods")(function*(params) {
      const { site, range, fetch } = yield* period(params)
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
        site: site.siteUrl,
        account: site.account,
        ...range,
        previousStartDate: previous.startDate,
        previousEndDate: previous.endDate,
        totals: { current: totals(currentTotals), previous: totals(previousTotals) }
      }
      if (!dimension) return base

      const rank = deltaRank(params.sortBy ?? "clicks")
      const direction = params.direction ?? "both"
      const changes = comparePeriods(currentRows, previousRows)
        .filter((d) => direction === "both" ? rank(d) !== 0 : direction === "gains" ? rank(d) > 0 : rank(d) < 0)
        .sort((a, b) => direction === "losses" ? rank(a) - rank(b) : direction === "gains" ? rank(b) - rank(a) : Math.abs(rank(b)) - Math.abs(rank(a)))
        .slice(0, params.limit ?? 25)

      return {
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
          rows: changes.map((d) => [
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
        }
      }
    }),

    find_opportunities: Effect.fn("find_opportunities")(function*(params) {
      const { site, range, fetch } = yield* period(params)
      const rows = yield* fetch(range, ["query", "page"], params.maxRows ?? PAGE_SIZE)
      const brandTerms = brandTermsFor(site.siteUrl, params)
      const { curve, opportunities } = findOpportunities(rows, {
        kinds: params.kinds ?? ["striking_distance", "low_ctr"],
        minImpressions: params.minImpressions ?? 50,
        strikingRange: [params.minPosition ?? 4, params.maxPosition ?? 20],
        isBranded: brandTerms.length > 0 ? brandMatcher(brandTerms) : undefined
      })
      return {
        site: site.siteUrl,
        account: site.account,
        ...range,
        excludedBrandTerms: brandTerms,
        expectedCtrByPosition: curve.slice(0, 10).map(pct),
        columns: ["kind", "query", "page", ...METRIC_COLUMNS, "expected_ctr_pct", "potential_clicks"],
        rows: opportunities.slice(0, params.limit ?? 30).map((o) => [
          o.kind,
          ...(o.row.keys ?? []),
          ...metrics(o.row),
          pct(o.expectedCtr),
          Math.round(o.potentialClicks)
        ])
      }
    }),

    detect_cannibalization: Effect.fn("detect_cannibalization")(function*(params) {
      const { site, range, fetch } = yield* period(params)
      const rows = yield* fetch(range, ["query", "page"], params.maxRows ?? PAGE_SIZE)
      const brandTerms = brandTermsFor(site.siteUrl, params)
      const issues = detectCannibalization(rows, {
        minImpressions: params.minImpressions ?? 100,
        minShare: params.minShare ?? 0.1,
        isBranded: brandTerms.length > 0 ? brandMatcher(brandTerms) : undefined
      })
      return {
        site: site.siteUrl,
        account: site.account,
        ...range,
        excludedBrandTerms: brandTerms,
        queries: issues.slice(0, params.limit ?? 20).map((issue) => ({
          query: issue.query,
          clicks: issue.clicks,
          impressions: issue.impressions,
          split_pct: round(issue.split * 100, 1),
          pages: {
            columns: ["page", "clicks", "impressions", "position"],
            rows: issue.pages.slice(0, 5).map((p) => [p.page, p.clicks, p.impressions, pos(p.position)])
          }
        }))
      }
    }),

    page_report: Effect.fn("page_report")(function*(params) {
      const { site, range, segment } = yield* period({ ...params, site: params.site ?? params.url })
      const previous = comparisonRange(range, "previous")
      const limit = params.limit ?? 50
      const onPage = { ...segment, filters: [{ dimension: "page", operator: "equals", expression: params.url }] } as const
      const request = (dates: DateRange, dimensions: SearchAnalyticsRequest["dimensions"], rowLimit: number) =>
        data.query({
          account: site.account,
          siteUrl: site.siteUrl,
          request: { ...dates, ...onPage, dimensions, rowLimit, startRow: 0 }
        })

      const [current, before, devices, queries] = yield* Effect.all([
        request(range, [], 1),
        request(previous, [], 1),
        request(range, ["device"], 10),
        request(range, ["query"], limit)
      ], { concurrency: "unbounded" })

      return {
        site: site.siteUrl,
        account: site.account,
        ...range,
        url: params.url,
        totals: { current: totals(current), previous: totals(before) },
        devices: {
          columns: ["device", ...METRIC_COLUMNS],
          rows: devices.map((row) => [...(row.keys ?? []), ...metrics(row)])
        },
        queries: {
          columns: ["query", ...METRIC_COLUMNS],
          rows: queries.map((row) => [...(row.keys ?? []), ...metrics(row)]),
          hasMore: queries.length === limit
        }
      }
    }),

    inspect_url: Effect.fn("inspect_url")(function*({ url, site, account }) {
      const resolved = yield* resolver.resolve(site ?? url, account)
      const result = yield* gsc.inspectUrl(resolved.account, resolved.siteUrl, url)
      const index = result.indexStatusResult
      const richResultTypes = result.richResultsResult?.detectedItems?.flatMap((item) =>
        item.richResultType ? [item.richResultType] : []
      )
      return compact({
        site: resolved.siteUrl,
        account: resolved.account,
        url,
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
    })
  })
}))

export const SERVER_INSTRUCTIONS = [
  "Read-only access to Google Search Console data across several Google accounts.",
  "Start with list_sites to discover properties; pass a plain domain or URL as `site` and the server picks the property and account.",
  "For analysis prefer compare_periods (what changed), find_opportunities (what to optimize next), " +
  "detect_cannibalization (pages competing for the same query) and page_report (one URL); " +
  "use search_analytics for custom raw queries.",
  "Performance data lags about 3 days and covers the last 16 months. Results are tables: read `columns` for " +
  "their meaning; ctr_pct is a percentage. Identical queries are cached for 15 minutes."
].join("\n")

/** Registers the toolkit on whatever MCP transport the application provides. */
export const GscMcpTools = McpServer.toolkit(GscToolkit).pipe(Layer.provide(GscToolkitHandlers))
