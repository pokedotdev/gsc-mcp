#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  Account,
  AccountAlias,
  AccountStore,
  GoogleOAuth,
  GscLive,
  GscMcpTools,
  OutputBudget,
  SERVER_INSTRUCTIONS,
  SiteResolver
} from "@gsc-mcp/core"
import { Config, Console, DateTime, Effect, FileSystem, Layer, Logger, Option, Schema } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { FileAccountStore } from "./FileAccountStore.ts"
import { clearCache, FileExporter, FileResultCache, pruneCache } from "./FileCache.ts"
import { runLoopbackFlow } from "./LoopbackFlow.ts"
import { OAuthClientLocal } from "./OAuthClient.ts"
import { CacheDir, ConfigDir } from "./Paths.ts"

const VERSION = "0.2.0"

const PlatformLive = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)
const ConfigDirLive = ConfigDir.layer.pipe(Layer.provide(PlatformLive))
const CacheDirLive = CacheDir.layer.pipe(Layer.provide(PlatformLive))
const StoreLive = FileAccountStore.pipe(Layer.provide([ConfigDirLive, PlatformLive]))
const OAuthClientLive = OAuthClientLocal.pipe(Layer.provide([ConfigDirLive, PlatformLive]))
const ResultCacheLive = FileResultCache.pipe(Layer.provide([CacheDirLive, PlatformLive]))
const ExporterLive = FileExporter.pipe(Layer.provide([CacheDirLive, PlatformLive]))
const AppLive = GscLive.pipe(
  Layer.provideMerge(StoreLive),
  Layer.provide([OAuthClientLive, ResultCacheLive, PlatformLive])
)

/** Characters of table rows per response, from GSC_MCP_MAX_OUTPUT_CHARS. */
const OutputBudgetLive = Layer.effect(
  OutputBudget,
  Config.Int("GSC_MCP_MAX_OUTPUT_CHARS").pipe(Config.withDefault(OutputBudget.defaultValue()))
)

// serve ----------------------------------------------------------------------

const serve = Command.make(
  "serve",
  {},
  () =>
    GscMcpTools.pipe(
      Layer.provide(McpServer.layerStdio({
        name: "gsc-mcp",
        version: VERSION,
        instructions: SERVER_INSTRUCTIONS,
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26]
      })),
      Layer.provide([AppLive, ExporterLive, OutputBudgetLive, PlatformLive]),
      Layer.launch,
      // Expired cache entries and old exports are cleaned up on every start.
      (launch) => pruneCache.pipe(Effect.provide([CacheDirLive, PlatformLive]), Effect.andThen(launch)),
      // stdout carries the MCP protocol, so logs must go to stderr.
      Effect.provideService(Logger.LogToStderr, true)
    )
).pipe(Command.withDescription("Run the MCP server over stdio"))

// auth -----------------------------------------------------------------------

const alias = Argument.String("alias").pipe(
  Argument.withDescription("Short name for the account, e.g. personal or client-acme")
)

const authAdd = Command.make(
  "add",
  {
    alias,
    loginHint: Flag.String("login-hint").pipe(
      Flag.withDescription("Email to preselect in the Google sign-in page"),
      Flag.optional
    )
  },
  Effect.fn(function*({ alias, loginHint }) {
    const decodedAlias = yield* Schema.decodeUnknownEffect(AccountAlias)(alias).pipe(
      Effect.mapError((error) => new Error(error.message))
    )
    const exchange = yield* runLoopbackFlow({ loginHint: Option.getOrUndefined(loginHint) })
    const oauth = yield* GoogleOAuth
    const email = yield* oauth.userEmail(exchange.accessToken.token)
    const store = yield* AccountStore
    const now = yield* DateTime.now
    yield* store.upsert(new Account({
      alias: decodedAlias,
      email,
      refreshToken: exchange.refreshToken,
      scopes: exchange.scopes,
      createdAt: DateTime.formatIso(now)
    }))
    yield* Console.log(`Connected ${email} as "${decodedAlias}".`)
    const resolver = yield* SiteResolver
    const index = yield* resolver.index
    const sites = index.sites.filter((s) => s.account === decodedAlias)
    yield* Console.log(
      sites.length === 0
        ? "This account has no Search Console properties."
        : `Properties:\n${sites.map((s) => `  ${s.siteUrl} (${s.permissionLevel})`).join("\n")}`
    )
  }, Effect.provide(AppLive))
).pipe(Command.withDescription("Connect a Google account through the browser"))

const authList = Command.make(
  "list",
  {},
  Effect.fn(function*() {
    const accounts = yield* (yield* AccountStore).list
    if (accounts.length === 0) {
      return yield* Console.log("No accounts configured. Run `gsc-mcp auth add <alias>`.")
    }
    for (const account of accounts) {
      yield* Console.log(`${account.alias}\t${account.email}\t(added ${account.createdAt.slice(0, 10)})`)
    }
  }, Effect.provide(StoreLive))
).pipe(Command.withDescription("List connected accounts"))

const authRemove = Command.make(
  "remove",
  {
    alias,
    keepToken: Flag.Boolean("keep-token").pipe(
      Flag.withDescription("Do not revoke the token at Google, only forget it locally"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function*({ alias, keepToken }) {
    const store = yield* AccountStore
    const account = yield* store.get(alias)
    if (!keepToken) {
      const oauth = yield* GoogleOAuth
      yield* oauth.revoke(account.refreshToken).pipe(
        Effect.catch((error) => Console.error(`Warning: ${error.message}. Removing locally anyway.`))
      )
    }
    yield* store.remove(alias)
    yield* Console.log(`Removed account "${alias}".`)
  }, Effect.provide(AppLive))
).pipe(Command.withDescription("Disconnect an account and revoke its token"))

const authClient = Command.make(
  "client",
  { file: Argument.String("client_secret.json").pipe(Argument.withDescription("OAuth client JSON downloaded from Google Cloud")) },
  Effect.fn(function*({ file }) {
    const fs = yield* FileSystem.FileSystem
    const { dir, clientFile } = yield* ConfigDir
    const content = yield* fs.readFileString(file)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as { installed?: { client_id?: unknown; client_secret?: unknown } },
      catch: () => new Error(`${file} is not valid JSON`)
    })
    if (typeof parsed.installed?.client_id !== "string" || typeof parsed.installed.client_secret !== "string") {
      return yield* Effect.fail(new Error(`${file} is not a "Desktop app" OAuth client file`))
    }
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(clientFile, content, { mode: 0o600 })
    yield* Console.log(`Saved OAuth client to ${clientFile}.`)
  }, Effect.provide([ConfigDirLive, PlatformLive]))
).pipe(Command.withDescription("Save the Google Cloud OAuth client credentials"))

// cache ----------------------------------------------------------------------

const cacheClear = Command.make(
  "clear",
  {},
  Effect.fn(function*() {
    const dir = yield* clearCache
    yield* Console.log(`Removed cached results and exported files in ${dir}.`)
  }, Effect.provide([CacheDirLive, PlatformLive]))
).pipe(Command.withDescription("Delete cached Search Console results and exported files"))

const cache = Command.make("cache").pipe(
  Command.withDescription("Manage the local cache"),
  Command.withSubcommands([cacheClear])
)

const auth = Command.make("auth").pipe(
  Command.withDescription("Manage Google accounts"),
  Command.withSubcommands([authAdd, authList, authRemove, authClient])
)

const cli = Command.make("gsc-mcp").pipe(
  Command.withDescription("Read-only Google Search Console MCP server"),
  Command.withSubcommands([serve, auth, cache]),
  Command.run({ version: VERSION })
)

cli.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
