import { NodeHttpServer } from "@effect/platform-node"
import { AuthError, GoogleOAuth, makePkce } from "@gsc-mcp/core"
import { Console, Deferred, Effect } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { spawn } from "node:child_process"
import { createServer } from "node:http"

const page = (title: string, body: string) =>
  HttpServerResponse.html(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p></body>`
  )

const openBrowser = (url: string) =>
  Effect.sync(() => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
    try {
      spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
    } catch {
      // The URL is printed anyway.
    }
  })

/**
 * Runs the OAuth authorization code flow with PKCE using a temporary HTTP
 * server on the loopback interface, as recommended for desktop apps.
 */
export const runLoopbackFlow = Effect.fn("runLoopbackFlow")(function*(options: { readonly loginHint?: string | undefined }) {
  const oauth = yield* GoogleOAuth
  const pkce = yield* makePkce
  const result = yield* Deferred.make<string, AuthError>()

  const handler = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname !== "/callback") return HttpServerResponse.empty({ status: 404 })
    const error = url.searchParams.get("error")
    const code = url.searchParams.get("code")
    if (url.searchParams.get("state") !== pkce.state) {
      return page("Authorization failed", "Invalid state parameter. Run the command again.")
    }
    if (error !== null || code === null) {
      yield* Deferred.fail(result, new AuthError({ account: "new account", message: `Authorization denied: ${error}` }))
      return page("Authorization denied", "You can close this tab.")
    }
    yield* Deferred.succeed(result, code)
    return page("Account connected", "You can close this tab and return to the terminal.")
  })

  return yield* Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    yield* server.serve(handler)
    const redirectUri = yield* HttpServer.addressFormattedWith((address) =>
      Effect.succeed(`${address.replace(/\/$/, "")}/callback`)
    )
    const authUrl = oauth.authorizationUrl({
      redirectUri,
      state: pkce.state,
      codeChallenge: pkce.challenge,
      loginHint: options.loginHint
    })
    yield* Console.log(`Opening the browser to authorize access. If it does not open, visit:\n\n${authUrl}\n`)
    yield* openBrowser(authUrl)
    const code = yield* Deferred.await(result).pipe(
      Effect.timeoutOrElse({
        duration: "5 minutes",
        orElse: () => Effect.fail(new AuthError({ account: "new account", message: "Timed out waiting for authorization" }))
      })
    )
    return yield* oauth.exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri })
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeHttpServer.layerServer(createServer, { port: 0, host: "127.0.0.1" }))
  )
})
