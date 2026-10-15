import { Clock, Context, Effect, Layer, SynchronizedRef } from "effect"
import type { Redacted } from "effect"
import { AccountStore } from "./AccountStore.ts"
import type { AccountNotFound, AccountStoreError, AuthError } from "./Errors.ts"
import { type AccessToken, GoogleOAuth } from "./GoogleOAuth.ts"

// Refresh slightly before Google's expiry to avoid using a token mid-flight.
const EXPIRY_MARGIN_MS = 60_000

/** Hands out valid access tokens per account, refreshing them on demand. */
export class GoogleAuth extends Context.Service<GoogleAuth, {
  accessToken(alias: string): Effect.Effect<Redacted.Redacted, AccountNotFound | AccountStoreError | AuthError>
  invalidate(alias: string): Effect.Effect<void>
}>()("gsc-mcp/GoogleAuth") {
  static readonly layer = Layer.effect(
    GoogleAuth,
    Effect.gen(function*() {
      const store = yield* AccountStore
      const oauth = yield* GoogleOAuth
      // SynchronizedRef serializes refreshes, so concurrent tool calls never
      // refresh the same account twice.
      const cache = yield* SynchronizedRef.make(new Map<string, AccessToken>())

      const accessToken = Effect.fn("GoogleAuth.accessToken")(function*(alias: string) {
        return yield* SynchronizedRef.modifyEffect(cache, Effect.fnUntraced(function*(tokens) {
          const now = yield* Clock.currentTimeMillis
          const cached = tokens.get(alias)
          if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now) {
            return [cached.token, tokens] as const
          }
          const account = yield* store.get(alias)
          const fresh = yield* oauth.refresh(alias, account.refreshToken)
          return [fresh.token, new Map(tokens).set(alias, fresh)] as const
        }))
      })

      const invalidate = (alias: string) =>
        SynchronizedRef.update(cache, (tokens) => {
          const next = new Map(tokens)
          next.delete(alias)
          return next
        })

      return GoogleAuth.of({ accessToken, invalidate })
    })
  )
}
