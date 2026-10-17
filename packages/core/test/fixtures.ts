import { Effect, Layer, Redacted } from "effect"
import { Account, Exporter, GoogleOAuth, GscClient, type GscClientError, type SiteEntry } from "../src/index.ts"

export const makeAccount = (alias: string) =>
  new Account({
    alias,
    email: `${alias}@example.com`,
    refreshToken: Redacted.make(`refresh-${alias}`),
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    createdAt: "2026-01-01T00:00:00.000Z"
  })

/** GoogleOAuth stub that issues one-hour tokens and counts refreshes. */
export const fakeOAuth = (refreshes: { count: number }) =>
  Layer.succeed(GoogleOAuth)(GoogleOAuth.of({
    authorizationUrl: () => "https://example.test/auth",
    exchangeCode: () => Effect.die("not used"),
    refresh: (account) =>
      Effect.clockWith((clock) =>
        Effect.sync(() => {
          refreshes.count++
          return {
            token: Redacted.make(`access-${account}-${refreshes.count}`),
            expiresAt: clock.currentTimeMillisUnsafe() + 3600_000
          }
        })
      ),
    userEmail: () => Effect.succeed("user@example.com"),
    revoke: () => Effect.void
  }))

/** GscClient stub backed by a static map of account -> sites. */
export const fakeGsc = (
  sites: Record<string, ReadonlyArray<SiteEntry> | GscClientError>,
  overrides: Partial<GscClient["Service"]> = {}
) =>
  Layer.succeed(GscClient)(GscClient.of({
    listSites: (account) => {
      const entry = sites[account]
      return entry === undefined ? Effect.succeed([]) : Array.isArray(entry) ? Effect.succeed(entry) : Effect.fail(entry as GscClientError)
    },
    searchAnalytics: () => Effect.succeed({ rows: [] }),
    inspectUrl: () => Effect.succeed({}),
    listSitemaps: () => Effect.succeed([]),
    ...overrides
  }))

/** Exporter that keeps files in a map. */
export const memoryExporter = (files: Map<string, string>) =>
  Layer.succeed(Exporter)(Exporter.of({
    write: ({ name, content }) =>
      Effect.sync(() => {
        files.set(name, content)
        return { path: `/exports/${name}`, bytes: content.length }
      })
  }))
