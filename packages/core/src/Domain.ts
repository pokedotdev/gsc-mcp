import { Schema } from "effect"

export const AccountAlias = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/, {
    message: "Alias must be lowercase letters, digits, '-' or '_' (max 63 chars)"
  }))
)

/** A Google account authorized through OAuth. */
export class Account extends Schema.Class<Account>("gsc-mcp/Account")({
  alias: AccountAlias,
  email: Schema.String,
  refreshToken: Schema.RedactedFromValue(Schema.String),
  scopes: Schema.Array(Schema.String),
  createdAt: Schema.String
}) {}

export const PermissionLevel = Schema.Literals([
  "siteOwner",
  "siteFullUser",
  "siteRestrictedUser",
  "siteUnverifiedUser"
])
export type PermissionLevel = typeof PermissionLevel.Type

export const SiteEntry = Schema.Struct({
  siteUrl: Schema.String,
  permissionLevel: PermissionLevel
})
export type SiteEntry = typeof SiteEntry.Type

/** A property reachable through a specific account. */
export interface SiteAccess {
  readonly siteUrl: string
  readonly permissionLevel: PermissionLevel
  readonly account: string
}

// Search Analytics -----------------------------------------------------------

export const Dimension = Schema.Literals(["query", "page", "country", "device", "date", "searchAppearance"])
export type Dimension = typeof Dimension.Type

export const FilterDimension = Schema.Literals(["query", "page", "country", "device", "searchAppearance"])

export const FilterOperator = Schema.Literals([
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex"
])

export const SearchType = Schema.Literals(["web", "image", "video", "news", "discover", "googleNews"])
export type SearchType = typeof SearchType.Type

export const DataState = Schema.Literals(["final", "all"])
export type DataState = typeof DataState.Type

export const DimensionFilter = Schema.Struct({
  dimension: FilterDimension,
  operator: FilterOperator,
  expression: Schema.String
})
export type DimensionFilter = typeof DimensionFilter.Type

export interface SearchAnalyticsRequest {
  readonly startDate: string
  readonly endDate: string
  readonly dimensions: ReadonlyArray<Dimension>
  readonly type: SearchType
  readonly filters: ReadonlyArray<DimensionFilter>
  readonly rowLimit: number
  readonly startRow: number
  readonly dataState: DataState
}

export const SearchAnalyticsRow = Schema.Struct({
  keys: Schema.optional(Schema.Array(Schema.String)),
  clicks: Schema.Number,
  impressions: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number
})
export type SearchAnalyticsRow = typeof SearchAnalyticsRow.Type

export const SearchAnalyticsResponse = Schema.Struct({
  rows: Schema.optional(Schema.Array(SearchAnalyticsRow)),
  responseAggregationType: Schema.optional(Schema.String)
})
export type SearchAnalyticsResponse = typeof SearchAnalyticsResponse.Type

// URL Inspection -------------------------------------------------------------

export const IndexStatusResult = Schema.Struct({
  verdict: Schema.optional(Schema.String),
  coverageState: Schema.optional(Schema.String),
  robotsTxtState: Schema.optional(Schema.String),
  indexingState: Schema.optional(Schema.String),
  lastCrawlTime: Schema.optional(Schema.String),
  pageFetchState: Schema.optional(Schema.String),
  googleCanonical: Schema.optional(Schema.String),
  userCanonical: Schema.optional(Schema.String),
  crawledAs: Schema.optional(Schema.String),
  sitemap: Schema.optional(Schema.Array(Schema.String)),
  referringUrls: Schema.optional(Schema.Array(Schema.String))
})

export const InspectionResult = Schema.Struct({
  inspectionResultLink: Schema.optional(Schema.String),
  indexStatusResult: Schema.optional(IndexStatusResult),
  mobileUsabilityResult: Schema.optional(Schema.Struct({
    verdict: Schema.optional(Schema.String)
  })),
  richResultsResult: Schema.optional(Schema.Struct({
    verdict: Schema.optional(Schema.String),
    detectedItems: Schema.optional(Schema.Array(Schema.Struct({
      richResultType: Schema.optional(Schema.String)
    })))
  }))
})
export type InspectionResult = typeof InspectionResult.Type

export const UrlInspectionResponse = Schema.Struct({
  inspectionResult: InspectionResult
})

// Sitemaps -------------------------------------------------------------------

export const Sitemap = Schema.Struct({
  path: Schema.String,
  lastSubmitted: Schema.optional(Schema.String),
  lastDownloaded: Schema.optional(Schema.String),
  isPending: Schema.optional(Schema.Boolean),
  isSitemapsIndex: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  // The API encodes these int64 counters as strings.
  warnings: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  errors: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  contents: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.optional(Schema.String),
    submitted: Schema.optional(Schema.Union([Schema.String, Schema.Number]))
  })))
})
export type Sitemap = typeof Sitemap.Type

export const SitemapsResponse = Schema.Struct({
  sitemap: Schema.optional(Schema.Array(Sitemap))
})
