import type { SearchAnalyticsRow } from "./Domain.ts"

// Pure analysis over Search Analytics rows. CTR and positions are kept as the
// API reports them (CTR as a 0-1 fraction); formatting happens in the tools.

const keyOf = (row: SearchAnalyticsRow) => (row.keys ?? []).join("\u0000")

// Generic organic CTR by position, used where the site has too little data
// to estimate its own curve.
const BENCHMARK_CTR = [0.28, 0.16, 0.11, 0.08, 0.06, 0.05, 0.04, 0.033, 0.028, 0.025]
const benchmarkCtr = (position: number) => BENCHMARK_CTR[position - 1] ?? 0.01

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

// Branded queries -------------------------------------------------------------

const normalizeBrand = (text: string) => text.toLowerCase().replace(/[\s.\-_]+/g, "")

/**
 * Guesses the brand from a property: "sc-domain:zona-craft.com.mx" -> "zonacraft".
 * Branded queries behave differently (sitelinks, very high CTR) and distort
 * opportunity analysis, so they are excluded by default.
 */
export const brandFromSite = (siteUrl: string): string | undefined => {
  const host = siteUrl.startsWith("sc-domain:")
    ? siteUrl.slice("sc-domain:".length)
    : new URL(siteUrl).hostname
  const labels = host.toLowerCase().replace(/^www\./, "").split(".")
  if (labels.length < 2) return undefined
  // Second-level public suffixes such as com.mx or co.uk.
  const secondLevel = labels.length >= 3 && labels.at(-2)!.length <= 3
  const label = secondLevel ? labels.at(-3)! : labels.at(-2)!
  return normalizeBrand(label)
}

/** Builds a predicate matching queries that contain any brand term, ignoring spaces and punctuation. */
export const brandMatcher = (terms: ReadonlyArray<string>) => {
  const normalized = terms.map(normalizeBrand).filter((term) => term.length >= 3)
  return (query: string) => {
    const text = normalizeBrand(query)
    return normalized.some((term) => text.includes(term))
  }
}

// Period comparison ----------------------------------------------------------

export interface PeriodDelta {
  readonly keys: ReadonlyArray<string>
  readonly current: SearchAnalyticsRow | undefined
  readonly previous: SearchAnalyticsRow | undefined
  readonly clicksDelta: number
  readonly impressionsDelta: number
  /** Negative values mean the average position improved. */
  readonly positionDelta: number | undefined
}

export const comparePeriods = (
  current: ReadonlyArray<SearchAnalyticsRow>,
  previous: ReadonlyArray<SearchAnalyticsRow>
): Array<PeriodDelta> => {
  const previousByKey = new Map(previous.map((row) => [keyOf(row), row]))
  const deltas: Array<PeriodDelta> = []
  const delta = (cur: SearchAnalyticsRow | undefined, prev: SearchAnalyticsRow | undefined): PeriodDelta => ({
    keys: (cur ?? prev)?.keys ?? [],
    current: cur,
    previous: prev,
    clicksDelta: (cur?.clicks ?? 0) - (prev?.clicks ?? 0),
    impressionsDelta: (cur?.impressions ?? 0) - (prev?.impressions ?? 0),
    positionDelta: cur && prev ? cur.position - prev.position : undefined
  })
  for (const row of current) {
    const key = keyOf(row)
    deltas.push(delta(row, previousByKey.get(key)))
    previousByKey.delete(key)
  }
  for (const row of previousByKey.values()) deltas.push(delta(undefined, row))
  return deltas
}

// Opportunities --------------------------------------------------------------

/**
 * Expected CTR for positions 1-20, estimated from the site's own rows (median
 * per rounded position, robust to branded outliers) and forced to decrease
 * with position. Falls back to a generic benchmark for sparse positions.
 */
export const ctrCurve = (rows: ReadonlyArray<SearchAnalyticsRow>, minImpressions: number): Array<number> => {
  const buckets = Array.from({ length: 20 }, () => [] as Array<number>)
  for (const row of rows) {
    const position = Math.round(row.position)
    if (row.impressions >= minImpressions && position >= 1 && position <= 20) buckets[position - 1]!.push(row.ctr)
  }
  const curve: Array<number> = []
  for (let i = 0; i < 20; i++) {
    const bucket = buckets[i]!
    const estimate = bucket.length >= 5 ? median(bucket) : benchmarkCtr(i + 1)
    curve.push(i === 0 ? estimate : Math.min(estimate, curve[i - 1]!))
  }
  return curve
}

export type OpportunityKind = "striking_distance" | "low_ctr"

export interface Opportunity {
  readonly kind: OpportunityKind
  readonly row: SearchAnalyticsRow
  readonly expectedCtr: number
  /** Extra monthly-ish clicks if the row reached the expected CTR. */
  readonly potentialClicks: number
}

/**
 * Finds untapped clicks in rows with dimensions [query, page]. Rows of a query
 * that another page of the site already wins (more clicks, same or better
 * position) are skipped: they are sitelinks or secondary listings, and the
 * opportunity belongs to the winning page.
 */
