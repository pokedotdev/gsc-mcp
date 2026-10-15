import { Context, Effect, Layer } from "effect"
import { AccountStore } from "./AccountStore.ts"
import type { PermissionLevel, SiteAccess } from "./Domain.ts"
import { type AccountNotFound, type AccountStoreError, SiteNotFound } from "./Errors.ts"
import { GscClient } from "./GscClient.ts"

export interface SiteIndex {
  readonly sites: ReadonlyArray<SiteAccess>
  /** Accounts whose sites could not be listed, with the reason. */
  readonly failures: ReadonlyArray<{ readonly account: string; readonly message: string }>
}

export interface ResolvedSite {
  readonly siteUrl: string
  readonly account: string
}

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  siteOwner: 3,
  siteFullUser: 2,
  siteRestrictedUser: 1,
  siteUnverifiedUser: 0
}

/**
 * Turns user input ("example.com", "https://example.com/blog",
 * "sc-domain:example.com") into the Search Console properties that may match,
 * most specific first.
 */
export const siteCandidates = (input: string): ReadonlyArray<string> => {
  const trimmed = input.trim()
  if (trimmed.toLowerCase().startsWith("sc-domain:")) {
    return [`sc-domain:${trimmed.slice("sc-domain:".length).toLowerCase()}`]
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`
    const prefixes: Array<string> = []
    // Every URL-prefix property that contains the URL, longest first.
    const segments = path.split("/").filter(Boolean)
    for (let i = segments.length; i >= 0; i--) {
      const prefix = segments.slice(0, i).join("/")
      prefixes.push(`${url.protocol}//${url.host}/${prefix ? `${prefix}/` : ""}`)
    }
    return [...prefixes, `sc-domain:${url.hostname.replace(/^www\./, "")}`]
  }
  const host = trimmed.replace(/\/+$/, "").toLowerCase()
  const bare = host.replace(/^www\./, "")
  return [
    `sc-domain:${bare}`,
    `https://${bare}/`,
    `https://www.${bare}/`,
    `http://${bare}/`,
    `http://www.${bare}/`
  ]
}

/** Picks the property and account to use for a site, from an index. */
export const resolveSite = (
  index: ReadonlyArray<SiteAccess>,
  input: string,
  account?: string
): ResolvedSite | undefined => {
  const usable = index.filter((s) =>
    s.permissionLevel !== "siteUnverifiedUser" && (account === undefined || s.account === account)
  )
  for (const candidate of siteCandidates(input)) {
    const best = usable
      .filter((s) => s.siteUrl === candidate)
      .sort((a, b) =>
        PERMISSION_RANK[b.permissionLevel] - PERMISSION_RANK[a.permissionLevel] || a.account.localeCompare(b.account)
      )[0]
    if (best) return { siteUrl: best.siteUrl, account: best.account }
  }
  return undefined
}

/** Knows which account can access which property, across all accounts. */
export class SiteResolver extends Context.Service<SiteResolver, {
  readonly index: Effect.Effect<SiteIndex, AccountStoreError>
  readonly refresh: Effect.Effect<void>
  resolve(input: string, account?: string): Effect.Effect<ResolvedSite, SiteNotFound | AccountNotFound | AccountStoreError>
}>()("gsc-mcp/SiteResolver") {
  static readonly layer = Layer.effect(
    SiteResolver,
    Effect.gen(function*() {
      const store = yield* AccountStore
      const gsc = yield* GscClient

      const buildIndex = Effect.gen(function*() {
        const accounts = yield* store.list
        const results = yield* Effect.forEach(
          accounts,
          (account) =>
            gsc.listSites(account.alias).pipe(
              Effect.map((entries) => ({ account: account.alias, entries, error: undefined })),
              Effect.catch((error) => Effect.succeed({ account: account.alias, entries: [], error: error.message }))
            ),
          { concurrency: 4 }
        )
        return {
          sites: results.flatMap((r) => r.entries.map((e) => ({ ...e, account: r.account }))),
          failures: results.flatMap((r) => r.error === undefined ? [] : [{ account: r.account, message: r.error }])
        } satisfies SiteIndex
      }).pipe(Effect.withSpan("SiteResolver.buildIndex"))

      const [index, invalidate] = yield* Effect.cachedInvalidateWithTTL(buildIndex, "10 minutes")

      const resolve = Effect.fn("SiteResolver.resolve")(function*(input: string, account?: string) {
        if (account !== undefined) yield* store.get(account)
        let current = yield* index
        let resolved = resolveSite(current.sites, input, account)
        if (resolved === undefined) {
          // The site may have been added recently: rebuild once before failing.
          yield* invalidate
          current = yield* index
          resolved = resolveSite(current.sites, input, account)
        }
        if (resolved !== undefined) return resolved
        const available = [...new Set(current.sites.map((s) => s.siteUrl))]
        return yield* new SiteNotFound({
          site: input,
          message: `No accessible Search Console property matches "${input}"` +
            (account ? ` in account "${account}"` : "") + ". " +
            (available.length > 0
              ? `Available properties: ${available.slice(0, 30).join(", ")}${available.length > 30 ? ", ..." : ""}.`
              : "No properties are available; check the configured accounts with list_accounts.")
        })
      })

      return SiteResolver.of({ index, refresh: invalidate, resolve })
    })
  )
}
