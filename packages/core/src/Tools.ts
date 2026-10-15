import { Effect, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { AccountStore } from "./AccountStore.ts"
import { DataState, Dimension, DimensionFilter, SearchType } from "./Domain.ts"
import { resolveDateRange, RangePreset } from "./DateRange.ts"
import { GscError } from "./Errors.ts"
import { GscClient } from "./GscClient.ts"
import { SiteResolver } from "./SiteResolver.ts"

const SiteParam = Schema.String.annotate({
  description: "Site to query: a domain (example.com), a URL (https://example.com/blog/) " +
    "or an exact Search Console property (sc-domain:example.com). Resolved to the best matching property."
})

const AccountParam = Schema.optional(Schema.String.annotate({
  description: "Account alias to use. Optional: by default the account with the highest permission on the site is used."
}))

const readOnly = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true) as T

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
  description: "Query Search Console performance data (clicks, impressions, CTR, average position), " +
    "grouped by the given dimensions and sorted by clicks. Data is available for the last 16 months " +
    "and finalized with a delay of about 3 days. Without dimensions, returns the totals for the period.",
  parameters: Schema.Struct({
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
    dimensions: Schema.optional(Schema.Array(Dimension).annotate({
      description: "Dimensions to group by, e.g. [\"query\"] or [\"page\", \"query\"]. Empty means totals."
    })),
    type: Schema.optional(SearchType.annotate({ description: "Search type. Defaults to web." })),
    filters: Schema.optional(Schema.Array(DimensionFilter).annotate({
      description: "Filters combined with AND. Regex operators use RE2 syntax."
    })),
    dataState: Schema.optional(DataState.annotate({
      description: "\"final\" (default) or \"all\" to include fresh, not yet finalized data."
    })),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25000 })).annotate({
      description: "Maximum rows to return (1-25000). Defaults to 100."
    })),
    startRow: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Zero-based row offset for pagination. Defaults to 0."
    }))
  }),
  success: Schema.Struct({
    site: Schema.String,
    account: Schema.String,
    startDate: Schema.String,
    endDate: Schema.String,
    columns: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
    hasMore: Schema.Boolean
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

export const GscToolkit = Toolkit.make(ListAccounts, ListSites, SearchAnalytics, InspectUrl)

// MCP structured content must be plain JSON, so absent fields are dropped
// instead of being sent as `undefined`.
const compact = <A extends Record<string, unknown>>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as A

const round = (value: number, digits: number) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export const GscToolkitHandlers = GscToolkit.toLayer(Effect.gen(function*() {
  const store = yield* AccountStore
  const resolver = yield* SiteResolver
  const gsc = yield* GscClient

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
      const site = yield* resolver.resolve(params.site, params.account)
      const range = yield* resolveDateRange(params)
      const dimensions = params.dimensions ?? []
      const limit = params.limit ?? 100
      const response = yield* gsc.searchAnalytics(site.account, site.siteUrl, {
        ...range,
        dimensions,
        type: params.type ?? "web",
        filters: params.filters ?? [],
        dataState: params.dataState ?? "final",
        rowLimit: limit,
        startRow: params.startRow ?? 0
      })
      const rows = response.rows ?? []
      return {
        site: site.siteUrl,
        account: site.account,
        ...range,
        columns: [...dimensions, "clicks", "impressions", "ctr_pct", "position"],
        rows: rows.map((row) => [
          ...(row.keys ?? []),
          row.clicks,
          row.impressions,
          round(row.ctr * 100, 2),
          round(row.position, 1)
        ]),
        hasMore: rows.length === limit
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
  "Performance data lags about 3 days and covers the last 16 months.",
  "search_analytics returns compact rows: read `columns` for their meaning; ctr_pct is a percentage."
].join("\n")

/** Registers the toolkit on whatever MCP transport the application provides. */
export const GscMcpTools = McpServer.toolkit(GscToolkit).pipe(Layer.provide(GscToolkitHandlers))