export const findOpportunities = (
  rows: ReadonlyArray<SearchAnalyticsRow>,
  options: {
    readonly kinds: ReadonlyArray<OpportunityKind>
    readonly minImpressions: number
    /** Position range considered "striking distance" of the top 3. */
    readonly strikingRange: readonly [number, number]
    readonly isBranded?: ((query: string) => boolean) | undefined
  }
): { readonly curve: Array<number>; readonly opportunities: Array<Opportunity> } => {
  const isBranded = options.isBranded
  const candidates = isBranded ? rows.filter((row) => !isBranded(row.keys?.[0] ?? "")) : rows
  const curve = ctrCurve(candidates, options.minImpressions)

  const byQuery = new Map<string, Array<SearchAnalyticsRow>>()
  for (const row of candidates) {
    const query = row.keys?.[0] ?? ""
    const siblings = byQuery.get(query) ?? []
    siblings.push(row)
    byQuery.set(query, siblings)
  }
  const isSecondary = (row: SearchAnalyticsRow) =>
    (byQuery.get(row.keys?.[0] ?? "") ?? []).some((other) =>
      other !== row && other.clicks > row.clicks && other.position <= row.position + 0.5
    )

  const opportunities: Array<Opportunity> = []
  const [minPosition, maxPosition] = options.strikingRange
  for (const row of candidates) {
    if (row.impressions < options.minImpressions || isSecondary(row)) continue
    if (options.kinds.includes("striking_distance") && row.position >= minPosition && row.position <= maxPosition) {
      const expectedCtr = curve[2]!
      const potentialClicks = row.impressions * (expectedCtr - row.ctr)
      if (potentialClicks > 0) opportunities.push({ kind: "striking_distance", row, expectedCtr, potentialClicks })
      continue
    }
    if (options.kinds.includes("low_ctr") && row.position < minPosition) {
      const expectedCtr = curve[Math.max(1, Math.round(row.position)) - 1]!
      // Only flag clear underperformers, not normal variance.
      if (row.ctr < expectedCtr * 0.6) {
        opportunities.push({ kind: "low_ctr", row, expectedCtr, potentialClicks: row.impressions * (expectedCtr - row.ctr) })
      }
    }
  }
  opportunities.sort((a, b) => b.potentialClicks - a.potentialClicks)
  return { curve, opportunities }
}

// Cannibalization ------------------------------------------------------------

export interface CannibalizedPage {
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number
}

export interface Cannibalization {
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  /** Share of impressions that does not go to the strongest page (0-1). */
  readonly split: number
  readonly pages: ReadonlyArray<CannibalizedPage>
}

/** Drops URL fragments: Google reports jump links (#section) as separate pages. */
const canonicalPage = (page: string) => {
  const hash = page.indexOf("#")
  return hash === -1 ? page : page.slice(0, hash)
}

/**
 * Finds queries where several pages of the site compete. Expects rows with
 * dimensions [query, page].
 */
export const detectCannibalization = (
  rows: ReadonlyArray<SearchAnalyticsRow>,
  options: {
    readonly minImpressions: number
    readonly minShare: number
    readonly isBranded?: ((query: string) => boolean) | undefined
  }
): Array<Cannibalization> => {
  const byQuery = new Map<string, Map<string, { clicks: number; impressions: number; weightedPosition: number }>>()
  for (const row of rows) {
    const [query, rawPage] = row.keys ?? []
    if (query === undefined || rawPage === undefined || options.isBranded?.(query)) continue
    const page = canonicalPage(rawPage)
    const pages = byQuery.get(query) ?? new Map()
    const entry = pages.get(page) ?? { clicks: 0, impressions: 0, weightedPosition: 0 }
    entry.clicks += row.clicks
    entry.impressions += row.impressions
    entry.weightedPosition += row.position * row.impressions
    pages.set(page, entry)
    byQuery.set(query, pages)
  }

  const issues: Array<Cannibalization> = []
  for (const [query, pages] of byQuery) {
    if (pages.size < 2) continue
    let clicks = 0
    let impressions = 0
    for (const entry of pages.values()) {
      clicks += entry.clicks
      impressions += entry.impressions
    }
    if (impressions < options.minImpressions) continue
    const competing = [...pages]
      .map(([page, entry]) => ({
        page,
        clicks: entry.clicks,
        impressions: entry.impressions,
        position: entry.impressions > 0 ? entry.weightedPosition / entry.impressions : 0
      }))
      .filter((page) => page.impressions / impressions >= options.minShare)
      .sort((a, b) => b.impressions - a.impressions)
    if (competing.length < 2) continue
    issues.push({ query, clicks, impressions, split: 1 - competing[0]!.impressions / impressions, pages: competing })
  }
  // Most impressions at stake first.
  return issues.sort((a, b) => b.impressions * b.split - a.impressions * a.split)
}
