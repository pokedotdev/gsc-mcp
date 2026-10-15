import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { AuthError } from "./Errors.ts"

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly"
] as const

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

/** Credentials of the Google Cloud OAuth client. */
export class OAuthClientConfig extends Context.Service<OAuthClientConfig, {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted
}>()("gsc-mcp/OAuthClientConfig") {
  static readonly layerConfig = Layer.effect(
    OAuthClientConfig,
    Effect.gen(function*() {
      const clientId = yield* Config.String("GSC_MCP_CLIENT_ID")
      const clientSecret = yield* Config.Redacted("GSC_MCP_CLIENT_SECRET")
      return OAuthClientConfig.of({ clientId, clientSecret })
    })
  )
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String)
})

const TokenErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String)
})

const UserInfo = Schema.Struct({ email: Schema.String })

export interface AccessToken {
  readonly token: Redacted.Redacted
  readonly expiresAt: number
}

export interface CodeExchange {
  readonly accessToken: AccessToken
  readonly refreshToken: Redacted.Redacted
  readonly scopes: ReadonlyArray<string>
}

/** Raw Google OAuth 2.0 endpoints. */
export class GoogleOAuth extends Context.Service<GoogleOAuth, {
  authorizationUrl(options: {
    readonly redirectUri: string
    readonly state: string
    readonly codeChallenge: string
    readonly loginHint?: string | undefined
  }): string
  exchangeCode(options: {
    readonly code: string
    readonly codeVerifier: string
    readonly redirectUri: string
  }): Effect.Effect<CodeExchange, AuthError>
  refresh(account: string, refreshToken: Redacted.Redacted): Effect.Effect<AccessToken, AuthError>
  userEmail(accessToken: Redacted.Redacted): Effect.Effect<string, AuthError>
  revoke(token: Redacted.Redacted): Effect.Effect<void, AuthError>
}>()("gsc-mcp/GoogleOAuth") {
  static readonly layer = Layer.effect(
    GoogleOAuth,
    Effect.gen(function*() {
      const config = yield* OAuthClientConfig
      const client = yield* HttpClient.HttpClient

      const requestToken = Effect.fnUntraced(function*(account: string, params: Record<string, string>) {
        const response = yield* client.execute(
          HttpClientRequest.post(TOKEN_URL).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyUrlParams({
              ...params,
              client_id: config.clientId,
              client_secret: Redacted.value(config.clientSecret)
            })
          )
        ).pipe(Effect.mapError((cause) => new AuthError({ account, message: `Token request failed: ${cause.message}` })))
        if (response.status >= 400) {
          const body = yield* HttpClientResponse.schemaBodyJson(TokenErrorResponse)(response).pipe(Effect.option)
          const error = body._tag === "Some" ? body.value : undefined
          return yield* new AuthError({
            account,
            message: error?.error === "invalid_grant"
              ? `Google rejected the stored credentials of account "${account}" (revoked or expired). ` +
                `Run \`gsc-mcp auth add ${account}\` again.`
              : `Token request failed for account "${account}": ${error?.error_description ?? error?.error ?? `HTTP ${response.status}`}`
          })
        }
        return yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
          Effect.mapError(() => new AuthError({ account, message: "Unexpected token response from Google" }))
        )
      })

      const toAccessToken = (body: typeof TokenResponse.Type, now: number): AccessToken => ({
        token: Redacted.make(body.access_token),
        expiresAt: now + body.expires_in * 1000
      })

      const authorizationUrl = (options: {
        readonly redirectUri: string
        readonly state: string
        readonly codeChallenge: string
        readonly loginHint?: string | undefined
      }) => {
        const url = new URL(AUTH_URL)
        url.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: options.redirectUri,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          // Forces Google to issue a refresh token even if the user already consented.
          prompt: "consent select_account",
          include_granted_scopes: "true",
          code_challenge: options.codeChallenge,
          code_challenge_method: "S256",
          state: options.state,
          ...(options.loginHint ? { login_hint: options.loginHint } : {})
        }).toString()
        return url.toString()
      }

      const exchangeCode = Effect.fn("GoogleOAuth.exchangeCode")(function*(options: {
        readonly code: string
        readonly codeVerifier: string
        readonly redirectUri: string
      }) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const body = yield* requestToken("new account", {
          grant_type: "authorization_code",
          code: options.code,
          code_verifier: options.codeVerifier,
          redirect_uri: options.redirectUri
        })
        if (body.refresh_token === undefined) {
          return yield* new AuthError({ account: "new account", message: "Google did not return a refresh token" })
        }
        const scopes = body.scope?.split(" ") ?? []
        if (!scopes.includes("https://www.googleapis.com/auth/webmasters.readonly")) {
          return yield* new AuthError({
            account: "new account",
            message: "The Search Console permission was not granted. Run the flow again and allow access."
          })
        }
        return {
          accessToken: toAccessToken(body, now),
          refreshToken: Redacted.make(body.refresh_token),
          scopes
        }
      })

      const refresh = Effect.fn("GoogleOAuth.refresh")(function*(account: string, refreshToken: Redacted.Redacted) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const body = yield* requestToken(account, {
          grant_type: "refresh_token",
          refresh_token: Redacted.value(refreshToken) as string
        })
        return toAccessToken(body, now)
      })

      const userEmail = Effect.fn("GoogleOAuth.userEmail")(function*(accessToken: Redacted.Redacted) {
        const info = yield* client.execute(
          HttpClientRequest.get(USERINFO_URL).pipe(
            HttpClientRequest.bearerToken(Redacted.value(accessToken) as string),
            HttpClientRequest.acceptJson
          )
        ).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(UserInfo)),
          Effect.mapError(() => new AuthError({ account: "new account", message: "Could not read the account email" }))
        )
        return info.email
      })

      const revoke = Effect.fn("GoogleOAuth.revoke")(function*(token: Redacted.Redacted) {
        yield* client.execute(
          HttpClientRequest.post(REVOKE_URL).pipe(
            HttpClientRequest.bodyUrlParams({ token: Redacted.value(token) as string })
          )
        ).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(() => new AuthError({ account: "", message: "Could not revoke the token at Google" }))
        )
      })

      return GoogleOAuth.of({ authorizationUrl, exchangeCode, refresh, userEmail, revoke })
    })
  )
}

/** PKCE (RFC 7636) helpers on top of WebCrypto, available in Node and Workers. */
export const makePkce = Effect.gen(function*() {
  const verifier = Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return {
    verifier,
    challenge: Base64Url.encode(new Uint8Array(digest)),
    state: Base64Url.encode(crypto.getRandomValues(new Uint8Array(16)))
  }
})
