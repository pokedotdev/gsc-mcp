import { OAuthClientConfig } from "@gsc-mcp/core"
import { Config, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { ConfigDir } from "./Paths.ts"

// The JSON file Google Cloud Console offers for "Desktop app" OAuth clients.
const ClientSecretFile = Schema.fromJsonString(Schema.Struct({
  installed: Schema.Struct({ client_id: Schema.String, client_secret: Schema.String })
}))

/**
 * OAuth client credentials from GSC_MCP_CLIENT_ID / GSC_MCP_CLIENT_SECRET, or
 * from client.json in the config directory.
 */
export const OAuthClientLocal = Layer.effect(
  OAuthClientConfig,
  Effect.gen(function*() {
    const clientId = yield* Config.option(Config.String("GSC_MCP_CLIENT_ID"))
    const clientSecret = yield* Config.option(Config.Redacted("GSC_MCP_CLIENT_SECRET"))
    if (clientId._tag === "Some" && clientSecret._tag === "Some") {
      return OAuthClientConfig.of({ clientId: clientId.value, clientSecret: clientSecret.value })
    }
    const fs = yield* FileSystem.FileSystem
    const { clientFile } = yield* ConfigDir
    const file = yield* fs.readFileString(clientFile).pipe(
      Effect.flatMap(Schema.decodeEffect(ClientSecretFile)),
      Effect.mapError(() =>
        new Error(
          `Missing OAuth client. Set GSC_MCP_CLIENT_ID and GSC_MCP_CLIENT_SECRET, ` +
            `or run \`gsc-mcp auth client <client_secret.json>\` (saved to ${clientFile}).`
        )
      )
    )
    return OAuthClientConfig.of({
      clientId: file.installed.client_id,
      clientSecret: Redacted.make(file.installed.client_secret)
    })
  })
)
